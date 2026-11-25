#!/bin/bash
# [media-saver] Q6 — risk probes: long GIF memory, hwaccel decode, animated inputs, NFC/NFD names, JPEG size vs q.
set -uo pipefail
cd "$(dirname "$0")/.."
FF=/opt/homebrew/bin/ffmpeg
rss() { grep 'maximum resident set size' "$1" | awk '{printf "%d MB", $1/1048576}'; }
wall() { grep -E '^ +[0-9.]+ real' "$1" | awk '{print $1 " s"}'; }
T=out/_time.txt

echo "== 1. 60 s GIF, 15 fps, long side 720: one pass (split) vs two pass (palette file) =="
rm -f out/L1-60s-onepass.gif out/L2-60s-twopass.gif out/_pal.png
/usr/bin/time -l $FF -hide_banner -nostdin -loglevel error -ss 60 -to 120 -i fixtures/long600.mp4 -filter_complex \
  "[0:v]fps=15,scale=w=720:h=720:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  -an out/L1-60s-onepass.gif 2>$T; echo "one pass : $(wall $T), peak RSS $(rss $T), $(stat -f %z out/L1-60s-onepass.gif) B"
/usr/bin/time -l bash -c "$FF -hide_banner -nostdin -loglevel error -ss 60 -to 120 -i fixtures/long600.mp4 -vf 'fps=15,scale=w=720:h=720:force_original_aspect_ratio=decrease:flags=lanczos,palettegen=stats_mode=diff' -update 1 out/_pal.png && \
  $FF -hide_banner -nostdin -loglevel error -ss 60 -to 120 -i fixtures/long600.mp4 -i out/_pal.png -filter_complex '[0:v]fps=15,scale=w=720:h=720:force_original_aspect_ratio=decrease:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle' -an out/L2-60s-twopass.gif" 2>$T
echo "two pass : $(wall $T), peak RSS $(rss $T) (largest child), $(stat -f %z out/L2-60s-twopass.gif) B"
rm -f out/_pal.png

echo "== 2. scene detection on 10 min 720p: software vs VideoToolbox decode =="
/usr/bin/time -l $FF -hide_banner -nostdin -i fixtures/long600.mp4 -an -vf "select='gt(scene,0.3)'" -fps_mode vfr -f null - 2>$T; echo "software     : $(wall $T), peak RSS $(rss $T)"
/usr/bin/time -l $FF -hide_banner -nostdin -hwaccel videotoolbox -i fixtures/long600.mp4 -an -vf "select='gt(scene,0.3)'" -fps_mode vfr -f null - 2>$T; echo "videotoolbox : $(wall $T), peak RSS $(rss $T)"

echo "== 3. animated inputs =="
rm -f out/AW-anim-webp-to.gif out/AG-anim-gif-frames-*.jpg
$FF -hide_banner -nostdin -loglevel error -i fixtures/img/07-anim.webp -filter_complex "[0:v]split[a][b];[a]palettegen[p];[b][p]paletteuse" out/AW-anim-webp-to.gif && \
  ffprobe -v error -count_frames -show_entries stream=width,height,nb_read_frames -of compact=p=0 out/AW-anim-webp-to.gif | sed 's/^/anim webp -> gif: /'
$FF -hide_banner -nostdin -loglevel error -i fixtures/img/06-anim.gif -vf "select='not(mod(n,10))'" -fps_mode vfr -q:v 3 out/AG-anim-gif-frames-%02d.jpg && \
  echo "anim gif every 10th frame -> $(ls out/AG-anim-gif-frames-*.jpg | wc -l | tr -d ' ') jpg"

echo "== 4. NFC vs NFD Korean file names (APFS) =="
node --input-type=module -e "
import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const nfc = '한글 파일.jpg'.normalize('NFC'), nfd = nfc.normalize('NFD');
const dir = path.resolve('out/_names'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
fs.copyFileSync('fixtures/img/01-landscape.jpg', path.join(dir, nfd));               // stored as NFD (like some Finder copies)
console.log('bytes NFC', Buffer.byteLength(nfc), 'NFD', Buffer.byteLength(nfd));
console.log('existsSync(NFC name) on NFD file:', fs.existsSync(path.join(dir, nfc)));
const rp = fs.realpathSync(path.join(dir, nfc));
console.log('realpath returns NFD form:', path.basename(rp) === nfd, '| NFC form:', path.basename(rp) === nfc);
console.log('readdir name === NFC string:', fs.readdirSync(dir)[0] === nfc, '| after .normalize(\"NFC\"):', fs.readdirSync(dir)[0].normalize('NFC') === nfc);
const out = path.join(dir, '한글 파일.gif');
execFileSync('$FF', ['-hide_banner','-loglevel','error','-nostdin','-n','-i', path.join(dir, nfc), '-frames:v','1', out]);
console.log('ffmpeg via NFC path on NFD file -> output exists:', fs.existsSync(out));
"

echo "== 5. JPEG bytes per page vs -q:v (1280x720 frames) =="
for q in 2 3 5 8; do
  s=0; for t in 1 5 9; do
    $FF -hide_banner -nostdin -loglevel error -y -ss $t -i fixtures/scenes.mp4 -frames:v 1 -q:v $q -update 1 out/_q.jpg; s=$((s + $(stat -f %z out/_q.jpg)))
  done
  echo "q=$q : avg $((s / 3 / 1024)) KB/frame over testsrc2(1s) mandelbrot(5s) cellauto-noise(9s)"
done
rm -f out/_q.jpg $T
