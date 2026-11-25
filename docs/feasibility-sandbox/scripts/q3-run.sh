#!/bin/bash
# [media-saver] Q3 — build .pptx with 3 engines, then verify (unzip -t, python-pptx re-open, Quick Look render).
set -uo pipefail
cd "$(dirname "$0")/.."
SC=out/frames-scene-scenes/manifest.json
IM=out/images-normalised/manifest.json
rm -f out/*.pptx
node scripts/q3-pptx.mjs mini      $SC "out/장면 모음 mini (테스트).pptx" "장면 모음 한글 제목"
node scripts/q3-pptx.mjs mini      $IM out/pptx-mini-images.pptx      "이미지 모음"
node scripts/q3-pptx.mjs pptxgenjs $SC out/pptxgenjs-scenes.pptx      "장면 모음 한글 제목"
node scripts/q3-pptx.mjs pptxgenjs $IM out/pptxgenjs-images.pptx      "이미지 모음"
venv/bin/python -I scripts/q3_pptx.py build $SC out/python-pptx-scenes.pptx "장면 모음 한글 제목"
venv/bin/python -I scripts/q3_pptx.py build $IM out/python-pptx-images.pptx "이미지 모음"
echo "=== file / unzip -t ==="
for f in out/*.pptx; do
  printf "%-40s %s | " "$f" "$(file -b "$f" | cut -c1-60)"
  unzip -tq "$f" 2>&1 | tail -1
done
echo "=== parts in the hand-built package ==="
unzip -l out/pptx-mini-images.pptx | awk 'NR>3 {print $4}' | grep -v '^$' | sed -n '1,8p;$p' | paste -sd ' ' -
echo "=== python-pptx re-open ==="
venv/bin/python -I scripts/q3_pptx.py verify out/*.pptx
echo "=== Quick Look thumbnails ==="
qlmanage -t -s 640 -o evidence out/*.pptx 2>&1 | grep -E "produced|Done|error" | sed 's#.*/out/#out/#'
