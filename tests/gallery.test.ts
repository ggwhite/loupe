import type { RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import { fitCells } from '../hooks/layout'
import { resetRegistry } from '../hooks/registry'
import { resetSourceCache } from '../hooks/source'
import { ENGINE_ROW, intercept, pngB64 } from './fixtures'

type Node = { type?: string; props?: Record<string, unknown>; children?: (Node | string)[] }

const textOf = (n: Node | string): string => (typeof n === 'string' ? n : (n.children ?? []).map(textOf).join(''))

const labelOf = (n: Node): string => (typeof n.props?.['label'] === 'string' ? n.props['label'] : textOf(n))

const findAll = (n: Node | string | undefined, type: string, out: Node[] = []): Node[] => {
  if (n === undefined || typeof n === 'string') return out
  if (n.type === type) out.push(n)
  for (const k of n.children ?? []) findAll(k, type, out)
  return out
}

const start = async ($: Engine) => {
  resetSourceCache()
  resetRegistry()
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

const message = async ($: Engine, text: string, id = 'msg-1', columns = 100, surface: 'terminal' | 'desktop' = 'terminal') =>
  (await $.ui.render({
    surface,
    component: 'AssistantMessage',
    requestId: id,
    viewport: { columns, rows: 40 },
    props: { text, isFirstOfReply: true },
  })) as RenderElement as Node

const IMAGE_OUTPUT = [{ type: 'image', file: { base64: pngB64(640, 480), type: 'image/png' } }]

const call = (id: string, tool: string, input: unknown, output: unknown) => ({
  tool_use_id: id,
  tool,
  input,
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output,
})

describe('AssistantMessage thumbnails', () => {
  test('a referenced png draws one Image and a #1 button', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(1600, 1000), mtime: 1 } })
    await start($)
    const tree = await message($, '看圖 ![a](/a.png)')
    const images = findAll(tree, 'Image')
    expect(images).toHaveLength(1)
    expect(textOf(tree)).toContain(ENGINE_ROW)
    expect(images[0]?.props?.['source']).toEqual({ file: '/a.png', format: 'png', generation: 1 })
    const cells = fitCells({ width: 1600, height: 1000 }, 40, 8, 6)
    expect(images[0]?.props?.['columns']).toBe(cells.columns)
    expect(images[0]?.props?.['rows']).toBe(cells.rows)
    expect(findAll(tree, 'Button').some(b => labelOf(b).includes('#1'))).toBe(true)
  })

  test('a message without images is left to the engine', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = await message($, '沒有圖')
    expect(findAll(tree, 'Image')).toHaveLength(0)
    expect(tree.type).toBe('Text')
    expect(textOf(tree)).toBe(ENGINE_ROW)
  })

  test('the desktop surface draws no thumbnails', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(1600, 1000) } })
    await start($)
    expect(findAll(await message($, '![a](/a.png)', 'msg-1', 100, 'desktop'), 'Image')).toHaveLength(0)
  })

  test('drawing a message again keeps its number and converts nothing twice', async ($, on) => {
    const { runs } = intercept(on, { '/a.jpg': { mtime: 5 } })
    await start($)
    await message($, '![a](/a.jpg)')
    const before = runs.length
    const tree = await message($, '![a](/a.jpg)')
    expect(findAll(tree, 'Button').map(labelOf).join(' ')).toContain('#1')
    expect(runs.length).toBe(before)
  })

  test('a second message with another image is #2', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(100, 100) }, '/b.png': { b64: pngB64(100, 100) } })
    await start($)
    await message($, '![a](/a.png)', 'msg-1')
    const tree = await message($, '![b](/b.png)', 'msg-2')
    expect(findAll(tree, 'Button').map(labelOf).join(' ')).toContain('#2')
  })

  test('a missing file draws its error line and no Image', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = await message($, '![x](/nope.png)')
    expect(findAll(tree, 'Image')).toHaveLength(0)
    expect(findAll(tree, 'Text').some(t => textOf(t) === '[找不到圖片: /nope.png]')).toBe(true)
  })

  test('at most 8 images per message', async ($, on) => {
    const files: Record<string, { b64: string }> = {}
    let text = ''
    for (let i = 0; i < 10; i++) {
      files[`/p${i}.png`] = { b64: pngB64(100, 100) }
      text += ` ![p](/p${i}.png)`
    }
    intercept(on, files)
    await start($)
    expect(findAll(await message($, text), 'Image')).toHaveLength(8)
  })

  test('thumbnails wrap into rows that fit the viewport', async ($, on) => {
    const files: Record<string, { b64: string }> = {}
    let text = ''
    for (let i = 0; i < 4; i++) {
      files[`/w${i}.png`] = { b64: pngB64(2600, 400) }
      text += ` ![w](/w${i}.png)`
    }
    intercept(on, files)
    await start($)
    const tree = await message($, text, 'msg-1', 50)
    const images = findAll(tree, 'Image')
    expect(images.map(i => i.props?.['columns'])).toEqual([26, 26, 26, 26])
    const rows = findAll(tree, 'Box').filter(b => b.props?.['flexDirection'] === 'row' && findAll(b, 'Image').length > 0)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      const widths = findAll(row, 'Image').map(i => Number(i.props?.['columns']))
      expect(widths.reduce((a, b) => a + b, 0) + widths.length - 1).toBeLessThanOrEqual(50 - 4)
    }
  })

  test('the file is statted with its links resolved', async ($, on) => {
    const { stats } = intercept(on, { '/a.png': { b64: pngB64(10, 10) } })
    await start($)
    await message($, '![a](/a.png)')
    const own = stats.filter(s => s.path === '/a.png')
    expect(own.length).toBeGreaterThan(0)
    expect(own.every(s => s.resolve)).toBe(true)
  })
})

describe('tool result thumbnails', () => {
  test('a Read image result draws from the cache dir', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_9',
      viewport: { columns: 100, rows: 40 },
      props: { tool_use_id: 'toolu_9', tool: 'Read', output: { type: 'image', file: { base64: pngB64(640, 480), type: 'image/png' } }, isErrored: false },
    })) as RenderElement as Node
    const images = findAll(tree, 'Image')
    expect(images).toHaveLength(1)
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/tmp/t/claude-gallery/toolu_9-0.png')
  })

  test('a tool group draws the one call that returned an image', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-1',
      viewport: { columns: 100, rows: 40 },
      props: {
        calls: [call('toolu_a', 'Read', { file_path: '/x/s.png' }, IMAGE_OUTPUT), call('toolu_b', 'Grep', {}, 'x')],
        isActive: false,
        isExpanded: false,
      },
    })) as RenderElement as Node
    const images = findAll(tree, 'Image')
    expect(images).toHaveLength(1)
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/tmp/t/claude-gallery/toolu_a-0.png')
  })

  test('an unreadable TMPDIR falls back to /tmp', async ($, on) => {
    intercept(on, {}, null)
    on('env.get', async (_$, e) => {
      if (e.name === 'TMPDIR') throw new Error('denied')
      return { value: e.name === 'HOME' ? '/Users/u' : undefined }
    })
    await start($)
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_7',
      viewport: { columns: 100, rows: 40 },
      props: { tool_use_id: 'toolu_7', tool: 'Read', output: IMAGE_OUTPUT, isErrored: false },
    })) as RenderElement as Node
    expect((findAll(tree, 'Image')[0]?.props?.['source'] as { file: string } | undefined)?.file).toBe('/tmp/claude-gallery/toolu_7-0.png')
  })
})
