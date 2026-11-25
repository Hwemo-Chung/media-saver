# [media-saver] PRD — Media Saver (Chrome MV3 확장 + ffmpeg 도우미)

작성 2026-11-25. 사용자 결정: 범위 「무제한+자막+이미지+라이브」, 도우미 설치, 위치 `~/Documents/media-saver`, 화면 팝업.

## 1. 목표

웹 페이지가 내려받는 영상·음성·이미지를 감지해 로컬에 저장하는 크롬 확장.
Video DownloadHelper(VDH) 10.7의 **공개 문서에 적힌 동작**을 기준으로 새로 작성한다(VDH 코드·이름·아이콘은 쓰지 않는다).

| VDH 무료판 | Media Saver |
|---|---|
| 단일 파일 무제한 | 단일 파일 무제한 |
| HLS·DASH: 설치 시 3회, 이후 2시간에 1회 | **횟수·시간 제한 없음** |
| 자막: 프리미엄 | **자막 저장(.vtt/.srt) + mp4 내장 선택** |
| — | **이미지 일괄 저장**(크기 필터) |
| — | **HLS 라이브 녹화**(Rec/Stop) |
| 파일 이름 규칙(smartnaming) | 파일 이름 템플릿(%title %hostname %quality %date) |

## 2. 범위

포함
- 감지: `webRequest`로 Content-Type·확장자 판정(mp4 webm mov mkv m4a mp3 aac ogg opus flac wav, m3u8, mpd). 세그먼트(.ts .m4s)는 목록에서 숨김. 아이콘 배지에 개수.
- HLS: master/media, 해상도 선택, 대체 음성(EXT-X-MEDIA AUDIO), 자막(SUBTITLES, WebVTT), EXT-X-MAP(fMP4), EXT-X-BYTERANGE, AES-128(IV 생략 시 미디어 시퀀스 번호), 라이브(ENDLIST 없음) 녹화.
- DASH: SegmentTemplate($Number$ $Time$ $RepresentationID$ $Bandwidth$, %0Nd), SegmentTimeline(r, r=-1), SegmentList, SegmentBase/단일 BaseURL, BaseURL 계층, 영상+음성 분리 → 합치기, text/vtt 자막.
- 요청 헤더 재현: 원래 요청의 Referer·Origin을 declarativeNetRequest 세션 규칙으로 붙이고, 쿠키는 credentials 포함으로 보낸다.
- 큰 파일: 오프스크린 문서가 조각을 순서대로 OPFS에 써서 메모리에 다 올리지 않는다.
- 도우미(네이티브 메시징 호스트, Node): ffmpeg로 TS→MP4 리먹스, 영상+음성(+자막) 합치기, Finder에서 보기. 경로는 홈 아래·허용 확장자만, 셸 없이 인자 배열로 실행.
- 팝업: [Media] [Images] [Jobs] 탭, 설정(톱니). 팝업은 탭으로도 열 수 있게(`popup.html?tab=<id>`).
- 기록(최근 200건), 동시 조각 수, 파일 이름 템플릿, 하위 폴더, 최소 이미지 크기 설정.

제외
- DRM(Widevine·FairPlay·PlayReady, HLS SAMPLE-AES, DASH ContentProtection): 「보호된 콘텐츠라 저장할 수 없음」으로 표시만 한다. 우회하지 않는다.
- 유튜브 등 사이트 전용 추출(yt-dlp 연동)은 이번 범위 밖.
- DASH 다중 Period는 첫 Period만(목록에 표시).
- DASH 라이브(type=dynamic) 녹화는 범위 밖(HLS 라이브만).

## 3. 완료 기준 (체크리스트)

- [ ] `npm test`(node --test) 단위 테스트 전부 통과: HLS·DASH·XML 파서, AES IV, 감지 분류, 파일 이름, 자막 병합·SRT 변환, 순서 보장 쓰기, 도우미 프레이밍·경로 검사·ffmpeg 인자.
- [ ] 로컬 시험 서버(127.0.0.1:47800, Referer·쿠키 없으면 403)에서 실제 크롬으로 받은 결과를 `ffprobe`로 확인:
  - [ ] 직접 mp4·mp3
  - [x] HLS TS 720p → .mp4, 길이 ±0.5초, 영상+음성 (크롬 실측 2026-11-25)
  - [ ] HLS fMP4 → .mp4
  - [ ] HLS AES-128 → 재생되는 .mp4
  - [ ] HLS 대체 음성 → 영상+음성 한 파일
  - [ ] HLS BYTERANGE → .mp4
  - [x] HLS 자막 en·ko → .srt/.vtt (크롬 실측 2026-11-25)
  - [ ] DASH SegmentTimeline·$Number$·SegmentBase → 영상+음성 한 파일
  - [ ] HLS 라이브 Rec→Stop → 재생되는 .mp4
  - [ ] 이미지 페이지: 최소 크기 이상만 일괄 저장
  - [ ] DRM 페이지: 「보호됨」 표시, 다운로드 버튼 없음
  - [ ] 연속 5회 이상 HLS 저장해도 제한 없음
  - [x] 접근 거절(Sec-Fetch-Site·client hint 검사) 페이지 → 헤더 흉내로 .mp4 (크롬 실측 2026-11-25)
  - [x] 일회용 목록 주소 → 단계별 거절 사유 표시 (크롬 실측 2026-11-25)
  - [x] 가짜 PNG 머리를 붙인 조각 → .mp4 (크롬 실측 2026-11-25)
- [ ] 팝업 세 탭 스크린샷 보관(`docs/evidence/`).
- [x] 사용하는 크롬 프로필에 로드되어 있음(사용자가 Load unpacked 1회, 2026-11-25).

## 4. 다음 목표(사용자 지시 2026-11-25)

저장한 미디어를 PDF·PPT·GIF로 변환 저장하는 도구가 가능한지 확인 → `docs/conversion-feasibility.md`.
