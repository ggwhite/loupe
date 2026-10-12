import type { Size } from './layout'

export type Item = { n: number; path: string; size: Size | null; generation: number; label: string }

const list: Item[] = []
const byId = new Map<string, Item>()

export function addItem(r: { path: string; size: Size | null; generation: number }, label: string): Item {
  const id = `${r.path}|${r.generation}`
  const hit = byId.get(id)
  if (hit) return hit
  const item: Item = { n: list.length + 1, path: r.path, size: r.size, generation: r.generation, label }
  list.push(item)
  byId.set(id, item)
  return item
}

export function items(): readonly Item[] {
  return list
}

export function resetRegistry(): void {
  list.length = 0
  byId.clear()
}
