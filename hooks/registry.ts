import type { Size } from './layout'

export type Item = { id: string; n: number; path: string; size: Size | null; generation: number; label: string; pending?: true }

const list: Item[] = []
const byId = new Map<string, Item>()

type Source = { path: string; size: Size | null; generation: number; pending?: true; ref?: string }

export function addItem(r: Source, label: string): Item {
  const id = r.ref ?? `${r.path}|${r.generation}`
  const hit = byId.get(id)
  if (hit) {
    if (hit.pending && !r.pending) settle(id, r)
    return hit
  }
  const item: Item = { id, n: list.length + 1, path: r.path, size: r.size, generation: r.generation, label, ...(r.pending ? { pending: true as const } : {}) }
  list.push(item)
  byId.set(id, item)
  return item
}

/** Once the raw file is converted to png, points the same number at the png. */
export function settle(id: string, r: { path: string; size: Size | null; generation: number }): void {
  const item = byId.get(id)
  if (!item?.pending) return
  item.path = r.path
  item.size = r.size
  item.generation = r.generation
  delete item.pending
}

export function items(): readonly Item[] {
  return list
}

export function resetRegistry(): void {
  list.length = 0
  byId.clear()
}
