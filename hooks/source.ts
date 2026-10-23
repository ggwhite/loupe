import type { Size } from './layout'

export type ToolImage = { base64: string; mime: string }
/** pending：只寫了原始檔，還沒轉成 png（子代理的圖，等檢視區要顯示才轉）。 */
export type Resolved = { path: string; size: Size | null; generation: number; pending?: true } | { error: string }

export const SOURCE_CACHE_MAX = 256
export const MEMO_MAX = 2048

/** 容量有上限的 Map：get 命中會移到最新，滿了就丟最久沒用的。 */
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

  get size(): number {
    return this.map.size
  }
}

const cache = new Lru<Promise<Resolved>>(SOURCE_CACHE_MAX)

/** 已定案的工具結果圖片（空陣列＝沒有圖），key 是 tool_use_id，ToolResult 與 ToolGroup 各一份。 */
export const resultMemo = new Lru<unknown[]>(MEMO_MAX)
export const groupMemo = new Lru<unknown[]>(MEMO_MAX)

export function resetSourceCache(): void {
  cache.clear()
  resultMemo.clear()
  groupMemo.clear()
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
