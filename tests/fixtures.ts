import type { EngineInterface, On } from 'claude-code'
import { mock } from 'claude-code/testing'

export function pngB64(w: number, h: number): string {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const v = new DataView(b.buffer)
  v.setUint32(16, w)
  v.setUint32(20, h)
  return btoa(String.fromCharCode(...b))
}

type FakeFile = { b64?: string; mtime?: number; size?: number; tooBig?: boolean }

/**
 * A stand-in `$` over a fake file map. The engine refuses fs, process and env
 * calls from a module whose registered hooks do not call them, so a helper
 * under test cannot take the engine's own `$` until a hook uses it.
 */
export function io(files: Record<string, FakeFile>) {
  const runs: { argv: string[]; stdin?: string }[] = []
  let exitCode = 0
  const env: Record<string, string> = { HOME: '/Users/u', TMPDIR: '/tmp/t/' }
  const $ = {
    env: { get: async (name: string) => env[name] },
    fs: {
      stat: async (path: string) => {
        const f = files[path]
        if (!f) throw new Error('ENOENT')
        return { kind: 'file' as const, size: f.size ?? 100, mtimeMs: f.mtime ?? 1, isLink: false }
      },
      exists: async (path: string) => path in files,
      read: async (path: string) => {
        const f = files[path] ?? (path.startsWith('/tmp/t/claude-gallery/') ? { b64: pngB64(800, 600) } : undefined)
        if (!f?.b64 || f.tooBig) throw new Error('too big or missing')
        return { base64: f.b64 }
      },
    },
    process: {
      run: async (argv: readonly string[], init?: { stdin?: string }) => {
        runs.push({ argv: [...argv], stdin: init?.stdin })
        return { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
      },
    },
  } as unknown as EngineInterface
  return {
    $,
    runs,
    fail: (isFailing = true) => {
      exitCode = isFailing ? 1 : 0
    },
  }
}

export const ENGINE_ROW = 'engine row'

/** The same fake file map, served through the real test engine's fs, process and env events. */
export function intercept(on: On, files: Record<string, FakeFile>, env: Record<string, string> | null = { HOME: '/Users/u', TMPDIR: '/tmp/t/' }) {
  const runs: { argv: string[]; stdin?: string }[] = []
  const stats: { path: string; resolve: boolean }[] = []
  let exitCode = 0
  if (env !== null) mock.env(on, env)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: ENGINE_ROW }))
  on('fs.stat', async (_$, e) => {
    stats.push({ path: e.path, resolve: e.resolve })
    const f = files[e.path]
    if (!f) throw new Error('ENOENT')
    return { value: { kind: 'file' as const, size: f.size ?? 100, mtimeMs: f.mtime ?? 1, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('fs.exists', async (_$, e) => ({ value: e.path in files }))
  on('fs.read', async (_$, e) => {
    const f = files[e.path] ?? (e.path.startsWith(`${(env?.['TMPDIR'] ?? '/tmp').replace(/\/+$/, '')}/claude-gallery/`) ? { b64: pngB64(800, 600) } : undefined)
    if (!f?.b64 || f.tooBig) throw new Error('too big or missing')
    return { value: { base64: f.b64 } }
  })
  on('process.run', async (_$, e) => {
    runs.push({ argv: [...e.argv], stdin: e.init?.stdin })
    return { value: { exitCode, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return {
    runs,
    stats,
    fail: (isFailing = true) => {
      exitCode = isFailing ? 1 : 0
    },
  }
}
