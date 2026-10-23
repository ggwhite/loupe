import type { Size } from './layout'

export type Item = { n: number; path: string; size: Size | null; generation: number; label: string; pending?: true }

const list: Item[] = []
const byId = new Map<string, Item>()

export function addItem(r: { path: string; size: Size | null; generation: number; pending?: true }, label: string): Item {
  const id = `${r.path}|${r.generation}`
  const hit = byId.get(id)
  if (hit) return hit
  const item: Item = { n: list.length + 1, path: r.path, size: r.size, generation: r.generation, label, ...(r.pending ? { pending: true as const } : {}) }
  list.push(item)
  byId.set(id, item)
  return item
}

/** 原始檔轉成 png 後，讓同一個編號改指向 png。 */
export function settle(rawPath: string, r: { path: string; size: Size | null; generation: number }): void {
  const item = byId.get(`${rawPath}|0`)
  if (!item?.pending) return
  byId.delete(`${rawPath}|0`)
  item.path = r.path
  item.size = r.size
  item.generation = r.generation
  delete item.pending
  byId.set(`${item.path}|${item.generation}`, item)
}

export function items(): readonly Item[] {
  return list
}

export function resetRegistry(): void {
  list.length = 0
  byId.clear()
}
