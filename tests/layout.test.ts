import { describe, expect, test } from 'claude-code/testing'
import { FALLBACK, fitCells, isImagePath, parseImageRefs, pngSize } from '../hooks/layout'
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
  test('keeps aspect within height limit', async () => {
    expect(fitCells({ width: 3200, height: 1000 }, 40, 8, 6)).toEqual({ columns: 13, rows: 8 })
  })
  test('wide image is width-limited and keeps aspect', async () => {
    expect(fitCells({ width: 8000, height: 500 }, 40, 8, 6)).toEqual({ columns: 40, rows: 5 })
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
