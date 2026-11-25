import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, extFromUrl } from '../../extension/lib/detect.js';
import { buildFilename, sanitize } from '../../extension/lib/naming.js';
import { parseVtt, mergeVttSegments, vttToSrt, formatSrtTime } from '../../extension/lib/subtitles.js';
import { OrderedSink, runPool } from '../../extension/lib/ordered.js';
import { decryptAes128 } from '../../extension/lib/aes.js';
import { createCipheriv, randomBytes } from 'node:crypto';

test('extFromUrl ignores query and fragment', () => {
  assert.equal(extFromUrl('https://a.test/x/y.M3U8?t=1#f'), 'm3u8');
  assert.equal(extFromUrl('https://a.test/x/'), '');
  assert.equal(extFromUrl('https://a.test/x.y/z'), '');
});

test('classify by content-type first, then by extension', () => {
  assert.equal(classify({ url: 'https://a.test/p?x', contentType: 'application/vnd.apple.mpegurl' }).kind, 'hls');
  assert.equal(classify({ url: 'https://a.test/p', contentType: 'audio/x-mpegurl; charset=utf-8' }).kind, 'hls');
  assert.equal(classify({ url: 'https://a.test/m.mpd', contentType: 'text/plain' }).kind, 'dash');
  assert.equal(classify({ url: 'https://a.test/m', contentType: 'application/dash+xml' }).kind, 'dash');
  assert.equal(classify({ url: 'https://a.test/v.mp4', contentType: 'video/mp4', contentLength: 5e6 }).kind, 'video');
  assert.equal(classify({ url: 'https://a.test/s.mp3', contentType: 'audio/mpeg', contentLength: 5e6 }).kind, 'audio');
  assert.equal(classify({ url: 'https://a.test/v.webm', contentType: 'application/octet-stream', contentLength: 5e6 }).kind, 'video');
});

test('classify hides stream segments, tiny files and non-media', () => {
  assert.equal(classify({ url: 'https://a.test/seg1.ts', contentType: 'video/mp2t' }).kind, 'segment');
  assert.equal(classify({ url: 'https://a.test/c.m4s', contentType: 'video/iso.segment' }).kind, 'segment');
  assert.equal(classify({ url: 'https://a.test/v.mp4', contentType: 'video/mp4', contentLength: 2000 }, { minMediaBytes: 100000 }).kind, null);
  assert.equal(classify({ url: 'https://a.test/page.html', contentType: 'text/html' }).kind, null);
  assert.equal(classify({ url: 'https://a.test/s.vtt', contentType: 'text/vtt' }).kind, 'subtitle');
  // unknown length is allowed
  assert.equal(classify({ url: 'https://a.test/v.mp4', contentType: 'video/mp4' }).kind, 'video');
});

test('sanitize removes path separators and control chars and trims dots', () => {
  assert.equal(sanitize('a/b:c*d?"<>|e\u0001'), 'a_b_c_d_____e');
  assert.equal(sanitize('  ..hidden. '), 'hidden');
  assert.equal(sanitize(''), 'media');
});

test('buildFilename applies template, limits length, keeps Korean, appends extension', () => {
  const name = buildFilename({
    template: '%title - %quality', title: '테스트 영상: 1화', hostname: 'www.example.com', quality: '720p', ext: 'mp4', maxLength: 64,
  });
  assert.equal(name, '테스트 영상_ 1화 - 720p.mp4');
  const long = buildFilename({ template: '%title', title: 'x'.repeat(300), ext: 'ts', maxLength: 10 });
  assert.equal(long, 'xxxxxxxxxx.ts');
  const host = buildFilename({ template: '%hostname-%title', title: 'T', hostname: 'www.example.com', ext: 'mp4' });
  assert.equal(host, 'example.com-T.mp4');
  const noQ = buildFilename({ template: '%title - %quality', title: 'T', ext: 'mp3' });
  assert.equal(noQ, 'T.mp3');
  const date = buildFilename({ template: '%date %title', title: 'T', ext: 'jpg', now: new Date(2026, 10, 25, 9, 5, 7) });
  assert.equal(date, '2026-11-25 090507 T.jpg');
});

const SEG1 = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

1
00:00:00.500 --> 00:00:02.000
First line

00:00:01.800 --> 00:00:03.000 align:start
Spans
two segments
`;
const SEG2 = `WEBVTT
X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000

00:00:01.800 --> 00:00:03.000 align:start
Spans
two segments

00:00:03.500 --> 00:00:04.250
한국어 자막
`;

test('parseVtt reads cues, settings and the timestamp map', () => {
  const v = parseVtt(SEG1);
  assert.equal(v.cues.length, 2);
  assert.equal(v.cues[0].start, 0.5);
  assert.equal(v.cues[1].text, 'Spans\ntwo segments');
  assert.equal(v.timestampMap.mpegts, 900000);
  assert.equal(v.timestampMap.local, 0);
});

test('mergeVttSegments de-duplicates cues repeated across segments and keeps order', () => {
  const merged = mergeVttSegments([SEG1, SEG2]);
  const v = parseVtt(merged);
  assert.equal(v.cues.length, 3);
  assert.deepEqual(v.cues.map((c) => c.text), ['First line', 'Spans\ntwo segments', '한국어 자막']);
  assert.match(merged, /^WEBVTT\n/);
});

test('mergeVttSegments re-bases segments whose MPEGTS map differs from the first', () => {
  const a = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00:01.000 --> 00:00:02.000\nA\n';
  const b = 'WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:1080000,LOCAL:00:00:00.000\n\n00:00:00.000 --> 00:00:01.000\nB\n';
  const v = parseVtt(mergeVttSegments([a, b]));
  assert.equal(v.cues[1].start, 2); // (1080000-900000)/90000 = 2 s later
});

test('vttToSrt numbers cues and uses comma milliseconds', () => {
  const srt = vttToSrt(mergeVttSegments([SEG1]));
  assert.equal(srt.split('\n')[0], '1');
  assert.equal(srt.split('\n')[1], '00:00:00,500 --> 00:00:02,000');
  assert.equal(formatSrtTime(3723.5), '01:02:03,500');
  assert.doesNotMatch(srt, /align:start/);
});

test('OrderedSink writes chunks strictly in index order', async () => {
  const out = [];
  const sink = new OrderedSink(async (chunk) => { out.push(chunk); });
  await sink.put(2, 'c');
  await sink.put(0, 'a');
  assert.deepEqual(out, ['a']);
  await sink.put(1, 'b');
  assert.deepEqual(out, ['a', 'b', 'c']);
  assert.equal(sink.next, 3);
});

test('runPool respects concurrency, retries failures and reports progress', async () => {
  let active = 0; let peak = 0; const attempts = {};
  const progress = [];
  const results = await runPool([0, 1, 2, 3, 4, 5], 2, async (item) => {
    attempts[item] = (attempts[item] || 0) + 1;
    active += 1; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active -= 1;
    if (item === 3 && attempts[item] < 3) throw new Error('flaky');
    return item * 10;
  }, { retries: 3, retryDelayMs: 1, onProgress: (done, total) => progress.push(`${done}/${total}`) });
  assert.deepEqual(results, [0, 10, 20, 30, 40, 50]);
  assert.equal(peak, 2);
  assert.equal(attempts[3], 3);
  assert.equal(progress.at(-1), '6/6');
});

test('runPool rejects after retries are exhausted and stops on abort', async () => {
  await assert.rejects(runPool([1], 1, async () => { throw new Error('nope'); }, { retries: 2, retryDelayMs: 1 }), /nope/);
  const ac = new AbortController();
  const p = runPool([1, 2, 3, 4], 1, async (i) => { if (i === 2) ac.abort(); await new Promise((r) => setTimeout(r, 2)); return i; }, { signal: ac.signal });
  await assert.rejects(p, /abort/i);
});

test('decryptAes128 matches openssl-style AES-128-CBC with PKCS7', async () => {
  const key = randomBytes(16); const iv = randomBytes(16);
  const plain = Buffer.from('hello segment data '.repeat(50));
  const c = createCipheriv('aes-128-cbc', key, iv);
  const enc = Buffer.concat([c.update(plain), c.final()]);
  const dec = await decryptAes128(new Uint8Array(enc), new Uint8Array(key), new Uint8Array(iv));
  assert.equal(Buffer.from(dec).toString(), plain.toString());
});
