import { describe, expect, test } from 'claude-code/testing'
import { FALLBACK, cropAt, fitCells, isImagePath, maxZoom, nextView, parseImageRefs, pngSize, ZOOM_LEVELS } from '../hooks/layout'
import { pngB64 } from './fixtures'

describe('parseImageRefs', () => {
  test('absolute, ~ and file:// paths', async () => {
    const text = '![a](/x/a.png) ![b](~/b.jpg) ![c](file:///y/c%20d.webp)'
    expect(parseImageRefs(text, '/Users/u')).toEqual(['/x/a.png', '/Users/u/b.jpg', '/y/c d.webp'])
  })
  test('angle-bracket path with spaces and a title', async () => {
    expect(parseImageRefs('![x](</a b/c.png> "t")', '/h')).toEqual(['/a b/c.png'])
  })
  test('ignores http, relative and non-image paths, dedupes', async () => {
    const text = '![a](https://e.com/a.png) ![b](rel/b.png) ![c](/x/c.txt) ![d](/x/d.png) ![e](/x/d.png)'
    expect(parseImageRefs(text, '/h')).toEqual(['/x/d.png'])
  })
})

describe('pngSize', () => {
  test('reads IHDR', async () => {
    expect(pngSize(pngB64(1280, 720))).toEqual({ width: 1280, height: 720 })
  })
  test('null for non-png bytes', async () => {
    expect(pngSize(btoa('not a png at all, definitely not'))).toBe(null)
  })
})

describe('fitCells', () => {
  test('height-limited keeps aspect (cell is twice as tall as wide)', async () => {
    expect(fitCells({ width: 1600, height: 1000 }, 40, 8, 6)).toEqual({ columns: 26, rows: 8 })
  })
  test('wide image falls back to the width limit', async () => {
    expect(fitCells({ width: 3200, height: 1000 }, 40, 8, 6)).toEqual({ columns: 40, rows: 6 })
  })
  test('very wide image is width-limited down to one row', async () => {
    expect(fitCells({ width: 8000, height: 500 }, 40, 8, 6)).toEqual({ columns: 40, rows: 1 })
  })
  test('tall image respects minColumns', async () => {
    expect(fitCells({ width: 100, height: 2000 }, 40, 8, 6)).toEqual({ columns: 6, rows: 8 })
  })
  test('null size uses FALLBACK', async () => {
    expect(fitCells(null, 40, 8, 6)).toEqual(fitCells(FALLBACK, 40, 8, 6))
  })
  test('never exceeds 255', async () => {
    const c = fitCells({ width: 9000, height: 100 }, 400, 400)
    expect(c.columns <= 255 && c.rows <= 255 && c.rows >= 1).toBe(true)
  })
})

describe('robustness', () => {
  test('malformed percent escape skips the ref instead of throwing', async () => {
    expect(parseImageRefs('![x](file:///y/100%.png) ![y](/ok.png)', '/h')).toEqual(['/ok.png'])
  })
  test('zero-sized png falls back to the default shape', async () => {
    expect(fitCells({ width: 0, height: 0 }, 40, 8, 6)).toEqual(fitCells(FALLBACK, 40, 8, 6))
  })
})

describe('isImagePath', () => {
  test('extensions', async () => {
    expect(['/a.PNG', '/a.jpeg', '/a.heic', '/a.gif'].every(isImagePath)).toBe(true)
    expect(isImagePath('/a.svg')).toBe(false)
  })
})

describe('zoom by cropping', () => {
  // 1600x1000 in a 78x26 cell box: the fit scale is 78/1600 box units per pixel (width-limited).
  const BIG = { width: 1600, height: 1000 }
  const BOX = { columns: 78, rows: 26 }
  const centre = { level: 1, cx: 800, cy: 500 }
  const crop = (v: { level: number; cx: number; cy: number }) => cropAt(BIG, BOX, v.level, v.cx, v.cy)
  const press = (v: { level: number; cx: number; cy: number }, ...keys: Parameters<typeof nextView>[3][]) =>
    keys.reduce((acc, key) => nextView(BIG, BOX, acc, key), v)

  test('the levels', async () => {
    expect([...ZOOM_LEVELS]).toEqual([1, 2, 3, 4, 6, 8])
  })

  test('1x is the whole image wherever the centre is', async () => {
    expect(cropAt(BIG, BOX, 1, 800, 500)).toEqual({ x: 0, y: 0, width: 1600, height: 1000 })
    expect(cropAt(BIG, BOX, 1, 0, 0)).toEqual({ x: 0, y: 0, width: 1600, height: 1000 })
  })

  test('2x at the centre is the box shape at twice the scale, centred', async () => {
    // width 78 / (0.04875 * 2) = 800, height 52 / 0.0975 = 533.3
    expect(cropAt(BIG, BOX, 2, 800, 500)).toEqual({ x: 400, y: 234, width: 800, height: 533 })
  })

  test('a crop never leaves the image', async () => {
    expect(cropAt(BIG, BOX, 2, 0, 0)).toMatchObject({ x: 0, y: 0 })
    expect(cropAt(BIG, BOX, 2, 1600, 1000)).toMatchObject({ x: 800, y: 467 })
  })

  test('z toggles 2x at the centre and back to fit', async () => {
    const off = { level: 1, cx: 10, cy: 10 }
    expect(press(off, 'toggle')).toEqual({ level: 2, cx: 800, cy: 500 })
    expect(press(off, 'toggle', 'toggle')).toEqual({ level: 1, cx: 800, cy: 500 })
  })

  test('in and out walk the levels and stop at the ends', async () => {
    expect(press(centre, 'in').level).toBe(2)
    expect(press(centre, 'in', 'in', 'in', 'in', 'in', 'in', 'in').level).toBe(8)
    expect(press(centre, 'in', 'in', 'in', 'out').level).toBe(3)
    expect(press(centre, 'out').level).toBe(1)
  })

  test('0 fits and recentres', async () => {
    expect(press(centre, 'in', 'right', 'down', 'fit')).toEqual({ level: 1, cx: 800, cy: 500 })
  })

  test('a pan moves half the visible area', async () => {
    const at2 = press(centre, 'toggle')
    expect(crop(press(at2, 'left'))).toMatchObject({ x: 0 })
    expect(crop(press(at2, 'right'))).toMatchObject({ x: 800 })
    expect(crop(press(at2, 'up')).y).toBe(0)
  })

  test('a pan clamps at the edges and comes back in one step', async () => {
    const at2 = press(centre, 'toggle')
    const left = press(at2, 'left', 'left', 'left')
    expect(crop(left)).toMatchObject({ x: 0, width: 800 })
    expect(crop(press(left, 'right'))).toMatchObject({ x: 400 })
    const corner = press(at2, 'right', 'right', 'down', 'down', 'down')
    expect(crop(corner)).toEqual({ x: 800, y: 467, width: 800, height: 533 })
  })

  test('at 1x a pan does nothing', async () => {
    expect(press(centre, 'left', 'up')).toEqual(centre)
  })

  test('the deepest level keeps at least one image pixel per cell', async () => {
    expect(maxZoom(BIG, BOX)).toBe(8)
    // 400x250: the crop is 400/z pixels wide, so 6x (66 px) would fall under 78 columns.
    expect(maxZoom({ width: 400, height: 250 }, BOX)).toBe(4)
    expect(nextView({ width: 400, height: 250 }, BOX, { level: 4, cx: 200, cy: 125 }, 'in').level).toBe(4)
  })

  test('an image already smaller than the box does not zoom', async () => {
    const small = { width: 100, height: 100 }
    expect(maxZoom(small, BOX)).toBe(1)
    expect(nextView(small, BOX, { level: 1, cx: 50, cy: 50 }, 'toggle').level).toBe(1)
    expect(nextView(small, BOX, { level: 1, cx: 50, cy: 50 }, 'in').level).toBe(1)
  })
})
