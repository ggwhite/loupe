export type Viewer = { index: number }

declare module 'claude-code' {
  interface PluginState {
    gallery: { viewer: Viewer }
  }
}
