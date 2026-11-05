export type Size = { width: number; height: number }
export type Cells = { columns: number; rows: number }

export const FALLBACK: Size = { width: 16, height: 10 }
// A terminal cell is about twice as tall as it is wide.
const CELL_ASPECT = 2
const MAX_CELLS = 255
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic)$/i
const MD_IMAGE = /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g

export function isImagePath(path: string): boolean {
  return IMAGE_EXT.test(path)
}

/** Absolute image paths a markdown text embeds, in order, without repeats. */
export function parseImageRefs(text: string, home: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(MD_IMAGE)) {
    let path = m[1] ?? m[2] ?? ''
    if (path.startsWith('file://')) {
      try {
        path = decodeURI(path.slice('file://'.length))
      } catch {
        continue
      }
    } else if (path.startsWith('~/')) path = home + path.slice(1)
    if (!path.startsWith('/') || !isImagePath(path) || out.includes(path)) continue
    out.push(path)
  }
  return out
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes aren't a PNG. */
export function pngSize(base64: string): Size | null {
  let head: Uint8Array
  try {
    head = Uint8Array.from(atob(base64.slice(0, 32)), ch => ch.charCodeAt(0))
  } catch {
    return null
  }
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (head.length < 24 || signature.some((byte, i) => head[i] !== byte)) return null
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** The largest box of cells within the limits that keeps the picture's shape. */
export function fitCells(size: Size | null, maxColumns: number, maxRows: number, minColumns = 1): Cells {
  const s = size && size.width > 0 && size.height > 0 ? size : FALLBACK
  const perRow = (s.width * CELL_ASPECT) / s.height
  const colCap = Math.max(1, Math.min(MAX_CELLS, maxColumns))
  const rowCap = Math.max(1, Math.min(MAX_CELLS, maxRows))
  let rows = rowCap
  let columns = Math.round(rows * perRow)
  if (columns > colCap) {
    columns = colCap
    rows = Math.round(columns / perRow)
  }
  columns = Math.min(colCap, Math.max(minColumns, columns, 1))
  rows = Math.min(rowCap, Math.max(1, rows))
  return { columns, rows }
}

export const ZOOM_LEVELS = [1, 2, 3, 4, 6, 8] as const

/** A rectangle of image pixels. */
export type Crop = { x: number; y: number; width: number; height: number }
/** What the viewer shows: a zoom level and the centre of the crop, in image pixels. */
export type View = { level: number; cx: number; cy: number }
export type ViewKey = 'in' | 'out' | 'fit' | 'toggle' | 'up' | 'down' | 'left' | 'right'

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

/**
 * The image pixels shown at a zoom level in a box of cells: the box's shape at
 * that many times the fit scale, centred on (cx, cy) and kept inside the image.
 */
export function cropAt(size: Size, box: Cells, level: number, cx: number, cy: number): Crop {
  const boxWidth = Math.max(1, box.columns)
  const boxHeight = Math.max(1, box.rows) * CELL_ASPECT
  // Box units (a cell's width) per image pixel when the whole image fits.
  const fit = Math.min(boxWidth / size.width, boxHeight / size.height)
  const width = clamp(Math.round(boxWidth / (fit * level)), 1, size.width)
  const height = clamp(Math.round(boxHeight / (fit * level)), 1, size.height)
  return {
    x: clamp(Math.round(cx - width / 2), 0, size.width - width),
    y: clamp(Math.round(cy - height / 2), 0, size.height - height),
    width,
    height,
  }
}

/** The deepest level whose crop still has at least one image pixel per cell, across and down. */
export function maxZoom(size: Size, box: Cells): number {
  let max: number = ZOOM_LEVELS[0]
  for (const level of ZOOM_LEVELS) {
    const c = cropAt(size, box, level, size.width / 2, size.height / 2)
    if (c.width < Math.min(size.width, box.columns) || c.height < Math.min(size.height, box.rows)) break
    max = level
  }
  return max
}

/** The view after a key: zoom in or out a level, fit, toggle 2x at the centre, or pan half the visible area. */
export function nextView(size: Size, box: Cells, view: View, key: ViewKey): View {
  const max = maxZoom(size, box)
  const level = Math.max(...ZOOM_LEVELS.filter(l => l <= Math.min(view.level, max)))
  const centred = (l: number): View => ({ level: l, cx: size.width / 2, cy: size.height / 2 })
  switch (key) {
    case 'fit':
      return centred(1)
    case 'toggle':
      return level > 1 ? centred(1) : max >= 2 ? centred(2) : view
    case 'in':
      return { ...view, level: ZOOM_LEVELS.find(l => l > level && l <= max) ?? level }
    case 'out':
      return { ...view, level: [...ZOOM_LEVELS].reverse().find(l => l < level) ?? 1 }
  }
  if (level <= 1) return view
  const now = cropAt(size, box, level, view.cx, view.cy)
  const dx = key === 'left' ? -1 : key === 'right' ? 1 : 0
  const dy = key === 'up' ? -1 : key === 'down' ? 1 : 0
  const moved = cropAt(size, box, level, now.x + now.width / 2 + (dx * now.width) / 2, now.y + now.height / 2 + (dy * now.height) / 2)
  return { level, cx: moved.x + moved.width / 2, cy: moved.y + moved.height / 2 }
}
