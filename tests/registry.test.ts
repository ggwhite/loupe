import { describe, expect, test } from 'claude-code/testing'
import { addItem, items, resetRegistry } from '../hooks/registry'

describe('registry', () => {
  test('numbers items from 1 in order and reuses one path and generation', async () => {
    resetRegistry()
    const a = addItem({ path: '/a.png', size: null, generation: 1 }, 'a')
    const b = addItem({ path: '/b.png', size: null, generation: 1 }, 'b')
    expect(addItem({ path: '/a.png', size: null, generation: 1 }, 'again')).toBe(a)
    expect(addItem({ path: '/a.png', size: null, generation: 2 }, 'a2').n).toBe(3)
    expect([a.n, b.n]).toEqual([1, 2])
    expect(items().map(i => i.label)).toEqual(['a', 'b', 'a2'])
    resetRegistry()
    expect(items()).toHaveLength(0)
  })
})
