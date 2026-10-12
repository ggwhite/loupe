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
    if (path.startsWith('file://')) path = decodeURI(path.slice('file://'.length))
    else if (path.startsWith('~/')) path = home + path.slice(1)
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
  const perRow = s.width / (s.height * CELL_ASPECT)
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
