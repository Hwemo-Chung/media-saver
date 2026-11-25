#!/bin/bash
# [media-saver] Q6 — HDR10 (PQ, 10-bit) handling in this ffmpeg build (no zscale / libplacebo)
set -uo pipefail
cd "$(dirname "$0")/.."
Q=(-hide_banner -nostdin -y -loglevel error)
rm -f out/hdr-*.png
ffmpeg "${Q[@]}" -ss 1 -i fixtures/clip720.mp4 -frames:v 1 -update 1 -vf scale=480:270 out/hdr-0-sdr-reference.png
ffmpeg "${Q[@]}" -ss 1 -i fixtures/hdr10.mp4 -frames:v 1 -update 1 -vf scale=480:270 out/hdr-1-no-tonemap.png
ffmpeg "${Q[@]}" -ss 1 -i fixtures/hdr10.mp4 -frames:v 1 -update 1 -vf "tonemap=hable,scale=480:270" out/hdr-2-tonemap-filter-unlinearized.png
ffmpeg "${Q[@]}" -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -ss 1 -i fixtures/hdr10.mp4 -frames:v 1 -update 1 \
  -vf "scale_vt=w=480:h=270:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le" out/hdr-3-scale_vt-to-bt709.png
echo "colorspace filter on PQ input:"
ffmpeg -hide_banner -nostdin -y -i fixtures/hdr10.mp4 -frames:v 1 -vf "colorspace=all=bt709" -f null - 2>&1 | grep -m1 -i unsupported
echo "zscale present?"; ffmpeg -hide_banner -filters 2>/dev/null | grep -cw zscale
for f in out/hdr-*.png; do
  printf "%-46s " "$f"
  ffmpeg -hide_banner -nostdin -i "$f" -vf "format=yuv444p,signalstats,metadata=print:key=lavfi.signalstats.YAVG" -f null - 2>&1 | grep -o "YAVG=[0-9.]*" | head -1
done
ffmpeg "${Q[@]}" -i out/hdr-0-sdr-reference.png -i out/hdr-1-no-tonemap.png -i out/hdr-2-tonemap-filter-unlinearized.png -i out/hdr-3-scale_vt-to-bt709.png \
  -filter_complex "[0]format=rgb24[a];[1]format=rgb24[b];[2]format=rgb24[c];[3]format=rgb24[d];[a][b][c][d]xstack=inputs=4:layout=0_0|w0_0|0_h0|w0_h0" \
  -frames:v 1 -update 1 evidence/q6-hdr-compare-2x2.png
file evidence/q6-hdr-compare-2x2.png
# full GIF through the VideoToolbox path
rm -f out/H2-hdr10-scale_vt-12fps-480.gif
/usr/bin/time -p ffmpeg "${Q[@]}" -hwaccel videotoolbox -hwaccel_output_format videotoolbox_vld -i fixtures/hdr10.mp4 -filter_complex \
  "[0:v]scale_vt=w=480:h=270:color_matrix=bt709:color_primaries=bt709:color_transfer=bt709,hwdownload,format=p010le,fps=12,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  -loop 0 out/H2-hdr10-scale_vt-12fps-480.gif 2>&1 | grep real
ffprobe -v error -count_frames -show_entries stream=width,height,nb_read_frames -of compact out/H2-hdr10-scale_vt-12fps-480.gif
