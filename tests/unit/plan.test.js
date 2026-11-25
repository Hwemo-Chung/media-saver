import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMaster } from '../../extension/lib/hls.js';
import { parseMpd } from '../../extension/lib/dash.js';
import { hlsOptions, hlsSubtitleOptions, dashOptions, dashSubtitleOptions, estimateBytes, formatBytes } from '../../extension/lib/plan.js';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Korean",LANGUAGE="ko",URI="ko.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="Korean",LANGUAGE="ko",URI="s-ko.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s2",NAME="Korean",LANGUAGE="ko",URI="s-ko.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"
720-backup.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO="a"
360.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"
audio-only.m3u8
`;

test('hlsOptions: one option per distinct variant, default audio attached, audio-only choices last', () => {
  const m = parseMaster(MASTER, 'https://h.test/x/master.m3u8');
  const o = hlsOptions(m, 10);
  const video = o.filter((x) => !x.audioOnly);
  assert.equal(video.length, 2);
  assert.equal(video[0].height, 720);
  assert.equal(video[0].videoUri, 'https://h.test/x/720.m3u8');
  assert.equal(video[0].audioUri, 'https://h.test/x/en.m3u8');
  assert.match(video[0].label, /720p/);
  assert.equal(video[0].estBytes, 3000000);
  const audio = o.filter((x) => x.audioOnly);
  assert.ok(audio.length >= 2);
  assert.ok(audio.some((x) => x.audioUri === 'https://h.test/x/ko.m3u8'));
  assert.ok(audio.some((x) => x.videoUri === 'https://h.test/x/audio-only.m3u8'));
  assert.equal(new Set(o.map((x) => x.id)).size, o.length);
});

test('hlsOptions: muxed audio (rendition without URI) means no separate audio', () => {
  const m = parseMaster('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=2x2,AUDIO="a"\nv.m3u8\n', 'https://h.test/m.m3u8');
  const o = hlsOptions(m, 0);
  assert.equal(o.length, 1);
  assert.equal(o[0].audioUri, null);
  assert.equal(o[0].estBytes, 0);
});

test('hlsSubtitleOptions de-duplicates by URI', () => {
  const s = hlsSubtitleOptions(parseMaster(MASTER, 'https://h.test/x/master.m3u8'));
  assert.equal(s.length, 1);
  assert.equal(s[0].lang, 'ko');
  assert.match(s[0].label, /Korean/);
});

const MPD = `<MPD type="static" mediaPresentationDuration="PT10S"><Period>
<AdaptationSet mimeType="video/mp4"><SegmentTemplate media="$RepresentationID$-$Number$.m4s" initialization="$RepresentationID$-init.mp4" duration="2" timescale="1"/>
  <Representation id="v720" bandwidth="2000000" width="1280" height="720"/>
  <Representation id="v360" bandwidth="600000" width="640" height="360"/>
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="en"><SegmentTemplate media="$RepresentationID$-$Number$.m4s" initialization="$RepresentationID$-init.mp4" duration="2" timescale="1"/>
  <Representation id="a128" bandwidth="128000"/><Representation id="a64" bandwidth="64000"/>
</AdaptationSet>
<AdaptationSet mimeType="audio/mp4" lang="ko"><SegmentTemplate media="$RepresentationID$-$Number$.m4s" initialization="$RepresentationID$-init.mp4" duration="2" timescale="1"/>
  <Representation id="ako" bandwidth="96000"/>
</AdaptationSet>
<AdaptationSet mimeType="text/vtt" lang="ko"><Representation id="t1" bandwidth="1"><BaseURL>ko.vtt</BaseURL></Representation></AdaptationSet>
<AdaptationSet mimeType="application/mp4" codecs="stpp" lang="en"><Representation id="t2" bandwidth="1"><BaseURL>en.mp4</BaseURL></Representation></AdaptationSet>
</Period></MPD>`;

test('dashOptions pairs each video with the best audio, adds audio-only per language', () => {
  const o = dashOptions(parseMpd(MPD, 'https://d.test/m.mpd'));
  const video = o.filter((x) => !x.audioOnly);
  assert.deepEqual(video.map((x) => [x.videoId, x.audioId]), [['v720', 'a128'], ['v360', 'a128']]);
  assert.equal(video[0].estBytes, Math.round((2000000 + 128000) * 10 / 8));
  const audio = o.filter((x) => x.audioOnly);
  assert.deepEqual(audio.map((x) => x.audioId).sort(), ['a128', 'ako']);
});

test('dashSubtitleOptions keeps only WebVTT tracks', () => {
  const s = dashSubtitleOptions(parseMpd(MPD, 'https://d.test/m.mpd'));
  assert.equal(s.length, 1);
  assert.equal(s[0].repId, 't1');
  assert.equal(s[0].lang, 'ko');
});

test('estimateBytes and formatBytes', () => {
  assert.equal(estimateBytes(8000, 2), 2000);
  assert.equal(estimateBytes(0, 10), 0);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(12.3 * 1024 * 1024), '12.3 MB');
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.50 GB');
});
