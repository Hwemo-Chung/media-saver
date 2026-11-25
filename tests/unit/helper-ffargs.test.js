// Tests for helper/lib/ffargs.js — ffmpeg argument arrays from
// docs/helper-protocol.md "ffmpeg 인자". The mp4 forms are asserted as exact arrays.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remuxArgs, mergeArgs, toIso639_2 } from '../../helper/lib/ffargs.js';

const HEAD = ['-hide_banner', '-nostdin', '-n'];
const TAIL = ['-progress', 'pipe:1', '-nostats'];

test('remux of a video input (.ts) uses the documented video form', () => {
  assert.deepEqual(remuxArgs('/Users/u/D/clip.ts', '/Users/u/D/clip.mp4'), [
    ...HEAD, '-i', '/Users/u/D/clip.ts',
    '-map', '0:v?', '-map', '0:a?', '-c', 'copy', '-dn', '-movflags', '+faststart',
    ...TAIL, '/Users/u/D/clip.mp4',
  ]);
});

test('remux of .aac to .m4a uses the documented audio form', () => {
  assert.deepEqual(remuxArgs('/Users/u/D/s.aac', '/Users/u/D/s.m4a'), [
    ...HEAD, '-i', '/Users/u/D/s.aac',
    '-map', '0:a', '-c', 'copy', '-movflags', '+faststart',
    ...TAIL, '/Users/u/D/s.m4a',
  ]);
});

test('remux uses the audio form for every audio-only input (.aac .m4a .mp3, any case)', () => {
  for (const [inp, out] of [['/h/a.M4A', '/h/a (1).m4a'], ['/h/a.mp3', '/h/a (1).mp3'], ['/h/a.AAC', '/h/a.m4a']]) {
    const args = remuxArgs(inp, out);
    assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-c')), ['-map', '0:a'], inp);
    assert.ok(!args.includes('-dn'), inp);
  }
});

test('remux of a video input to an audio container extracts the audio', () => {
  const args = remuxArgs('/h/clip.ts', '/h/clip.m4a');
  assert.deepEqual(args.slice(args.indexOf('-map'), args.indexOf('-c')), ['-map', '0:a']);
});

test('remux passes paths with spaces, quotes and $ as single verbatim elements', () => {
  const inp = "/Users/u/D/it's a \"clip\" $HOME `x`.ts";
  const out = "/Users/u/D/it's a \"clip\" $HOME `x`.mp4";
  const args = remuxArgs(inp, out);
  assert.equal(args[args.indexOf('-i') + 1], inp);
  assert.equal(args.at(-1), out);
});

test('merge of video + audio uses the documented form', () => {
  assert.deepEqual(mergeArgs({ video: '/h/v.mp4', audio: '/h/a.m4a', output: '/h/v (1).mp4' }), [
    ...HEAD, '-i', '/h/v.mp4', '-i', '/h/a.m4a',
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'copy', '-movflags', '+faststart',
    ...TAIL, '/h/v (1).mp4',
  ]);
});

test('merge of video + audio + two subtitles maps them and tags their languages', () => {
  assert.deepEqual(mergeArgs({
    video: '/h/v.mp4',
    audio: '/h/a.m4a',
    subtitles: [{ path: '/h/en.vtt', lang: 'en' }, { path: '/h/ko.srt', lang: 'kor' }],
    output: '/h/out.mp4',
  }), [
    ...HEAD, '-i', '/h/v.mp4', '-i', '/h/a.m4a', '-i', '/h/en.vtt', '-i', '/h/ko.srt',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:0', '-map', '3:0',
    '-c:v', 'copy', '-c:a', 'copy',
    '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=kor',
    '-movflags', '+faststart',
    ...TAIL, '/h/out.mp4',
  ]);
});

test('merge without audio shifts subtitle input numbers and keeps the video file own audio', () => {
  assert.deepEqual(mergeArgs({
    video: '/h/v.mp4',
    subtitles: [{ path: '/h/en.vtt', lang: 'en-US' }],
    output: '/h/out.mp4',
  }), [
    ...HEAD, '-i', '/h/v.mp4', '-i', '/h/en.vtt',
    '-map', '0:v:0', '-map', '0:a?', '-map', '1:0',
    '-c:v', 'copy', '-c:a', 'copy',
    '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng',
    '-movflags', '+faststart',
    ...TAIL, '/h/out.mp4',
  ]);
});

test('merge omits the language tag when a subtitle has no usable language', () => {
  const args = mergeArgs({ video: '/h/v.mp4', audio: '/h/a.m4a', subtitles: [{ path: '/h/x.vtt' }, { path: '/h/y.vtt', lang: 'qq' }, { path: '/h/z.vtt', lang: 'ja' }], output: '/h/o.mp4' });
  const meta = args.filter((a, i) => args[i - 1]?.startsWith('-metadata:'));
  assert.deepEqual(meta, ['language=jpn']);
  assert.equal(args[args.indexOf('language=jpn') - 1], '-metadata:s:s:2');
});

test('merge into .mkv uses srt subtitles because matroska cannot hold mov_text', () => {
  const args = mergeArgs({ video: '/h/v.mp4', audio: '/h/a.m4a', subtitles: [{ path: '/h/en.vtt', lang: 'en' }], output: '/h/o.mkv' });
  assert.equal(args[args.indexOf('-c:s') + 1], 'srt');
});

test('toIso639_2 maps ISO 639-1 and BCP-47 tags to the 3-letter codes mp4 stores', () => {
  assert.equal(toIso639_2('en'), 'eng');
  assert.equal(toIso639_2('EN'), 'eng');
  assert.equal(toIso639_2('ko'), 'kor');
  assert.equal(toIso639_2('ko-KR'), 'kor');
  assert.equal(toIso639_2('pt_BR'), 'por');
  assert.equal(toIso639_2('zh-Hans'), 'zho');
  assert.equal(toIso639_2('fil'), 'fil');
  assert.equal(toIso639_2('KOR'), 'kor');
  assert.equal(toIso639_2('qq'), null);
  assert.equal(toIso639_2(''), null);
  assert.equal(toIso639_2('e n'), null);
  assert.equal(toIso639_2(undefined), null);
});
