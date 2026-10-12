import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type { Viewer } from '../types'
import { fitCells, parseImageRefs, pngSize } from './layout'
import type { Size } from './layout'
import { addItem, items } from './registry'
import type { Item } from './registry'
import { cached, hash, remember, toolImages } from './source'
import type { Resolved, ToolImage } from './source'

export const PANE_ID = 'gallery'
const MAX_PER_MESSAGE = 8
const THUMB_ROWS = 8
const THUMB_MIN_COLUMNS = 6
const THUMB_MAX_COLUMNS = 40
const MARGIN = 4
const GAP = 1
const RUN_TIMEOUT_MS = 5000
const TITLE_ROWS = 1
const BUTTON_ROWS = 1

export const viewer = atom({ plugin: 'gallery', key: 'viewer' } as const, { index: 0 } as Viewer)

type Found = { r: Resolved; label: string }
type Site = RenderInput<'AssistantMessage' | 'ToolResult' | 'ToolGroup', 'terminal'>

async function cacheDir($: EngineInterface): Promise<string> {
  const tmp = (await $.env.get('TMPDIR').catch(() => undefined))?.replace(/\/+$/, '') || '/tmp'
  return `${tmp}/claude-gallery`
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
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (stat === null || stat.kind !== 'file') return { error: `找不到圖片: ${path}` }
  const generation = Math.floor(stat.mtimeMs)
  const key = `file|${path}|${generation}|${stat.size}`
  return cached(key) ?? remember(key, toPng($, path, generation), true)
}

export async function resolveToolImage($: EngineInterface, key: string, image: ToolImage): Promise<Resolved> {
  const name = key.replace(/[^A-Za-z0-9_-]/g, '_')
  const cacheKey = `tool|${name}`
  const hit = cached(cacheKey)
  if (hit) return hit
  return remember(
    cacheKey,
    (async (): Promise<Resolved> => {
      const dir = await cacheDir($)
      const ext = (image.mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
      const size = ext === 'png' ? pngSize(image.base64) : null
      const raw = `${dir}/${name}.${ext === 'png' && size === null ? 'img' : ext}`
      const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/base64 -D > "$2"', 'sh', dir, raw], image.base64)
      if (!ok) return { error: '圖片寫入失敗' }
      if (size !== null) return { path: raw, size, generation: 0 }
      return toPng($, raw, 0)
    })(),
  )
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export async function openViewer($: EngineInterface, index: number): Promise<boolean> {
  try {
    // Opened before any await, so it counts as answering the press and is placed at any width.
    const opened = $.ui.open({ id: PANE_ID, title: '圖片檢視', focus: true, closeOnEscape: true, rows: 30 })
    await update($, viewer, () => ({ index }))
    await opened
    return true
  } catch {
    return false
  }
}

async function step($: EngineInterface, delta: -1 | 1): Promise<void> {
  const last = items().length - 1
  try {
    await update($, viewer, v => ({ index: Math.max(0, Math.min(last, v.index + delta)) }))
  } catch {}
}

function drawThumbs($: EngineInterface, e: Site, found: Found[], below: RenderElement) {
  const { Box, Button, Image, Text } = $.ui.resolve(e)
  const room = Math.max(THUMB_MIN_COLUMNS, (e.viewport?.columns ?? 80) - MARGIN)
  const tiles: { item: Item; columns: number; rows: number }[] = []
  const errors: string[] = []
  for (const { r, label } of found) {
    if ('error' in r) {
      errors.push(r.error)
      continue
    }
    const item = addItem(r, label)
    const cells = fitCells(r.size, Math.min(THUMB_MAX_COLUMNS, room), THUMB_ROWS, THUMB_MIN_COLUMNS)
    tiles.push({ item, ...cells })
  }
  const rows: (typeof tiles)[] = []
  let width = 0
  for (const t of tiles) {
    const w = t.columns + (rows.at(-1)?.length ? GAP : 0)
    if (rows.length === 0 || width + w > room) {
      rows.push([t])
      width = t.columns
    } else {
      rows.at(-1)?.push(t)
      width += w
    }
  }
  return (
    <Box flexDirection="column">
      {below}
      {rows.map((row, i) => (
        <Box key={`row-${i}`} flexDirection="row" columnGap={GAP}>
          {row.map(t => (
            <Box key={`tile-${t.item.n}`} flexDirection="column" alignItems="center">
              <Image
                key={`img-${t.item.n}`}
                source={{ file: t.item.path, format: 'png', generation: t.item.generation }}
                columns={t.columns}
                rows={t.rows}
                alt={`[#${t.item.n} ${basename(t.item.label)}]`}
              />
              <Button key={`zoom-${t.item.n}`} plain dimColor onPress={() => void openViewer($, t.item.n - 1)}>
                {`#${t.item.n} 放大`}
              </Button>
            </Box>
          ))}
        </Box>
      ))}
      {errors.map((msg, i) => (
        <Text key={`error-${i}`} dimColor>{`[${msg}]`}</Text>
      ))}
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'gallery', description: '開啟圖片檢視區，從最新一張開始', immediate: true })
    } catch {}
    return next(e)
  })

  on('command.run', { command: 'gallery' }, async $ => {
    const count = items().length
    if (!(await openViewer($, Math.max(0, count - 1)))) return { text: '[無法開啟檢視區]' }
    return { text: count === 0 ? '還沒有圖片' : `圖片檢視：${count} 張` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const list = items()
    if (list.length === 0) return <Text dimColor>還沒有圖片</Text>
    const { index } = await read($, viewer).catch(() => ({ index: list.length - 1 }))
    const i = Math.max(0, Math.min(list.length - 1, index))
    const item = list[i] as Item
    const alive = await $.fs.exists(item.path).catch(() => false)
    const cells = fitCells(item.size, e.props.bodyColumns, Math.max(1, e.props.scroll.bodyRows - TITLE_ROWS - BUTTON_ROWS))
    return (
      <Box flexDirection="column" alignItems="center">
        <Text>
          {`${i + 1}/${list.length}  `}
          <Text dimColor>{basename(item.label)}</Text>
        </Text>
        {alive ? (
          <Image
            key="view"
            source={{ file: item.path, format: 'png', generation: item.generation }}
            columns={cells.columns}
            rows={cells.rows}
            alt={`[#${item.n} ${basename(item.label)}]`}
          />
        ) : (
          <Text dimColor>[檔案已刪除]</Text>
        )}
        <Box flexDirection="row" columnGap={2}>
          <Button hotkey="h" onPress={() => void step($, -1)}>◀ 上一張</Button>
          <Button hotkey="l" onPress={() => void step($, 1)}>下一張 ▶</Button>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (!e.props.text.includes('![')) return next(e)
    const home = (await $.env.get('HOME').catch(() => undefined)) ?? ''
    const refs = parseImageRefs(e.props.text, home).slice(0, MAX_PER_MESSAGE)
    if (refs.length === 0) return next(e)
    const found = await Promise.all(refs.map(async path => ({ r: await resolveFile($, path), label: path })))
    return drawThumbs($, e, found, await next(e))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const images = toolImages(e.props.output).slice(0, MAX_PER_MESSAGE)
    if (images.length === 0) return next(e)
    const found = await Promise.all(
      images.map(async (img, i) => ({ r: await resolveToolImage($, `${e.props.tool_use_id}-${i}`, img), label: `${e.props.tool} ${i + 1}` })),
    )
    return drawThumbs($, e, found, await next(e))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const jobs: Promise<Found>[] = []
    e.props.calls.forEach((call, ci) => {
      const input = call.input as { file_path?: unknown } | null
      const label = typeof input?.file_path === 'string' ? input.file_path : call.tool
      toolImages(call.output).forEach((img, i) => {
        if (jobs.length >= MAX_PER_MESSAGE) return
        jobs.push(resolveToolImage($, `${call.tool_use_id ?? `${e.requestId}-${ci}`}-${i}`, img).then(r => ({ r, label })))
      })
    })
    if (jobs.length === 0) return next(e)
    return drawThumbs($, e, await Promise.all(jobs), await next(e))
  })
}
