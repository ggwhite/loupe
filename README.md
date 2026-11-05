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
- **A full-screen viewer.** Press a thumbnail's `⤢ view #n` button (or `⤢` on a tool row), or run `/loupe`, to open the viewer on that image. Step through every image of the session with `h` and `l`. Inside [herdr](https://herdr.dev) the image fills the whole herdr window (see [Full-screen viewer in herdr](#full-screen-viewer-in-herdr)); elsewhere it opens in a Claude Code pane.
- **Zoom and pan.** Zoom in to 2×, 3×, 4×, 6× or 8× and move around the image to read the detail. The viewer crops the image and draws the crop at full size, so what you see is real pixels, not a blurry upscale of the thumbnail.

## Full-screen viewer in herdr

A Claude Code pane can never be wider than 45% of the terminal when docked, and the engine has no fullscreen pane. So inside herdr loupe does not draw the viewer in Claude Code at all: it opens a herdr pane of its own, zooms it over the whole window, and runs `bin/loupe-view` in it. The image covers herdr's normal view until you press `q`; then the pane closes and the focus is back on your session.

```text
herdr window, the loupe pane zoomed over everything
─────────────────────────────────────────────────────────────────────────────────────────

              the image, as large as the window allows,
              centred, its aspect ratio kept


─────────────────────────────────────────────────────────────────────────────────────────
[‹] [›] [−] [+] [fit] [✕]  2/5 · 2× · settings-page.png   h/l prev/next  i/o zoom  wasd pan
```

| Key | Action |
| --- | --- |
| `h` / `l` | Previous / next image (the zoom resets) |
| `i` / `o` | Zoom in / out one level (1×, 2×, 3×, 4×, 6×, 8×) |
| `z` | Toggle 2× at the centre of the image |
| `0` | Fit the whole image |
| `w` `a` `s` `d` | Pan up / left / down / right by half of what is visible |
| `q` or `Esc` | Quit, close the pane |

### Mouse

The viewer turns on the terminal's mouse reporting (SGR, `CSI ? 1000 h`, `1002 h`, `1006 h`) while it runs and turns it off again on every way out.

| Mouse | Action |
| --- | --- |
| Wheel up / down | Zoom in / out one level, about the pointer: the image point under it stays where it is |
| Left drag | Pan: the image follows the pointer (the view follows every 2 cells and settles on release, since each crop takes about 100 ms) |
| Double-click | Toggle 2× at the clicked point (two presses within 400 ms on the same cell, give or take one) |
| Click on the left / right tenth of the screen | Previous / next image |
| Click on a status bar button | `[‹]` `[›]` previous / next, `[−]` `[+]` zoom out / in, `[fit]` fit, `[✕]` quit, the same as their keys |

The right and middle buttons do nothing. When the window is narrow the key hints after the buttons shrink to `h/l i/o wasd 0 z q`, or are left out.

herdr passes mouse events on to a pane whose program asks for them, with its default `mouse_capture = true`, so nothing needs setting. The right button stays herdr's pane menu unless `right_click_passthrough_modifier` is set in herdr's `config.toml`.

If any herdr step fails (or you are not in herdr), loupe opens the Claude Code pane below instead. In that pane, inside herdr, `f` (`⛶ full`) tries the full-screen viewer again at the image you are on.

`bin/loupe-view` also runs on its own in any terminal that draws kitty graphics from files: `bin/loupe-view 1 a.png b.png` (the number counts from 1). `bin/loupe-view --self-test` checks its fit and crop math against the numbers `hooks/layout.ts` gives.

## Keys in the Claude Code pane

The keys work while the viewer has the focus (it takes it when it opens).

| Key | Action |
| --- | --- |
| `h` / `l` | Previous / next image (the zoom resets) |
| `z` | Toggle 2× at the centre of the image |
| `0` | Fit the whole image |
| `i` / `o` | Zoom in / out one level (1×, 2×, 3×, 4×, 6×, 8×); also the `+` / `−` buttons |
| `w` `a` `s` `d` | Pan up / left / down / right by half of what is visible |
| `f` | Open the full-screen viewer at this image (shown inside herdr only) |
| `x` or `Esc` | Close the viewer |

The title line shows where you are: `2 of 5 · 2× · settings-page.png`.

## Requirements

- **Claude Code** with mods (plugins with a hooks module) enabled.
- **A terminal that draws images** with the kitty graphics protocol, such as [herdr](https://herdr.dev) or kitty.
- **macOS.** Conversion and cropping use the built-in `sips`.
- The environment variable `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`, so Claude Code draws images even when it cannot detect the terminal's support.
- Optional: **herdr**, for the full-window viewer. Outside herdr the viewer opens at the size the Claude Code layout gives it. The full-window viewer needs nothing to install: it is a bash script that uses `sips`, `base64` and `stty`.

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
- **herdr.** When `HERDR_ENV=1` and `HERDR_PANE_ID` is set at session start, opening the viewer runs `herdr pane split --pane $HERDR_PANE_ID --direction right --focus --cwd $HOME`, reads the new pane's id from the JSON answer, runs `herdr pane zoom --pane <new> --on`, and then `herdr pane run <new> "'<mod>/bin/loupe-view' <n> '<png>' ..."` with every image of the session, each path single-quoted. Images a subagent read are converted to PNG first. If the zoom or the run fails, loupe closes the pane it split and falls back to the Claude Code pane.
- **loupe-view.** The script switches to the alternate screen, hides the cursor and draws with the kitty graphics protocol, passing the file's path rather than its bytes (`a=T,f=100,t=f`), since herdr does not draw directly transmitted images. It asks the terminal for its cell size (`CSI 16 t`) and counts a cell as 1:2 when there is no answer. Zoom crops are made with `sips` into `$TMPDIR/claude-loupe/view/`, once per file and crop. Before each draw it deletes the previous image; it redraws when the terminal is resized, and restores the terminal on exit.

## Limits

- **Pane width.** Docked beside a fullscreen transcript, a Claude Code pane is capped at 45% of the terminal's columns. Inside herdr the full-screen viewer avoids the cap; elsewhere it applies.
- **Full-screen viewer.** It needs herdr for the pane it opens, and a terminal that reads kitty images from a file path (`t=f`), so a remote session whose files are on another machine cannot use it. It shows the images loupe had when it opened; images that arrive later need another open.
- **No mouse zoom in the Claude Code pane.** There the wheel and drags do nothing; use the keys and buttons. The full-screen viewer in herdr has [mouse](#mouse) zoom and pan.
- **No `=` / `-` keys.** Claude Code hotkeys are single letters or digits, so zooming one level at a time is on `i` and `o` (the `+` and `−` buttons). In a pane narrower than 40 columns the buttons are left out and `i: in` / `o: out` join the key line instead.
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
