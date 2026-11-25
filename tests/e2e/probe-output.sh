#!/bin/bash
# Usage: probe-output.sh <file> <expect: av|v|a> <durationSec> [tolerance=0.6]
# Prints one line: OK/FAIL <file> streams=<v,a> duration=<d>
set -u
f="$1"; expect="$2"; want="$3"; tol="${4:-0.6}"
FFPROBE=/opt/homebrew/bin/ffprobe
if [ ! -s "$f" ]; then echo "FAIL $f missing-or-empty"; exit 1; fi
streams=$($FFPROBE -v error -show_entries stream=codec_type -of csv=p=0 "$f" | sort -u | tr '\n' ',' | sed 's/,$//')
dur=$($FFPROBE -v error -show_entries format=duration -of csv=p=0 "$f")
ok=1
case "$expect" in
  av) [[ "$streams" == *video* && "$streams" == *audio* ]] || ok=0 ;;
  v)  [[ "$streams" == *video* ]] || ok=0 ;;
  a)  [[ "$streams" == *audio* && "$streams" != *video* ]] || ok=0 ;;
esac
awk -v d="$dur" -v w="$want" -v t="$tol" 'BEGIN { if (w > 0 && (d - w > t || w - d > t)) exit 1 }' || ok=0
# decode the whole file to catch corrupt segments (errors only)
errs=$(/opt/homebrew/bin/ffmpeg -v error -nostdin -i "$f" -f null - 2>&1 | grep -v -i 'non monotonic\|DTS' | head -3)
[ -n "$errs" ] && ok=0
if [ $ok = 1 ]; then echo "OK   $(basename "$f") streams=$streams duration=$dur"; else echo "FAIL $(basename "$f") streams=$streams duration=$dur ${errs:+decode-errors: $errs}"; exit 1; fi
