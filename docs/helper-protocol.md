# [media-saver] 도우미(네이티브 메시징 호스트) 규격

- 호스트 이름: `com.mediasaver.helper`
- 확장 ID(고정, manifest `key`): `ljojagcmpjloafhjikdgpdfndbncfhdc`
- 호스트 매니페스트 설치 위치: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mediasaver.helper.json`
  ```json
  {"name":"com.mediasaver.helper","description":"Media Saver ffmpeg helper",
   "path":"<저장소 절대 경로>/helper/host.sh","type":"stdio",
   "allowed_origins":["chrome-extension://ljojagcmpjloafhjikdgpdfndbncfhdc/"]}
  ```
- `host.sh`는 install.sh가 만든다. 크롬은 셸 PATH 없이 호스트를 띄우므로 node·ffmpeg는 **절대 경로**. 설치 때 `command -v node`/`command -v ffmpeg`를 `helper/config.json`에 기록하고, host.sh는 기록된 node가 없으면 `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `~/.nvm/versions/node/*/bin/node`(가장 높은 버전) 순으로 찾는다.

## 프레이밍

크롬 표준: 4바이트 길이(리틀 엔디언 uint32) + UTF-8 JSON. 호스트→크롬 한 메시지 최대 1MB.

## 메시지

요청 `{ "id": <string>, "op": <string>, ...인자 }`
응답 `{ "id", "type": "progress" | "result" | "error", ... }` — 한 요청에 progress 0개 이상, 그다음 result 또는 error 정확히 1개.

| op | 인자 | result |
|---|---|---|
| `hello` | — | `{ version, ffmpeg, ffmpegVersion, home }` |
| `remux` | `input`, `output?`, `deleteInput?`(기본 false), `durationSec?` | `{ output, size }` |
| `merge` | `video`, `audio?`, `subtitles?: [{path, lang}]`, `output?`, `deleteInputs?`, `durationSec?` | `{ output, size }` |
| `reveal` | `path` | `{}` (`open -R`) |

progress: `{ type:"progress", outTimeSec, percent? }` (`durationSec`가 있으면 percent 0~100).
error: `{ type:"error", code, message }` — code: `BAD_REQUEST` `BAD_PATH` `NOT_FOUND` `FFMPEG_FAILED` `NO_FFMPEG`.

## 경로 규칙(보안)

- 입력: 절대 경로, `realpath`가 `$HOME` 아래, 일반 파일, 확장자 허용 목록 `.ts .mp4 .m4a .m4s .m4v .aac .mp3 .webm .mkv .mov .vtt .srt`.
- 출력: 첫 입력과 **같은 폴더**, 확장자 `.mp4 .m4a .mkv .mp3`. 이미 있으면 ` (1)`, ` (2)`…를 붙여 덮어쓰지 않는다.
- 기본 출력 이름: remux는 입력 확장자만 바꾼다(.ts→.mp4, .aac→.m4a). merge는 영상 파일 이름에서 `.video`를 뺀 뒤 `.mp4`.
- 삭제는 요청에 들어온 입력 파일만, ffmpeg 성공(종료 코드 0, 출력 크기 > 0) 뒤에만.
- ffmpeg는 `spawn(ffmpegPath, argsArray, { shell:false })`. 셸 문자열을 만들지 않는다.

## ffmpeg 인자

- remux(영상): `-hide_banner -nostdin -n -i IN -map 0:v? -map 0:a? -c copy -dn -movflags +faststart -progress pipe:1 -nostats OUT`
- remux(.aac→.m4a): `... -i IN -map 0:a -c copy -movflags +faststart ... OUT`
- merge: `-i V -i A [-i S1 ...] -map 0:v:0 -map 1:a:0 [-map 2:0 ...] -c:v copy -c:a copy [-c:s mov_text -metadata:s:s:N language=LANG] -movflags +faststart ... OUT`
  - audio 없이 자막만 넣는 merge도 허용(입력 번호가 당겨진다).
