import type { Size } from './layout'

export type ToolImage = { base64: string; mime: string }
export type Resolved = { path: string; size: Size | null; generation: number } | { error: string }

const cache = new Map<string, Promise<Resolved>>()

export function resetSourceCache(): void {
  cache.clear()
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
