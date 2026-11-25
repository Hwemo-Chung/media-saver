#!/bin/bash
# [media-saver] feasibility sandbox — generate test inputs (all synthetic, no network)
set -euo pipefail
S="$(cd "$(dirname "$0")/.." && pwd)"
F="$S/fixtures"
mkdir -p "$F"
FF="ffmpeg -hide_banner -loglevel error -nostdin -y"

# 1. 12 s 720p H.264 + AAC (main test clip)
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=12" -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=12" \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p -g 60 -c:a aac -b:a 128k -movflags +faststart "$F/clip720.mp4"

# 2. 12 s with 6 hard cuts (2 s each) for scene detection
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=2" \
    -f lavfi -i "smptehdbars=size=1280x720:rate=30:duration=2" \
    -f lavfi -i "mandelbrot=size=1280x720:rate=30" \
    -f lavfi -i "color=c=0x3060c0:size=1280x720:rate=30:duration=2" \
    -f lavfi -i "cellauto=size=1280x720:rate=30:rule=110" \
    -f lavfi -i "rgbtestsrc=size=1280x720:rate=30:duration=2" \
    -f lavfi -i "sine=frequency=330:sample_rate=48000:duration=12" \
  -filter_complex "[2:v]trim=duration=2,setpts=PTS-STARTPTS,format=yuv420p[m];[4:v]trim=duration=2,setpts=PTS-STARTPTS,format=yuv420p[c];[0:v]format=yuv420p[a];[1:v]format=yuv420p[b];[3:v]format=yuv420p[d];[5:v]format=yuv420p[e];[a][b][m][d][c][e]concat=n=6:v=1:a=0[v]" \
  -map "[v]" -map 6:a -c:v libx264 -preset medium -crf 20 -g 60 -c:a aac -b:a 128k -movflags +faststart "$F/scenes.mp4"

# 3. portrait 720x1280, 8 s
$FF -f lavfi -i "testsrc2=size=720x1280:rate=30:duration=8" -c:v libx264 -crf 20 -pix_fmt yuv420p "$F/portrait.mp4"

# 4. landscape-coded clip (1280x720) with a 90-degree display matrix (phone-style rotation metadata)
$FF -display_rotation 90 -i "$F/clip720.mp4" -c copy "$F/rotated.mp4" 2>/dev/null || \
  echo "WARN: -display_rotation unsupported"

# 5. HDR10-tagged HEVC 10-bit (BT.2020 / PQ), 4 s
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" -vf "format=yuv420p10le" \
  -c:v libx265 -preset fast -crf 22 -tag:v hvc1 \
  -x265-params "log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):max-cll=1000,400" \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc "$F/hdr10.mp4"

# 6. VP9 + Opus webm, 4 s
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" -f lavfi -i "sine=duration=4" \
  -c:v libvpx-vp9 -b:v 1M -deadline realtime -cpu-used 8 -c:a libopus "$F/vp9.webm"

# 7. AV1 (SVT-AV1) + Opus webm, 4 s
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=4" -f lavfi -i "sine=duration=4" \
  -c:v libsvtav1 -preset 10 -crf 35 -c:a libopus "$F/av1.webm"

# 8. 10-minute 720p for long-video timing (2 s GOP like typical web streams)
if [ ! -f "$F/long600.mp4" ]; then
$FF -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=600" -f lavfi -i "sine=duration=600" \
  -c:v libx264 -preset ultrafast -crf 26 -g 60 -pix_fmt yuv420p -c:a aac -b:a 96k "$F/long600.mp4"
fi

# 9. images
mkdir -p "$F/img"
$FF -f lavfi -i "mandelbrot=size=1920x1080" -frames:v 1 -q:v 2 "$F/img/01-landscape.jpg"
$FF -f lavfi -i "testsrc2=size=1080x1920" -frames:v 1 -q:v 2 "$F/img/02-portrait.jpg"
magick -size 800x600 gradient:orange-purple \( -size 800x600 xc:none -fill white -draw "circle 400,300 400,80" \) \
  -compose CopyOpacity -composite "$F/img/03-alpha.png"
magick -size 1200x800 plasma:fractal -seed 7 -quality 85 "$F/img/04-still.webp"
magick -size 640x480 pattern:checkerboard -resize 640x480 "$F/img/05-static.gif"
# animated GIF (3 s, 10 fps) and animated WebP (from the same frames)
$FF -f lavfi -i "testsrc2=size=320x240:rate=10:duration=3" -vf "split[a][b];[a]palettegen[p];[b][p]paletteuse" "$F/img/06-anim.gif"
magick "$F/img/06-anim.gif" -coalesce -quality 80 "$F/img/07-anim.webp"
cp "$F/img/01-landscape.jpg" "$F/img/08-한글 이름 테스트.jpg"
cp "$F/clip720.mp4" "$F/한글 영상 (테스트).mp4"
# JPEG with EXIF Orientation=6 (Rotate 90 CW) — exiftool from Homebrew, test input only
cp "$F/img/01-landscape.jpg" "$F/exif-orient6.jpg"
exiftool -q -overwrite_original -Orientation#=6 "$F/exif-orient6.jpg"

echo "fixtures done:"; ls -la "$F" "$F/img"
