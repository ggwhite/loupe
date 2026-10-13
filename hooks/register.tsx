import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderViewport } from 'claude-code'

import type { Viewer } from '../types'
import { fitCells, parseImageRefs, pngSize } from './layout'
import type { Size } from './layout'
import { addItem, items, resetRegistry } from './registry'
import type { Item } from './registry'
import { cached, hash, remember, toolImages } from './source'
import type { Resolved, ToolImage } from './source'

export const PANE_ID = 'gallery'
const MAX_PER_MESSAGE = 8
const THUMB_ROWS = 8
const THUMB_MIN_COLUMNS = 6
const THUMB_MAX_COLUMNS = 40
const THUMB_INDENT = 2
const THUMB_RIGHT_MARGIN = 2
const GAP = 2
const PANE_PAD_X = 2
const PANE_PAD_Y = 1
const PANE_GAP = 1
const RUN_TIMEOUT_MS = 5000
const TITLE_ROWS = 1
const BUTTON_ROWS = 1
const ROW_THUMBS = 3
const ROW_THUMB_COLUMNS = 8
const ROW_THUMB_ROWS = 2
const ROW_THUMB_MIN_COLUMNS = 2
const ROW_GAP = 1
const STRIP_INDENT = 5
const SINGLE_MAX_COLUMNS = 80
const SINGLE_MAX_ROWS = 20
const VIEWER_MIN_ROWS = 12
const VIEWER_ROW_MARGIN = 8
const VIEWER_WIDTH = 0.7
const FALLBACK_VIEWPORT = { columns: 100, rows: 40 }
const LATEST = -1

export const viewer = atom({ plugin: 'gallery', key: 'viewer' } as const, { index: 0 } as Viewer)

type Found = { r: Resolved; label: string }
type Site = RenderInput<'AssistantMessage' | 'ToolResult' | 'ToolGroup', 'terminal'>
type Viewport = { columns: number; rows?: number }

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

export async function openViewer($: EngineInterface, index: number, viewport: Viewport | undefined): Promise<boolean> {
  try {
    const columns = Math.round((viewport?.columns ?? FALLBACK_VIEWPORT.columns) * VIEWER_WIDTH)
    const rows = Math.max(VIEWER_MIN_ROWS, (viewport?.rows ?? FALLBACK_VIEWPORT.rows) - VIEWER_ROW_MARGIN)
    // Opened before any await, so it counts as answering the press and is placed at any width.
    const placed = $.ui.open({ id: PANE_ID, title: '圖片檢視', focus: true, closeOnEscape: true, rows, columns }).then(
      () => true,
      () => false,
    )
    await update($, viewer, () => ({ index }))
    return await placed
  } catch {
    return false
  }
}

async function step($: EngineInterface, delta: -1 | 1): Promise<void> {
  const last = items().length - 1
  try {
    await update($, viewer, v => ({ index: Math.max(0, Math.min(last, (v.index === LATEST ? last : v.index) + delta)) }))
  } catch {}
}

async function close($: EngineInterface): Promise<void> {
  try {
    await $.ui.close({ id: PANE_ID })
  } catch {}
}

function collect(found: Found[]): { added: Item[]; errors: string[] } {
  const added: Item[] = []
  const errors: string[] = []
  for (const { r, label } of found) {
    if ('error' in r) errors.push(r.error)
    else added.push(addItem(r, label))
  }
  return { added, errors }
}

function source(item: Item) {
  return { file: item.path, format: 'png' as const, generation: item.generation }
}

function drawRow($: EngineInterface, e: Site, found: Found[], row: RenderElement) {
  const { Box, Button, Image, Text } = $.ui.resolve(e)
  const viewport: RenderViewport | undefined = e.viewport
  const { added, errors } = collect(found)
  const first = added[0]
  return (
    <Box flexDirection="column">
      {row}
      {first && (
        <Box flexDirection="row" paddingLeft={STRIP_INDENT} columnGap={ROW_GAP}>
          {added.slice(0, ROW_THUMBS).map(item => (
            <Image
              key={`img-${item.n}`}
              source={source(item)}
              {...fitCells(item.size, ROW_THUMB_COLUMNS, ROW_THUMB_ROWS, ROW_THUMB_MIN_COLUMNS)}
              alt={`[#${item.n} ${basename(item.label)}]`}
            />
          ))}
          <Box flexDirection="column" height={ROW_THUMB_ROWS} justifyContent="flex-end">
            <Box flexDirection="row" columnGap={ROW_GAP}>
              {added.length > ROW_THUMBS && <Text dimColor>{`+${added.length - ROW_THUMBS}`}</Text>}
              <Button key={`open-${first.n}`} plain dimColor onPress={() => void openViewer($, first.n - 1, viewport)}>
                {'⤢ '}
              </Button>
            </Box>
          </Box>
        </Box>
      )}
      {errors.length > 0 && (
        <Box flexDirection="column" paddingLeft={STRIP_INDENT}>
          {errors.map((msg, i) => (
            <Text key={`error-${i}`} dimColor>{`[${msg}]`}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function drawThumbs($: EngineInterface, e: Site, found: Found[], below: RenderElement) {
  const { Box, Button, Image, Text } = $.ui.resolve(e)
  const viewport: RenderViewport | undefined = e.viewport
  const columns = viewport?.columns ?? 80
  const room = Math.max(THUMB_MIN_COLUMNS, columns - THUMB_INDENT - THUMB_RIGHT_MARGIN)
  const { added, errors } = collect(found)
  const single = found.length === 1 ? added[0] : undefined
  if (single) {
    const cells = fitCells(single.size, Math.min(SINGLE_MAX_COLUMNS, columns - THUMB_INDENT * 2), SINGLE_MAX_ROWS, THUMB_MIN_COLUMNS)
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="column" alignItems="flex-start" marginTop={1} paddingLeft={THUMB_INDENT}>
          <Image key={`img-${single.n}`} source={source(single)} {...cells} alt={`[#${single.n} ${basename(single.label)}]`} />
          <Button key={`zoom-${single.n}`} plain dimColor onPress={() => void openViewer($, single.n - 1, viewport)}>
            {`⤢ #${single.n}`}
          </Button>
        </Box>
      </Box>
    )
  }
  const tiles = added.map(item => ({ item, ...fitCells(item.size, Math.min(THUMB_MAX_COLUMNS, room), THUMB_ROWS, THUMB_MIN_COLUMNS) }))
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
      <Box flexDirection="column" marginTop={1} paddingLeft={THUMB_INDENT}>
      {rows.map((row, i) => (
        <Box key={`row-${i}`} flexDirection="row" columnGap={GAP}>
          {row.map(t => (
            <Box key={`tile-${t.item.n}`} flexDirection="column" alignItems="center">
              <Image
                key={`img-${t.item.n}`}
                source={source(t.item)}
                columns={t.columns}
                rows={t.rows}
                alt={`[#${t.item.n} ${basename(t.item.label)}]`}
              />
              <Button key={`zoom-${t.item.n}`} plain dimColor onPress={() => void openViewer($, t.item.n - 1, viewport)}>
                {`⤢ #${t.item.n}`}
              </Button>
            </Box>
          ))}
        </Box>
      ))}
      {errors.map((msg, i) => (
        <Text key={`error-${i}`} dimColor>{`[${msg}]`}</Text>
      ))}
      </Box>
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

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'startup' || e.source === 'clear' || e.source === 'resume') {
      resetRegistry()
      await update($, viewer, () => ({ index: LATEST })).catch(() => undefined)
    }
    return next(e)
  })

  on('command.run', { command: 'gallery' }, async ($, e) => {
    const count = items().length
    if (!(await openViewer($, LATEST, { columns: e.presentation.columns }))) return { text: '[無法開啟檢視區]' }
    return { text: count === 0 ? '還沒有圖片' : `圖片檢視：${count} 張` }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      const images = toolImages(r.result).slice(0, MAX_PER_MESSAGE)
      if (images.length === 0) return r
      const input = e as { file_path?: unknown }
      const label = typeof input.file_path === 'string' ? input.file_path : e.tool
      collect(await Promise.all(images.map(async (img, i) => ({ r: await resolveToolImage($, `${e.tool_use_id}-${i}`, img), label }))))
    } catch {}
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const list = items()
    if (list.length === 0) return <Text dimColor>還沒有圖片</Text>
    const { index } = await read($, viewer).catch(() => ({ index: LATEST }))
    const i = index === LATEST ? list.length - 1 : Math.max(0, Math.min(list.length - 1, index))
    const item = list[i] as Item
    const alive = await $.fs.exists(item.path).catch(() => false)
    const cells = fitCells(
      item.size,
      Math.max(1, e.props.bodyColumns - PANE_PAD_X * 2),
      Math.max(1, e.props.scroll.bodyRows - PANE_PAD_Y * 2 - TITLE_ROWS - BUTTON_ROWS - PANE_GAP * 2),
    )
    return (
      <Box flexDirection="column" alignItems="center" paddingX={PANE_PAD_X} paddingY={PANE_PAD_Y} rowGap={PANE_GAP}>
        <Text>
          <Text bold>{`${i + 1} of ${list.length}`}</Text>
          {'  '}
          <Text dimColor>{basename(item.label)}</Text>
        </Text>
        {alive ? (
          <Image
            key="view"
            source={source(item)}
            columns={cells.columns}
            rows={cells.rows}
            alt={`[#${item.n} ${basename(item.label)}]`}
          />
        ) : (
          <Text dimColor>[檔案已刪除]</Text>
        )}
        <Box flexDirection="row" columnGap={2}>
          <Button hotkey="h" onPress={() => void step($, -1)}>‹</Button>
          <Button hotkey="l" onPress={() => void step($, 1)}>›</Button>
          <Button hotkey="x" onPress={() => void close($)}>✕</Button>
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
    return drawRow($, e, found, await next(e))
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
    return drawRow($, e, await Promise.all(jobs), await next(e))
  })
}
