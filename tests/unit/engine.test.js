// Segment sniffing: disguised MPEG-TS (fake image header in front), other formats, error pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tsSyncOffset, sniffSegment, cleanTsSegment, downloadHlsTrack } from '../../extension/lib/engine.js';

/** n MPEG-TS packets: 0x47 sync byte + 187 filler bytes each. */
function tsPackets(n) {
  const out = new Uint8Array(188 * n);
  for (let i = 0; i < n; i += 1) { out[i * 188] = 0x47; out.fill(0x11, i * 188 + 1, (i + 1) * 188); }
  return out;
}
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const bytes = (...v) => Uint8Array.from(v);
const ascii = (s) => new TextEncoder().encode(s);
const PNG_HEAD = join(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), new Uint8Array(112).fill(0x47)); // 120 bytes, many 0x47 decoys
const JPEG_HEAD = join(bytes(0xff, 0xd8, 0xff, 0xe0), new Uint8Array(600).fill(0x00));

test('tsSyncOffset: plain TS starts at 0', () => {
  assert.equal(tsSyncOffset(tsPackets(4)), 0);
});

test('tsSyncOffset: skips a fake PNG header full of 0x47 decoys', () => {
  assert.equal(tsSyncOffset(join(PNG_HEAD, tsPackets(4))), PNG_HEAD.length);
});

test('tsSyncOffset: skips a JPEG header longer than hls.js scans', () => {
  const big = join(bytes(0xff, 0xd8, 0xff, 0xe0), new Uint8Array(5000));
  assert.equal(tsSyncOffset(join(big, tsPackets(5))), big.length);
});

test('tsSyncOffset: a single short packet still counts', () => {
  assert.equal(tsSyncOffset(tsPackets(1)), 0);
});

test('tsSyncOffset: -1 when there is no TS', () => {
  assert.equal(tsSyncOffset(ascii('<!doctype html><html><body>blocked</body></html>')), -1);
  assert.equal(tsSyncOffset(new Uint8Array(0)), -1);
});

test('sniffSegment names what a segment really is', () => {
  assert.equal(sniffSegment(join(PNG_HEAD, tsPackets(2))), 'PNG');
  assert.equal(sniffSegment(JPEG_HEAD), 'JPEG');
  assert.equal(sniffSegment(ascii('GIF89a....')), 'GIF');
  assert.equal(sniffSegment(ascii('  <!DOCTYPE html>')), 'HTML');
  assert.equal(sniffSegment(join(bytes(0, 0, 0, 24), ascii('styp'), new Uint8Array(16))), 'fMP4');
  assert.equal(sniffSegment(join(bytes(0, 0, 0, 24), ascii('moof'), new Uint8Array(16))), 'fMP4');
  assert.equal(sniffSegment(bytes(0xff, 0xf1, 0x50, 0x80)), 'AAC(ADTS)');
  assert.equal(sniffSegment(ascii('ID3\x04\x00')), 'ID3');
  assert.match(sniffSegment(bytes(1, 2, 3, 4)), /^01 02 03 04/);
});

test('cleanTsSegment strips the disguise and keeps plain TS untouched', () => {
  const ts = tsPackets(3);
  assert.equal(cleanTsSegment(ts, false), ts);
  assert.deepEqual(cleanTsSegment(join(PNG_HEAD, ts), false), ts);
  const id3 = join(ascii('ID3'), new Uint8Array(20));
  assert.equal(cleanTsSegment(id3, false), id3);
});

test('cleanTsSegment explains what it got instead of TS', () => {
  assert.throws(() => cleanTsSegment(ascii('<html>denied</html>'), false), /HTML/);
  assert.throws(() => cleanTsSegment(join(bytes(0x89, 0x50, 0x4e, 0x47), new Uint8Array(300)), false), /PNG/);
  assert.throws(() => cleanTsSegment(bytes(9, 9, 9, 9), true), /키 또는 IV/);
});

test('downloadHlsTrack writes disguised segments as clean TS', async () => {
  const segs = [join(PNG_HEAD, tsPackets(2)), join(JPEG_HEAD, tsPackets(3)), tsPackets(1)];
  const pl = { isFmp4: false, segments: segs.map((_, i) => ({ uri: `https://cdn.test/s${i}.png`, duration: 2, seq: i, byteRange: null, key: null, map: null })) };
  const chunks = [];
  await downloadHlsTrack({
    pl, role: 'video', concurrency: 2, retries: 1, retryDelayMs: 1,
    fetchBytes: async (url) => segs[Number(/s(\d)\.png/.exec(url)[1])],
    write: async (c) => { chunks.push(c); },
  });
  assert.deepEqual(join(...chunks), tsPackets(6));
});
