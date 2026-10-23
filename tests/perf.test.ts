import type { RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, test } from 'claude-code/testing'

import { register, resolveToolImage } from '../hooks/register'
import { resetRegistry } from '../hooks/registry'
import { Lru, MEMO_MAX, SOURCE_CACHE_MAX, resetSourceCache } from '../hooks/source'
import { intercept, io, pngB64 } from './fixtures'

const start = async ($: Engine) => {
  resetSourceCache()
  resetRegistry()
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
}

const IMAGE = { type: 'image', file: { base64: pngB64(640, 480), type: 'image/png' } }

/** 每次被 toolImages 走訪（讀 type）就加一。 */
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

/** 直接呼叫已註冊的 ui.render hook：引擎會複製 props，Proxy 在引擎裡數不到走訪次數。 */
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
    const { prunes } = intercept(on, {})
    await start($)
    await new Promise(r => setTimeout(r, 0))
    expect(prunes).toHaveLength(1)
    const argv = prunes[0] as string[]
    expect(argv.slice(0, 7)).toEqual(['/usr/bin/find', '/tmp/t/claude-gallery', '-maxdepth', '1', '-type', 'f', '-mmin'])
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
    console.log(`walks=${hits.walks} imageReads=${hits.images} runs=${h.runs.length}`)
    expect(hits.images).toBe(33)
  })
})

describe('lazy conversion for subagent images', () => {
  const JPEG = { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }
  const PANE = {
    plugin: 'gallery',
    surface: 'terminal' as const,
    component: 'Pane' as const,
    requestId: 'gallery',
    props: { title: '圖片檢視', isFocused: true, bodyColumns: 80, placement: 'inline' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} },
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
    expect(JSON.stringify(tree)).toContain('/tmp/t/claude-gallery/')
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
    expect(tree).toContain('轉檔失敗')
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
