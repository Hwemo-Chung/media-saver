#!/bin/bash
# [media-saver] Q1 — two-pass GIF (palette PNG in a temp file) on the 12 s 720p clip
cd "$(dirname "$0")/.."
for w in 480 720; do
  out=out/T2-12s-15fps-$w-twopass.gif; rm -f "$out" out/_p.png
  vf="fps=15,scale=w=$w:h=$w:force_original_aspect_ratio=decrease:flags=lanczos"
  /usr/bin/time -l bash -c "ffmpeg -hide_banner -nostdin -loglevel error -i fixtures/clip720.mp4 -vf '$vf,palettegen=stats_mode=diff' -update 1 out/_p.png && \
    ffmpeg -hide_banner -nostdin -loglevel error -i fixtures/clip720.mp4 -i out/_p.png -filter_complex '[0:v]$vf[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle' -an $out" 2>out/_t.txt
  echo "two-pass 12s 15fps long-side $w: $(grep -E ' real' out/_t.txt | awk '{print $1}') s, peak RSS $(grep 'maximum resident' out/_t.txt | awk '{printf "%d", $1/1048576}') MB (largest child), $(stat -f %z $out) B"
  grep -vE '^ +[0-9]|real|user|sys' out/_t.txt | head -3
done
rm -f out/_p.png out/_t.txt
cmp -s out/T2-12s-15fps-480-twopass.gif out/A-12s-15fps-480.gif && echo "480: byte-identical to one-pass A" || echo "480: differs from one-pass A"
# same via the library builder (convert-lib.mjs gifTwoPassArgs)
node --input-type=module -e "
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { FFMPEG, run, gifTwoPassArgs } from './scripts/convert-lib.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-saver-'));
const out = 'out/T3-12s-15fps-480-lib-twopass.gif'; fs.rmSync(out, { force: true });
const [p1, p2] = gifTwoPassArgs({ input: 'fixtures/clip720.mp4', output: out, palettePath: path.join(tmp, 'pal.png'), fps: 15, maxSide: 480 });
const a = await run(FFMPEG, p1), b = await run(FFMPEG, p2);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('gifTwoPassArgs exit', a.code, b.code, 'identical to one-pass A:', Buffer.compare(fs.readFileSync(out), fs.readFileSync('out/A-12s-15fps-480.gif')) === 0);"
