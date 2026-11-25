// Tests for helper/lib/framing.js — Chrome native-messaging framing
// (4-byte little-endian length + UTF-8 JSON). Spec: docs/helper-protocol.md "프레이밍".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encode,
  FrameDecoder,
  MAX_OUTGOING_BYTES,
} from '../../helper/lib/framing.js';

function frame(json) {
  const body = Buffer.from(json, 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

test('encode writes a little-endian byte length followed by the UTF-8 JSON body', () => {
  const buf = encode({ id: '1', type: 'result', text: '한글' });
  const body = JSON.stringify({ id: '1', type: 'result', text: '한글' });
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  assert.equal(buf.readUInt32LE(0), bodyBytes);
  assert.notEqual(bodyBytes, body.length, 'fixture must contain multi-byte characters');
  assert.equal(buf.length, 4 + bodyBytes);
  assert.equal(buf.subarray(4).toString('utf8'), body);
});

test('encode accepts a body of exactly 1MB and rejects one byte more', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ s: '' }), 'utf8');
  const exact = { s: 'a'.repeat(MAX_OUTGOING_BYTES - overhead) };
  assert.equal(MAX_OUTGOING_BYTES, 1024 * 1024);
  assert.equal(encode(exact).length, 4 + MAX_OUTGOING_BYTES);
  const over = { s: 'a'.repeat(MAX_OUTGOING_BYTES - overhead + 1) };
  assert.throws(() => encode(over), (err) => err.code === 'MESSAGE_TOO_LARGE');
});

test('encode rejects values that do not serialise to JSON', () => {
  assert.throws(() => encode(undefined), TypeError);
});

test('decoder parses one whole frame', () => {
  const dec = new FrameDecoder();
  const out = dec.push(frame('{"id":"a","op":"hello"}'));
  assert.deepEqual(out, [{ ok: true, value: { id: 'a', op: 'hello' } }]);
  assert.equal(dec.bufferedBytes, 0);
});

test('decoder reassembles a frame fed one byte at a time, header included', () => {
  const dec = new FrameDecoder();
  const bytes = frame('{"id":"b","op":"remux","input":"/Users/x/영상.ts"}');
  const got = [];
  for (let i = 0; i < bytes.length; i += 1) got.push(...dec.push(bytes.subarray(i, i + 1)));
  assert.deepEqual(got, [{ ok: true, value: { id: 'b', op: 'remux', input: '/Users/x/영상.ts' } }]);
});

test('decoder splits several frames merged into one chunk and keeps a trailing partial frame', () => {
  const dec = new FrameDecoder();
  const third = frame('{"id":"3"}');
  const chunk = Buffer.concat([frame('{"id":"1"}'), frame('{"id":"2"}'), third.subarray(0, 6)]);
  const first = dec.push(chunk);
  assert.deepEqual(first.map((m) => m.value.id), ['1', '2']);
  assert.equal(dec.bufferedBytes, 6);
  const rest = dec.push(third.subarray(6));
  assert.deepEqual(rest, [{ ok: true, value: { id: '3' } }]);
});

test('decoder reports invalid JSON as a non-fatal error and keeps decoding', () => {
  const dec = new FrameDecoder();
  const out = dec.push(Buffer.concat([frame('{not json'), frame('{"id":"ok"}')]));
  assert.equal(out.length, 2);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].fatal, false);
  assert.deepEqual(out[1], { ok: true, value: { id: 'ok' } });
});

test('decoder treats an oversized declared length as fatal and stops consuming', () => {
  const dec = new FrameDecoder({ maxMessageBytes: 16 });
  const head = Buffer.alloc(4);
  head.writeUInt32LE(17, 0);
  const out = dec.push(Buffer.concat([head, Buffer.alloc(17, 0x20)]));
  assert.equal(out.length, 1);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].fatal, true);
  assert.deepEqual(dec.push(frame('{"id":"x"}')), []);
});

test('decoder round-trips what encode produces', () => {
  const dec = new FrameDecoder();
  const msgs = [{ id: '1', type: 'progress', outTimeSec: 1.5, percent: 37.5 }, { id: '1', type: 'result', output: '/Users/a b/c (1).mp4', size: 10 }];
  const out = dec.push(Buffer.concat(msgs.map((m) => encode(m))));
  assert.deepEqual(out.map((m) => m.value), msgs);
});
