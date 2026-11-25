#!/usr/bin/env bash
# Proves the test server's contract with curl, ffprobe and the DASH fetcher in
# tests/fixtures/fixture-tool.mjs. Uses the server already answering on $PORT (default 47800),
# or starts one and stops it at the end. Needs the fixtures: bash tests/fixtures/make.sh
# Prints one PASS/FAIL line per check with its evidence; exit status = number of failures (max 1).

set -u -o pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
FIX="$HERE/../fixtures"
OUT="$FIX/out"
PORT="${PORT:-47800}"
BASE="http://127.0.0.1:$PORT"
REF="$BASE/p/hls-ts"
if [ -z "${FFMPEG:-}" ]; then
  if [ -x /opt/homebrew/bin/ffmpeg ]; then FFMPEG=/opt/homebrew/bin/ffmpeg; else FFMPEG="$(command -v ffmpeg)"; fi
fi
FFPROBE="${FFPROBE:-$(dirname "$FFMPEG")/ffprobe}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ms-selfcheck.XXXXXX")"
HDRS=$'Referer: '"$REF"$'\r\nCookie: ms_auth=ok\r\n'
FAILS=0
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

result() { # result <ok 0|1> <description> <evidence>
  if [ "$1" = 0 ]; then printf 'PASS  %-46s %s\n' "$2" "$3"; else printf 'FAIL  %-46s %s\n' "$2" "$3"; FAILS=$((FAILS + 1)); fi
}
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
auth() { curl -s -H "Referer: $REF" -b 'ms_auth=ok' "$@"; }
header() { tr -d '\r' | grep -i "^$1:" | head -1 | sed 's/^[^:]*: //'; }
near() { awk -v a="$1" -v b="$2" 'BEGIN{ exit !(a != "" && a - b <= 0.5 && b - a <= 0.5) }'; }
fsize() { wc -c <"$1" | tr -d ' '; }
wait_s() { sleep "$1"; }

if ! curl -s -o /dev/null "$BASE/healthz"; then
  node "$HERE/server.js" >"$TMP/server.out" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 50); do curl -s -o /dev/null "$BASE/healthz" && break; wait_s 0.1; done
  echo "started server pid $SERVER_PID: $(head -1 "$TMP/server.out")"
else
  echo "using the server already on $BASE"
fi
curl -s -X POST -o /dev/null "$BASE/__log/clear"

# ---- health + auth ---------------------------------------------------------------------------
h=$(curl -s "$BASE/healthz")
[ "$h" = ok ]; result $? "GET /healthz" "body=$h"

M="$BASE/media/hls-ts/master.m3u8"
c=$(code "$M"); [ "$c" = 403 ]; result $? "no Referer, no cookie -> 403" "$c"
c=$(code -H "Referer: $REF" "$M"); [ "$c" = 403 ]; result $? "Referer only -> 403" "$c"
c=$(code -b 'ms_auth=ok' "$M"); [ "$c" = 403 ]; result $? "cookie only -> 403" "$c"
c=$(code -H "Referer: $BASE/elsewhere" -b 'ms_auth=ok' "$M"); [ "$c" = 403 ]; result $? "non-/p/ Referer + cookie -> 403" "$c"
c=$(code -H "Referer: $REF" -b 'ms_auth=ok' "$M"); [ "$c" = 200 ]; result $? "/p/ Referer + cookie -> 200" "$c"

# ---- content types --------------------------------------------------------------------------
for pair in \
  hls-ts/master.m3u8=application/vnd.apple.mpegurl dash-number/manifest.mpd=application/dash+xml \
  hls-ts/720p/seg000.ts=video/mp2t hls-fmp4/seg000.m4s=video/iso.segment direct/clip.mp4=video/mp4 \
  dash-base/audio.m4a=audio/mp4 direct/tone.mp3=audio/mpeg hls-ts/subs/ko/seg000.vtt=text/vtt \
  images/icon-48x48.png=image/png images/photo-800x600.jpg=image/jpeg images/small-320x240.webp=image/webp \
  images/anim-200x200.gif=image/gif hls-aes/key.bin=application/octet-stream; do
  f=${pair%%=*}; want=${pair#*=}
  got=$(auth -I "$BASE/media/$f" | header content-type)
  [ "$got" = "$want" ]; result $? "Content-Type $f" "$got"
done

# ---- Range -----------------------------------------------------------------------------------
F="$OUT/hls-byterange/media.ts"; U="$BASE/media/hls-byterange/media.ts"; SIZE=$(fsize "$F")
auth -D "$TMP/h" -o "$TMP/body" -H 'Range: bytes=100-199' "$U"
st=$(head -1 "$TMP/h" | tr -d '\r'); cr=$(header content-range <"$TMP/h"); ar=$(header accept-ranges <"$TMP/h")
dd if="$F" bs=1 skip=100 count=100 2>/dev/null | cmp -s - "$TMP/body"; same=$?
[ "$st" = "HTTP/1.1 206 Partial Content" ] && [ "$cr" = "bytes 100-199/$SIZE" ] && [ "$ar" = bytes ] && [ $same = 0 ]
result $? "Range bytes=100-199 -> 206" "$st | Content-Range: $cr | 100 bytes match file"
first=$(grep -m1 '^#EXT-X-BYTERANGE:' "$OUT/hls-byterange/media.m3u8" | sed 's/^#EXT-X-BYTERANGE://')
len=${first%@*}; off=${first#*@}
auth -D "$TMP/h" -o "$TMP/body" -H "Range: bytes=$off-$((off + len - 1))" "$U"
cr=$(header content-range <"$TMP/h"); n=$(fsize "$TMP/body")
[ "$cr" = "bytes $off-$((off + len - 1))/$SIZE" ] && [ "$n" = "$len" ] && [ "$(head -c1 "$TMP/body" | xxd -p)" = 47 ]
result $? "EXT-X-BYTERANGE $first as Range" "Content-Range: $cr, $n bytes, starts 0x47"
auth -D "$TMP/h" -o "$TMP/body" -H 'Range: bytes=-500' "$U"; cr=$(header content-range <"$TMP/h")
[ "$cr" = "bytes $((SIZE - 500))-$((SIZE - 1))/$SIZE" ]; result $? "Range bytes=-500 (suffix)" "$cr"
auth -D "$TMP/h" -o "$TMP/body" -H "Range: bytes=$((SIZE - 10))-" "$U"; cr=$(header content-range <"$TMP/h")
[ "$cr" = "bytes $((SIZE - 10))-$((SIZE - 1))/$SIZE" ] && [ "$(fsize "$TMP/body")" = 10 ]; result $? "Range bytes=N- (open end)" "$cr"
auth -D "$TMP/h" -o /dev/null -H "Range: bytes=$SIZE-" "$U"
st=$(head -1 "$TMP/h" | tr -d '\r'); cr=$(header content-range <"$TMP/h")
[ "$st" = "HTTP/1.1 416 Range Not Satisfiable" ] && [ "$cr" = "bytes */$SIZE" ]; result $? "Range past end -> 416" "$st | $cr"
ib=$(grep -o 'indexRange="[0-9-]*"' "$OUT/dash-base/manifest.mpd" | head -1 | sed 's/indexRange="\(.*\)"/\1/')
auth -o "$TMP/body" -H "Range: bytes=$ib" "$BASE/media/dash-base/video.mp4"
typ=$(dd if="$TMP/body" bs=1 skip=4 count=4 2>/dev/null)
[ "$typ" = sidx ]; result $? "SegmentBase indexRange $ib -> sidx box" "box type '$typ'"

# ---- path traversal (all with valid auth) -----------------------------------------------------
for t in '/media/../../etc/passwd' '/media/%2e%2e/%2e%2e/%2e%2e/etc/passwd' '/media/..%2f..%2f..%2f..%2fetc%2fpasswd' \
  '/media/hls-ts/..%2f..%2f..%2fserver%2fserver.js' '/media/%2fetc%2fpasswd' '/media/images/%00.png'; do
  c=$(auth --path-as-is -o "$TMP/body" -w '%{http_code}' "$BASE$t")
  ! grep -q -e 'root:' -e 'createServer' "$TMP/body" && [ "$c" != 200 ]
  result $? "traversal $t" "$c"
done

# ---- live simulator ----------------------------------------------------------------------------
L="$BASE/media/live/live.m3u8"
seqof() { sed -n 's/^#EXT-X-MEDIA-SEQUENCE://p'; }
curl -s -o /dev/null "$BASE/__live/reset"
p1=$(auth "$L"); s1=$(echo "$p1" | seqof)
wait_s 4.2
p2=$(auth "$L"); s2=$(echo "$p2" | seqof)
ct=$(auth -I "$L" | header content-type)
[ "$s2" -ge $((s1 + 2)) ] && ! echo "$p2" | grep -q ENDLIST && [ "$(echo "$p2" | grep -c '^seg-')" = 5 ]
result $? "live sequence advances (4.2 s)" "MEDIA-SEQUENCE $s1 -> $s2, 5 segments, no ENDLIST, $ct"
curl -s -o /dev/null "$BASE/__live/end"
p3=$(auth "$L"); s3=$(echo "$p3" | seqof)
echo "$p3" | grep -q '^#EXT-X-ENDLIST$'; result $? "/__live/end -> #EXT-X-ENDLIST" "sequence frozen at $s3"
curl -s -o /dev/null "$BASE/__live/reset?seq=38"
p4=$(auth "$L")
echo "$p4" | tr '\n' ' ' | grep -q '#EXTINF:2.000, seg-39.ts #EXT-X-DISCONTINUITY #EXTINF:2.000, seg-40.ts'
result $? "live wrap 39 -> 40 has DISCONTINUITY" "$(echo "$p4" | grep -E '^(#EXT-X-MEDIA-SEQUENCE|#EXT-X-DISCONTINUITY|seg-)' | tr '\n' ' ')"
auth -o "$TMP/body" "$BASE/media/live/seg-40.ts"; cmp -s "$TMP/body" "$OUT/live/seg0.ts"
result $? "seg-40.ts serves seg0.ts" "$(fsize "$TMP/body") bytes"
curl -s -o /dev/null "$BASE/__live/reset?seq=81"
p5=$(auth "$L"); ds=$(echo "$p5" | sed -n 's/^#EXT-X-DISCONTINUITY-SEQUENCE://p')
[ "$ds" = 2 ]; result $? "DISCONTINUITY-SEQUENCE after 2 wraps" "first=81 -> $ds"
curl -s -o /dev/null "$BASE/__live/reset"

# ---- pages -----------------------------------------------------------------------------------
for pg in '' direct hls-ts hls-fmp4 hls-aes hls-aes-iv hls-altaudio hls-byterange dash-timeline dash-number \
  dash-base live images drm-hls drm-dash; do
  curl -s -D "$TMP/h" -o "$TMP/body" "$BASE/p/$pg"
  st=$(head -1 "$TMP/h" | tr -d '\r'); ck=$(header set-cookie <"$TMP/h")
  title=$(sed -n 's:.*<title>\(.*\)</title>.*:\1:p' "$TMP/body")
  [ "$st" = "HTTP/1.1 200 OK" ] && [ "$ck" = 'ms_auth=ok; Path=/; SameSite=Lax; HttpOnly' ] && [ -n "$title" ]
  result $? "page /p/$pg" "$title"
done

# ---- ffprobe / ffmpeg through the server with Referer + cookie -------------------------------
curl -s -X POST -o /dev/null "$BASE/__log/clear"
d=$("$FFPROBE" -v error -headers "$HDRS" -show_entries format=duration -of default=nw=1:nk=1 "$BASE/media/hls-ts/master.m3u8")
k=$("$FFPROBE" -v error -headers "$HDRS" -show_entries stream=codec_type,width,height -of csv=p=0 "$BASE/media/hls-ts/master.m3u8" | sort -u | tr '\n' ' ')
near "$d" 12; result $? "ffprobe HLS TS master over HTTP" "duration=$d streams: $k"
for pl in hls-aes/media.m3u8 hls-aes/media-iv.m3u8 hls-fmp4/master.m3u8 hls-altaudio/master.m3u8 hls-byterange/media.m3u8; do
  name=$(echo "$pl" | tr '/' '_')
  err=$("$FFMPEG" -hide_banner -nostdin -loglevel error -y -headers "$HDRS" -i "$BASE/media/$pl" -map 0:v:0 -map 0:a:0 -c copy "$TMP/$name.mp4" 2>&1)
  d=$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$TMP/$name.mp4" 2>/dev/null)
  [ -z "$err" ] && near "$d" 12; result $? "ffmpeg $pl over HTTP -> mp4" "duration=$d ${err:+err=$err}"
done
for mpd in dash-timeline dash-number dash-base; do
  lines=$(node "$FIX/fixture-tool.mjs" dash-fetch "$BASE/media/$mpd/manifest.mpd" "$TMP/$mpd" "Referer: $REF" 'Cookie: ms_auth=ok' 2>&1)
  v=$(echo "$lines" | sed -n 's/^best-video=//p'); a=$(echo "$lines" | sed -n 's/^audio=//p')
  reqs=$(echo "$lines" | grep -o '"requests":[0-9]*' | sed 's/.*://' | paste -sd+ - | bc)
  d=""
  if [ -n "$v" ] && [ -n "$a" ] && "$FFMPEG" -hide_banner -nostdin -loglevel error -y -i "$v" -i "$a" -map 0:v -map 1:a -c copy "$TMP/$mpd.mp4"; then
    d=$("$FFPROBE" -v error -show_entries format=duration -of default=nw=1:nk=1 "$TMP/$mpd.mp4")
  fi
  near "$d" 12; result $? "DASH $mpd over HTTP (fetch+mux)" "duration=$d, $reqs requests"
done

# ---- request log -------------------------------------------------------------------------------
curl -s "$BASE/__log" >"$TMP/log.json"
summary=$(node -e '
const log = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const bad = log.filter((e) => e.status >= 300);
const lavf = log.filter((e) => e.ua.startsWith("Lavf"));
const keys = log.filter((e) => e.path.endsWith("key.bin"));
console.log([log.length, bad.length, lavf.length, keys.length, lavf.every((e) => e.hasReferer && e.hasCookie)].join(" "));
console.log(JSON.stringify(log.find((e) => e.path.endsWith(".ts")) || {}));
' "$TMP/log.json")
set -- $(echo "$summary" | head -1)
[ "$2" = 0 ] && [ "$3" -gt 0 ] && [ "$4" -gt 0 ] && [ "$5" = true ]
result $? "/__log: all media requests 2xx" "$1 entries, $2 non-2xx, $3 from ffmpeg (Lavf), $4 key.bin, all with Referer+cookie=$5"
echo "      sample: $(echo "$summary" | tail -1)"
[ -s "$HERE/requests.log" ]; result $? "requests.log written" "$(wc -l <"$HERE/requests.log" | tr -d ' ') lines"

echo
if [ "$FAILS" = 0 ]; then echo "selfcheck: all passed"; else echo "selfcheck: $FAILS failed"; fi
[ "$FAILS" = 0 ]
