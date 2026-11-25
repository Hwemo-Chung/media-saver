# Media Saver

웹 페이지의 영상·음성·이미지를 감지해 이 컴퓨터에 저장하는 크롬 확장입니다(Manifest V3).
Video DownloadHelper의 공개 문서에 적힌 동작을 기준으로 새로 만들었고, 그 코드·이름·아이콘은 쓰지 않았습니다.

| 기능 | 내용 |
|---|---|
| 감지 | 영상·음성 파일, HLS(.m3u8), DASH(.mpd). 찾으면 아이콘에 색이 들고 개수가 뜹니다. |
| HLS | 화질 선택, 대체 음성, fMP4, 바이트 범위, AES-128, **라이브 녹화** |
| DASH | SegmentTemplate·SegmentTimeline·SegmentList·SegmentBase, 영상+음성 합치기 |
| 자막 | HLS·DASH WebVTT 자막을 .srt/.vtt로 저장. 선택하면 mp4 안에도 넣습니다. |
| 이미지 | 페이지의 그림을 크기 조건으로 골라 한꺼번에 저장 |
| 제한 | **없음** — 횟수·대기 시간 제한이 없습니다 |
| 접근 거절 대응 | 목록·조각 요청이 401/403이면 페이지가 보낸 `Sec-Fetch-Site`·`sec-ch-ua` 헤더를 흉내 내 다시 요청하고, 목록은 마지막으로 페이지 안에서 받아 옵니다. 실패하면 단계별 결과를 오류에 적습니다. |
| 위장 조각 | 조각 앞에 가짜 PNG·JPEG 머리를 붙인 HLS도 첫 TS 패킷부터 잘라 저장합니다. |
| 개인정보 | 모든 처리를 이 컴퓨터에서 합니다. 어떤 데이터도 밖으로 보내지 않습니다. |

저장할 수 없는 것: DRM으로 보호된 콘텐츠(넷플릭스 등 Widevine·FairPlay·PlayReady, HLS SAMPLE-AES)는 「보호됨」으로만 표시합니다. DASH 라이브 녹화와 유튜브 전용 추출은 지원하지 않습니다.

## 설치

0. 요구 사항: macOS, Chrome 120 이상, Node.js 18 이상, ffmpeg(`brew install node ffmpeg`).
   ```bash
   git clone https://github.com/Hwemo-Chung/media-saver.git
   cd media-saver
   ```
1. ffmpeg 도우미(선택이지만 권장): 저장소 폴더에서 `bash helper/install.sh`
   - 크롬이 `/opt/homebrew/bin/ffmpeg`를 부를 수 있게 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.mediasaver.helper.json` 한 파일을 만듭니다.
   - 없으면 HLS는 `.ts`, DASH는 영상·음성 두 파일로 남습니다.
2. 크롬 주소창에 `chrome://extensions` → 오른쪽 위 **개발자 모드** 켜기 → **압축해제된 확장 프로그램을 로드합니다** → 저장소의 `extension` 폴더 선택.
3. 퍼즐 조각 아이콘에서 Media Saver를 고정(핀)합니다.

확장 ID는 매니페스트의 `key`로 고정되어 있습니다: `ljojagcmpjloafhjikdgpdfndbncfhdc`.

## 쓰는 법

- 영상을 재생하면 아이콘에 숫자가 뜹니다. 아이콘 → **미디어** 탭 → 화질·자막 고르기 → **저장**(라이브는 **녹화**, 끝낼 때 작업 탭의 「녹화 끝내고 저장」).
- **이미지** 탭: 최소 크기(px)를 정하면 그보다 작은 그림은 빠집니다. 눌러서 고르고 **저장**하면 `다운로드/Media Saver/<사이트 날짜>/`에 들어갑니다.
- **작업** 탭: 진행률·속도, 취소, 「Finder에서 보기」, 최근 기록.
- 설정(⚙): 파일 이름 규칙(`%title %hostname %quality %date`), 하위 폴더, 동시 조각 수, 자막 형식, 도우미 사용 여부.

## 제거

- 확장: `chrome://extensions`에서 삭제.
- 도우미: 저장소 폴더에서 `bash helper/uninstall.sh`

## 개발

```bash
npm test                 # 단위 테스트(node --test)
npm run fixtures         # 시험용 HLS·DASH·이미지 생성(ffmpeg)
npm run serve            # 시험 서버 http://127.0.0.1:47800/p/ (Referer·쿠키 없으면 403)
                         # 접근 검사 페이지: /p/guard-site · /p/guard-ch · /p/once · /p/disguise
```

자동 종단 시험은 `extension/dev-token.txt`가 있을 때만 열리는 연결(127.0.0.1 페이지 → 확장)을 씁니다. 시험이 끝나면 이 파일을 지워 닫습니다.

구조: `extension/`(서비스 워커 `background.js`, 다운로드 엔진 `offscreen.js`, 팝업, 설정, `lib/` 순수 모듈) · `helper/`(Node 네이티브 메시징 호스트) · `tests/` · `docs/`(PRD, 도우미 규격, 변환 가능성 검토).

## 이용 주의

저작권이 있는 콘텐츠는 권리자가 허락한 범위와 각 사이트의 이용 약관 안에서만 저장하십시오. DRM 보호를 풀거나 우회하는 기능은 넣지 않습니다.

## 라이선스

[MIT](LICENSE)
