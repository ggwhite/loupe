import type { EngineInterface } from 'claude-code'

import { pngSize } from './layout'
import type { Size } from './layout'

export type ToolImage = { base64: string; mime: string }
export type Resolved = { path: string; size: Size | null; generation: number } | { error: string }

const RUN_TIMEOUT_MS = 5000
const cache = new Map<string, Promise<Resolved>>()

export function resetSourceCache(): void {
  cache.clear()
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

async function cacheDir($: EngineInterface): Promise<string> {
  const tmp = (await $.env.get('TMPDIR'))?.replace(/\/+$/, '') || '/tmp'
  return `${tmp}/claude-gallery`
}

function hash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

async function run($: EngineInterface, argv: string[], stdin?: string): Promise<boolean> {
  const r = await $.process
    .run(argv, stdin === undefined ? { timeoutMs: RUN_TIMEOUT_MS } : { stdin, timeoutMs: RUN_TIMEOUT_MS })
    .catch(() => null)
  return r !== null && r.exitCode === 0
}

async function sizeOf($: EngineInterface, png: string): Promise<Size | null> {
  return $.fs.read(png, { as: 'bytes' }).then(
    ({ base64 }) => pngSize(base64),
    () => null, // over the read cap: still drawable, just without its aspect ratio
  )
}

async function toPng($: EngineInterface, src: string, generation: number): Promise<Resolved> {
  if (/\.png$/i.test(src)) return { path: src, size: await sizeOf($, src), generation }
  const dir = await cacheDir($)
  const out = `${dir}/${hash(`${src}|${generation}`)}.png`
  const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/sips -s format png "$2" --out "$3" >/dev/null', 'sh', dir, src, out])
  if (!ok) return { error: `轉檔失敗: ${src}` }
  return { path: out, size: await sizeOf($, out), generation }
}

export async function resolveFile($: EngineInterface, path: string): Promise<Resolved> {
  const stat = await $.fs.stat(path).catch(() => null)
  if (stat === null || stat.kind !== 'file') return { error: `找不到圖片: ${path}` }
  const generation = Math.floor(stat.mtimeMs)
  const key = `file|${path}|${generation}|${stat.size}`
  let hit = cache.get(key)
  if (!hit) {
    hit = toPng($, path, generation)
    cache.set(key, hit)
  }
  return hit
}

export async function resolveToolImage($: EngineInterface, key: string, image: ToolImage): Promise<Resolved> {
  const name = key.replace(/[^A-Za-z0-9_-]/g, '_')
  const cacheKey = `tool|${name}`
  let hit = cache.get(cacheKey)
  if (!hit) {
    hit = (async (): Promise<Resolved> => {
      const dir = await cacheDir($)
      const ext = (image.mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      const raw = `${dir}/${name}.${ext}`
      const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/base64 -D > "$2"', 'sh', dir, raw], image.base64)
      if (!ok) return { error: '圖片寫入失敗' }
      if (ext === 'png') return { path: raw, size: pngSize(image.base64), generation: 0 }
      return toPng($, raw, 0)
    })()
    cache.set(cacheKey, hit)
  }
  return hit
}
