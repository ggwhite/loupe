/** The zoom of the image whose registry id is `id`: a level and the crop's centre in image pixels. */
export type Zoom = { id: string; level: number; cx: number; cy: number }
export type Viewer = { index: number; epoch?: number; zoom?: Zoom }

declare module 'claude-code' {
  interface PluginState {
    loupe: { viewer: Viewer }
  }
}
