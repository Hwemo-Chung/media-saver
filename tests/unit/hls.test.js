import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttributeList, isMasterPlaylist, parseMaster, parseMedia, ivForSequence, parseHexIV,
} from '../../extension/lib/hls.js';

const BASE = 'https://cdn.example.com/v/abc/master.m3u8?token=1';

test('parseAttributeList keeps commas inside quotes and parses hex/decimal', () => {
  const a = parseAttributeList('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,IV=0x0A0B');
  assert.equal(a.BANDWIDTH, '1280000');
  assert.equal(a.CODECS, 'avc1.4d401f,mp4a.40.2');
  assert.equal(a.RESOLUTION, '1280x720');
  assert.equal(a.IV, '0x0A0B');
});

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="Korean",LANGUAGE="ko",DEFAULT=NO,URI="subs/ko.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="subs/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e",AUDIO="aud",SUBTITLES="subs"
360p/index.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI="iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.4d401f",AUDIO="aud",SUBTITLES="subs",FRAME-RATE=30
https://other.example.com/720p/index.m3u8
`;

test('isMasterPlaylist distinguishes master from media', () => {
  assert.equal(isMasterPlaylist(MASTER), true);
  assert.equal(isMasterPlaylist('#EXTM3U\n#EXTINF:2,\na.ts\n'), false);
});

test('parseMaster resolves variants, audio and subtitle renditions, sorted best first', () => {
  const m = parseMaster(MASTER, BASE);
  assert.equal(m.variants.length, 2);
  assert.equal(m.variants[0].height, 720);
  assert.equal(m.variants[0].uri, 'https://other.example.com/720p/index.m3u8');
  assert.equal(m.variants[1].uri, 'https://cdn.example.com/v/abc/360p/index.m3u8');
  assert.equal(m.variants[1].bandwidth, 800000);
  assert.equal(m.variants[0].audioGroup, 'aud');
  assert.equal(m.audio.length, 1);
  assert.equal(m.audio[0].uri, 'https://cdn.example.com/v/abc/audio/en.m3u8');
  assert.equal(m.audio[0].default, true);
  assert.equal(m.subtitles.length, 2);
  assert.deepEqual(m.subtitles.map((s) => s.language).sort(), ['en', 'ko']);
  assert.equal(m.subtitles.find((s) => s.language === 'ko').uri, 'https://cdn.example.com/v/abc/subs/ko.m3u8');
});

const MEDIA_AES = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:7
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:2.000,
seg7.ts
#EXTINF:2.000,
seg8.ts
#EXT-X-KEY:METHOD=AES-128,URI="key2.bin",IV=0x000102030405060708090a0b0c0d0e0f
#EXTINF:1.5,
seg9.ts
#EXT-X-KEY:METHOD=NONE
#EXT-X-DISCONTINUITY
#EXTINF:2,
seg10.ts
#EXT-X-ENDLIST
`;

test('parseMedia tracks sequence numbers, keys, explicit and implicit IVs, discontinuity, endlist', () => {
  const p = parseMedia(MEDIA_AES, 'https://h.example.com/a/b/media.m3u8');
  assert.equal(p.targetDuration, 2);
  assert.equal(p.mediaSequence, 7);
  assert.equal(p.endList, true);
  assert.equal(p.live, false);
  assert.equal(p.segments.length, 4);
  assert.deepEqual(p.segments.map((s) => s.seq), [7, 8, 9, 10]);
  assert.equal(p.segments[0].uri, 'https://h.example.com/a/b/seg7.ts');
  assert.equal(p.segments[0].key.method, 'AES-128');
  assert.equal(p.segments[0].key.uri, 'https://h.example.com/a/b/key.bin');
  assert.equal(p.segments[0].key.iv, null);
  assert.equal(p.segments[2].key.uri, 'https://h.example.com/a/b/key2.bin');
  assert.deepEqual([...p.segments[2].key.iv], [...Array(16).keys()]);
  assert.equal(p.segments[3].key, null);
  assert.equal(p.segments[3].discontinuity, true);
  assert.equal(p.totalDuration, 7.5);
  assert.equal(p.drm, false);
});

test('ivForSequence is the 128-bit big-endian sequence number', () => {
  assert.deepEqual([...ivForSequence(0)], new Array(16).fill(0));
  const iv = ivForSequence(258);
  assert.equal(iv[15], 2);
  assert.equal(iv[14], 1);
  assert.equal(iv.slice(0, 14).every((b) => b === 0), true);
  const big = ivForSequence(2 ** 33 + 5);
  assert.equal(big[15], 5);
  assert.equal(big[11], 2);
});

test('parseHexIV accepts 0x prefix and short values (left-padded)', () => {
  assert.deepEqual([...parseHexIV('0x01')], [...new Array(15).fill(0), 1]);
  assert.equal(parseHexIV('0X000102030405060708090A0B0C0D0E0F')[15], 15);
});

test('parseMedia handles EXT-X-MAP and EXT-X-BYTERANGE with implicit offsets', () => {
  const text = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:2000
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500
main.mp4
#EXT-X-ENDLIST`;
  const p = parseMedia(text, 'https://x.test/p/list.m3u8');
  assert.deepEqual(p.segments[0].map, { uri: 'https://x.test/p/main.mp4', byteRange: { offset: 0, length: 720 } });
  assert.deepEqual(p.segments.map((s) => s.byteRange), [
    { offset: 720, length: 1000 },
    { offset: 1720, length: 2000 },
    { offset: 3720, length: 500 },
  ]);
});

test('parseMedia flags live playlists and DRM keys', () => {
  const live = parseMedia('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:100\n#EXTINF:2,\ns100.ts\n#EXTINF:2,\ns101.ts\n', 'https://l.test/live.m3u8');
  assert.equal(live.live, true);
  assert.equal(live.endList, false);
  assert.deepEqual(live.segments.map((s) => s.seq), [100, 101]);

  const fairplay = parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://x",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'https://d.test/m.m3u8');
  assert.equal(fairplay.drm, true);
  assert.match(fairplay.drmReason, /SAMPLE-AES|streamingkeydelivery/);

  const widevine = parseMedia('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:x",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"\n#EXTINF:2,\na.ts\n#EXT-X-ENDLIST', 'https://d.test/m.m3u8');
  assert.equal(widevine.drm, true);
});

test('parseMaster flags session keys that are DRM', () => {
  const m = parseMaster('#EXTM3U\n#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="skd://a",KEYFORMAT="com.apple.streamingkeydelivery"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n', 'https://d.test/master.m3u8');
  assert.equal(m.drm, true);
});

test('parseMedia handles CRLF line endings and blank lines', () => {
  const p = parseMedia('#EXTM3U\r\n\r\n#EXT-X-TARGETDURATION:6\r\n#EXTINF:6.006,title\r\nx.ts\r\n#EXT-X-ENDLIST\r\n', 'https://c.test/m.m3u8');
  assert.equal(p.segments.length, 1);
  assert.equal(p.segments[0].duration, 6.006);
  assert.equal(p.segments[0].uri, 'https://c.test/x.ts');
});
