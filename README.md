# loupe

**See the images in your Claude Code session without leaving the terminal: thumbnails in the transcript, and a full-screen viewer with zoom and pan.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-d97757.svg)](#install)

Screenshots, mockups and charts pass through a Claude Code session all the time, but the transcript only shows `[Image #1]`. loupe draws them where they appear, and opens any of them large enough to read the small print, right in the terminal.

```text
╭─ Loupe ──────────────────────────────────────────────────────────╮
│                   2 of 5 · 2× · settings-page.png                │
│                                                                  │
│      ┌────────────────────────────────────────────────────┐      │
│      │                                                    │      │
│      │                                                    │      │
│      │           the middle of the screenshot,            │      │
│      │            cropped and drawn at 2× scale           │      │
│      │                                                    │      │
│      │                                                    │      │
│      └────────────────────────────────────────────────────┘      │
│                                                                  │
│                    ‹     ›     −     +     ✕                     │
│               0: fit z: 2× w: ↑ a: ← s: ↓ d: →                   │
╰──────────────────────────────────────────────────────────────────╯
```

## What it does

- **Thumbnails in the transcript.** Images show up as pictures, under the row that produced them:
  - images Claude reads with the `Read` tool,
  - images Claude puts in a reply as Markdown, `![](/path/to/shot.png)`,
  - images returned by MCP tools, such as browser or screenshot tools.
- **A full-screen viewer.** Press a thumbnail's `⤢ view #n` button (or `⤢` on a tool row), or run `/loupe`, to open the viewer on that image. Step through every image of the session with `h` and `l`. Inside [herdr](https://herdr.dev), the session's pane is zoomed to fill the whole window while the viewer is open, and restored when it closes.
- **Zoom and pan.** Zoom in to 2×, 3×, 4×, 6× or 8× and move around the image to read the detail. The viewer crops the image and draws the crop at full size, so what you see is real pixels, not a blurry upscale of the thumbnail.

## Keys

The keys work while the viewer has the focus (it takes it when it opens).

| Key | Action |
| --- | --- |
| `h` / `l` | Previous / next image (the zoom resets) |
| `z` | Toggle 2× at the centre of the image |
| `0` | Fit the whole image |
| `−` / `+` buttons | Zoom out / in one level (1×, 2×, 3×, 4×, 6×, 8×) |
| `w` `a` `s` `d` | Pan up / left / down / right by half of what is visible |
| `x` or `Esc` | Close the viewer |

The title line shows where you are: `2 of 5 · 2× · settings-page.png`.

## Requirements

- **Claude Code** with mods (plugins with a hooks module) enabled.
- **A terminal that draws images** with the kitty graphics protocol, such as [herdr](https://herdr.dev) or kitty.
- **macOS.** Conversion and cropping use the built-in `sips`.
- The environment variable `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`, so Claude Code draws images even when it cannot detect the terminal's support.
- Optional: **herdr**, for the full-window viewer. Outside herdr the viewer opens at the size the Claude Code layout gives it.

## Install

1. Clone the repository anywhere you like:

   ```sh
   git clone https://github.com/ggwhite/loupe.git ~/src/loupe
   ```

2. Point Claude Code at it in `~/.claude/settings.json`. `CLAUDE_CODE_PLUGIN_DIRS` is a colon-separated list, so append loupe to any directories already there:

   ```json
   {
     "env": {
       "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/other-mod:/Users/you/src/loupe",
       "CLAUDE_CODE_FORCE_TERMINAL_IMAGES": "1"
     }
   }
   ```

3. Start a new Claude Code session.

## Usage

- Ask Claude to look at a screenshot, or to show you an image: thumbnails appear on their own.
- Press `⤢ view #n` under a thumbnail to open it in the viewer.
- `/loupe` opens the viewer on the newest image.
- `/loupe clear` forgets this session's images and deletes the cache files loupe wrote for them.

## How it works

- **Cache directory.** loupe writes what it needs to `$TMPDIR/claude-loupe` (or `/tmp/claude-loupe`): tool images, converted files and crops. Files older than a day are pruned when a session starts, and the files of a running session are kept fresh every hour.
- **PNG everywhere.** A PNG is drawn in place. Other formats (JPEG, GIF, WebP, HEIC, ...) are converted once with `sips -s format png`, and the result is reused as long as the source file is unchanged.
- **Lazy conversion for subagents.** Images that subagents read are only written to the cache as they are; the conversion to PNG waits until the viewer actually shows them, so a busy subagent costs nothing extra.
- **Zoom by cropping.** From the image size and the cell box the viewer has (a cell counted as twice as tall as it is wide), loupe works out which pixels are visible at the current level and position, cuts them out with `sips -c <h> <w> --cropOffset <y> <x>`, and draws that crop. Each crop is made once and reused.
- **herdr.** When `HERDR_ENV=1`, loupe asks `herdr pane layout` whether the session's pane is already zoomed. If not, it runs `herdr pane zoom --on` while the viewer is open and `--off` when it closes. A pane you zoomed yourself is left alone, and any herdr error is ignored.

## Limits

- **Pane width.** Docked beside a fullscreen transcript, a Claude Code pane is capped at 45% of the terminal's columns. herdr's zoom gives the whole session more room, but the cap still applies to the dock.
- **No mouse zoom.** There is no scroll-wheel zoom or drag-to-pan; use the keys and buttons.
- **No `=` / `-` keys.** Claude Code hotkeys are single letters or digits, so zooming one level at a time is done with the `−` / `+` buttons; the buttons are left out when the pane is narrower than 40 columns.
- **Very large files.** A PNG too large for Claude Code's file read cap still shows, but at fit only, since loupe cannot read its size.
- **Zoom depth.** The deepest level is the one that still has at least one image pixel per terminal cell, so small images may not zoom at all.

## Development

```sh
claude plugin test ~/src/loupe        # run the tests
claude plugin validate ~/src/loupe    # check the manifest and hooks module
npx -y -p typescript tsc -p .         # type-check (from the repository root)
```

The engine writes its type definitions into `.claude-plugin/types/` the first time it loads the mod.

## License

[MIT](LICENSE) © 2026 ggwhite
