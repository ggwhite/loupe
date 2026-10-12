import { describe, expect, test } from 'claude-code/testing'
import { resolveFile, resolveToolImage } from '../hooks/register'
import { resetSourceCache, toolImages } from '../hooks/source'
import { io, pngB64 } from './fixtures'

describe('toolImages', () => {
  test('Read, MCP and Anthropic shapes, nested in content', async () => {
    const out = toolImages([
      { type: 'image', file: { base64: 'AAA', type: 'image/jpeg' } },
      { content: [{ type: 'image', data: 'BBB', mimeType: 'image/png' }] },
      { type: 'image', source: { type: 'base64', data: 'CCC', media_type: 'image/webp' } },
      { type: 'text', text: 'hi' },
    ])
    expect(out).toEqual([
      { base64: 'AAA', mime: 'image/jpeg' },
      { base64: 'BBB', mime: 'image/png' },
      { base64: 'CCC', mime: 'image/webp' },
    ])
  })
  test('non-image output gives nothing', async () => {
    expect(toolImages({ stdout: 'x' })).toEqual([])
    expect(toolImages(null)).toEqual([])
  })
})

describe('resolveFile', () => {
  test('png is used in place with its size and mtime generation', async () => {
    resetSourceCache()
    const { $, runs } = io({ '/a.png': { b64: pngB64(1280, 720), mtime: 42 } })
    expect(await resolveFile($, '/a.png')).toEqual({ path: '/a.png', size: { width: 1280, height: 720 }, generation: 42 })
    expect(runs.length).toBe(0)
  })
  test('jpg is converted once with sips into the cache dir', async () => {
    resetSourceCache()
    const { $, runs } = io({ '/b.jpg': { mtime: 7 } })
    const r1 = await resolveFile($, '/b.jpg')
    const r2 = await resolveFile($, '/b.jpg')
    expect(r1).toEqual(r2)
    expect('path' in r1 && r1.path.startsWith('/tmp/t/claude-gallery/') && r1.path.endsWith('.png')).toBe(true)
    expect(runs.length).toBe(1)
    expect(runs[0]?.argv.join(' ')).toContain('sips')
  })
  test('missing file is an error, not a throw', async () => {
    resetSourceCache()
    const { $ } = io({})
    expect(await resolveFile($, '/nope.png')).toEqual({ error: '找不到圖片: /nope.png' })
  })
  test('sips failure is an error', async () => {
    resetSourceCache()
    const { $, fail } = io({ '/c.heic': {} })
    fail()
    expect(await resolveFile($, '/c.heic')).toEqual({ error: '轉檔失敗: /c.heic' })
  })
  test('a failed conversion is tried again on the next call', async () => {
    resetSourceCache()
    const { $, runs, fail } = io({ '/d.heic': {} })
    fail()
    expect(await resolveFile($, '/d.heic')).toEqual({ error: '轉檔失敗: /d.heic' })
    fail(false)
    const r = await resolveFile($, '/d.heic')
    expect('path' in r).toBe(true)
    expect(runs.length).toBe(2)
  })
  test('png over the read cap still draws with null size', async () => {
    resetSourceCache()
    const { $ } = io({ '/big.png': { b64: pngB64(10, 10), tooBig: true, mtime: 3 } })
    expect(await resolveFile($, '/big.png')).toEqual({ path: '/big.png', size: null, generation: 3 })
  })
})

describe('resolveToolImage', () => {
  test('png base64 is written once through stdin', async () => {
    resetSourceCache()
    const { $, runs } = io({})
    const img = { base64: pngB64(640, 480), mime: 'image/png' }
    const r1 = await resolveToolImage($, 'toolu_1-0', img)
    await resolveToolImage($, 'toolu_1-0', img)
    expect(r1).toEqual({ path: '/tmp/t/claude-gallery/toolu_1-0.png', size: { width: 640, height: 480 }, generation: 0 })
    expect(runs.length).toBe(1)
    expect(runs[0]?.stdin).toBe(img.base64)
    expect(runs[0]?.argv).toContain('/tmp/t/claude-gallery/toolu_1-0.png')
  })
  test('jpeg is written then converted', async () => {
    resetSourceCache()
    const { $, runs } = io({})
    const r = await resolveToolImage($, 'k', { base64: 'AAAA', mime: 'image/jpeg' })
    expect('path' in r && r.path.endsWith('.png')).toBe(true)
    expect(runs.length).toBe(2)
  })
  test('a failed write is tried again on the next call', async () => {
    resetSourceCache()
    const { $, runs, fail } = io({})
    const img = { base64: pngB64(2, 2), mime: 'image/png' }
    fail()
    expect(await resolveToolImage($, 'toolu_2-0', img)).toEqual({ error: '圖片寫入失敗' })
    fail(false)
    expect('path' in (await resolveToolImage($, 'toolu_2-0', img))).toBe(true)
    expect(runs.length).toBe(2)
  })
  test('key is sanitized', async () => {
    resetSourceCache()
    const { $ } = io({})
    const r = await resolveToolImage($, '../x y', { base64: pngB64(1, 1), mime: 'image/png' })
    expect('path' in r && r.path).toBe('/tmp/t/claude-gallery/___x_y.png')
  })
})
