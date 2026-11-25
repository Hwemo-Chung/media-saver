# [media-saver] 변환 타당성 — 저장한 미디어를 GIF·PDF·PPTX로

작성 2026-11-25. 조사와 시제품만 했습니다. `extension/`·`helper/` 코드와 이 문서 밖의 저장소 파일은 건드리지 않았습니다.

## 0. 요청·가정·완료 기준

- **무엇**: `~/Downloads`에 저장한 mp4·mp3/m4a·jpg/png/webp/gif를 GIF·PDF·PPTX로 바꿔 같은 폴더에 저장할 수 있는지, 그리고 어떻게 할지 정합니다.
- **어디서**: 이 Mac(Apple M4, 10코어, 24 GB, macOS 26.7.3)에서만 했습니다. 시제품·입력·출력은 모두 `docs/feasibility-sandbox/` 안에 있습니다. npm 패키지와 Python venv도 이 폴더에만 설치했습니다.
- **완료 기준**: 질문 1~6마다 실제로 돌린 명령이나 스크립트와 증거(`file`, 크기, ffprobe/pdfinfo 쪽수, 렌더 확인)를 남깁니다.
- **가정·측정 조건**
  - 조사를 시작할 때 `extension/`·`helper/`는 비어 있었습니다. 조사 도중 다른 작업이 `extension/lib`와 `tests/`를 채웠습니다. 그래서 아래 새 op는 기존 코드에 맞춘 것이 아니라 `helper-protocol.md` 규격을 기준으로 한 **설계안**입니다.
  - 측정하는 동안 같은 기계에서 다른 작업(테스트용 영상 생성 등)이 돌아 load average가 4~7이었습니다. 시간은 상한치로 보십시오.
  - 입력은 ffmpeg로 합성한 영상(testsrc2 등)입니다. 실제 영상에서는 GIF·JPEG 크기가 다를 수 있습니다.

## 1. 판정

| 변환 | 가능 여부 | 권장 방식 | 근거 파일/명령 | 신뢰도 |
|---|---|---|---|---|
| 영상 → GIF | 가능 | 도우미에서 ffmpeg 2패스: palettegen으로 임시 PNG를 만든 뒤 paletteuse. 옵션은 start·end·fps·긴 변 | `out/A-12s-15fps-480.gif`, `out/T2-*.gif`, `scripts/q1-gif.mjs`, `scripts/q1-twopass.sh`, `evidence/q1-gif.json` | [High] |
| 이미지 여러 장 → GIF | 가능 | 도우미에서 ffmpeg로 입력 N개를 scale·pad한 뒤 흰 배경에 overlay하고 concat, 팔레트 처리 | `out/I-images-slideshow-640x360.gif`, `evidence/q1-images-slideshow-contact.png` | [High] |
| 영상 → PDF (N초마다) | 가능 | ffmpeg 시크 루프(`-ss t -frames:v 1`)로 프레임을 뽑고, 순수 Node PDF 작성기로 JPEG를 `/DCTDecode` 그대로 넣음 | `out/pdf-mini-every2s.pdf`, `out/pdf-mini-long60.pdf`, `scripts/pdf-mini.mjs` | [High] |
| 영상 → PDF (장면 전환) | 가능(임계값 조정 필요) | `select='eq(n,0)+gt(scene,T)'`와 showinfo 시각, 최소 간격 필터 | `out/pdf-mini-scenes.pdf`, `evidence/q2-scenes-all-pages.png` | 동작 [High], 기본값 0.3 [Medium] |
| 이미지 → PDF (A4 맞춤) | 가능 | ffmpeg로 기준 JPEG를 만들고(EXIF 회전·알파 처리) 순수 작성기의 A4 모드에 넣음 | `out/이미지 모음 (A4).pdf`, `evidence/q2-images-a4-all-pages.png` | [High] |
| 영상·이미지 → PPTX | 가능 | 의존성 없는 순수 Node OOXML 작성기. 대안은 pptxgenjs | `out/장면 모음 mini (테스트).pptx` 외 5개, `scripts/pptx-mini.mjs`, `evidence/q3-quicklook-pptx-thumbs.png` | 구조·Quick Look·python-pptx 재열기 [High], PowerPoint 실물 열기 [Medium](미실시) |
| 음성 → PDF·PPT·GIF | 의미 없음 | 메뉴를 끕니다. 파형 그림은 만들 수 있지만 범위 밖입니다 | `out/audio-waveform-showwavespic.png` | [High] |
| 실행 위치 | — | **도우미(Node + ffmpeg)**, npm 의존성 0 유지 | §4 | 측정 [High], 브라우저 쪽 주장 [Medium] |

## 2. 도구 유무 (이 Mac)

| 있음 | 없음 |
|---|---|
| ffmpeg·ffprobe 9.0.2 (`/opt/homebrew/bin`; libx264·x265·dav1d·vpx·svtav1, videotoolbox; `webp_anim` 디코더 있음) | `zscale`, `libplacebo` 필터 (HDR 톤매핑용), ffmpeg libwebp 인코더 |
| `sips`, `qlmanage`, `mdls`, `textutil`, `cupsfilter` (macOS 기본) | `img2pdf`, `soffice`(LibreOffice), `gifski`, `qpdf`, `gs` |
| ImageMagick 7.1.2-34 `magick`/`convert`, poppler 26.10 `pdfinfo`/`pdftoppm`/`pdfimages`, `exiftool` (Homebrew) | Pillow·python-pptx (사용자 Python 3.11.15에는 없음, 샌드박스 venv에만 설치) |
| Automator `New PDF from Images.action`, `Combine PDF Pages.action`(`join`은 Mach-O, PDF 합치기 전용) | |
| Microsoft PowerPoint.app, Node 24.22.3(`zlib.crc32` 있음) | |

도우미가 이미 의존하는 것은 ffmpeg 하나뿐입니다. magick·poppler는 이 기계에만 있는 도구이므로 기능의 의존성으로 삼지 않고 검증에만 썼습니다.

## 3. 질문별 결과

### Q1. 영상 → GIF

```
# 1패스 (짧은 클립용)
ffmpeg -hide_banner -nostdin -n [-ss S] [-to E] -i IN -filter_complex \
 "[0:v]fps=F,scale=w=M:h=M:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];\
  [a]palettegen=max_colors=256:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -an -loop 0 OUT.gif
# 2패스 (권장: 팔레트를 임시 PNG로)
ffmpeg ... -i IN -vf "fps=F,scale=...,palettegen=stats_mode=diff" -update 1 TMP/pal.png
ffmpeg ... -i IN -i TMP/pal.png -filter_complex "[0:v]fps=F,scale=...[x];[x][1:v]paletteuse=dither=sierra2_4a:diff_mode=rectangle" -an -loop 0 OUT.gif
```

12초 1280×720 H.264 클립의 결과입니다. 크기는 KiB, SSIM은 같은 fps·크기로 줄인 원본과 비교한 값입니다.

| 출력 | 설정 | 시간 | 최대 RSS | 크기 | 프레임·길이 | SSIM |
|---|---|---|---|---|---|---|
| A | 15 fps, 긴 변 480, 1패스 | 0.99 s | 182 MB | 2,549 | 180 · 12.0 s | 0.893 |
| T2-480 | A와 같은 설정, **2패스** | 1.09 s | **82 MB** | A와 바이트 단위로 같음 | 180 | — |
| B | 10 fps, 320 | 0.45 s | 105 MB | 900 | 120 | 0.914 |
| C | 15 fps, 720, 1패스 / 2패스 | 2.08 s / 2.14 s | 325 MB / 97 MB | 4,893 | 180 | 0.904 |
| D | `-ss 2 -to 7`, 12 fps, 480 | 0.34 s | 109 MB | 862 | **60 · 5.0 s** (start·end·fps 반영 확인) | 0.897 |
| E | `stats_mode=full` | 0.89 s | 179 MB | 2,649 | 180 | 0.905 |
| N | 팔레트 없이 기본 인코딩 | 0.20 s | 70 MB | 1,568 | 180 | **0.796** (디더 무늬: `evidence/q1-palette-vs-naive-frame45.png`) |
| gifenc(JS) | 프레임마다 양자화, 디더 없음 | 인코드만 4.9 s | 177 MB | 2,429 | 180 | 0.812 |

- **60초 GIF(15 fps, 720)에서 1패스는 RSS 1,002~1,185 MB를 썼습니다**(두 번 측정, 8.8~12.5 s). **2패스는 132 MB**(9.9 s)였습니다. 출력은 26,382,423 B로 둘이 바이트 단위까지 같습니다.
  - 원인: paletteuse가 팔레트가 나올 때(EOF)까지 다른 갈래의 프레임을 메모리에 쌓습니다.
  - 권장: **2패스로 고정** [High]. 근거는 `evidence/q6-risks.log`, `evidence/q1-twopass.log`입니다.
  - 1패스 출력 `L1`은 L2와 같은 파일이라 지웠습니다.
  - 2패스 인자 생성기는 `convert-lib.mjs`의 `gifTwoPassArgs`입니다. 출력 `out/T3-*`가 A와 바이트 단위로 같은 것을 확인했습니다.
- 세로 영상 720×1280은 270×480으로 나왔습니다(`out/P-*.gif`). 1280×720에 90° 표시 회전이 붙은 영상도 270×480으로 자동 회전되었습니다(`out/R-*.gif`, `evidence/q1-portrait-and-rotated.png`). 그래서 옵션은 「가로 폭」이 아니라 **「긴 변」**으로 두는 것이 맞습니다. [High]
- VP9·AV1 webm(`out/V-*`, `out/W-*`)과 한글 이름 `한글 영상 (테스트).mp4` → `out/한글 영상 (테스트).gif`도 정상 처리되었습니다. [High]
- **이미지 → GIF**: 8장(가로·세로 jpg, 알파 png, 정지 webp, 정지 gif, 애니 gif, 애니 webp, 한글 이름 jpg)을 640×360, 장당 1.5초로 묶었습니다. 결과는 24프레임, 12.0초, 372 KiB, 0.59 s입니다. 레터박스와 알파의 흰 배경 처리는 `evidence/q1-images-slideshow-contact.png`에서 확인했습니다. 애니메이션 입력은 첫 프레임만 씁니다. [High]
- 애니 webp를 통째로 GIF로 바꾸면 30프레임이 나옵니다(`out/AW-anim-webp-to.gif`). ffmpeg 9의 `webp_anim` 디코더 덕분입니다. [High]
- 렌더 확인: `qlmanage -t`로 `evidence/A-12s-15fps-480.gif.png`와 `evidence/한글 영상 (테스트).gif.png`를 만들었습니다. `sips`로 480×270을 확인했습니다.

### Q2. 영상 → PDF, 이미지 → PDF

**프레임 추출** (`scripts/q2-extract.mjs`, `evidence/q2-extract.json`)

| 방식 | 대상 | 결과 |
|---|---|---|
| (a) `-vf fps=1/N` (한 프로세스, 전체 디코드) | 12 s, 2초마다 | 6장, 0.15 s |
| (a) `fps=1/10` | 10분 720p (GOP 2 s) | 60장, 3.16 s |
| (a') 시크 루프 `-ss t -i IN -frames:v 1` ×60 | 같은 영상 | 60장, **2.01 s**. 걸리는 시간은 영상 길이가 아니라 쪽수에 비례합니다 → 권장 |
| (b) `select='eq(n\,0)+gt(scene\,0.3)',showinfo -fps_mode vfr` | 컷 5개(2·4·6·8·10 s) | 0.3이면 0·2·4·6·8(10 s 컷 놓침), 0.2와 0.1이면 컷 5개 모두 + 오탐 8.03 s |
| (b) | 컷 없는 영상 | 0번 프레임 1장뿐 → 2장 미만이면 간격 모드를 권하는 안내 필요 |
| (b) | 10분 720p | 6.3 s(720p 그대로 분석), 5.9 s(320으로 줄여 분석), 다시 재서 5.6 s. 디코드가 시간 대부분을 차지합니다. VideoToolbox 디코드는 17.6~19.5 s로 오히려 느렸습니다(`evidence/q6-risks.log`) |

**PDF 작성기 비교** (`scripts/build-pdf.mjs`, `scripts/q2-build.sh`, 로그 `evidence/q2-build.log`; 빈 Node 프로세스의 기본 RSS는 약 47 MB)

| 엔진 | 출력 | 쪽 | 시간 | 최대 RSS | 크기(B) | 버전 |
|---|---|---|---|---|---|---|
| 순수 Node (`pdf-mini.mjs`, 98줄) | `out/pdf-mini-scenes.pdf` | 5 | 3 ms | 50 MB | 808,176 | 1.4 |
| 〃 | `out/pdf-mini-long60.pdf` | 60 | 16 ms | **54 MB** | 3,546,329 | 1.4 |
| 〃 A4 맞춤 | `out/이미지 모음 (A4).pdf` | 8 | 8 ms | 51 MB | 2,096,825 | 1.4 |
| pdf-lib 1.17.1 | `out/pdf-lib-scenes.pdf` | 5 | 67 ms | 76 MB | 807,852 | 1.7 |
| 〃 | `out/pdf-lib-long60.pdf` | 60 | 64 ms | **94 MB** | 3,541,328 | 1.7 |
| 〃 A4 | `out/pdf-lib-images-a4.pdf` | 8 | 47 ms | 80 MB | 2,096,308 | 1.7 |

- **유효성 검증** [High]
  - 모든 PDF가 `pdfinfo`로 쪽수·쪽 크기·한글 Title을 정상 출력했고 stderr는 비어 있었습니다.
  - `pdftoppm`의 1쪽 렌더도 stderr가 비어 있었습니다.
  - `pdfimages -list`에서 이미지가 `jpeg`로 나와 재인코딩 없이 들어간 것을 확인했습니다.
  - 순수 작성기 PDF 6개는 `scripts/check-xref.mjs`로 xref의 모든 오프셋이 `N 0 obj`를 가리키는지 검사해 모두 통과했습니다(badOffsets=0, 행 20 B). Preview와 poppler는 깨진 xref를 조용히 고치기 때문에 따로 검사했습니다.
  - `mdls kMDItemNumberOfPages`는 60과 8이 나왔습니다.
  - `qlmanage -t` 결과는 `evidence/*.pdf.png`, `sips -s format png` 결과는 `evidence/q2-sips-pdf-mini-every2s-page1.png`입니다.
  - 모든 쪽의 렌더는 `evidence/q2-images-a4-all-pages.png`와 `evidence/q2-scenes-all-pages.png`에 있습니다.
- **pdf-lib의 함정** [High]
  - `embedJpg(Buffer)`는 Node 풀에서 나온 작은 Buffer(byteOffset ≠ 0)에서 "SOI not found in JPEG"로 실패합니다. 장면 프레임 5장 중 2장이 이렇게 실패했습니다. `new Uint8Array(buf)`로 복사하면 해결됩니다.
  - WebP·GIF는 받지 않습니다.
  - 마지막 릴리스가 2021-11입니다.
- 무손실 옵션: PNG를 ffmpeg로 rgb24 raw로 풀고 `/FlateDecode`로 넣었습니다. 800×600 한 쪽이 14,265 B였습니다(`out/pdf-mini-lossless-png.pdf`). [High]
- 이미지 → PDF는 항상 ffmpeg 정규화를 거쳐야 합니다.
  - EXIF Orientation=6인 1920×1080 JPEG는 정규화하면 1125×2000으로 바로 섭니다(`out/exif-orient6-normalised.jpg`). JPEG를 그대로 넣으면 옆으로 누운 채 들어갑니다.
  - 알파는 흰 배경으로 합칩니다.
  - 애니 이미지는 첫 프레임만 씁니다. [High]
- 캡션은 표준 Helvetica라 ASCII만 됩니다. 한글은 `?`로 바뀝니다(A4 PDF 8쪽). 한글 캡션을 넣으려면 CJK 폰트 서브셋을 내장해야 하므로 v1에서는 빼기를 권합니다. 메타데이터 Title(UTF-16BE)은 한글이 됩니다. [High]
- **음성 → PDF는 의미가 없습니다.** 담을 화면이 없습니다. `showwavespic`로 파형 PNG는 만들 수 있지만(`out/audio-waveform-showwavespic.png`) 요청 범위 밖입니다.

### Q3. 영상·이미지 → PPTX (한 장당 한 슬라이드, 16:9, contain, 검은 배경)

| 엔진 | 장면 5장 | 이미지 8장 | 시간 | 최대 RSS | 추가 의존성 |
|---|---|---|---|---|---|
| (b) 순수 Node OOXML (`pptx-mini.mjs`, ZIP 작성기 포함 약 140줄) | 548,589 B | 1,817,158 B | 15~34 ms | 53~55 MB | 없음 |
| (a) pptxgenjs 4.0.1 | 870,472 B | 2,172,885 B | 52~76 ms | 73~82 MB | jszip 등 하위 패키지 18개 |
| (c) python-pptx 1.0.2 (venv) | 569,437 B | 1,509,992 B* | 28~44 ms | 40~42 MB | Python 3 + venv 65 MB |

\* python-pptx는 같은 이미지(01과 08은 같은 파일)를 한 번만 저장합니다.

- **유효성 검증** [High] — 로그는 `evidence/q3-run.log`입니다. 썸네일은 최종 작성기로 다시 만든 파일에서 확인했습니다.
  - 6개 파일 모두 `unzip -t`에서 "No errors"였습니다.
  - python-pptx로 다시 열어 슬라이드 수·그림 수·슬라이드 크기 12192000×6858000 EMU·한글 Title이 모두 맞는 것을 확인했습니다.
  - 세로 이미지 슬라이드는 세 엔진 모두 가운데 3857625×6858000(비율 0.5625 = 1125/2000)으로 놓였습니다.
  - `qlmanage -t` 썸네일 6개가 모두 렌더되었습니다(`evidence/q3-quicklook-pptx-thumbs.png`).
- 순수 작성기의 파트 구성: `[Content_Types].xml`, `_rels/.rels`, `docProps/core·app`, `ppt/presentation.xml`(+rels), `presProps`·`viewProps`·`tableStyles`, `theme1`, `slideMaster1`(+rels), `slideLayout1`(blank, +rels), `slides/slideN`(+rels), `media/imageN.jpeg`.
  - ZIP64가 없으므로 4 GB 미만, 파트 65,535개 미만이어야 합니다.
  - ffmpeg JPEG는 deflate하면 19~97% 줄어 media도 압축합니다. 5% 미만이면 store로 둡니다.
- **남은 검증**: PowerPoint.app은 설치되어 있지만 열지 않았습니다. 자동화하면 macOS 권한·파일 접근 창이 사용자 화면에 뜨기 때문입니다. `out/장면 모음 mini (테스트).pptx`를 PowerPoint로 한 번 열어 「복구」 창이 뜨지 않으면 [High]로 올리십시오. 그 전까지 PowerPoint 호환은 세 엔진 모두 [Medium]입니다.
- pptxgenjs는 브라우저에서도 동작합니다(`pptxgen.bundle.js` 461 KB, gzip 156 KB, jszip 포함). 다만 런타임 의존성에 내용이 빈 `https@1.0.0`(package.json만 있음)과 `@types/node`가 끼어 있습니다.

### Q4. 어디서 실행할지 — 권장: 도우미

| 기준 | 확장(브라우저) | 도우미(Node + ffmpeg) |
|---|---|---|
| 저장된 파일 접근 | MV3 확장은 `~/Downloads`를 경로로 읽지 못합니다. `chrome.downloads`는 경로만 주고, `file://` 읽기는 사용자가 「파일 URL 액세스 허용」을 켜야 합니다 [Medium, 문서 기반·미실행] | 이미 경로로 동작합니다 |
| 코덱·컨테이너 | `<video>`로는 .ts·.mkv가 안 되고 HEVC는 하드웨어에 따릅니다 [Medium] | H.264·HEVC 10-bit·VP9·AV1·애니 webp/gif 디코드를 확인했습니다 [High] |
| 속도·품질 | gifenc 인코드만 4.9 s, SSIM 0.812, 디더 없음. 프레임마다 seek→drawImage를 해야 해서 더 느립니다 [Medium] | GIF 전체 1.0 s, SSIM 0.893 [High] |
| 메모리 | pdf-lib·pptxgenjs는 문서 전체를 메모리에 만든 뒤 Blob으로 저장합니다(60쪽 94 MB, Node 측정). 서비스 워커에서는 오프스크린 문서가 필요합니다 | 순수 작성기는 한 장씩 디스크에 씁니다(60쪽 54 MB) [High] |
| 설치 | 번들 0.3~0.5 MB가 늘어납니다 | npm 의존성 0을 유지합니다(작성기 약 240줄 이식) |

브라우저 경로는 「지금 재생 중인 영상에서 바로 GIF」 같은 캡처 시점 기능이 필요할 때만 검토하십시오. v1에서는 권하지 않습니다.

**도우미 프로토콜 추가안** (`helper-protocol.md` 기준 설계, 미구현)

| op | 인자 | result |
|---|---|---|
| `probe` | `path` | `{ kind, durationSec, width, height, rotation, codec, hdr, frames }` (UI 옵션·경고용, ffprobe) |
| `toGif` | `input` 또는 `inputs[]`, `start?`, `end?`, `fps?`(12, 1~30), `maxSide?`(480, 120~1080), `secondsPerImage?`(1.5), `output?` | `{ output, size, frames, durationSec, warnings[] }` |
| `toPdf` | `input` 또는 `inputs[]`, `mode:'interval'\|'scene'`, `every?`(10 s), `threshold?`(0.3), `minGapSec?`(1), `maxPages?`(200), `maxSide?`(1280), `quality?`(q:v 3), `fit?:'image'\|'a4'`, `captions?:'time'\|'none'`, `output?` | `{ output, size, pages, warnings[] }` |
| `toPptx` | `toPdf`와 같은 프레임 선택 인자(`fit` 제외) | `{ output, size, slides, warnings[] }` |
| `cancel` | `targetId` | `{}` — 자식 ffmpeg를 끝내고 임시 폴더를 지웁니다 |

- **progress**
  - GIF는 기존 형식(`-progress pipe:1`의 outTimeSec·percent)을 씁니다.
  - PDF·PPTX는 `{ phase:'frames'|'assemble', done, total }`을 보냅니다.
- **error 코드 추가**: `UNSUPPORTED_INPUT`(음성 등), `NO_FRAMES`, `CANCELLED`. 상한을 넘으면 실패시키지 않고 간격을 넓힌 뒤 `warnings`에 적습니다.
- **경로 규칙 변경**
  - 입력 허용 목록에 `.jpg .jpeg .png .webp .gif`를 추가합니다. 변환 op는 영상·이미지만 받습니다.
  - `inputs[]`는 항목마다 realpath가 `$HOME` 아래인지 검사합니다.
  - 출력 확장자는 op마다 `.gif`/`.pdf`/`.pptx` 하나입니다.
  - 출력 위치는 첫 입력과 같은 폴더입니다. 이름이 겹치면 ` (1)`을 붙이고, `wx` 플래그로 덮어쓰지 않습니다(시제품이 이렇게 동작합니다).
  - 변환은 입력을 지우지 않습니다(`deleteInput` 없음).
  - 임시 프레임은 `mkdtemp(os.tmpdir()/media-saver-)`에 두고 `finally`에서 지웁니다.
  - 응답에는 경로만 싣습니다(호스트→크롬 1 MB 제한).
  - 변환은 한 번에 하나씩 큐로 처리합니다. 장면 감지와 GIF가 코어를 많이 쓰기 때문입니다.

**팝업 UI 위치** (목업)

```
[Media] [Images] [Jobs]
-------------------------------------------------
완료  lecture.mp4   12:03  148MB  [Finder] [변환 v]
                                     | GIF 만들기...
                                     | PDF (장면/간격)...
                                     | PPT (장면/간격)...
완료  song.m4a       3:41          [Finder]  (변환 없음)
-------------------------------------------------
GIF: 시작[00:10] 끝[00:18] fps[12] 긴 변[480]  ~2-4MB [만들기]
```

- Images 탭에서는 저장한 이미지를 체크해 `[PDF로 묶기] [PPT로 묶기] [GIF로 묶기]`를 누르게 합니다.
- 변환 작업은 Jobs 행으로 진행률과 취소 버튼을 보여 줍니다. 끝나면 `reveal`을 씁니다.

### Q5. 라이선스·크기

| 대상 | 라이선스 | 설치 크기 | 브라우저 번들(raw/gzip) | 판단 |
|---|---|---|---|---|
| **권장**: 순수 Node 작성기 2개 | 프로젝트 자체 코드 | 약 240줄 | — | 채택 |
| ffmpeg 9.0.2 (Homebrew) | 이 빌드는 **GPLv3**(`--enable-gpl --enable-version3`) | 사용자가 설치 | — | 별도 프로세스로 실행하고 배포하지 않으므로 로컬 사용에 문제없습니다. 번들해 배포하면 GPL 의무가 생깁니다 [High] |
| pdf-lib 1.17.1 | MIT (standard-fonts MIT, upng MIT, pako MIT AND Zlib, tslib 0BSD) | 23 MB + 1.6 MB | 525 KB / 206 KB | 대안. 2021년 이후 릴리스 없음 |
| pptxgenjs 4.0.1 | MIT (jszip "MIT OR GPL-3.0-or-later" → MIT 선택, image-size MIT, https ISC, @types/node MIT) | 2.5 MB + jszip 0.8 MB + @types 2.5 MB | 461 KB / 156 KB | 대안(브라우저가 필요할 때) |
| gifenc 1.0.3 | MIT | 204 KB | 9 KB / 3.9 KB | 비교용. 디더가 없어 비권장 |
| python-pptx 1.0.2 | MIT (Pillow MIT-CMU, lxml BSD-3-Clause, XlsxWriter BSD-2-Clause, typing_extensions PSF-2.0) | venv 65 MB | — | Python 런타임이 추가되므로 비권장 |

라이선스는 설치된 `package.json`과 pip 메타데이터에서 읽었습니다. 샌드박스 `node_modules` 전체는 32 MB입니다.

### Q6. 위험·한계

- **긴 영상**
  - GIF는 2패스가 필수입니다(1패스 60 s에서 1 GB).
  - 60 s·720·15 fps GIF는 26 MB입니다. 기본 상한을 30 s로 두고, 넘으면 fps·크기를 낮추자고 제안합니다.
  - PDF·PPTX는 `maxPages` 200, 간격 = max(N, 길이/200)으로 자동 조정합니다.
  - 장면 모드는 영상 길이만큼 전체를 디코드합니다(10분 720p에서 5~6 s). 2시간 1080p는 몇 분 걸릴 것으로 봅니다 [Low]. 진행률과 취소가 필수입니다.
- **세로 영상·회전 메타**
  - 자동 회전은 확인했습니다 [High].
  - PPTX 16:9 슬라이드에서 세로 이미지는 양옆이 검게 남습니다. 세로 영상에는 9:16 슬라이드(`cx`/`cy` 옵션)를 제안합니다.
  - PDF A4 모드는 쪽마다 방향을 따릅니다.
- **HDR·10-bit**: 이 ffmpeg에서 PQ→SDR 경로는 **검증된 것이 없습니다**(`evidence/q6-hdr-compare-2x2.png`, `evidence/q6-hdr.log`).
  - **시험 입력의 한계**: `hdr10.mp4`는 SDR 시험 패턴에 PQ·BT.2020 태그만 붙인 10-bit HEVC입니다. 실제 PQ로 인코딩한 영상이 아닙니다. 그래서 톤매핑 없는 프레임이 SDR 원본과 같게 보입니다(YAVG 125.8과 125.5). 이 그림을 「톤매핑이 필요 없다」는 뜻으로 읽으면 안 됩니다.
  - **이 시험이 증명한 것**: PQ 태그가 붙은 10-bit HEVC는 디코드되어 GIF가 됩니다. 기본 경로는 전송 함수 태그를 무시합니다. 「실제 HDR 영상이면 색이 바래 보인다」는 원리에서 나온 판단이고, 여기서 보여 준 것은 아닙니다 [Medium].
  - **확인한 사실** [High]
    - `zscale`이 없습니다.
    - `colorspace`는 "Unsupported input transfer characteristics 16 (smpte2084)"로 거부합니다.
    - 선형화 없이 `tonemap=hable`을 쓰면 YAVG 50으로 확 어두워집니다.
    - VideoToolbox `scale_vt`(→bt709, `hwdownload,format=p010le`)는 그림을 바꾸고(그라디언트가 잘림) GIF도 만듭니다(`out/H2-*.gif`). 다만 정확성은 검증하지 못했습니다.
  - **쓸 수 있는 신호**: HDR 태그가 붙은 입력이면 palettegen이 "The input frame is not in sRGB, colors may be off"를 냅니다(태그 없는 SDR에서는 안 냄).
  - **권장**: `probe`에서 `color_transfer`가 `smpte2084`나 `arib-std-b67`이면 「색이 바랠 수 있음」 경고를 띄웁니다 [Medium]. 10-bit SDR은 따로 시험하지 않았습니다.
- **VP9·AV1 webm**: ffmpeg에서 정상입니다 [High].
- **애니 webp·gif**
  - GIF로 바꿀 때는 전체 프레임을 씁니다.
  - PDF·PPTX에는 첫 프레임만 넣고, 필요하면 N번째마다 뽑는 옵션을 둡니다(`select='not(mod(n,10))'` → 3장 확인) [High].
- **한글 파일 이름** [High]
  - spawn 인자, ffmpeg 입출력, PDF Title(UTF-16BE), PPTX XML(UTF-8)이 모두 정상입니다.
  - APFS에 NFD로 저장된 파일도 NFC 경로로 열립니다(`existsSync` true, ffmpeg OK).
  - 다만 `readdir`은 NFD 바이트(38 B, NFC는 17 B)를 돌려줍니다. 그래서 이름 비교는 `normalize('NFC')` 뒤에 하고, ` (1)` 충돌 검사는 `existsSync`로 하십시오.
  - PDF 캡션은 ASCII만 됩니다.
- **PDF 크기**
  - 1280×720 JPEG(q=3) 한 쪽은 내용에 따라 단색 5.6 KB, 컬러바 17 KB, 일반 56~69 KB, 노이즈 657 KB입니다.
  - q를 2에서 8로 올리면 평균 291→185 KB로 36% 줄어듭니다.
  - 200쪽이면 대략 12~50 MB입니다(노이즈가 많은 영상은 더 큽니다). 기본값은 긴 변 1280, q 3~5를 제안합니다.
- 측정에 쓴 GIF·JPEG는 합성 영상에서 나온 것이므로 실제 영상의 크기는 ±50% 이상 다를 수 있습니다 [Medium].

## 4. 샘플 출력·스크립트 위치 (`docs/feasibility-sandbox/`)

- **스크립트** `scripts/`
  - 작성기: `pdf-mini.mjs`, `pptx-mini.mjs`
  - ffmpeg 인자 생성: `convert-lib.mjs` (`gifArgs`, `gifTwoPassArgs`, `imagesToGifArgs`, `framesEveryArgs`, `frameAtArgs`, `framesSceneArgs`, `toJpegArgs`)
  - 검증: `check-xref.mjs`
  - 측정·실험: `make-fixtures.sh`, `q1-gif.mjs`, `q1-twopass.sh`, `q1-gifenc.mjs`, `q2-extract.mjs`, `build-pdf.mjs`, `q2-build.sh`, `q3-pptx.mjs`, `q3_pptx.py`, `q3-run.sh`, `q6-hdr.sh`, `q6-risks.sh`
- **입력** `fixtures/` (`make-fixtures.sh`가 전부 다시 만듭니다)
  - 영상: `clip720.mp4`, `scenes.mp4`, `portrait.mp4`, `rotated.mp4`(1280×720 + 90° 표시 회전), `hdr10.mp4`, `vp9.webm`, `av1.webm`, `한글 영상 (테스트).mp4`
  - 이미지: `img/01~08`, `exif-orient6.jpg`(EXIF Orientation=6)
  - 10분짜리 `long600.mp4`(480 MB)는 측정 뒤 지웠습니다.
- **GIF** `out/`: `A-*.gif`, `B-*`, `C-*`, `D-*`, `E-*`, `N-*`, `S-*`, `P-*`, `R-*`, `V-*`, `W-*`, `H-*`, `H2-*`, `T2-*`, `T3-*`, `L2-60s-twopass.gif`, `I-images-slideshow-640x360.gif`, `AW-anim-webp-to.gif`, `A-gifenc-js-15fps-480.gif`, `한글 영상 (테스트).gif`
- **PDF** `out/`: `pdf-mini-*.pdf`(5개), `pdf-lib-*.pdf`(3개), `이미지 모음 (A4).pdf`
- **PPTX** `out/`: `장면 모음 mini (테스트).pptx`, `pptx-mini-images.pptx`, `pptxgenjs-*.pptx`, `python-pptx-*.pptx`
- **중간 산출물** `out/`
  - 프레임: `frames-every2s/`, `frames-scene-scenes/`, `frames-scene-nocuts/`, `frames-long-fps/`, `frames-long-seek/`, `frames-long-scene-*/` (각 폴더에 `manifest.json`)
  - 정규화한 이미지: `images-normalised/`, `exif-orient6-normalised.jpg`
  - 기타: `AG-anim-gif-frames-*.jpg`, `hdr-*.png`, `audio-waveform-showwavespic.png`
- **증거** `evidence/`
  - 측정값: `q1-gif.json`, `q1-gifenc.json`, `q2-extract.json`
  - 실행 로그(시각·load 포함): `make-fixtures.log`, `q1-twopass.log`, `q2-build.log`, `q3-run.log`, `q6-hdr.log`, `q6-risks.log`
  - Quick Look 썸네일: `*.gif.png`, `*.pdf.png`, `*.pptx.png`
  - 렌더·비교 그림: `q1-*.png`, `q2-*.png`, `q3-quicklook-pptx-thumbs.png`, `q6-hdr-compare-2x2.png`
- **수치의 출처**
  - Q1 표의 A~N 값은 `q1-gif.json`, gifenc 값은 `q1-gifenc.json`에 있습니다.
  - 콘솔에서만 본 값은 「1패스 60 s 12.5 s / 1,002 MB」(첫 측정) 하나입니다. 재측정값은 `q6-risks.log`에 있습니다.
- **임시 파일**: `out/_render/`, `out/_names/`. 남겨 두었으니 지워도 됩니다.
- **git**: `node_modules/`와 `venv/`는 샌드박스의 `.gitignore`가 제외합니다. 커밋하지 않았습니다.
