export type Viewer = { index: number; epoch?: number }

declare module 'claude-code' {
  interface PluginState {
    gallery: { viewer: Viewer }
  }
}
