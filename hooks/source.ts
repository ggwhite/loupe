import type { Size } from './layout'

export type ToolImage = { base64: string; mime: string }
/** pending：只寫了原始檔，還沒轉成 png（子代理的圖，等檢視區要顯示才轉）。 */
/** ref：工具圖片的快取名稱，註冊表用它當編號的 id，讓同一張圖不論何時解析都對到同一項。 */
export type Resolved = { path: string; size: Size | null; generation: number; pending?: true; ref?: string } | { error: string }

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

  keys(): string[] {
    return [...this.map.keys()]
  }

  get size(): number {
    return this.map.size
  }
}

const cache = new Lru<Promise<Resolved>>(SOURCE_CACHE_MAX)

/** 已定案的工具結果圖片（空陣列＝沒有圖），key 是 tool_use_id，ToolResult 與 ToolGroup 各一份。 */
export const resultMemo = new Lru<unknown[]>(MEMO_MAX)
export const groupMemo = new Lru<unknown[]>(MEMO_MAX)

/** 這個 session 寫進快取目錄的檔案；/gallery clear 與保鮮 touch 只動這些。 */
export const written = new Set<string>()

/** 出過圖的 tool_use_id；/gallery clear 把它們轉進 clearedIds，之後重畫就不再寫檔、加項目。 */
export const usedIds = new Lru<true>(MEMO_MAX)
export const clearedIds = new Lru<true>(MEMO_MAX)

/** 折疊 //、. 與 ..，並把 macOS 的 /private/{var,tmp,etc} 視為同一條路徑，讓不同寫法比得起來。 */
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

/** AssistantMessage 的 ![](path) 引用過的路徑；/gallery clear 不刪這些。 */
export const referenced = new Lru<true>(MEMO_MAX)

/** 每次 /gallery clear 加一；開始寫圖時記下它，寫完發現變了就不能再加項目。 */
export const clearing = { generation: 0 }

/** /gallery clear 用：清掉這個 session 的圖片狀態，但保留 clearedIds 與 referenced。 */
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
