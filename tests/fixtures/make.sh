#!/usr/bin/env bash
# Builds the media fixtures for the Media Saver end-to-end tests into tests/fixtures/out/
# (gitignored). Idempotent: each run deletes and rebuilds every fixture directory.
#
# Needs: ffmpeg + ffprobe (FFMPEG/FFPROBE override), cwebp (this ffmpeg build has no WebP
# encoder), openssl, node. Written for macOS /bin/bash 3.2 and BSD tools.
#
# Exit status is non-zero when any build step or any check in the summary failed.
# Full tool output goes to out/make.log.

set -o pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/out"
WORK="$OUT/.work"
LOG="$OUT/make.log"
TOOL="$HERE/fixture-tool.mjs"

if [ -z "${FFMPEG:-}" ]; then
  if [ -x /opt/homebrew/bin/ffmpeg ]; then FFMPEG=/opt/homebrew/bin/ffmpeg; else FFMPEG="$(command -v ffmpeg)"; fi
fi
FFPROBE="${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}"
CWEBP="${CWEBP:-$(command -v cwebp || echo /opt/homebrew/bin/cwebp)}"
OPENSSL="${OPENSSL:-$(command -v openssl)}"
NODE="${NODE:-$(command -v node)}"

# ---- fixed values the tests rely on -------------------------------------------------------
DURATION=12                                   # base clip length, seconds
LIVE_SEGMENTS=40                              # live simulator pool: seg0.ts .. seg39.ts
KEY_HEX=6d656469612d73617665722d6b657921      # AES-128 key = ASCII "media-saver-key!"
IV_HEX=a1b2c3d4e5f60718293a4b5c6d7e8f90       # explicit IV used by hls-aes/media-iv.m3u8
AES_FIRST_SEQ=5                               # hls-aes/media.m3u8 EXT-X-MEDIA-SEQUENCE (IV = seq no.)

X264="-c:v libx264 -profile:v high -preset veryfast -pix_fmt yuv420p -r 30 -g 60 -keyint_min 60 -sc_threshold 0"
V720="$X264 -b:v 2000k -maxrate 2400k -bufsize 4000k"
V360="$X264 -b:v 600k -maxrate 720k -bufsize 1200k"
A128="-c:a aac -b:a 128k -ar 48000 -ac 2"
A96="-c:a aac -b:a 96k -ar 48000 -ac 2"

# testsrc2 already prints a small running timestamp at its top-left corner; crop it and paint it
# back 4x larger so the time is readable in every frame. Audio: 440 Hz sine with a beep each second.
source_graph() { # source_graph <seconds>
  echo "testsrc2=size=1280x720:rate=30:duration=$1,split[bg][tsrc];[tsrc]crop=104:18:0:0,scale=iw*4:ih*4:flags=neighbor[big];[bg][big]overlay=0:0[v];sine=frequency=440:beep_factor=2:sample_rate=48000:duration=$1[a]"
}

FAILED=""
log() { printf '%s\n' "$*" >>"$LOG"; }
step() { # step <name> <function>: runs the function in a set -e subshell, records failure
  local name=$1 rc
  printf '==> %-18s' "$name"
  log "" "===== $name ====="
  ( set -e; "$2" ) >>"$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo ok; else echo "FAILED (rc=$rc, see $LOG)"; FAILED="$FAILED $name"; fi
}
ff() { "$FFMPEG" -hide_banner -nostdin -loglevel error -y "$@"; }
probe() { "$FFPROBE" -v error "$@"; }
fresh() { rm -rf "$OUT/$1"; mkdir -p "$OUT/$1"; }

# hls_pack <input> <dir> <playlist> <segment pattern> [ffmpeg output args...]
hls_pack() {
  local in=$1 dir=$2 pl=$3 seg=$4
  shift 4
  mkdir -p "$dir"
  ff -i "$in" "$@" -c copy -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type vod \
    -hls_segment_filename "$dir/$seg" "$dir/$pl"
}

aac_codec() { # RFC 6381 string of the first audio stream, from its ffprobe profile
  local p
  p=$(probe -select_streams a:0 -show_entries stream=profile -of default=nw=1:nk=1 "$1")
  case "$p" in
    LC) echo mp4a.40.2 ;;
    HE-AAC) echo mp4a.40.5 ;;
    HE-AACv2) echo mp4a.40.29 ;;
    *) echo "unknown AAC profile '$p' in $1" >&2; return 1 ;;
  esac
}
bw_of() { "$NODE" "$TOOL" bw "$@"; }              # prints "<peak> <average>"
first() { echo "${1%% *}"; }
second() { echo "${1#* }"; }

# ---- build steps --------------------------------------------------------------------------

build_mezzanine() {
  rm -rf "$WORK"; mkdir -p "$WORK"
  # 12 s 720p and 360p from one graph so both renditions carry identical frames.
  ff -filter_complex "$(source_graph $DURATION);[v]split[v1][v2];[v2]scale=640:360[v360];[a]asplit[a1][a2]" \
    -map '[v1]' -map '[a1]' $V720 $A128 -movflags +faststart "$WORK/mezz720.mp4" \
    -map '[v360]' -map '[a2]' $V360 $A96 -movflags +faststart "$WORK/mezz360.mp4"
  # 80 s 720p for the live pool: same settings, one continuous timeline.
  local live=$((LIVE_SEGMENTS * 2))
  ff -filter_complex "$(source_graph $live)" -map '[v]' -map '[a]' $V720 $A128 -movflags +faststart "$WORK/live80.mp4"
}

build_direct() {
  fresh direct
  cp "$WORK/mezz720.mp4" "$OUT/direct/clip.mp4"
  ff -f lavfi -i "sine=frequency=660:beep_factor=3:sample_rate=44100:duration=$DURATION" \
    -ac 2 -c:a libmp3lame -b:a 128k "$OUT/direct/tone.mp3"
}

# Writes one segmented WebVTT subtitle track: <dir>/index.m3u8 + seg000.vtt..seg005.vtt.
# Cue 4 (7.0-9.0 s) crosses the 8 s segment boundary, so it is repeated in seg003 and seg004
# the way real packagers do; a merger should keep it once (6 unique cues per language).
write_subs() { # write_subs <dir> <mpegts> <text prefix>
  local dir=$1 mpegts=$2 prefix=$3 i
  mkdir -p "$dir"
  local starts="00:00:00.500 00:00:02.300 00:00:04.200 00:00:07.000 00:00:09.300 00:00:10.400"
  local ends="00:00:01.700 00:00:03.600 00:00:05.500 00:00:09.000 00:00:09.900 00:00:11.600"
  # cue numbers carried by each 2 s segment
  local segcues="1 2 3 4 4,5 6"
  set -- $segcues
  i=0
  for cues in "$@"; do
    {
      printf 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:%s,LOCAL:00:00:00.000\n' "$mpegts"
      for c in $(echo "$cues" | tr ',' ' '); do
        printf '\n%s --> %s\n%s %s\n' "$(echo $starts | cut -d' ' -f$c)" "$(echo $ends | cut -d' ' -f$c)" "$prefix" "$c"
      done
    } >"$dir/$(printf 'seg%03d.vtt' $i)"
    i=$((i + 1))
  done
  {
    printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n'
    for n in 0 1 2 3 4 5; do printf '#EXTINF:2.000000,\nseg%03d.vtt\n' $n; done
    printf '#EXT-X-ENDLIST\n'
  } >"$dir/index.m3u8"
}

build_hls_ts() {
  fresh hls-ts
  local D="$OUT/hls-ts"
  hls_pack "$WORK/mezz360.mp4" "$D/360p" index.m3u8 'seg%03d.ts'
  hls_pack "$WORK/mezz720.mp4" "$D/720p" index.m3u8 'seg%03d.ts'
  # X-TIMESTAMP-MAP must name the real first video PTS of the TS segments.
  local p720 p360
  # (ffprobe lists a TS stream once per program as well, hence head -1)
  p720=$(probe -select_streams v:0 -show_entries stream=start_pts -of default=nw=1:nk=1 "$D/720p/seg000.ts" | head -1)
  p360=$(probe -select_streams v:0 -show_entries stream=start_pts -of default=nw=1:nk=1 "$D/360p/seg000.ts" | head -1)
  case "$p720" in '' | *[!0-9]*) echo "bad start PTS '$p720'"; return 1 ;; esac
  [ -n "$p720" ] && [ "$p720" = "$p360" ] || { echo "start PTS differ: 720p=$p720 360p=$p360"; return 1; }
  echo "$p720" >"$WORK/ts-start-pts"
  write_subs "$D/subs/en" "$p720" "EN cue"
  write_subs "$D/subs/ko" "$p720" "한국어 자막"
  local c360 c720 acodec b360 b720
  c360=$("$NODE" "$TOOL" avc1 "$WORK/mezz360.mp4")
  c720=$("$NODE" "$TOOL" avc1 "$WORK/mezz720.mp4")
  acodec=$(aac_codec "$WORK/mezz720.mp4")
  b360=$(bw_of "$D/360p/index.m3u8")
  b720=$(bw_of "$D/720p/index.m3u8")
  cat >"$D/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,FORCED=NO,URI="subs/en/index.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Korean",LANGUAGE="ko",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="subs/ko/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=$(first "$b360"),AVERAGE-BANDWIDTH=$(second "$b360"),RESOLUTION=640x360,FRAME-RATE=30.000,CODECS="$c360,$acodec",SUBTITLES="subs"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=$(first "$b720"),AVERAGE-BANDWIDTH=$(second "$b720"),RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="$c720,$acodec",SUBTITLES="subs"
720p/index.m3u8
EOF
}

build_hls_fmp4() {
  fresh hls-fmp4
  local D="$OUT/hls-fmp4" c720 acodec b
  hls_pack "$WORK/mezz720.mp4" "$D" media.m3u8 'seg%03d.m4s' \
    -hls_segment_type fmp4 -hls_fmp4_init_filename init.mp4
  [ -f "$D/init.mp4" ] || { echo "no init.mp4"; return 1; }
  grep -q '#EXT-X-MAP:URI="init.mp4"' "$D/media.m3u8"
  c720=$("$NODE" "$TOOL" avc1 "$WORK/mezz720.mp4")
  acodec=$(aac_codec "$WORK/mezz720.mp4")
  b=$(bw_of "$D/media.m3u8" "$D/init.mp4")
  cat >"$D/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:7
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=$(first "$b"),AVERAGE-BANDWIDTH=$(second "$b"),RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="$c720,$acodec"
media.m3u8
EOF
}

# hls-aes/media.m3u8    : no IV attribute -> IV = media sequence number (starts at 5), seg005..seg010.ts
# hls-aes/media-iv.m3u8 : IV=0x$IV_HEX on every segment, iv000..iv005.ts
# Plaintext of both is byte-identical to hls-ts/720p/seg000..seg005.ts.
build_hls_aes() {
  fresh hls-aes
  local D="$OUT/hls-aes" SRC="$OUT/hls-ts/720p/index.m3u8" td i seq src
  printf '%s' "$KEY_HEX" | xxd -r -p >"$D/key.bin"
  [ "$(wc -c <"$D/key.bin" | tr -d ' ')" = 16 ]
  td=$(sed -n 's/^#EXT-X-TARGETDURATION://p' "$SRC")
  local durs uris
  durs=($(sed -n 's/^#EXTINF:\([0-9.]*\),.*/\1/p' "$SRC"))
  uris=($(grep -v '^#' "$SRC" | grep .))
  [ ${#uris[@]} -gt 0 ]
  [ ${#durs[@]} -eq ${#uris[@]} ]
  {
    printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%s\n#EXT-X-MEDIA-SEQUENCE:%s\n#EXT-X-PLAYLIST-TYPE:VOD\n' "$td" "$AES_FIRST_SEQ"
    printf '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
  } >"$D/media.m3u8"
  {
    printf '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:%s\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n' "$td"
    printf '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x%s\n' "$IV_HEX"
  } >"$D/media-iv.m3u8"
  i=0
  while [ $i -lt ${#uris[@]} ]; do
    src="$OUT/hls-ts/720p/${uris[$i]}"
    seq=$((AES_FIRST_SEQ + i))
    "$OPENSSL" aes-128-cbc -e -K "$KEY_HEX" -iv "$(printf '%032x' $seq)" -in "$src" -out "$D/$(printf 'seg%03d.ts' $seq)"
    "$OPENSSL" aes-128-cbc -e -K "$KEY_HEX" -iv "$IV_HEX" -in "$src" -out "$D/$(printf 'iv%03d.ts' $i)"
    printf '#EXTINF:%s,\nseg%03d.ts\n' "${durs[$i]}" $seq >>"$D/media.m3u8"
    printf '#EXTINF:%s,\niv%03d.ts\n' "${durs[$i]}" $i >>"$D/media-iv.m3u8"
    # independent oracle: decrypting with the expected IV gives the plaintext back exactly
    "$OPENSSL" aes-128-cbc -d -K "$KEY_HEX" -iv "$(printf '%032x' $seq)" -in "$D/$(printf 'seg%03d.ts' $seq)" | cmp -s - "$src"
    "$OPENSSL" aes-128-cbc -d -K "$KEY_HEX" -iv "$IV_HEX" -in "$D/$(printf 'iv%03d.ts' $i)" | cmp -s - "$src"
    i=$((i + 1))
  done
  printf '#EXT-X-ENDLIST\n' >>"$D/media.m3u8"
  printf '#EXT-X-ENDLIST\n' >>"$D/media-iv.m3u8"
  if grep -q 'IV=' "$D/media.m3u8"; then echo "media.m3u8 must not carry IV"; return 1; fi
}

build_hls_altaudio() {
  fresh hls-altaudio
  local D="$OUT/hls-altaudio" c720 acodec bv ba pv pa
  # One muxer for both renditions so they share a timeline (two separate runs shift the
  # audio-only TS by the video's B-frame delay, ~45 ms off).
  ff -i "$WORK/mezz720.mp4" -map 0:v -map 0:a -c copy -f hls -hls_time 2 -hls_list_size 0 \
    -hls_playlist_type vod -var_stream_map "v:0,name:video a:0,name:audio" \
    -hls_segment_filename "$D/%v/seg%03d.ts" "$D/%v/index.m3u8"
  pv=$(probe -select_streams v:0 -show_entries stream=start_pts -of default=nw=1:nk=1 "$D/video/seg000.ts" | head -1)
  pa=$(probe -select_streams a:0 -show_entries stream=start_pts -of default=nw=1:nk=1 "$D/audio/seg000.ts" | head -1)
  echo "alt-audio start PTS: video=$pv audio=$pa"
  [ "$pv" = "$(cat "$WORK/ts-start-pts")" ]
  c720=$("$NODE" "$TOOL" avc1 "$WORK/mezz720.mp4")
  acodec=$(aac_codec "$WORK/mezz720.mp4")
  bv=$(bw_of "$D/video/index.m3u8")
  ba=$(bw_of "$D/audio/index.m3u8")
  cat >"$D/master.m3u8" <<EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=$(($(first "$bv") + $(first "$ba"))),AVERAGE-BANDWIDTH=$(($(second "$bv") + $(second "$ba"))),RESOLUTION=1280x720,FRAME-RATE=30.000,CODECS="$c720,$acodec",AUDIO="aud"
video/index.m3u8
EOF
}

build_hls_byterange() {
  fresh hls-byterange
  local D="$OUT/hls-byterange"
  hls_pack "$WORK/mezz720.mp4" "$D" media.m3u8 media.ts -hls_flags single_file
  grep -q '^#EXT-X-BYTERANGE:' "$D/media.m3u8"
}

dash_pack() { # dash_pack <dir> <use_timeline 0|1> <media_seg_name>
  ff -i "$WORK/mezz360.mp4" -i "$WORK/mezz720.mp4" -map 0:v -map 1:v -map 1:a -c copy \
    -f dash -seg_duration 2 -use_template 1 -use_timeline "$2" \
    -adaptation_sets "id=0,streams=v id=1,streams=a" \
    -init_seg_name 'init-$RepresentationID$.$ext$' -media_seg_name "$3" "$OUT/$1/manifest.mpd"
}

build_dash_timeline() {
  fresh dash-timeline
  dash_pack dash-timeline 1 'chunk-$RepresentationID$-$Time$.$ext$'
  grep -q '<SegmentTimeline>' "$OUT/dash-timeline/manifest.mpd"
  # ffmpeg names the first AAC chunk by its pre-roll time (chunk-2--1024.m4s) while the MPD
  # timeline starts at t="0"; rename it to the name the MPD resolves to.
  local f id
  for f in "$OUT"/dash-timeline/chunk-*--*.m4s; do
    [ -e "$f" ] || continue
    id=$(basename "$f" | sed 's/^chunk-\(.*\)--[0-9]*\.m4s$/\1/')
    mv "$f" "$OUT/dash-timeline/chunk-$id-0.m4s"
    echo "renamed $(basename "$f") -> chunk-$id-0.m4s"
  done
}

build_dash_number() {
  fresh dash-number
  dash_pack dash-number 0 'chunk-$RepresentationID$-$Number%05d$.$ext$'
  if grep -q '<SegmentTimeline>' "$OUT/dash-number/manifest.mpd"; then return 1; fi
}

# Hand-written on-demand MPD: one whole-file BaseURL per representation, SegmentBase with the
# Initialization range (ftyp+moov) and indexRange (sidx) read from the files themselves.
build_dash_base() {
  fresh dash-base
  local D="$OUT/dash-base" vs as vdur adur dur cv acodec vbw abw
  ff -i "$WORK/mezz720.mp4" -map 0:v -c copy -movflags +frag_keyframe+empty_moov+default_base_moof+global_sidx -f mp4 "$D/video.mp4"
  ff -i "$WORK/mezz720.mp4" -map 0:a -c copy -frag_duration 2000000 -movflags +empty_moov+default_base_moof+global_sidx -f mp4 "$D/audio.m4a"
  vs=$("$NODE" "$TOOL" sidx "$D/video.mp4")   # "<init> <index> <refs>"
  as=$("$NODE" "$TOOL" sidx "$D/audio.m4a")
  vdur=$(probe -show_entries format=duration -of default=nw=1:nk=1 "$D/video.mp4")
  adur=$(probe -show_entries format=duration -of default=nw=1:nk=1 "$D/audio.m4a")
  dur=$(printf '%s\n%s\n' "$vdur" "$adur" | sort -g | tail -1)
  cv=$("$NODE" "$TOOL" avc1 "$D/video.mp4")
  acodec=$(aac_codec "$D/audio.m4a")
  vbw=$(awk -v b="$(wc -c <"$D/video.mp4")" -v d="$vdur" 'BEGIN{printf "%d", b*8/d}')
  abw=$(awk -v b="$(wc -c <"$D/audio.m4a")" -v d="$adur" 'BEGIN{printf "%d", b*8/d}')
  cat >"$D/manifest.mpd" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011" minBufferTime="PT2S" mediaPresentationDuration="PT$(printf '%.3f' "$dur")S">
  <Period id="0" start="PT0S">
    <AdaptationSet id="0" contentType="video" mimeType="video/mp4" segmentAlignment="true" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="video-720p" codecs="$cv" width="1280" height="720" frameRate="30" sar="1:1" bandwidth="$vbw">
        <BaseURL>video.mp4</BaseURL>
        <SegmentBase indexRange="$(echo $vs | cut -d' ' -f2)" indexRangeExact="true">
          <Initialization range="$(echo $vs | cut -d' ' -f1)"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" lang="en" subsegmentAlignment="true" subsegmentStartsWithSAP="1">
      <Representation id="audio-en" codecs="$acodec" audioSamplingRate="48000" bandwidth="$abw">
        <AudioChannelConfiguration schemeIdUri="urn:mpeg:dash:23003:3:audio_channel_configuration:2011" value="2"/>
        <BaseURL>audio.m4a</BaseURL>
        <SegmentBase indexRange="$(echo $as | cut -d' ' -f2)" indexRangeExact="true">
          <Initialization range="$(echo $as | cut -d' ' -f1)"/>
        </SegmentBase>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
EOF
  echo "dash-base sidx video: $vs | audio: $as"
}

build_live() {
  fresh live
  hls_pack "$WORK/live80.mp4" "$WORK/live-hls" live.m3u8 'seg%d.ts' -start_number 0
  mv "$WORK"/live-hls/seg*.ts "$OUT/live/"
  local n
  n=$(ls "$OUT/live" | grep -c '^seg[0-9]*\.ts$')
  [ "$n" -eq $LIVE_SEGMENTS ] || { echo "live: expected $LIVE_SEGMENTS segments, got $n"; return 1; }
}

# img <file> <w> <h> <lavfi source> <label 0|1>. Label = testsrc's digit counter showing the
# image width, centred on the background (this ffmpeg has no drawtext).
img() {
  local file=$1 w=$2 h=$3 src=$4 label=$5 graph png lw lh
  png="$WORK/img-$w-$h.png"
  case "$src" in *=*) graph="$src:size=${w}x${h}:rate=1" ;; *) graph="$src=size=${w}x${h}:rate=1" ;; esac
  if [ "$label" = 1 ]; then
    lw=$((w / 4 * 2)); lh=$((h / 4 * 2))
    graph="$graph[bg];testsrc=size=${lw}x${lh}:rate=1/$w:decimals=0,trim=start_frame=1:end_frame=2,setpts=PTS-STARTPTS[lbl];[bg][lbl]overlay=(W-w)/2:(H-h)/2"
  fi
  case "$file" in
    *.png) ff -filter_complex "$graph" -frames:v 1 -update 1 -pix_fmt rgb24 "$OUT/images/$file" ;;
    *.jpg) ff -filter_complex "$graph" -frames:v 1 -update 1 -pix_fmt yuvj420p -q:v 3 "$OUT/images/$file" ;;
    *.webp)
      ff -filter_complex "$graph" -frames:v 1 -update 1 -pix_fmt rgb24 "$png"
      "$CWEBP" -quiet -q 80 "$png" -o "$OUT/images/$file" ;;
  esac
}

build_images() {
  fresh images
  img icon-48x48.png 48 48 testsrc2 0
  img thumb-120x90.jpg 120 90 smptebars 0
  ff -f lavfi -i "life=size=200x200:rate=5:mold=10:ratio=0.1:death_color=#C83232:life_color=#00ff00" \
    -frames:v 10 -loop 0 "$OUT/images/anim-200x200.gif"
  img small-320x240.webp 320 240 colorspectrum 1
  img banner-468x60.png 468 60 rgbtestsrc 1
  img portrait-360x640.jpg 360 640 zoneplate 1
  img photo-800x600.jpg 800 600 mandelbrot 1
  img hero-1600x900.png 1600 900 smptehdbars 1
  img square-1200x1200.webp 1200 1200 gradients 1
  img srcset-1x-400x300.jpg 400 300 pal75bars 1
  img srcset-2x-800x600.jpg 800 600 yuvtestsrc 1
  img css-bg-640x360.webp 640 360 cellauto 1
  img lazy-1024x768.jpg 1024 768 color=c=0x2a6f97 1
}

# DRM samples: only the signalling matters (the extension must flag them as protected).
# Segments are plain copies of normal ones.
build_drm() {
  fresh drm
  local D="$OUT/drm" SRC="$OUT/hls-ts/720p/index.m3u8"
  cp "$OUT"/hls-ts/720p/seg*.ts "$D/"
  {
    printf '#EXTM3U\n#EXT-X-VERSION:5\n'
    grep -E '^#EXT-X-(TARGETDURATION|MEDIA-SEQUENCE|PLAYLIST-TYPE):' "$SRC"
    printf '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://fake",KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"\n'
    grep -v -E '^#(EXTM3U|EXT-X-VERSION|EXT-X-TARGETDURATION|EXT-X-MEDIA-SEQUENCE|EXT-X-PLAYLIST-TYPE)' "$SRC"
  } >"$D/hls.m3u8"
  cp "$OUT"/dash-number/*.m4s "$D/"
  awk '
    /xmlns="urn:mpeg:dash:schema:mpd:2011"/ { print; print "\txmlns:cenc=\"urn:mpeg:cenc:2013\""; next }
    /<AdaptationSet/ {
      print
      print "\t\t\t<ContentProtection schemeIdUri=\"urn:mpeg:dash:mp4protection:2011\" value=\"cenc\" cenc:default_KID=\"00000000-0000-0000-0000-00000000fa4e\"/>"
      print "\t\t\t<ContentProtection schemeIdUri=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\" value=\"Widevine\"><cenc:pssh>ZmFrZS13aWRldmluZS1wc3No</cenc:pssh></ContentProtection>"
      next
    }
    { print }' "$OUT/dash-number/manifest.mpd" >"$D/dash.mpd"
  grep -q 'xmlns:cenc=' "$D/dash.mpd"
  [ "$(grep -c 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' "$D/dash.mpd")" -ge 1 ]
  grep -q 'METHOD=SAMPLE-AES' "$D/hls.m3u8"
}

# ---- checks + summary ---------------------------------------------------------------------

ROWS=""
CHECK_FAILED=""
row() { ROWS="$ROWS$(printf '%-30s %-5s %9s  %s' "$1" "$2" "$3" "$4")
"; [ "$2" = ok ] || CHECK_FAILED="$CHECK_FAILED $1"; }
dur_of() { probe -show_entries format=duration -of default=nw=1:nk=1 "$1" 2>/dev/null; }
kinds_of() { probe -show_entries stream=codec_type,codec_name,width,height -of csv=p=0 "$1" 2>/dev/null | sort -u | tr '\n' ' '; }
near() { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a != "" && a - b <= 0.5 && b - a <= 0.5) }'; }

check_media() { # check_media <label> <file> <expected seconds> <need audio 0|1>
  local d k res=ok
  d=$(dur_of "$2"); k=$(kinds_of "$2")
  near "$d" "$3" || res=FAIL
  echo "$k" | grep -q 'video' || [ "$4" = audio-only ] || res=FAIL
  if [ "$4" != 0 ]; then echo "$k" | grep -q 'audio' || res=FAIL; fi
  row "$1" "$res" "$(printf '%.3f' "${d:-0}")" "$k"
}

remux_check() { # remux_check <label> <playlist> [-map ...]: HLS -> mp4 via ffmpeg, then probe
  local label=$1 pl=$2 out="$WORK/verify/$1.mp4" err
  shift 2
  if err=$(ff -allowed_extensions ALL -i "$pl" "$@" -c copy "$out" 2>&1); then
    check_media "$label" "$out" $DURATION 1
  else
    row "$label" FAIL - "$(echo "$err" | tail -1)"
  fi
}

decode_check() { # full decode must be silent at -loglevel error (proves AES decryption)
  local err
  err=$("$FFMPEG" -hide_banner -nostdin -loglevel error -allowed_extensions ALL -i "$2" -map 0 -f null - 2>&1)
  if [ -z "$err" ]; then row "$1" ok - "full decode, no errors"; else row "$1" FAIL - "$(echo "$err" | head -1)"; fi
}

dash_check() { # dash_check <label> <mpd>: fetch every representation, mux best video + audio
  local label=$1 out lines v a
  out="$WORK/verify/$label"
  if ! lines=$("$NODE" "$TOOL" dash-fetch "$2" "$out" 2>&1); then row "$label" FAIL - "$lines"; return; fi
  v=$(echo "$lines" | sed -n 's/^best-video=//p'); a=$(echo "$lines" | sed -n 's/^audio=//p')
  if ff -i "$v" -i "$a" -map 0:v -map 1:a -c copy "$out.mp4" 2>>"$LOG"; then
    check_media "$label" "$out.mp4" $DURATION 1
  else
    row "$label" FAIL - "mux failed"
  fi
}

summary() {
  mkdir -p "$WORK/verify"
  check_media direct/clip.mp4 "$OUT/direct/clip.mp4" $DURATION 1
  check_media direct/tone.mp3 "$OUT/direct/tone.mp3" $DURATION audio-only
  check_media hls-ts/master.m3u8 "$OUT/hls-ts/master.m3u8" $DURATION 1
  remux_check hls-ts-720p "$OUT/hls-ts/720p/index.m3u8" -map 0:v -map 0:a
  remux_check hls-fmp4 "$OUT/hls-fmp4/master.m3u8" -map 0:v -map 0:a
  remux_check hls-aes "$OUT/hls-aes/media.m3u8" -map 0:v -map 0:a
  decode_check hls-aes-decode "$OUT/hls-aes/media.m3u8"
  remux_check hls-aes-iv "$OUT/hls-aes/media-iv.m3u8" -map 0:v -map 0:a
  decode_check hls-aes-iv-decode "$OUT/hls-aes/media-iv.m3u8"
  remux_check hls-altaudio "$OUT/hls-altaudio/master.m3u8" -map 0:v:0 -map 0:a:0
  remux_check hls-byterange "$OUT/hls-byterange/media.m3u8" -map 0:v -map 0:a
  dash_check dash-timeline "$OUT/dash-timeline/manifest.mpd"
  dash_check dash-number "$OUT/dash-number/manifest.mpd"
  dash_check dash-base "$OUT/dash-base/manifest.mpd"
  local cat="concat:" i
  i=0; while [ $i -lt $LIVE_SEGMENTS ]; do cat="$cat$OUT/live/seg$i.ts|"; i=$((i + 1)); done
  if ff -i "${cat%|}" -c copy "$WORK/verify/live.mp4" 2>>"$LOG"; then
    check_media live/seg0-39 "$WORK/verify/live.mp4" $((LIVE_SEGMENTS * 2)) 1
  else
    row live/seg0-39 FAIL - "concat failed"
  fi
  local f wh want bad=""
  [ "$(ls "$OUT/images" 2>/dev/null | wc -l | tr -d ' ')" -ge 10 ] || bad=" fewer than 10 images"
  for f in "$OUT"/images/*; do
    [ -e "$f" ] || continue
    want=$(basename "$f" | sed -n 's/.*-\([0-9]*x[0-9]*\)\..*/\1/p')
    wh=$(probe -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$f")
    [ "$wh" = "$want" ] || bad="$bad $(basename "$f")=$wh"
  done
  if [ -z "$bad" ]; then row images/ ok - "$(ls "$OUT/images" | wc -l | tr -d ' ') files, sizes match names"; else row images/ FAIL - "$bad"; fi
  if grep -q 'METHOD=SAMPLE-AES' "$OUT/drm/hls.m3u8" && grep -q 'edef8ba9-79d6-4ace-a3c8-27dcd51d21ed' "$OUT/drm/dash.mpd"; then
    row drm/ ok - "SAMPLE-AES + Widevine ContentProtection present"
  else
    row drm/ FAIL - "DRM signalling missing"
  fi

  echo
  echo "Files under $OUT"
  printf '%-16s %6s %10s\n' DIR FILES BYTES
  local d n b
  for d in direct hls-ts hls-fmp4 hls-aes hls-altaudio hls-byterange dash-timeline dash-number dash-base live images drm; do
    if [ -d "$OUT/$d" ]; then
      n=$(find "$OUT/$d" -type f | wc -l | tr -d ' ')
      b=$(find "$OUT/$d" -type f -exec cat {} + | wc -c | tr -d ' ')
    else n=0; b=0; fi
    printf '%-16s %6s %10s\n' "$d" "$n" "$b"
  done
  echo
  printf '%-30s %-5s %9s  %s\n' CHECK RESULT DURATION STREAMS
  printf '%s' "$ROWS"
  echo
  echo "AES-128 key (key.bin) = $KEY_HEX   explicit IV = 0x$IV_HEX   first media sequence = $AES_FIRST_SEQ"
  echo "TS start PTS (X-TIMESTAMP-MAP MPEGTS) = $(cat "$WORK/ts-start-pts" 2>/dev/null)"
}

# ---- main ---------------------------------------------------------------------------------

mkdir -p "$OUT"
: >"$LOG"
missing=""
for t in "$FFMPEG" "$FFPROBE" "$CWEBP" "$OPENSSL" "$NODE"; do
  [ -n "$t" ] && [ -x "$t" ] || missing="$missing ${t:-?}"
done
command -v xxd >/dev/null || missing="$missing xxd"
if [ -n "$missing" ]; then echo "missing tools:$missing" >&2; exit 2; fi
log "ffmpeg: $FFMPEG ($("$FFMPEG" -version | head -1))"

step mezzanine build_mezzanine
step direct build_direct
step hls-ts build_hls_ts
step hls-fmp4 build_hls_fmp4
step hls-aes build_hls_aes
step hls-altaudio build_hls_altaudio
step hls-byterange build_hls_byterange
step dash-timeline build_dash_timeline
step dash-number build_dash_number
step dash-base build_dash_base
step live build_live
step images build_images
step drm build_drm

summary

rm -rf "$WORK"
if [ -n "$FAILED$CHECK_FAILED" ]; then
  echo "FAILED steps:${FAILED:- none}   failed checks:${CHECK_FAILED:- none}" >&2
  exit 1
fi
echo "All fixtures built and checked."
