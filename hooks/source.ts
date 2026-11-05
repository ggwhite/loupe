import type { Size } from './layout'

export type ToolImage = { base64: string; mime: string }
/** pending: only the raw file is written, not yet converted to png (a subagent's image, converted once the viewer shows it). */
/** ref: the tool image's cache name; the registry keys its number by it, so one image maps to one entry whenever it resolves. */
export type Resolved = { path: string; size: Size | null; generation: number; pending?: true; ref?: string } | { error: string }

export const SOURCE_CACHE_MAX = 256
export const MEMO_MAX = 2048

/** A capped Map: a get hit moves to newest; when full, the least recently used goes. */
export class Lru<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly cap: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v === undefined) return undefined
    this.map.delete(key)
    this.map.set(key, v)
    return v
  }

  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.cap) this.map.delete(this.map.keys().next().value as string)
  }

  delete(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }

  keys(): string[] {
    return [...this.map.keys()]
  }

  get size(): number {
    return this.map.size
  }
}

const cache = new Lru<Promise<Resolved>>(SOURCE_CACHE_MAX)

/** Settled tool result images (an empty array means none), keyed by tool_use_id, one map each for ToolResult and ToolGroup. */
export const resultMemo = new Lru<unknown[]>(MEMO_MAX)
export const groupMemo = new Lru<unknown[]>(MEMO_MAX)

/** Files this session wrote into the cache dir; /loupe clear and the keep-fresh touch only act on these. */
export const written = new Set<string>()

/** tool_use_ids that produced images; /loupe clear moves them into clearedIds, so later redraws neither write files nor add entries. */
export const usedIds = new Lru<true>(MEMO_MAX)
export const clearedIds = new Lru<true>(MEMO_MAX)

/** Collapses //, . and .., and treats macOS /private/{var,tmp,etc} as the same path, so different spellings compare equal. */
export function canonicalPath(path: string): string {
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  if (parts[0] === 'private' && ['var', 'tmp', 'etc'].includes(parts[1] ?? '')) parts.shift()
  return `/${parts.join('/')}`
}

/** Paths an AssistantMessage referenced with ![](path); /loupe clear never deletes these. */
export const referenced = new Lru<true>(MEMO_MAX)

/** Bumped by each /loupe clear; a write notes it at the start and adds no entry if it changed by the end. */
export const clearing = { generation: 0 }

/** For /loupe clear: drops this session's image state but keeps clearedIds and referenced. */
export function clearSourceCache(): void {
  usedIds.clear()
  cache.clear()
  resultMemo.clear()
  groupMemo.clear()
  written.clear()
}

export function resetSourceCache(): void {
  clearSourceCache()
  clearedIds.clear()
  referenced.clear()
}

export function cached(key: string): Promise<Resolved> | undefined {
  return cache.get(key)
}

/** Keeps a resolution for reuse; an error is dropped unless keepErrors, so the next draw tries again. */
export function remember(key: string, work: Promise<Resolved>, keepErrors = false): Promise<Resolved> {
  cache.set(key, work)
  if (!keepErrors) {
    void work.then(r => {
      if ('error' in r && cache.get(key) === work) cache.delete(key)
    })
  }
  return work
}

export function toolImages(output: unknown): ToolImage[] {
  const out: ToolImage[] = []
  const visit = (v: unknown, depth: number): void => {
    if (depth > 4 || v === null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1)
      return
    }
    const o = v as Record<string, unknown>
    if (o['type'] === 'image') {
      const file = o['file'] as Record<string, unknown> | undefined
      const source = o['source'] as Record<string, unknown> | undefined
      const base64 = file?.['base64'] ?? o['data'] ?? source?.['data']
      const mime = file?.['type'] ?? o['mimeType'] ?? source?.['media_type']
      if (typeof base64 === 'string' && base64.length > 0) {
        out.push({ base64, mime: typeof mime === 'string' ? mime : 'image/png' })
      }
      return
    }
    if ('content' in o) visit(o['content'], depth + 1)
  }
  visit(output, 0)
  return out
}

export function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
