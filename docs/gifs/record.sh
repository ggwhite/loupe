#!/usr/bin/env bash
# record.sh: re-records the README clips (animated WebP) from a real terminal window.
#
#   docs/gifs/record.sh tour|open|zoom|pan|browse|all
#   docs/gifs/record.sh --build-only <frames-dir> <name> <crop> <width> [<blank> [mp4]]
#
# --build-only encodes frames named <n>-<microseconds>.png without recording; <blank> is the
# region checked for blank frames, as fractions x,y,w,h of the cropped frame.
#
# vhs and asciinema cannot draw kitty graphics, so the clips are screenshots of a real
# window that can (Ghostty, kitty, cmux, ...), which must stay on screen while recording.
# Setup, once:
#
#   1. Open a new terminal window and run, in it:
#        cd docs/gifs/demo && herdr --session loupe-demo
#   2. Find that window's CGWindowID:  swift docs/gifs/window-id.swift
#   3. WINDOW=<id> docs/gifs/record.sh all
#
# Keys are sent with `herdr --session loupe-demo pane send-keys`, so nothing outside that
# session is typed into. Frames are taken with `screencapture -l <id>` about ten times a
# second and each is shown for as long as it was on screen, capped at MAX_HOLD_MS; while
# Claude is thinking the capture pauses.
#
# tour and open run `claude` with only this checkout's mod (--settings) and send Claude one
# short prompt. Needs bash 5 ($EPOCHREALTIME), ffmpeg (libx264), img2webp (libwebp) and
# macOS screencapture.
#
# Environment:
#   WINDOW      CGWindowID of the window that shows the loupe-demo session (required)
#   SESSION     herdr session name (loupe-demo)
#   PANE        the session's first pane (w1:p1)
#   CROP_TOUR   ffmpeg crop w:h:x:y of the herdr UI in the window (1680:1052:240:28)
#   CROP_PANE   ffmpeg crop w:h:x:y of the zoomed pane's inside (1388:1000:519:57)
#   TOUR_WIDTH  width of the tour clip (900)
#   CLIP_WIDTH  width of the feature clips (720)
#   MAX_HOLD_MS longest time one frame is held (1800)
#   QUALITY     img2webp lossy quality (70)

set -euo pipefail

if ((BASH_VERSINFO[0] < 5)); then
	echo "record.sh needs bash 5 (brew install bash)" >&2
	exit 2
fi

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
DEMO="$HERE/demo"
SESSION=${SESSION:-loupe-demo}
PANE=${PANE:-w1:p1}
CROP_TOUR=${CROP_TOUR:-1680:1052:240:28}
CROP_PANE=${CROP_PANE:-1388:1000:519:57}
TOUR_WIDTH=${TOUR_WIDTH:-900}
CLIP_WIDTH=${CLIP_WIDTH:-720}
MAX_HOLD_MS=${MAX_HOLD_MS:-1800}
QUALITY=${QUALITY:-70}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/loupe-gifs.XXXXXX")
trap 'stop_capture; rm -rf "$WORK"' EXIT

# hd ...: herdr, aimed at the demo session only (never at the session this script runs in).
hd() { env -u HERDR_PANE_ID -u HERDR_WORKSPACE_ID -u HERDR_TAB_ID herdr --session "$SESSION" "$@"; }

keys() { hd pane send-keys "$1" "${@:2}" >/dev/null; }

# type_text pane text: types text a few characters at a time, like a person.
type_text() {
	local pane=$1 text=$2 i
	for ((i = 0; i < ${#text}; i += 3)); do
		hd pane send-text "$pane" "${text:i:3}" >/dev/null
		sleep 0.06
	done
}

# --- capture: a background loop that takes a frame whenever $WORK/rec exists ----------

CAP_PID=''
start_capture() {
	FRAMES="$WORK/$1"
	mkdir -p "$FRAMES"
	touch "$WORK/rec"
	(
		n=0
		while [[ -d $FRAMES ]]; do
			if [[ -e $WORK/rec ]]; then
				t=${EPOCHREALTIME/./}
				screencapture -x -o -l "$WINDOW" -t png "$FRAMES/$(printf '%05d' $n)-$t.png" || true
				n=$((n + 1))
			else
				sleep 0.05
			fi
		done
	) &
	CAP_PID=$!
}
pause_capture() { rm -f "$WORK/rec"; sleep 0.2; }
resume_capture() { touch "$WORK/rec"; }
stop_capture() {
	[[ -n $CAP_PID ]] || return 0
	rm -f "$WORK/rec"
	kill "$CAP_PID" 2>/dev/null || true
	wait "$CAP_PID" 2>/dev/null || true
	CAP_PID=''
}
hold() { sleep "$1"; }

# Where loupe-view draws, as fractions x,y,w,h of a cropped frame: the whole pane but its
# status bar, or the zoomed pane inside the herdr UI (tour, open).
BLANK_PANE=0,0,1,0.95
BLANK_TOUR=0.166,0.028,0.826,0.9

# build name crop width blank [mp4]: frames -> docs/gifs/<name>.webp (and .mp4), each frame
# shown until the next one was taken, capped at MAX_HOLD_MS; the last frame is held
# MAX_HOLD_MS so the loop has a beat before it starts again.
build() {
	local name=$1 crop=$2 width=$3 blank=$4 scaled="$WORK/$1-scaled" list="$WORK/$1.txt"
	local frames=("$FRAMES"/*.png) args=() keep=() hold_ms=() i t next d f geom total=0
	mkdir -p "$scaled"
	ffmpeg -v error -y -pattern_type glob -i "$FRAMES/*.png" \
		-vf "crop=$crop,scale=$width:-2:flags=lanczos" "$scaled/%05d.png"
	: >"$list"
	geom=$(magick identify -format '%w %h' "$scaled/00001.png" | awk -v r="$blank" '{
		split(r, b, ","); printf "%dx%d+%d+%d", b[3] * $1, b[4] * $2, b[1] * $1, b[2] * $2 }')
	for ((i = 0; i < ${#frames[@]}; i++)); do
		t=${frames[i]##*-} t=${t%.png}
		if ((i + 1 < ${#frames[@]})); then
			next=${frames[i + 1]##*-} next=${next%.png}
			d=$(((next - t) / 1000))
		else
			d=0
		fi
		((d > MAX_HOLD_MS || i + 1 == ${#frames[@]})) && d=$MAX_HOLD_MS
		((d < 40)) && d=40
		f="$scaled/$(printf '%05d' $((i + 1))).png"
		# loupe-view clears the pane before it draws the next crop; a frame caught in between
		# is blank where it draws and is dropped, its time going to the frame before.
		if ((${#keep[@]})) && magick "$f" -crop "$geom" +repage -format '%[fx:standard_deviation < 0.01 ? 1 : 0]' info: | grep -q 1; then
			hold_ms[${#hold_ms[@]} - 1]=$((hold_ms[${#hold_ms[@]} - 1] + d))
			continue
		fi
		keep+=("$f")
		hold_ms+=("$d")
	done
	for ((i = 0; i < ${#keep[@]}; i++)); do
		d=${hold_ms[i]}
		((d > MAX_HOLD_MS)) && d=$MAX_HOLD_MS
		args+=(-d "$d" "${keep[i]}")
		total=$((total + d))
		printf "file '%s'\nduration %s\n" "${keep[i]}" "$(printf '%d.%03d' $((d / 1000)) $((d % 1000)))" >>"$list"
	done
	img2webp -loop 0 -lossy -q "$QUALITY" -m 4 -min_size "${args[@]}" -o "$HERE/$name.webp" >/dev/null
	echo "wrote $HERE/$name.webp"
	if [[ ${5-} == mp4 ]]; then
		# concat needs the last file twice to keep its duration; -t cuts the video to the WebP's length.
		printf "file '%s'\n" "${keep[-1]}" >>"$list"
		ffmpeg -v error -y -f concat -safe 0 -i "$list" -vf "fps=30,format=yuv420p" -t "$(printf '%d.%03d' $((total / 1000)) $((total % 1000)))" \
			-c:v libx264 -crf 20 -preset slow -movflags +faststart "$HERE/$name.mp4"
		echo "wrote $HERE/$name.mp4"
	fi
}

# viewer: splits a pane off PANE, zooms it over the window and runs loupe-view in it, like /loupe does.
viewer() {
	local out
	out=$(hd pane split "$PANE" --direction right --focus --cwd "$DEMO")
	VIEW=$(printf '%s' "$out" | sed -n 's/.*"pane_id":"\([^"]*\)".*/\1/p')
	hd pane zoom "$VIEW" --on >/dev/null
	hd pane run "$VIEW" "'$ROOT/bin/loupe-view' $1 specimen-04.png dusk.png" >/dev/null
	sleep 1.5
}

# --- the clips ---------------------------------------------------------------------------

# The clips are published: keep the recorder's own CLAUDE.md habits out of the reply.
NOTE="This session is recorded for a public README demo. Ignore any personal reply-format rules (language drills, corrections, quizzes, glosses, notes). Answer in plain English only, briefly."

# claude_ready: starts Claude in PANE with only this checkout's mod, unless it runs already.
claude_ready() {
	local settings="{\"env\":{\"CLAUDE_CODE_PLUGIN_DIRS\":\"$ROOT\",\"CLAUDE_CODE_FORCE_TERMINAL_IMAGES\":\"1\"}}"
	if ! hd pane get "$PANE" | grep -q '"agent":"claude"'; then
		hd pane send-text "$PANE" "clear; claude --settings '$settings' --append-system-prompt '$NOTE'"$'\n' >/dev/null
		sleep 3
	fi
	hd agent wait "$PANE" --until idle --timeout 30000 >/dev/null
}

# loupe_pane: VIEW = the pane /loupe split off PANE (the one that is not PANE).
loupe_pane() {
	VIEW=$(hd pane list | grep -o '"pane_id":"[^"]*"' | cut -d'"' -f4 | grep -vxF "$PANE" | head -1)
}

# open_viewer: types /loupe in PANE. The capture pauses from the moment herdr splits the pane
# until loupe-view has drawn, so the command line herdr types into the new pane is left out.
open_viewer() {
	local n
	type_text "$PANE" "/loupe"
	keys "$PANE" enter
	hold 0.3
	pause_capture
	VIEW=''
	for ((n = 0; n < 50 && ${#VIEW} == 0; n++)); do
		sleep 0.1
		loupe_pane
	done
	[[ -n $VIEW ]] || { echo "record.sh: /loupe opened no pane" >&2; return 1; }
	hd pane wait-output "$VIEW" --match "[fit]" --source visible --timeout 10000 >/dev/null
	sleep 0.4
	resume_capture
}

# close_viewer: q in VIEW; the capture pauses until the pane is gone, since the shell under
# loupe-view shows the command line and the prompt again before herdr closes it.
close_viewer() {
	local n
	pause_capture
	keys "$VIEW" q
	for ((n = 0; n < 50; n++)); do
		hd pane list | grep -qF "\"pane_id\":\"$VIEW\"" || break
		sleep 0.1
	done
	sleep 0.3
	resume_capture
}

# tour (15-30 s): Claude reads two images, thumbnails appear under the Read rows, /loupe opens
# the newest full screen, h steps back, i i zooms to 3x, d pans, q returns to Claude.
tour() {
	claude_ready
	start_capture tour
	hold 0.4
	type_text "$PANE" "Read specimen-04.png and dusk.png and name each in five words."
	keys "$PANE" enter
	hold 1
	pause_capture
	hd agent wait "$PANE" --until working --timeout 15000 >/dev/null || true
	hd agent wait "$PANE" --until idle --until done --timeout 120000 >/dev/null
	sleep 1
	resume_capture
	hold 2.5
	open_viewer
	hold 2
	keys "$VIEW" h
	hold 2
	keys "$VIEW" i
	hold 1.2
	keys "$VIEW" i
	hold 1.8
	keys "$VIEW" d
	hold 1.2
	close_viewer
	hold 2
	stop_capture
	build tour "$CROP_TOUR" "$TOUR_WIDTH" "$BLANK_TOUR" mp4
}

# clip_open (5-12 s): the thumbnails in the transcript, /loupe opens the viewer over the window,
# q closes it. Runs after tour, in the same Claude session, so the thumbnails are on screen.
clip_open() {
	claude_ready
	start_capture open
	hold 1.2
	open_viewer
	hold 2
	keys "$VIEW" h
	hold 2
	close_viewer
	hold 1.5
	stop_capture
	build open "$CROP_TOUR" "$CLIP_WIDTH" "$BLANK_TOUR"
}

# zoom (5-12 s): fit, then i to 2x, 3x and 4x, each a sips crop of the original; 0 back to fit.
zoom() {
	viewer 1
	start_capture zoom
	hold 1.2
	for k in i i i; do
		keys "$VIEW" "$k"
		hold 1.5
	done
	keys "$VIEW" 0
	hold 1.2
	stop_capture
	keys "$VIEW" q
	build zoom "$CROP_PANE" "$CLIP_WIDTH" "$BLANK_PANE"
}

# pan (5-12 s): at 3x, d s a a w d walks the view round and back to where it started.
pan() {
	viewer 1
	keys "$VIEW" i
	keys "$VIEW" i
	sleep 1.5
	start_capture pan
	hold 1
	for k in d s a a w d; do
		keys "$VIEW" "$k"
		hold 1
	done
	stop_capture
	keys "$VIEW" q
	build pan "$CROP_PANE" "$CLIP_WIDTH" "$BLANK_PANE"
}

# browse (5-12 s): zoomed in on image 1, l steps to image 2 at fit (the zoom resets), z toggles
# 2x there and back, h returns to image 1 at fit.
browse() {
	viewer 1
	start_capture browse
	hold 1
	keys "$VIEW" i
	hold 1.2
	keys "$VIEW" l
	hold 1.6
	keys "$VIEW" z
	hold 1.6
	keys "$VIEW" z
	hold 1
	keys "$VIEW" h
	hold 1.4
	stop_capture
	keys "$VIEW" q
	build browse "$CROP_PANE" "$CLIP_WIDTH" "$BLANK_PANE"
}

if [[ ${1-} == --build-only ]]; then
	(($# >= 5 && $# <= 7)) || { echo "usage: $0 --build-only <frames-dir> <name> <crop> <width> [<blank> [mp4]]" >&2; exit 2; }
	FRAMES=$2
	build "$3" "$4" "$5" "${6:-$BLANK_PANE}" "${7-}"
	exit
fi

: "${WINDOW:?set WINDOW to the CGWindowID of the window that shows the loupe-demo session}"
case ${1-} in
tour | zoom | pan | browse) "$1" ;;
open) clip_open ;;
all) tour && clip_open && zoom && pan && browse ;;
*)
	echo "usage: WINDOW=<id> $0 tour|open|zoom|pan|browse|all" >&2
	exit 2
	;;
esac
