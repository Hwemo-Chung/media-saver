#!/bin/bash
# [media-saver] Q2 — build PDFs with the pure-Node writer and with pdf-lib, then verify each one.
set -uo pipefail
cd "$(dirname "$0")/.."
B="node scripts/build-pdf.mjs"
build() { # engine fit manifest out title
  /usr/bin/time -l $B "$@" 2>/tmp/ms-time.$$ | tr -d '\n'
  echo " procPeakRssMB=$(( $(grep 'maximum resident set size' /tmp/ms-time.$$ | awk '{print $1}') / 1048576 ))"
}
rm -f out/*.pdf
build mini  image out/frames-every2s/manifest.json      out/pdf-mini-every2s.pdf        "clip720 every 2 s"
build mini  image out/frames-scene-scenes/manifest.json out/pdf-mini-scenes.pdf         "scenes.mp4 scene changes"
build mini  image out/frames-scene-nocuts/manifest.json out/pdf-mini-nocuts.pdf         "no cuts fallback"
build mini  image out/frames-long-seek/manifest.json    out/pdf-mini-long60.pdf         "long600 60 frames"
build mini  a4    out/images-normalised/manifest.json   "out/이미지 모음 (A4).pdf"        "이미지 모음 한글 제목"
build pdflib image out/frames-scene-scenes/manifest.json out/pdf-lib-scenes.pdf         "scenes.mp4 scene changes"
build pdflib image out/frames-long-seek/manifest.json   out/pdf-lib-long60.pdf          "long600 60 frames"
build pdflib a4    out/images-normalised/manifest.json  out/pdf-lib-images-a4.pdf       "이미지 모음 한글 제목"
# lossless page: PNG with alpha flattened on white -> raw rgb24 -> /FlateDecode
node --input-type=module -e "
import fs from 'node:fs'; import { execFileSync } from 'node:child_process'; import { writePdf } from './scripts/pdf-mini.mjs';
const rgb = execFileSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner','-loglevel','error','-i','fixtures/img/03-alpha.png','-filter_complex',
 '[0:v]format=rgba,split[i][s];[s]drawbox=c=white:t=fill[w];[w][i]overlay,format=rgb24','-f','rawvideo','-'], { maxBuffer: 1<<28 });
console.log(JSON.stringify(writePdf('out/pdf-mini-lossless-png.pdf', [{ rgb, width: 800, height: 600, caption: '03-alpha.png lossless FlateDecode' }], { fit: 'a4', title: 'lossless' })));"
# pdf-lib cannot take WebP/GIF directly:
node --input-type=module -e "
import fs from 'node:fs'; import { PDFDocument } from 'pdf-lib';
const d = await PDFDocument.create();
for (const f of ['fixtures/img/04-still.webp','fixtures/img/06-anim.gif']) {
  try { await d.embedPng(fs.readFileSync(f)); console.log('pdf-lib embedPng', f, 'OK'); }
  catch (e) { try { await d.embedJpg(fs.readFileSync(f)); console.log('pdf-lib embedJpg', f, 'OK'); } catch (e2) { console.log('pdf-lib rejects', f, '->', e2.message.split('\n')[0]); } }
}"
echo "=== verify ==="
for f in out/*.pdf; do
  echo "--- $f"
  file -b "$f"
  pdfinfo "$f" 2>/tmp/pdfinfo.err | grep -E "^(Pages|Page size|PDF version|Title|Producer):" | tr -s ' ' | paste -sd ';' -
  [ -s /tmp/pdfinfo.err ] && echo "pdfinfo STDERR: $(head -2 /tmp/pdfinfo.err)"
  pdfimages -list "$f" 2>/dev/null | awk 'NR>2 {print $4"/"$5"x"$6"/"$9}' | sort | uniq -c | head -3 | tr '\n' ' '; echo
  pdftoppm -f 1 -l 1 -r 36 -png "$f" /tmp/ms-p1 2>/tmp/pdftoppm.err; [ -s /tmp/pdftoppm.err ] && echo "pdftoppm STDERR: $(head -2 /tmp/pdftoppm.err)" || echo "pdftoppm page1 render: OK (no stderr)"
  ls -l "$f" | awk '{print "bytes="$5}'
done
rm -f /tmp/ms-p1*.png /tmp/ms-time.$$ /tmp/pdfinfo.err /tmp/pdftoppm.err
echo "=== strict xref check (pdf-mini outputs) ==="
node scripts/check-xref.mjs out/pdf-mini-*.pdf "out/이미지 모음 (A4).pdf"
echo "=== Spotlight page count ==="
for f in out/pdf-mini-long60.pdf "out/이미지 모음 (A4).pdf"; do printf "%s: " "$f"; mdls -name kMDItemNumberOfPages "$f"; done
