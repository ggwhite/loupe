import type { RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import { pruneArgv, register, resolveToolImage } from '../hooks/register'
import { resetRegistry } from '../hooks/registry'
import { Lru, MEMO_MAX, canonicalPath, SOURCE_CACHE_MAX, resetSourceCache } from '../hooks/source'
import { intercept, io, pngB64 } from './fixtures'

const start = async ($: Engine) => {
  resetSourceCache()
  resetRegistry()
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

const IMAGE = { type: 'image', file: { base64: pngB64(640, 480), type: 'image/png' } }

/** Counts each time toolImages visits it (reads type). */
function counted(value: Record<string, unknown>, hits: { walks: number; images: number }) {
  return new Proxy(value, {
    get(target, key) {
      if (key === 'type') hits.walks++
      if (key === 'file') hits.images++
      return Reflect.get(target, key)
    },
  })
}

type Hook = (...a: unknown[]) => Promise<unknown>

/** Calls the registered ui.render hook directly: the engine copies props, so a Proxy inside the engine cannot count visits. */
function direct() {
  const hooks: Record<string, Hook> = {}
  const on = (event: string, matcher: unknown, hook?: Hook) => {
    if (event === 'ui.render' && matcher && (matcher as { component: string }).component) hooks[(matcher as { component: string }).component] = hook as Hook
  }
  register(on as never, {} as never)
  const { $, runs } = io({})
  const parts = new Proxy({}, { get: (_t, type) => (props: unknown) => ({ type, props }) })
  ;($ as unknown as { ui: unknown }).ui = { resolve: () => parts }
  const next = async () => 'engine'
  return {
    runs,
    result: (id: string, output: unknown) =>
      hooks['ToolResult']?.($, { surface: 'terminal', requestId: id, props: { tool_use_id: id, tool: 'Bash', output, isErrored: false } }, next),
    group: (requestId: string, calls: unknown[]) =>
      hooks['ToolGroup']?.($, { surface: 'terminal', requestId, props: { calls, isActive: false, isExpanded: false } }, next),
  }
}

const result = ($: Engine, id: string, output: unknown) =>
  $.ui.render({
    surface: 'terminal',
    component: 'ToolResult',
    requestId: id,
    viewport: { columns: 100, rows: 40 },
    props: { tool_use_id: id, tool: 'Bash', output, isErrored: false },
  }) as Promise<RenderElement>

const group = ($: Engine, requestId: string, calls: unknown[]) =>
  $.ui.render({
    surface: 'terminal',
    component: 'ToolGroup',
    requestId,
    viewport: { columns: 100, rows: 40 },
    props: { calls, isActive: false, isExpanded: false },
  } as never) as Promise<RenderElement>

const call = (id: string | undefined, output: unknown, isRunning = false) => ({
  ...(id === undefined ? {} : { tool_use_id: id }),
  tool: 'Read',
  input: {},
  isRunning,
  isErrored: false,
  isInterrupted: false,
  output,
})

const imageCount = (tree: unknown): number => JSON.stringify(tree).split('"type":"Image"').length - 1

describe('per tool-use memo', () => {
  test('a finished non-image result is not walked again', async () => {
    resetSourceCache()
    const h = direct()
    const hits = { walks: 0, images: 0 }
    const output = counted({ stdout: 'x', content: [{ type: 'text' }] }, hits)
    expect(await h.result('toolu_a', output)).toBe('engine')
    const first = hits.walks
    expect(first).toBeGreaterThan(0)
    expect(await h.result('toolu_a', output)).toBe('engine')
    await h.result('toolu_a', output)
    expect(hits.walks).toBe(first)
  })

  test('a still-running group call is read again until it finishes', async () => {
    resetSourceCache()
    const h = direct()
    const hits = { walks: 0, images: 0 }
    const output = counted({ content: [{ type: 'text' }] }, hits)
    await h.group('g1', [call('toolu_r', output, true)])
    const first = hits.walks
    expect(first).toBeGreaterThan(0)
    await h.group('g1', [call('toolu_r', output, true)])
    expect(hits.walks).toBe(first * 2)
    await h.group('g1', [call('toolu_r', output, false)])
    const done = hits.walks
    await h.group('g1', [call('toolu_r', output, false)])
    expect(hits.walks).toBe(done)
  })

  test('a group call without output yet is read again', async ($, on) => {
    intercept(on, {})
    await start($)
    await group($, 'g2', [call('toolu_p', undefined)])
    const tree = await group($, 'g2', [call('toolu_p', [IMAGE])])
    expect(imageCount(tree)).toBe(1)
  })

  test('images still draw after the memo, in a result and across a group', async ($, on) => {
    const { runs } = intercept(on, {})
    await start($)
    expect(imageCount(await result($, 'toolu_i', IMAGE))).toBe(1)
    expect(imageCount(await result($, 'toolu_i', IMAGE))).toBe(1)
    const calls = [call('toolu_g1', [IMAGE]), call('toolu_g2', { stdout: 'no' }), call(undefined, [IMAGE])]
    expect(imageCount(await group($, 'g3', calls))).toBe(2)
    const before = runs.length
    expect(imageCount(await group($, 'g3', calls))).toBe(2)
    expect(runs.length).toBe(before)
  })

  test('a failed resolve is not memoized and is tried again', async ($, on) => {
    const io = intercept(on, {})
    await start($)
    io.fail()
    const first = await result($, 'toolu_f', IMAGE)
    expect(imageCount(first)).toBe(0)
    io.fail(false)
    expect(imageCount(await result($, 'toolu_f', IMAGE))).toBe(1)
  })
})

describe('lru', () => {
  test('evicts the oldest beyond the cap and a hit refreshes', () => {
    const lru = new Lru<number>(3)
    lru.set('a', 1)
    lru.set('b', 2)
    lru.set('c', 3)
    expect(lru.get('a')).toBe(1)
    lru.set('d', 4)
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('a')).toBe(1)
    expect(lru.size).toBe(3)
  })

  test('the source cache holds at most its cap and evicts the oldest key', async () => {
    resetSourceCache()
    const { $, runs } = io({})
    const img = { base64: pngB64(2, 2), mime: 'image/png' }
    for (let i = 0; i < SOURCE_CACHE_MAX + 1; i++) await resolveToolImage($, `k${i}`, img)
    expect(runs.length).toBe(SOURCE_CACHE_MAX + 1)
    await resolveToolImage($, `k${SOURCE_CACHE_MAX}`, img)
    expect(runs.length).toBe(SOURCE_CACHE_MAX + 1)
    await resolveToolImage($, 'k0', img)
    expect(runs.length).toBe(SOURCE_CACHE_MAX + 2)
  })

  test('a source cache hit refreshes the key', async () => {
    resetSourceCache()
    const { $, runs } = io({})
    const img = { base64: pngB64(2, 2), mime: 'image/png' }
    for (let i = 0; i < SOURCE_CACHE_MAX; i++) await resolveToolImage($, `k${i}`, img)
    await resolveToolImage($, 'k0', img)
    await resolveToolImage($, 'extra', img)
    const before = runs.length
    await resolveToolImage($, 'k0', img)
    expect(runs.length).toBe(before)
    await resolveToolImage($, 'k1', img)
    expect(runs.length).toBe(before + 1)
  })

  test('the memo cap is 2048', () => {
    expect(MEMO_MAX).toBe(2048)
  })
})

describe('cache pruning', () => {
  test('session.start prunes old files in the cache dir by argv', async ($, on) => {
    const { clock, prunes } = intercept(on, {})
    await start($)
    await clock.settle()
    expect(prunes).toHaveLength(1)
    const argv = prunes[0] as string[]
    expect(argv.slice(0, 7)).toEqual(['/usr/bin/find', '/tmp/t/claude-loupe', '-maxdepth', '1', '-type', 'f', '-mmin'])
    expect(argv[7]).toBe('+1440')
    expect(argv.at(-1)).toBe('-delete')
    expect(argv).toContain('*.png')
    expect(argv).not.toContain('/bin/sh')
  })
})

describe('render cost with 516 tool results (33 with images), 5 passes', () => {
  test('walks and image reads', async () => {
    resetSourceCache()
    const h = direct()
    const hits = { walks: 0, images: 0 }
    const outputs = Array.from({ length: 516 }, (_, i) =>
      i % 16 === 0 && i < 33 * 16 ? counted(IMAGE, hits) : counted({ stdout: `o${i}`, content: [{ type: 'text' }] }, hits),
    )
    for (let pass = 0; pass < 5; pass++) for (let i = 0; i < 516; i++) await h.result(`toolu_${i}`, outputs[i])
    expect(hits.images).toBe(33)
  })
})

describe('lazy conversion for subagent images', () => {
  const JPEG = { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }
  const PANE = {
    plugin: 'loupe',
    surface: 'terminal' as const,
    component: 'Pane' as const,
    requestId: 'loupe',
    props: { title: 'Loupe', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 100, rows: 40 },
  }
  const anyFile = new Proxy({}, { has: () => true, get: () => ({}) }) as Record<string, never>
  const sips = (runs: { argv: string[] }[]) => runs.filter(r => r.argv.join(' ').includes('sips')).length

  test('a subagent image only gets its raw write until the viewer shows it', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x.jpg', tool_use_id: 'toolu_sub', agentId: 'agent-1' } as never)
    expect(runs).toHaveLength(1)
    expect(sips(runs)).toBe(0)
    const tree = await $.ui.render(PANE as never)
    expect(runs).toHaveLength(2)
    expect(sips(runs)).toBe(1)
    expect(JSON.stringify(tree)).toContain('/tmp/t/claude-loupe/')
    expect(JSON.stringify(tree)).toContain('.png')
    expect(JSON.stringify(tree)).toContain('"type":"Image"')
    await $.ui.render(PANE as never)
    expect(runs).toHaveLength(2)
  })

  test('a failed conversion shows the error and is tried again next time', async ($, on) => {
    const io = intercept(on, anyFile)
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x.jpg', tool_use_id: 'toolu_sub2', agentId: 'agent-1' } as never)
    io.fail()
    const tree = JSON.stringify(await $.ui.render(PANE as never))
    expect(tree).toContain('conversion failed')
    expect(tree).not.toContain('"type":"Image"')
    io.fail(false)
    expect(JSON.stringify(await $.ui.render(PANE as never))).toContain('"type":"Image"')
  })

  test('a subagent png needs no conversion at all', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('tool.call', async () => ({ result: IMAGE as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x.png', tool_use_id: 'toolu_sub3', agentId: 'agent-1' } as never)
    await $.ui.render(PANE as never)
    expect(runs).toHaveLength(1)
  })

  test('a main-loop jpeg is converted at once, as before', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/x.jpg', tool_use_id: 'toolu_main' } as never)
    expect(runs).toHaveLength(2)
    expect(sips(runs)).toBe(1)
    await $.ui.render(PANE as never)
    expect(runs).toHaveLength(2)
  })
})

describe('registry ids for tool images', () => {
  const JPEG = { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }
  const PNG = { type: 'image', file: { base64: pngB64(8, 8), type: 'image/png' } }
  const anyFile = new Proxy({}, { has: () => true, get: () => ({}) }) as Record<string, never>
  const PANE = {
    plugin: 'loupe',
    surface: 'terminal' as const,
    component: 'Pane' as const,
    requestId: 'loupe',
    props: { title: 'Loupe', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 100, rows: 40 },
  }
  const sub = ($: Engine, id: string) => $.tool.call({ tool: 'Read', file_path: '/x.jpg', tool_use_id: id, agentId: 'a1' } as never)
  const total = async ($: Engine) =>
    Number(/Loupe: (\d+) image/.exec(JSON.stringify(await $.command.run({ command: 'loupe', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })))?.[1])
  const sips = (runs: { argv: string[] }[]) => runs.filter(r => r.argv.join(' ').includes('sips')).length

  test('an eager resolve after the cache evicted a pending item reuses its number', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    let output: unknown = JPEG
    on('tool.call', async () => ({ result: output as never }))
    await start($)
    await sub($, 'toolu_d')
    expect(await total($)).toBe(1)
    output = PNG
    for (let i = 0; i < SOURCE_CACHE_MAX + 1; i++) await $.tool.call({ tool: 'Read', file_path: '/p.png', tool_use_id: `toolu_e${i}` } as never)
    expect(await total($)).toBe(SOURCE_CACHE_MAX + 2)
    expect(sips(runs)).toBe(0)
    await result($, 'toolu_d', JPEG)
    expect(sips(runs)).toBe(1)
    expect(await total($)).toBe(SOURCE_CACHE_MAX + 2)
  })

  test('an eager resolve of a still pending item settles it without a second item', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await sub($, 'toolu_h')
    await result($, 'toolu_h', JPEG)
    expect(await total($)).toBe(1)
    expect(sips(runs)).toBe(1)
    await $.ui.render(PANE as never)
    expect(sips(runs)).toBe(1)
  })

  test('a lazy call repeated after the item settled adds nothing', async ($, on) => {
    const { runs } = intercept(on, anyFile)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await sub($, 'toolu_r')
    await $.ui.render(PANE as never)
    expect(sips(runs)).toBe(1)
    await sub($, 'toolu_r')
    expect(await total($)).toBe(1)
    await $.ui.render(PANE as never)
    expect(sips(runs)).toBe(1)
  })
})

describe('/loupe clear', () => {
  const message = ($: Engine, text: string) =>
    $.ui.render({ surface: 'terminal', component: 'AssistantMessage', requestId: 'msg-1', viewport: { columns: 100, rows: 40 }, props: { text, isFirstOfReply: true } })
  const JPEG = { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }
  const files = new Proxy({ '/u/a.png': { b64: pngB64(10, 10) } } as Record<string, unknown>, {
    has: (t, k) => k in t || (typeof k === 'string' && k.startsWith('/tmp/t/claude-loupe/')),
    get: (t, k) => (k in t ? t[k as string] : {}),
  }) as Record<string, never>
  const PANE = {
    plugin: 'loupe',
    surface: 'terminal' as const,
    component: 'Pane' as const,
    requestId: 'loupe',
    props: { title: 'Loupe', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
    viewport: { columns: 100, rows: 40 },
  }
  const loupe = ($: Engine, args: string) =>
    $.command.run({ command: 'loupe', args, origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } })

  test('empties the list and removes only this session cache files', async ($, on) => {
    const { runs } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await message($, '![a](/u/a.png)')
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_m' } as never)
    await $.tool.call({ tool: 'Read', file_path: '/s.jpg', tool_use_id: 'toolu_s', agentId: 'a1' } as never)
    const text = JSON.stringify(await loupe($, ' clear '))
    expect(text).toContain('cleared 3 images')
    const rm = runs.filter(r => r.argv[0] === '/bin/rm')
    expect(rm).toHaveLength(1)
    const argv = rm[0]?.argv ?? []
    expect(argv.slice(0, 3)).toEqual(['/bin/rm', '-f', '--'])
    const paths = argv.slice(3)
    expect(paths).toHaveLength(3)
    expect(paths.every(p => p.startsWith('/tmp/t/claude-loupe/'))).toBe(true)
    expect(paths).not.toContain('/u/a.png')
    expect(paths).toContain('/tmp/t/claude-loupe/toolu_m-0.jpg')
    expect(paths).toContain('/tmp/t/claude-loupe/toolu_s-0.jpg')
    expect(JSON.stringify(await $.ui.render(PANE as never))).toContain('no images yet')
    expect(JSON.stringify(await loupe($, 'clear'))).toContain('no images yet')
    expect(runs.filter(r => r.argv[0] === '/bin/rm')).toHaveLength(1)
  })

  test('rows that redraw after clear write nothing and add nothing, new ids still work', async ($, on) => {
    const { runs } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_old' } as never)
    await result($, 'toolu_res', JPEG)
    await group($, 'g', [call('toolu_grp', [JPEG])])
    await loupe($, 'clear')
    const before = runs.length
    for (const tree of [await result($, 'toolu_old', JPEG), await result($, 'toolu_res', JPEG), await group($, 'g', [call('toolu_grp', [JPEG])])]) {
      expect(JSON.stringify(tree)).toBe(JSON.stringify(await result($, 'toolu_none', 'plain')))
    }
    expect(runs.length).toBe(before)
    expect(JSON.stringify(await loupe($, ''))).toContain('no images yet')
    await $.tool.call({ tool: 'Read', file_path: '/n.jpg', tool_use_id: 'toolu_new' } as never)
    expect(JSON.stringify(await loupe($, ''))).toContain('Loupe: 1 image')
    expect(JSON.stringify(await result($, 'toolu_new', JPEG))).toContain('"type":"Image"')
  })

  test('clear bumps the viewer epoch so the pane redraws even when already at the latest', async ($, on) => {
    intercept(on, files)
    const values: unknown[] = []
    on('state.set', async (_$, e, next) => {
      values.push(e.value)
      return next(e)
    })
    await start($)
    await loupe($, 'clear')
    await loupe($, 'clear')
    const epochs = values.map(v => (v as { epoch?: number }).epoch)
    expect(epochs).toEqual([1, 2])
  })

  test('a second clear does not forget ids cleared by the first', async ($, on) => {
    const { runs } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/a.jpg', tool_use_id: 'toolu_A' } as never)
    await loupe($, 'clear')
    await $.tool.call({ tool: 'Read', file_path: '/b.jpg', tool_use_id: 'toolu_B' } as never)
    await loupe($, 'clear')
    const before = runs.length
    const plain = JSON.stringify(await result($, 'toolu_none', 'plain'))
    expect(JSON.stringify(await result($, 'toolu_A', JPEG))).toBe(plain)
    expect(JSON.stringify(await result($, 'toolu_B', JPEG))).toBe(plain)
    expect(runs.length).toBe(before)
    expect(JSON.stringify(await loupe($, ''))).toContain('no images yet')
  })

  test('a write in flight during clear adds no item and its file stays tracked', async ($, on) => {
    const { runs, hold, clock } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    const release = hold()
    const pending = $.tool.call({ tool: 'Read', file_path: '/r.jpg', tool_use_id: 'toolu_race' } as never)
    await clock.settle()
    expect(JSON.stringify(await loupe($, 'clear'))).toContain('no images yet')
    release()
    await pending
    await clock.settle()
    expect(JSON.stringify(await loupe($, ''))).toContain('no images yet')
    const before = runs.filter(r => r.argv[0] === '/usr/bin/touch').length
    await clock.advance(61 * 60 * 1000)
    const touch = runs.filter(r => r.argv[0] === '/usr/bin/touch')
    expect(touch.length).toBeGreaterThan(before)
    expect(touch.at(-1)?.argv.some(p => p.endsWith('/toolu_race-0.jpg'))).toBe(true)
    await loupe($, 'clear')
    expect(runs.filter(r => r.argv[0] === '/bin/rm').at(-1)?.argv.some(p => p.endsWith('/toolu_race-0.jpg'))).toBe(true)
  })

  test('clear keeps a cache-dir file that an assistant message referenced', async ($, on) => {
    const { runs } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_k' } as never)
    await message($, '![k](/tmp/t/claude-loupe/toolu_k-0.jpg)')
    await loupe($, 'clear')
    const paths = (runs.find(r => r.argv[0] === '/bin/rm')?.argv ?? []).slice(3)
    expect(paths).not.toContain('/tmp/t/claude-loupe/toolu_k-0.jpg')
    expect(paths.length).toBeGreaterThan(0)
  })

  test('a spared referenced file is still touched hourly, never removed, however its path is spelled', async ($, on) => {
    const { runs, clock } = intercept(on, files)
    on('ui.open', async () => ({ value: { isPlaced: true as const } }))
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_k' } as never)
    await message($, '![k](/private/tmp//t/./claude-loupe/toolu_k-0.jpg)')
    await loupe($, 'clear')
    await loupe($, 'clear')
    const kept = '/tmp/t/claude-loupe/toolu_k-0.jpg'
    expect(runs.filter(r => r.argv[0] === '/bin/rm').every(r => !r.argv.includes(kept))).toBe(true)
    await clock.advance(61 * 60 * 1000)
    const touch = runs.filter(r => r.argv[0] === '/usr/bin/touch').at(-1)
    expect(touch?.argv).toContain(kept)
  })

  test('a long list is removed in chunks', async ($, on) => {
    const { runs } = intercept(on, files)
    on('tool.call', async () => ({ result: { type: 'image', file: { base64: pngB64(4, 4), type: 'image/png' } } as never }))
    await start($)
    for (let i = 0; i < 250; i++) await $.tool.call({ tool: 'Read', file_path: '/p.png', tool_use_id: `toolu_c${i}` } as never)
    await loupe($, 'clear')
    const rm = runs.filter(r => r.argv[0] === '/bin/rm')
    expect(rm.map(r => r.argv.length - 3)).toEqual([100, 100, 50])
  })

  test('plain /loupe still opens the viewer and removes nothing', async ($, on) => {
    const { runs } = intercept(on, files)
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true as const } }
    })
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_m' } as never)
    expect(JSON.stringify(await loupe($, ''))).toContain('Loupe: 1 image')
    expect(opened).toEqual(['loupe'])
    expect(runs.some(r => r.argv[0] === '/bin/rm')).toBe(false)
  })
})

describe('cache file refresh', () => {
  const JPEG = { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }

  test('touches this session files hourly and a new session.start replaces the timer', async ($, on) => {
    const { runs, clock } = intercept(on, {})
    on('tool.call', async () => ({ result: JPEG as never }))
    await start($)
    await start($)
    await $.tool.call({ tool: 'Read', file_path: '/m.jpg', tool_use_id: 'toolu_t' } as never)
    const touches = () => runs.filter(r => r.argv[0] === '/usr/bin/touch')
    await clock.advance(59 * 60 * 1000)
    expect(touches()).toHaveLength(0)
    await clock.advance(2 * 60 * 1000)
    expect(touches()).toHaveLength(1)
    const argv = touches()[0]?.argv ?? []
    expect(argv.slice(0, 3)).toEqual(['/usr/bin/touch', '-c', '--'])
    expect(argv.slice(3).sort()).toHaveLength(2)
    expect(argv.slice(3).every(p => p.startsWith('/tmp/t/claude-loupe/'))).toBe(true)
  })

  test('nothing is touched when the session wrote no files', async ($, on) => {
    const { runs, clock } = intercept(on, {})
    await start($)
    await clock.advance(3 * 60 * 60 * 1000)
    expect(runs.some(r => r.argv[0] === '/usr/bin/touch')).toBe(false)
  })
})

describe('written extensions', () => {
  test('odd mime subtypes get a safe extension that the prune covers', async () => {
    resetSourceCache()
    const { $, runs } = io({})
    await resolveToolImage($, 'a', { base64: 'AAAA', mime: 'image/svg+xml' })
    await resolveToolImage($, 'b', { base64: 'AAAA', mime: 'image/x-weird;v=1' })
    await resolveToolImage($, 'c', { base64: 'AAAA', mime: 'image/JPEG' })
    const raws = runs.filter(r => r.stdin !== undefined).map(r => r.argv.at(-1) as string)
    expect(raws).toEqual(['/tmp/t/claude-loupe/a.svg', '/tmp/t/claude-loupe/b.img', '/tmp/t/claude-loupe/c.jpg'])
    const prune = pruneArgv('/tmp/t/claude-loupe')
    for (const raw of raws) expect(prune).toContain(`*.${raw.split('.').pop()}`)
    expect(prune).toContain('-iname')
    expect(prune).not.toContain('-name')
  })
})
describe('canonicalPath', () => {
  test('collapses slashes and dots and unifies /private aliases', () => {
    expect(canonicalPath('//a/./b/../c')).toBe('/a/c')
    expect(canonicalPath('/private/var/folders/x')).toBe('/var/folders/x')
    expect(canonicalPath('/private/tmp/t')).toBe('/tmp/t')
    expect(canonicalPath('/private/other')).toBe('/private/other')
  })
})
