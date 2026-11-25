// Tests for helper/lib/progress.js — parsing ffmpeg `-progress pipe:1` output.
// Sample block captured from ffmpeg 9.0.2 on this machine (out_time_ms is in
// microseconds, like out_time_us — a long-standing ffmpeg quirk).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOutTime, toProgress, ProgressParser } from '../../helper/lib/progress.js';

const BLOCK_END = [
  'frame=50',
  'fps=0.00',
  'stream_0_0_q=-1.0',
  'bitrate= 202.7kbits/s',
  'total_size=51770',
  'out_time_us=2043344',
  'out_time_ms=2043344',
  'out_time=00:00:02.043344',
  'dup_frames=0',
  'drop_frames=0',
  'speed=3.36e+03x',
  'progress=end',
  '',
].join('\n');

test('parseOutTime prefers out_time_us', () => {
  assert.equal(parseOutTime({ out_time_us: '2043344', out_time_ms: '999', out_time: '00:00:09.000000' }), 2.043344);
});

test('parseOutTime falls back to out_time, then to out_time_ms read as microseconds', () => {
  assert.equal(parseOutTime({ out_time_us: 'N/A', out_time: '00:01:02.500000' }), 62.5);
  assert.equal(parseOutTime({ out_time_ms: '1500000' }), 1.5);
  assert.equal(parseOutTime({ out_time: '01:00:00.000000' }), 3600);
});

test('parseOutTime returns null when no usable value is present', () => {
  assert.equal(parseOutTime({ out_time_us: 'N/A', out_time_ms: 'N/A', out_time: 'N/A' }), null);
  assert.equal(parseOutTime({}), null);
});

test('parseOutTime clamps a negative time to zero', () => {
  assert.equal(parseOutTime({ out_time_us: '-23219' }), 0);
  assert.equal(parseOutTime({ out_time: '-00:00:00.023219' }), 0);
});

test('toProgress adds a clamped percent only when durationSec is positive', () => {
  assert.deepEqual(toProgress(1, 4), { outTimeSec: 1, percent: 25 });
  assert.deepEqual(toProgress(5, 4), { outTimeSec: 5, percent: 100 });
  assert.deepEqual(toProgress(1, undefined), { outTimeSec: 1 });
  assert.deepEqual(toProgress(1, 0), { outTimeSec: 1 });
  assert.deepEqual(toProgress(1, Number.NaN), { outTimeSec: 1 });
});

test('toProgress rounds outTimeSec to milliseconds and percent to one decimal', () => {
  assert.deepEqual(toProgress(2.043344, 3), { outTimeSec: 2.043, percent: 68.1 });
});

test('ProgressParser emits one event per block and records progress=end', () => {
  const p = new ProgressParser(4);
  const events = p.push(BLOCK_END);
  assert.deepEqual(events, [{ outTimeSec: 2.043, percent: 51.1 }]);
  assert.equal(p.ended, true);
});

test('ProgressParser handles blocks split across arbitrary chunk boundaries', () => {
  const text = BLOCK_END.replace('progress=end', 'progress=continue') + BLOCK_END.replace('2043344', '4000000').replace('2043344', '4000000').replace('00:00:02.043344', '00:00:04.000000');
  const p = new ProgressParser(4);
  const events = [];
  for (let i = 0; i < text.length; i += 7) events.push(...p.push(text.slice(i, i + 7)));
  assert.deepEqual(events, [{ outTimeSec: 2.043, percent: 51.1 }, { outTimeSec: 4, percent: 100 }]);
  assert.equal(p.ended, true);
});

test('ProgressParser skips a block whose time is N/A and is not ended by progress=continue', () => {
  const p = new ProgressParser(10);
  const events = p.push('out_time_us=N/A\nout_time_ms=N/A\nout_time=N/A\nprogress=continue\n');
  assert.deepEqual(events, []);
  assert.equal(p.ended, false);
});

test('ProgressParser accepts CRLF line endings', () => {
  const p = new ProgressParser();
  assert.deepEqual(p.push('out_time_us=1000000\r\nprogress=continue\r\n'), [{ outTimeSec: 1 }]);
});
