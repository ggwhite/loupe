import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import { fitCells } from '../hooks/layout'
import { herdrZoomOn, register } from '../hooks/register'
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

const THUMB_INDENT = 2
const THUMB_RIGHT_MARGIN = 2
const THUMB_GAP = 2
const PANE_PAD_X = 1
const PANE_PAD_Y = 0

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
  test('a single referenced png draws large with a ⤢ view #1 button', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(1600, 1000), mtime: 1 } })
    await start($)
    const tree = await message($, 'see ![a](/a.png)')
    const images = findAll(tree, 'Image')
    expect(images).toHaveLength(1)
    expect(textOf(tree)).toContain(ENGINE_ROW)
    expect(images[0]?.props?.['source']).toEqual({ file: '/a.png', format: 'png', generation: 1 })
    const cells = fitCells({ width: 1600, height: 1000 }, Math.min(80, 100 - 4), 20, 6)
    expect(images[0]?.props?.['columns']).toBe(cells.columns)
    expect(images[0]?.props?.['rows']).toBe(cells.rows)
    expect(findAll(tree, 'Button').map(labelOf)).toEqual(['⤢ view #1'])
  })

  test('two referenced images keep the thumbnail grid', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(1600, 1000) }, '/b.png': { b64: pngB64(100, 100) } })
    await start($)
    const tree = await message($, '![a](/a.png) ![b](/b.png)')
    const images = findAll(tree, 'Image')
    expect(images.map(i => i.props?.['rows'])).toEqual([8, 8])
    expect(findAll(tree, 'Button').map(labelOf)).toEqual(['⤢ view #1', '⤢ view #2'])
  })

  test('thumbnail block is indented 2 columns with a blank row above', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(1600, 1000), mtime: 1 } })
    await start($)
    const tree = await message($, 'see ![a](/a.png)')
    const block = findAll(tree, 'Box').find(b => findAll(b, 'Image').length > 0 && b.props?.['marginTop'] !== undefined)
    expect(block?.props?.['marginTop']).toBe(1)
    expect(block?.props?.['paddingLeft']).toBe(THUMB_INDENT)
  })

  test('a message without images is left to the engine', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = await message($, 'no pictures here')
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
    expect(before).toBeGreaterThan(0)
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
    expect(findAll(tree, 'Text').some(t => textOf(t) === '[image not found: /nope.png]')).toBe(true)
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
    const room = 50 - THUMB_INDENT - THUMB_RIGHT_MARGIN
    const cells = fitCells({ width: 2600, height: 400 }, Math.min(40, room), 8, 6)
    expect(images.map(i => i.props?.['columns'])).toEqual([cells.columns, cells.columns, cells.columns, cells.columns])
    const rows = findAll(tree, 'Box').filter(b => b.props?.['flexDirection'] === 'row' && findAll(b, 'Image').length > 0)
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows) {
      const widths = findAll(row, 'Image').map(i => Number(i.props?.['columns']))
      expect(widths.reduce((a, b) => a + b, 0) + (widths.length - 1) * THUMB_GAP).toBeLessThanOrEqual(room)
    }
  })

  test('a path with spaces in angle brackets draws as is', async ($, on) => {
    intercept(on, { '/a b/c.png': { b64: pngB64(100, 100) } })
    await start($)
    const images = findAll(await message($, '![x](</a b/c.png>)'), 'Image')
    expect(images).toHaveLength(1)
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/a b/c.png')
  })

  test('a heic path with spaces reaches sips as one argument', async ($, on) => {
    const { runs } = intercept(on, { '/my pics/shot 1.heic': { mtime: 2 } })
    await start($)
    const images = findAll(await message($, '![x](</my pics/shot 1.heic>)'), 'Image')
    expect(images).toHaveLength(1)
    const sips = runs.find(r => r.argv.join(' ').includes('sips'))
    expect(sips?.argv).toContain('/my pics/shot 1.heic')
    expect(sips?.argv[0]).toBe('/bin/sh')
  })

  test('an unreadable HOME still draws absolute paths', async ($, on) => {
    intercept(on, { '/a.png': { b64: pngB64(100, 100) } }, null)
    on('env.get', async (_$, e) => {
      if (e.name === 'HOME') throw new Error('denied')
      return { value: e.name === 'TMPDIR' ? '/tmp/t/' : undefined }
    })
    await start($)
    expect(findAll(await message($, '![a](/a.png)'), 'Image')).toHaveLength(1)
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
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/tmp/t/claude-loupe/toolu_9-0.png')
  })

  test('a tool group resolves at most 8 images and draws 3 with +5', async ($, on) => {
    const { runs } = intercept(on, {})
    await start($)
    const many = Array.from({ length: 10 }, () => IMAGE_OUTPUT[0])
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-2',
      viewport: { columns: 100, rows: 40 },
      props: { calls: [call('toolu_m', 'Read', {}, many)], isActive: false, isExpanded: false },
    })) as RenderElement as Node
    expect(findAll(tree, 'Image')).toHaveLength(3)
    expect(findAll(tree, 'Text').map(textOf)).toContain('+5')
    expect(runs.length).toBe(8)
  })

  const strip = (tree: Node) => (tree.children ?? [])[1] as Node

  test('one tool image: column with the engine row, then a strip below', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'toolu_1',
      viewport: { columns: 100, rows: 40 },
      props: { tool_use_id: 'toolu_1', tool: 'Read', output: IMAGE_OUTPUT, isErrored: false },
    })) as RenderElement as Node
    expect(tree.type).toBe('Box')
    expect(tree.props?.['flexDirection']).toBe('column')
    expect(textOf((tree.children ?? [])[0] ?? '')).toBe(ENGINE_ROW)
    expect(findAll((tree.children ?? [])[0], 'Image')).toHaveLength(0)
    const bar = strip(tree)
    expect(bar.props?.['flexDirection']).toBe('row')
    expect(bar.props?.['paddingLeft']).toBe(5)
    expect(bar.props?.['columnGap']).toBe(1)
    const images = findAll(bar, 'Image')
    expect(images).toHaveLength(1)
    expect(images[0]?.props?.['rows']).toBe(2)
    expect(images[0]?.props?.['columns']).toBe(fitCells({ width: 640, height: 480 }, 8, 2, 2).columns)
    expect(findAll(bar, 'Button').map(labelOf)).toEqual(['⤢ '])
  })

  test('5 images: 3 thumbnails, +2 and ⤢ bottom-aligned in a height-2 box', async ($, on) => {
    intercept(on, {})
    await start($)
    const five = Array.from({ length: 5 }, () => IMAGE_OUTPUT[0])
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-6',
      viewport: { columns: 100, rows: 40 },
      props: { calls: [call('toolu_6', 'Read', {}, five)], isActive: false, isExpanded: false },
    })) as RenderElement as Node
    const bar = strip(tree)
    expect(findAll(bar, 'Image')).toHaveLength(3)
    const tail = findAll(bar, 'Box').find(b => b.props?.['height'] === 2)
    expect(tail?.props?.['justifyContent']).toBe('flex-end')
    expect(findAll(tail, 'Text').map(textOf)).toContain('+2')
    expect(findAll(tail, 'Button').map(labelOf)).toEqual(['⤢ '])
  })

  const EMPTY_ROWS: [string, () => unknown][] = [
    ['empty text', () => ({ type: 'Text', props: {}, children: [''] })],
    ['empty box', () => ({ type: 'Box', props: {}, children: [{ type: 'Text', props: {}, children: [] }] })],
  ]

  for (const [name, empty] of EMPTY_ROWS) {
    test(`an empty engine row (${name}) still gets the strip below`, async ($, on) => {
      on('ui.render', { component: 'ToolResult' }, async () => empty() as RenderElement)
      intercept(on, {})
      await start($)
      const tree = (await $.ui.render({
        surface: 'terminal',
        component: 'ToolResult',
        requestId: 'toolu_e',
        viewport: { columns: 100, rows: 40 },
        props: { tool_use_id: 'toolu_e', tool: 'Read', output: IMAGE_OUTPUT, isErrored: false },
      })) as RenderElement as Node
      expect(tree.props?.['flexDirection']).toBe('column')
      expect(findAll(strip(tree), 'Image')).toHaveLength(1)
      expect(findAll(strip(tree), 'Button').map(labelOf)).toEqual(['⤢ '])
    })
  }

  test('a tool group with one image draws the same row', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-3',
      viewport: { columns: 100, rows: 40 },
      props: { calls: [call('toolu_g', 'Read', {}, IMAGE_OUTPUT)], isActive: false, isExpanded: false },
    })) as RenderElement as Node
    expect(tree.props?.['flexDirection']).toBe('column')
    expect(findAll(strip(tree), 'Image').map(i => i.props?.['rows'])).toEqual([2])
    expect(findAll(tree, 'Button').map(labelOf)).toEqual(['⤢ '])
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
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/tmp/t/claude-loupe/toolu_a-0.png')
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
    expect((findAll(tree, 'Image')[0]?.props?.['source'] as { file: string } | undefined)?.file).toBe('/tmp/claude-loupe/toolu_7-0.png')
  })
})

describe('viewer pane', () => {
  const PANE = {
    plugin: 'loupe',
    surface: 'terminal' as const,
    component: 'Pane' as const,
    requestId: 'loupe',
    props: { title: 'Loupe', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 100, rows: 40 },
  }

  const opened = (on: On) => {
    const ids: string[] = []
    const args: Record<string, unknown>[] = []
    on('ui.open', async (_$, e) => {
      ids.push(e.id)
      args.push(e as unknown as Record<string, unknown>)
      return { value: { isPlaced: true as const } }
    })
    return Object.assign(ids, { args })
  }

  const three = async ($: Engine) => {
    await message($, '![a](/a.png)', 'msg-1')
    await message($, '![b](/b.png)', 'msg-2')
    await message($, '![c](/c.png)', 'msg-3')
  }

  const files = () => ({
    '/a.png': { b64: pngB64(100, 100) },
    '/b.png': { b64: pngB64(1600, 1000) },
    '/c.png': { b64: pngB64(100, 100) },
  })

  const zoom = async ($: Engine, n: number) => {
    const ui = await $.ui.mount({
      plugin: 'loupe',
      surface: 'terminal',
      component: 'AssistantMessage',
      requestId: `msg-${n}`,
      viewport: { columns: 100, rows: 40 },
      props: { text: `![x](/${'abc'[n - 1]}.png)`, isFirstOfReply: true },
    })
    const button = (await ui.findAll({ type: 'Button' })).find(b => b.props['label'] === `⤢ view #${n}`)
    expect(button?.key).toBeDefined()
    await ui.press({ key: button?.key ?? '' })
    await ui.unmount()
  }

  const hotkey = async ($: Engine, key: string) => {
    const ui = await $.ui.mount(PANE)
    const button = (await ui.findAll({ type: 'Button' })).find(b => b.props['hotkey'] === key)
    expect(button?.key).toBeDefined()
    await ui.press({ key: button?.key ?? '' })
    await ui.unmount()
  }

  const pane = async ($: Engine) => {
    const ui = await $.ui.mount(PANE)
    const tree = (await ui.drawn()) as RenderElement as Node
    await ui.unmount()
    return tree
  }

  const counter = (tree: Node) => findAll(tree, 'Text').map(textOf).find(t => /\d+ of \d+/.test(t)) ?? ''

  test('an empty viewer says so and draws no Image', async ($, on) => {
    intercept(on, {})
    await start($)
    const tree = await pane($)
    expect(findAll(tree, 'Image')).toHaveLength(0)
    expect(findAll(tree, 'Text').map(textOf)).toContain('no images yet')
  })

  test('#2 opens the pane on the second image, sized to the body', async ($, on) => {
    intercept(on, files())
    const ids = opened(on)
    await start($)
    await three($)
    await zoom($, 2)
    expect(ids).toContain('loupe')
    const tree = await pane($)
    expect(counter(tree)).toContain('2 of 3')
    const images = findAll(tree, 'Image')
    expect(images).toHaveLength(1)
    expect((images[0]?.props?.['source'] as { file: string }).file).toBe('/b.png')
    const cells = fitCells({ width: 1600, height: 1000 }, 80 - PANE_PAD_X * 2, 30 - PANE_PAD_Y * 2 - 1 - 1 - 2)
    expect(images[0]?.props?.['columns']).toBe(cells.columns)
    expect(images[0]?.props?.['rows']).toBe(cells.rows)
  })

  test('l and h stop at the ends', async ($, on) => {
    intercept(on, files())
    opened(on)
    await start($)
    await three($)
    await zoom($, 2)
    await hotkey($, 'l')
    await hotkey($, 'l')
    expect(counter(await pane($))).toContain('3 of 3')
    await hotkey($, 'h')
    await hotkey($, 'h')
    await hotkey($, 'h')
    expect(counter(await pane($))).toContain('1 of 3')
  })

  test('the zoom button opens the pane at the full viewport', async ($, on) => {
    intercept(on, files())
    const ids = opened(on)
    await start($)
    await three($)
    await zoom($, 2)
    expect(ids.args[0]).toMatchObject({ id: 'loupe', title: 'Loupe', focus: true, closeOnEscape: true, rows: 40, columns: 100 })
  })

  test('the title names the position and the file', async ($, on) => {
    intercept(on, files())
    opened(on)
    await start($)
    await three($)
    await zoom($, 2)
    const tree = await pane($)
    expect(counter(tree)).toContain('2 of 3  b.png')
    expect(findAll(tree, 'Button').map(labelOf)).toEqual(['‹', '›', '✕'])
  })

  test('✕ (x) closes the pane', async ($, on) => {
    intercept(on, files())
    opened(on)
    const closed: string[] = []
    on('ui.close', async (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    await start($)
    await three($)
    await zoom($, 1)
    await hotkey($, 'x')
    expect(closed).toEqual(['loupe'])
  })

  test('a ui.close that throws does not break ✕', async ($, on) => {
    intercept(on, files())
    opened(on)
    on('ui.close', async () => {
      throw new Error('denied')
    })
    await start($)
    await three($)
    await zoom($, 1)
    await hotkey($, 'x')
    expect(counter(await pane($))).toContain('1 of 3')
  })

  test('⤢ on a tool group of 5 opens the pane on its first image', async ($, on) => {
    intercept(on, {})
    const ids = opened(on)
    await start($)
    const five = Array.from({ length: 5 }, (_, i) => ({ type: 'image', file: { base64: pngB64(640 + i, 480), type: 'image/png' } }))
    const ui = await $.ui.mount({
      plugin: 'loupe',
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-5',
      viewport: { columns: 100, rows: 40 },
      props: { calls: [call('toolu_5', 'Read', {}, five)], isActive: false, isExpanded: false },
    })
    const button = (await ui.findAll({ type: 'Button' })).find(b => b.props['label'] === '⤢ ')
    expect(button?.key).toBeDefined()
    await ui.press({ key: button?.key ?? '' })
    await ui.unmount()
    expect(ids).toContain('loupe')
    expect(counter(await pane($))).toContain('1 of 5')
  })

  test('/loupe opens the pane on the newest image', async ($, on) => {
    intercept(on, files())
    const ids = opened(on)
    on('command.run', async () => ({}))
    await start($)
    await three($)
    await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    expect(ids).toContain('loupe')
    expect(ids.args[0]).toMatchObject({ rows: 40, columns: 100 })
    expect(counter(await pane($))).toContain('3 of 3')
  })

  test('a tool image registered at tool.call stays #1 though its group draws after the reply', async ($, on) => {
    intercept(on, { '/r.png': { b64: pngB64(100, 100) } })
    opened(on)
    on('command.run', async () => ({}))
    on('tool.call', async () => ({ result: IMAGE_OUTPUT[0] as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x/s.png', tool_use_id: 'toolu_live' })
    const reply = await message($, '![r](/r.png)', 'msg-r')
    expect(findAll(reply, 'Button').map(labelOf)).toEqual(['⤢ view #2'])
    const group = (await $.ui.render({
      surface: 'terminal',
      component: 'ToolGroup',
      requestId: 'group-live',
      viewport: { columns: 100, rows: 40 },
      props: { calls: [call('toolu_live', 'Read', { file_path: '/x/s.png' }, IMAGE_OUTPUT)], isActive: false, isExpanded: false },
    })) as RenderElement as Node
    expect(findAll(group, 'Image').map(i => i.props?.['alt'])).toEqual(['[#1 s.png]'])
    await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    expect(counter(await pane($))).toContain('2 of 2')
    await message($, '![b](/b.png)', 'msg-b')
    expect(counter(await pane($))).toContain('2 of 2')
  })

  test('/loupe follows images registered after it opened', async ($, on) => {
    intercept(on, files())
    opened(on)
    on('command.run', async () => ({}))
    await start($)
    await message($, '![a](/a.png)', 'msg-1')
    await message($, '![b](/b.png)', 'msg-2')
    await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    expect(counter(await pane($))).toContain('2 of 2')
    await message($, '![c](/c.png)', 'msg-3')
    expect(counter(await pane($))).toContain('3 of 3')
    await hotkey($, 'h')
    expect(counter(await pane($))).toContain('2 of 3')
  })

  test('a /clear starts the numbering over', async ($, on) => {
    intercept(on, files())
    opened(on)
    on('command.run', async () => ({}))
    on('classic.SessionStart', async () => ({}))
    await start($)
    await message($, '![a](/a.png)', 'msg-1')
    await message($, '![b](/b.png)', 'msg-2')
    await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    await hotkey($, 'h')
    await $.classic.SessionStart({ source: 'clear' })
    const tree = await message($, '![c](/c.png)', 'msg-3')
    expect(findAll(tree, 'Button').map(labelOf)).toEqual(['⤢ view #1'])
    expect(counter(await pane($))).toContain('1 of 1')
  })

  test('a compaction keeps the numbering', async ($, on) => {
    intercept(on, files())
    on('classic.SessionStart', async () => ({}))
    await start($)
    await message($, '![a](/a.png)', 'msg-1')
    await $.classic.SessionStart({ source: 'compact' })
    expect(findAll(await message($, '![b](/b.png)', 'msg-2'), 'Button').map(labelOf)).toEqual(['⤢ view #2'])
  })

  test('a file deleted since it was drawn shows a dim line and keeps h/l', async ($, on) => {
    const map: Record<string, { b64: string }> = files()
    intercept(on, map)
    opened(on)
    await start($)
    await three($)
    await zoom($, 2)
    delete map['/b.png']
    const tree = await pane($)
    expect(findAll(tree, 'Image')).toHaveLength(0)
    expect(findAll(tree, 'Text').map(textOf)).toContain('[file deleted]')
    const hotkeys = findAll(tree, 'Button').map(b => b.props?.['hotkey'])
    expect(hotkeys).toEqual(expect.arrayContaining(['h', 'l', 'x']))
  })

  test('a ui.open that throws neither breaks the zoom button nor /loupe', async ($, on) => {
    intercept(on, files())
    on('ui.open', async () => {
      throw new Error('denied')
    })
    on('command.run', async () => ({}))
    await start($)
    await three($)
    await zoom($, 2)
    const result = await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })
    expect(JSON.stringify(result)).toContain('[could not open the viewer]')
  })

  describe('herdr full screen', () => {
    const HERDR = { HOME: '/Users/u', TMPDIR: '/tmp/t/', HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p2' }
    const LAYOUT = ['herdr', 'pane', 'layout', '--pane', 'w1:p2']
    const ON = ['herdr', 'pane', 'zoom', '--pane', 'w1:p2', '--on']
    const OFF = ['herdr', 'pane', 'zoom', '--pane', 'w1:p2', '--off']
    const layout = (zoomed: boolean) => JSON.stringify({ id: 'cli:pane:layout', result: { layout: { zoomed }, type: 'pane_layout' } })

    const herdr = (on: On, zoomed: boolean, env: Record<string, string> = HERDR) => {
      const io = intercept(on, files(), env)
      io.respond(argv => (argv.join(' ') === LAYOUT.join(' ') ? layout(zoomed) : undefined))
      on('ui.close', async () => ({ value: undefined }))
      return { io, calls: () => io.runs.map(r => r.argv).filter(a => a[0] === 'herdr') }
    }

    test('opening the viewer zooms the herdr pane on after checking it', async ($, on) => {
      const { calls } = herdr(on, false)
      opened(on)
      await start($)
      await three($)
      await zoom($, 2)
      expect(calls()).toEqual([LAYOUT, ON])
    })

    test('x zooms the pane back off', async ($, on) => {
      const { calls } = herdr(on, false)
      opened(on)
      await start($)
      await three($)
      await zoom($, 2)
      await hotkey($, 'x')
      expect(calls()).toEqual([LAYOUT, ON, OFF])
    })

    test('Escape (a close by the person) zooms the pane back off', async () => {
      // The test engine raises no ui.close of its own, and a test's import is not the engine's
      // copy of the module: zoom on through the import, then hand its hook the person's close.
      const hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {}
      register(((event: string, matcher: unknown, hook?: (...a: unknown[]) => Promise<unknown>) => {
        if (event === 'ui.close') hooks[JSON.stringify(matcher)] = hook ?? (matcher as never)
      }) as never, {} as never)
      const ran: string[][] = []
      const env: Record<string, string> = HERDR
      const fake = {
        env: { get: async (name: string) => env[name] },
        process: {
          run: async (argv: string[]) => {
            ran.push(argv)
            return { exitCode: 0, stdout: argv.join(' ') === LAYOUT.join(' ') ? layout(false) : '', stderr: '' }
          },
        },
      }
      await herdrZoomOn(fake as never)
      await hooks[JSON.stringify({ id: 'loupe' })]?.(fake, { id: 'loupe', origin: { kind: 'person' } }, async () => undefined)
      expect(ran).toEqual([LAYOUT, ON, OFF])
    })

    test('a pane that was already zoomed is left alone', async ($, on) => {
      const { calls } = herdr(on, true)
      opened(on)
      await start($)
      await three($)
      await zoom($, 2)
      await hotkey($, 'x')
      expect(calls()).toEqual([LAYOUT])
    })

    test('opening again while open zooms once and closes once', async ($, on) => {
      const { calls } = herdr(on, false)
      opened(on)
      await start($)
      await three($)
      await zoom($, 1)
      await zoom($, 2)
      await hotkey($, 'x')
      expect(calls()).toEqual([LAYOUT, ON, OFF])
    })

    test('outside herdr nothing runs', async ($, on) => {
      const { calls } = herdr(on, false, { HOME: '/Users/u', TMPDIR: '/tmp/t/' })
      opened(on)
      await start($)
      await three($)
      await zoom($, 2)
      await hotkey($, 'x')
      expect(calls()).toEqual([])
    })

    test('a failing herdr query neither zooms nor breaks the viewer', async ($, on) => {
      const { io, calls } = herdr(on, false)
      const ids = opened(on)
      await start($)
      await three($)
      io.fail()
      await zoom($, 2)
      await hotkey($, 'x')
      expect(calls()).toEqual([LAYOUT])
      expect(ids).toContain('loupe')
    })
  })
})

describe('tool.call registration', () => {
  test('passes the result through untouched', async ($, on) => {
    intercept(on, {})
    const result = { type: 'image', file: { base64: pngB64(10, 10), type: 'image/png' } }
    on('tool.call', async () => ({ result: result as never, text: 't' }))
    await start($)
    const r = await $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: 'toolu_p' })
    expect(r).toMatchObject({ result, text: 't' })
  })

  test('a failing image write still returns the result', async ($, on) => {
    const io = intercept(on, {})
    io.fail()
    on('tool.call', async () => ({ result: IMAGE_OUTPUT[0] as never }))
    await start($)
    const r = await $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: 'toolu_f' })
    expect(r).toMatchObject({ result: IMAGE_OUTPUT[0] })
  })

  test('a call with no image writes nothing', async ($, on) => {
    const io = intercept(on, {})
    on('tool.call', async () => ({ result: { stdout: 'x' } as never }))
    await start($)
    await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'toolu_n' })
    expect(io.runs).toHaveLength(0)
  })
})

describe('cost of drawing', () => {
  test('a message without an image ref makes no env lookup', async ($, on) => {
    const gets: string[] = []
    intercept(on, {}, null)
    on('env.get', async (_$, e) => {
      gets.push(e.name)
      return { value: '/Users/u' }
    })
    await start($)
    gets.length = 0
    await message($, 'plain text, no pictures')
    expect(gets).toHaveLength(0)
    await message($, '![a](/a.png)')
    expect(gets.length).toBeGreaterThan(0)
  })

  test('a failing conversion of an unchanged file runs sips once, and again after it changes', async ($, on) => {
    const map: Record<string, { mtime: number }> = { '/x.heic': { mtime: 1 } }
    const io = intercept(on, map)
    io.fail()
    await start($)
    await message($, '![x](/x.heic)')
    await message($, '![x](/x.heic)')
    expect(io.runs).toHaveLength(1)
    map['/x.heic'] = { mtime: 2 }
    await message($, '![x](/x.heic)')
    expect(io.runs).toHaveLength(2)
  })

  test('a png-labelled tool image that is not a png goes through sips', async ($, on) => {
    const io = intercept(on, {})
    await start($)
    const output = [{ type: 'image', file: { base64: btoa('GIF89a-not-a-png'), type: 'image/png' } }]
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolResult',
      requestId: 'r1',
      viewport: { columns: 100, rows: 40 },
      props: { tool: 'Read', tool_use_id: 'toolu_x', output, isErrored: false },
    })
    expect(io.runs.some(r => r.argv.join(' ').includes('sips'))).toBe(true)
  })
})
