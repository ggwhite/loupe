import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput, RenderViewport } from 'claude-code'

import type { Viewer } from '../types'
import { cropAt, fitCells, maxZoom, nextView, parseImageRefs, pngSize } from './layout'
import type { Crop, Size, View, ViewKey } from './layout'
import { addItem, items, resetRegistry, settle } from './registry'
import type { Item } from './registry'
import { cached, canonicalPath, clearSourceCache, clearedIds, clearing, groupMemo, hash, referenced, remember, resultMemo, toolImages, usedIds, written } from './source'
import type { Resolved, ToolImage } from './source'

export const PANE_ID = 'loupe'
const MAX_PER_MESSAGE = 8
const THUMB_ROWS = 8
const THUMB_MIN_COLUMNS = 6
const THUMB_MAX_COLUMNS = 40
const THUMB_INDENT = 2
const THUMB_RIGHT_MARGIN = 2
const GAP = 2
const PANE_PAD_X = 1
const PANE_PAD_Y = 0
const PANE_GAP = 1
const RUN_TIMEOUT_MS = 5000
const TITLE_ROWS = 1
const BUTTON_ROWS = 1
const HINT_ROWS = 1
// Narrower than this, the viewer leaves out its − and + buttons and their keys join the hint line.
const ZOOM_BUTTONS_MIN_COLUMNS = 40
const ZOOM_HINTS: [hotkey: string, label: string, key: ViewKey][] = [
  ['i', 'in', 'in'],
  ['o', 'out', 'out'],
]
// The key hint under the buttons: each a plain Button, since a hotkey needs one drawn.
const HINTS: [hotkey: string, label: string, key: ViewKey][] = [
  ['0', 'fit', 'fit'],
  ['z', '2×', 'toggle'],
  ['w', '↑', 'up'],
  ['a', '←', 'left'],
  ['s', '↓', 'down'],
  ['d', '→', 'right'],
]
const ROW_THUMBS = 3
const ROW_THUMB_COLUMNS = 8
const ROW_THUMB_ROWS = 2
const ROW_THUMB_MIN_COLUMNS = 2
const ROW_GAP = 1
const STRIP_INDENT = 5
const SINGLE_MAX_COLUMNS = 80
const SINGLE_MAX_ROWS = 20
const VIEWER_MIN_ROWS = 12
const FALLBACK_VIEWPORT = { columns: 100, rows: 40 }
const LATEST = -1
const HOUR_MS = 60 * 60 * 1000
const CHUNK = 100
const WRITE_EXTENSIONS = ['png', 'jpg', 'gif', 'webp', 'heic', 'bmp', 'tiff', 'svg', 'ico', 'img']

export const viewer = atom({ plugin: 'loupe', key: 'viewer' } as const, { index: 0 } as Viewer)

type Found = { r: Resolved; label: string }
type Site = RenderInput<'AssistantMessage' | 'ToolResult' | 'ToolGroup', 'terminal'>
type Viewport = { columns: number; rows?: number }

async function cacheDir($: EngineInterface): Promise<string> {
  const tmp = (await $.env.get('TMPDIR').catch(() => undefined))?.replace(/\/+$/, '') || '/tmp'
  return `${tmp}/claude-loupe`
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
  written.add(out)
  const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/sips -s format png "$2" --out "$3" >/dev/null', 'sh', dir, src, out])
  written.add(out)
  if (!ok) return { error: `conversion failed: ${src}` }
  return { path: out, size: await sizeOf($, out), generation }
}

/** Crops a png to those pixels with sips into the cache dir, once per image and crop. */
async function cropTo($: EngineInterface, item: Item, c: Crop): Promise<Resolved> {
  const key = `crop|${item.id}|${item.generation}|${c.x},${c.y},${c.width},${c.height}`
  return (
    cached(key) ??
    remember(
      key,
      (async (): Promise<Resolved> => {
        const dir = await cacheDir($)
        const out = `${dir}/crop-${hash(key)}.png`
        written.add(out)
        const argv = [String(c.height), String(c.width), String(c.y), String(c.x), item.path, out]
        const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/sips -c "$2" "$3" --cropOffset "$4" "$5" "$6" --out "$7" >/dev/null', 'sh', dir, ...argv])
        written.add(out)
        if (!ok) return { error: `crop failed: ${basename(item.label)}` }
        return { path: out, size: { width: c.width, height: c.height }, generation: item.generation }
      })(),
    )
  )
}

export async function resolveFile($: EngineInterface, path: string): Promise<Resolved> {
  const stat = await $.fs.stat(path, { resolve: true }).catch(() => null)
  if (stat === null || stat.kind !== 'file') return { error: `image not found: ${path}` }
  const generation = Math.floor(stat.mtimeMs)
  const key = `file|${path}|${generation}|${stat.size}`
  return cached(key) ?? remember(key, toPng($, path, generation), true)
}

/** Converts an image written only as its raw file to png, once per file; its number then points at the png. */
export async function convertPending($: EngineInterface, raw: string, id: string): Promise<Resolved> {
  const r = await (cached(`lazy|${raw}`) ?? remember(`lazy|${raw}`, toPng($, raw, 0)))
  if (!('error' in r)) settle(id, r)
  return r
}

export async function resolveToolImage($: EngineInterface, key: string, image: ToolImage, lazy = false): Promise<Resolved> {
  const name = key.replace(/[^A-Za-z0-9_-]/g, '_')
  const cacheKey = `tool|${name}`
  const hit = cached(cacheKey)
  if (hit) {
    const r = await hit
    if (lazy || !('pending' in r) || !r.pending) return r
    return convertPending($, r.path, cacheKey).then(done => ('error' in done ? done : { ...done, ref: cacheKey }))
  }
  return remember(
    cacheKey,
    (async (): Promise<Resolved> => {
      const dir = await cacheDir($)
      const subtype = (image.mime.split('/')[1] ?? 'png').split(/[+;]/)[0]?.toLowerCase().replace('jpeg', 'jpg') ?? 'png'
      const ext = WRITE_EXTENSIONS.includes(subtype) ? subtype : 'img'
      const size = ext === 'png' ? pngSize(image.base64) : null
      const raw = `${dir}/${name}.${ext === 'png' && size === null ? 'img' : ext}`
      written.add(raw)
      const ok = await run($, ['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/base64 -D > "$2"', 'sh', dir, raw], image.base64)
      written.add(raw)
      if (!ok) return { error: 'image write failed' }
      if (size !== null) return { path: raw, size, generation: 0, ref: cacheKey }
      if (lazy) return { path: raw, size: null, generation: 0, pending: true, ref: cacheKey }
      const png = await toPng($, raw, 0)
      return 'error' in png ? png : { ...png, ref: cacheKey }
    })(),
  )
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The herdr pane this mod zoomed, to zoom back off on close; undefined while it zoomed none. */
let herdrZoomed: string | undefined

/** Inside herdr, zooms the session's pane to fill the window, unless it is zoomed already. */
export async function herdrZoomOn($: EngineInterface): Promise<void> {
  if (herdrZoomed !== undefined) return
  const inside = await $.env.get('HERDR_ENV').catch(() => undefined)
  const pane = await $.env.get('HERDR_PANE_ID').catch(() => undefined)
  if (inside !== '1' || !pane) return
  const r = await $.process.run(['herdr', 'pane', 'layout', '--pane', pane], { timeoutMs: RUN_TIMEOUT_MS }).catch(() => null)
  if (r === null || r.exitCode !== 0) return
  let zoomed: unknown
  try {
    zoomed = (JSON.parse(r.stdout) as { result?: { layout?: { zoomed?: unknown } } }).result?.layout?.zoomed
  } catch {
    return
  }
  if (zoomed !== false) return
  if (await run($, ['herdr', 'pane', 'zoom', '--pane', pane, '--on'])) herdrZoomed = pane
}

async function herdrZoomOff($: EngineInterface): Promise<void> {
  const pane = herdrZoomed
  if (pane === undefined) return
  herdrZoomed = undefined
  await run($, ['herdr', 'pane', 'zoom', '--pane', pane, '--off'])
}

export async function openViewer($: EngineInterface, index: number, viewport: Viewport | undefined): Promise<boolean> {
  try {
    // The whole terminal: the engine trims both to what its layout can spare.
    const columns = viewport?.columns ?? FALLBACK_VIEWPORT.columns
    const rows = Math.max(VIEWER_MIN_ROWS, viewport?.rows ?? FALLBACK_VIEWPORT.rows)
    // Opened before any await, so it counts as answering the press and is placed at any width.
    const placed = $.ui.open({ id: PANE_ID, title: 'Loupe', focus: true, closeOnEscape: true, rows, columns }).then(
      () => true,
      () => false,
    )
    await update($, viewer, () => ({ index }))
    const isPlaced = await placed
    if (isPlaced) await herdrZoomOn($)
    return isPlaced
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
  } catch {
    return
  }
  // A plugin's own $.ui.close runs only the hooks beneath it, not its own ui.close hook.
  await herdrZoomOff($)
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
            {`⤢ view #${single.n}`}
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
                {`⤢ view #${t.item.n}`}
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

const PRUNE_AFTER_MINUTES = 24 * 60

export function pruneArgv(dir: string): string[] {
  const names = WRITE_EXTENSIONS.flatMap((ext, i) => (i === 0 ? ['-iname', `*.${ext}`] : ['-o', '-iname', `*.${ext}`]))
  return ['/usr/bin/find', dir, '-maxdepth', '1', '-type', 'f', '-mmin', `+${PRUNE_AFTER_MINUTES}`, '(', ...names, ')', '-delete']
}

/** Runs the argv prefix over this session's own files inside the cache dir, in chunks. */
async function onWritten($: EngineInterface, prefix: string[], paths: string[]): Promise<void> {
  const dir = await cacheDir($)
  const own = paths.filter(p => p.startsWith(`${dir}/`))
  for (let i = 0; i < own.length; i += CHUNK) await run($, [...prefix, ...own.slice(i, i + CHUNK)])
}

async function clearSession($: EngineInterface): Promise<number> {
  clearing.generation++
  const count = items().length
  const all = [...written]
  const spared = all.filter(p => referenced.get(canonicalPath(p)))
  const paths = all.filter(p => !spared.includes(p))
  const ids = usedIds.keys()
  resetRegistry()
  clearSourceCache()
  for (const p of spared) written.add(p)
  for (const id of ids) clearedIds.set(id, true)
  await update($, viewer, v => ({ index: LATEST, epoch: (v.epoch ?? 0) + 1 })).catch(() => undefined)
  await onWritten($, ['/bin/rm', '-f', '--'], paths)
  return count
}

let refresh: { cancel: () => void } | undefined

const allResolved = (found: Found[]): boolean => found.every(f => !('error' in f.r))

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void cacheDir($).then(dir => run($, pruneArgv(dir)))
    refresh?.cancel()
    try {
      refresh = $.clock.every(HOUR_MS, () => void onWritten($, ['/usr/bin/touch', '-c', '--'], [...written]))
    } catch {}
    try {
      await $.command.register({ name: 'loupe', description: 'Open the image viewer at the newest image; `clear` drops the images of this session', immediate: true })
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

  on('command.run', { command: 'loupe' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      const count = await clearSession($)
      return { text: count === 0 ? 'no images yet' : `cleared ${count} ${count === 1 ? 'image' : 'images'}` }
    }
    const count = items().length
    if (!(await openViewer($, LATEST, { columns: e.presentation.columns }))) return { text: '[could not open the viewer]' }
    return { text: count === 0 ? 'no images yet' : `Loupe: ${count} ${count === 1 ? 'image' : 'images'}` }
  })

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      const images = toolImages(r.result).slice(0, MAX_PER_MESSAGE)
      if (images.length === 0) return r
      const input = e as { file_path?: unknown }
      const label = typeof input.file_path === 'string' ? input.file_path : e.tool
      usedIds.set(e.tool_use_id, true)
      const lazy = e.agentId !== undefined
      const generation = clearing.generation
      const found = await Promise.all(images.map(async (img, i) => ({ r: await resolveToolImage($, `${e.tool_use_id}-${i}`, img, lazy), label })))
      if (generation === clearing.generation) collect(found)
    } catch {}
    return r
  })

  // Escape (closeOnEscape) and any close not made by this mod's own x button.
  on('ui.close', { id: PANE_ID }, async ($, e, next) => {
    const r = await next(e)
    await herdrZoomOff($)
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const { Box, Button, Image, Text } = $.ui.resolve(e)
    const { index, zoom } = await read($, viewer).catch((): Viewer => ({ index: LATEST }))
    const list = items()
    if (list.length === 0) return <Text dimColor>no images yet</Text>
    const i = index === LATEST ? list.length - 1 : Math.max(0, Math.min(list.length - 1, index))
    const item = list[i] as Item
    const failure = item.pending ? await convertPending($, item.path, item.id).then(r => ('error' in r ? r.error : null)) : null
    const alive = await $.fs.exists(item.path).catch(() => false)
    const box = {
      columns: Math.max(1, e.props.bodyColumns - PANE_PAD_X * 2),
      rows: Math.max(1, e.props.scroll.bodyRows - PANE_PAD_Y * 2 - TITLE_ROWS - BUTTON_ROWS - HINT_ROWS - PANE_GAP * 2),
    }
    // A zoom belongs to one image: another one (h, l, a new newest) starts at fit.
    const size = item.size
    const view: View | undefined = size ? (zoom?.id === item.id ? zoom : { level: 1, cx: size.width / 2, cy: size.height / 2 }) : undefined
    const level = size && view ? Math.min(view.level, maxZoom(size, box)) : 1
    const crop = size && view && level > 1 ? cropAt(size, box, level, view.cx, view.cy) : null
    const shown: Resolved =
      failure === null && alive && crop ? await cropTo($, item, crop) : { path: item.path, size: item.size, generation: item.generation }
    const cells = fitCells('error' in shown ? null : shown.size, box.columns, box.rows)
    const wide = e.props.bodyColumns >= ZOOM_BUTTONS_MIN_COLUMNS
    const press = (key: ViewKey) => () => {
      if (!size || !view) return
      void update($, viewer, v => ({ ...v, zoom: { id: item.id, ...nextView(size, box, v.zoom?.id === item.id ? v.zoom : view, key) } })).catch(() => undefined)
    }
    return (
      <Box flexDirection="column" alignItems="center" paddingX={PANE_PAD_X} paddingY={PANE_PAD_Y} rowGap={PANE_GAP}>
        <Text>
          <Text bold>{`${i + 1} of ${list.length}`}</Text>
          <Text dimColor>{` · ${level}× · ${basename(item.label)}`}</Text>
        </Text>
        {failure !== null ? (
          <Text dimColor>{`[${failure}]`}</Text>
        ) : !alive ? (
          <Text dimColor>[file deleted]</Text>
        ) : 'error' in shown ? (
          <Text dimColor>{`[${shown.error}]`}</Text>
        ) : (
          <Image
            key={`view-${shown.path}`}
            source={{ file: shown.path, format: 'png', generation: shown.generation }}
            columns={cells.columns}
            rows={cells.rows}
            alt={`[#${item.n} ${basename(item.label)}]`}
          />
        )}
        <Box flexDirection="column" alignItems="center">
          <Box flexDirection="row" columnGap={2}>
            <Button hotkey="h" onPress={() => void step($, -1)}>‹</Button>
            <Button hotkey="l" onPress={() => void step($, 1)}>›</Button>
            {wide && (
              <Button hotkey="o" onPress={press('out')}>
                −
              </Button>
            )}
            {wide && (
              <Button hotkey="i" onPress={press('in')}>
                +
              </Button>
            )}
            <Button hotkey="x" onPress={() => void close($)}>✕</Button>
          </Box>
          <Box flexDirection="row" columnGap={1}>
            {(wide ? HINTS : [...ZOOM_HINTS, ...HINTS]).map(([hotkey, label, key]) => (
              <Button key={`hint-${hotkey}`} plain dimColor hotkey={hotkey} onPress={press(key)}>
                {label}
              </Button>
            ))}
          </Box>
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
    for (const path of refs) referenced.set(canonicalPath(path), true)
    const found = await Promise.all(refs.map(async path => ({ r: await resolveFile($, path), label: path })))
    return drawThumbs($, e, found, await next(e))
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const id = e.props.tool_use_id
    if (clearedIds.get(id)) return next(e)
    const memo = resultMemo.get(id) as Found[] | undefined
    if (memo) return memo.length === 0 ? next(e) : drawRow($, e, memo, await next(e))
    const output = e.props.output
    if (output === null || typeof output !== 'object') return next(e)
    const images = toolImages(output).slice(0, MAX_PER_MESSAGE)
    if (images.length === 0) {
      resultMemo.set(id, [])
      return next(e)
    }
    usedIds.set(id, true)
    const generation = clearing.generation
    const found = await Promise.all(
      images.map(async (img, i) => ({ r: await resolveToolImage($, `${id}-${i}`, img), label: `${e.props.tool} ${i + 1}` })),
    )
    if (generation !== clearing.generation) return next(e)
    if (allResolved(found)) resultMemo.set(id, found)
    return drawRow($, e, found, await next(e))
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    const parts: Promise<Found[]>[] = []
    const generation = clearing.generation
    let room = MAX_PER_MESSAGE
    e.props.calls.forEach((call, ci) => {
      if (room <= 0) return
      const id = call.tool_use_id ?? `${e.requestId}-${ci}`
      if (clearedIds.get(id)) return
      const memo = groupMemo.get(id) as Found[] | undefined
      if (memo) {
        const part = memo.slice(0, room)
        room -= part.length
        if (part.length > 0) parts.push(Promise.resolve(part))
        return
      }
      const input = call.input as { file_path?: unknown } | null
      const label = typeof input?.file_path === 'string' ? input.file_path : call.tool
      const all = toolImages(call.output)
      const images = all.slice(0, room)
      room -= images.length
      if (images.length > 0) usedIds.set(id, true)
      const part = Promise.all(images.map((img, i) => resolveToolImage($, `${id}-${i}`, img).then(r => ({ r, label }))))
      if (!call.isRunning && call.output !== undefined) {
        void part.then(found => {
          if (generation === clearing.generation && all.length === images.length && allResolved(found)) groupMemo.set(id, found)
        })
      }
      if (images.length > 0) parts.push(part)
    })
    if (parts.length === 0) return next(e)
    const found = (await Promise.all(parts)).flat()
    if (generation !== clearing.generation) return next(e)
    return drawRow($, e, found, await next(e))
  })
}
