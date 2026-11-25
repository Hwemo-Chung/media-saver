#!/bin/bash
# Helper smoke test: real ffmpeg, real host.js over stdio. Not part of `npm test`.
# Fixtures go under $HOME (the path rule requires it) and are removed on exit.
#   bash tests/e2e/helper-smoke.sh          (SMOKE_REVEAL=1 also opens Finder once)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
FFMPEG="${FFMPEG:-/opt/homebrew/bin/ffmpeg}"
FFPROBE="${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}"
NODE="${NODE:-$(command -v node)}"
BASE="$HOME/Library/Caches/media-saver-helper-test"
WORK="$BASE/run-$$"
OUTSIDE="/tmp/media-saver-helper-smoke-$$.ts"

cleanup() {
  rm -f -- "$OUTSIDE"
  case "$WORK" in
    "$BASE"/run-*) rm -rf -- "$WORK" ;;
  esac
  rmdir "$BASE" 2>/dev/null || true
}
trap cleanup EXIT

mkdir -p "$WORK"
ff() { "$FFMPEG" -hide_banner -loglevel error -nostdin -y "$@"; }

# 4 s test clip: testsrc2 + 440 Hz sine
ff -f lavfi -i testsrc2=size=320x240:rate=25:duration=4 -f lavfi -i sine=frequency=440:duration=4 \
   -c:v libx264 -pix_fmt yuv420p -c:a aac -f mpegts "$WORK/clip.ts"
ff -f lavfi -i testsrc2=size=320x240:rate=25:duration=4 -an -c:v libx264 -pix_fmt yuv420p "$WORK/mv.video.mp4"
ff -f lavfi -i sine=frequency=660:duration=4 -vn -c:a aac "$WORK/mv.audio.m4a"
ff -f lavfi -i sine=frequency=330:duration=4 -c:a aac -f adts "$WORK/tone.aac"
cp "$WORK/clip.ts" "$WORK/clip2.ts"
cp "$WORK/clip.ts" "$WORK/del.ts"
cp "$WORK/clip.ts" "$OUTSIDE"
head -c 4096 /dev/zero > "$WORK/bad.ts"
echo "not media" > "$WORK/notes.txt"
printf 'WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nHello\n\n00:00:02.000 --> 00:00:03.500\nWorld\n' > "$WORK/en.vtt"
printf '1\n00:00:00,000 --> 00:00:01,500\n안녕하세요\n\n2\n00:00:02,000 --> 00:00:03,500\n세계\n' > "$WORK/ko.srt"

echo "fixtures in $WORK"
"$NODE" "$ROOT/tests/e2e/helper-smoke-driver.js" "$ROOT/helper/host.js" "$WORK" "$OUTSIDE" "$FFPROBE"
