// Chrome native-messaging framing: a 4-byte little-endian uint32 byte length,
// then that many bytes of UTF-8 JSON. Spec: docs/helper-protocol.md "프레이밍".

/** Chrome refuses a host->browser message larger than 1MB. */
export const MAX_OUTGOING_BYTES = 1024 * 1024;

/** Chrome sends at most 64MiB to a host; anything larger means a corrupt stream. */
export const MAX_INCOMING_BYTES = 64 * 1024 * 1024;

/**
 * Encode one message for stdout.
 * @param {unknown} obj JSON-serialisable value.
 * @returns {Buffer} header + body.
 * @throws {TypeError} when obj does not serialise to JSON.
 * @throws {RangeError} with code MESSAGE_TOO_LARGE when the body exceeds 1MB.
 */
export function encode(obj) {
  const json = JSON.stringify(obj);
  if (typeof json !== 'string') throw new TypeError('message does not serialise to JSON');
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_OUTGOING_BYTES) {
    const err = new RangeError(`message is ${body.length} bytes; the limit is ${MAX_OUTGOING_BYTES}`);
    err.code = 'MESSAGE_TOO_LARGE';
    throw err;
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Streaming decoder. Feed it stdin chunks of any size; it returns every complete
 * message found so far and keeps the remainder for the next chunk.
 *
 * Each entry is `{ ok: true, value }` or `{ ok: false, error, fatal }`.
 * Invalid JSON is non-fatal (frame boundaries are intact). An oversized length
 * is fatal: the stream cannot be resynchronised, so the decoder stops consuming.
 */
export class FrameDecoder {
  /** @param {{ maxMessageBytes?: number }} [opts] */
  constructor({ maxMessageBytes = MAX_INCOMING_BYTES } = {}) {
    this.maxMessageBytes = maxMessageBytes;
    this.chunks = [];
    this.length = 0;
    this.failed = false;
  }

  /** Bytes held back waiting for the rest of a frame. */
  get bufferedBytes() {
    return this.length;
  }

  /**
   * @param {Buffer|Uint8Array} chunk
   * @returns {Array<{ok: true, value: unknown} | {ok: false, error: Error, fatal: boolean}>}
   */
  push(chunk) {
    if (this.failed) return [];
    if (chunk && chunk.length) {
      this.chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
      this.length += chunk.length;
    }
    const out = [];
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
    let offset = 0;
    while (buf.length - offset >= 4) {
      const size = buf.readUInt32LE(offset);
      if (size > this.maxMessageBytes) {
        this.failed = true;
        this.chunks = [];
        this.length = 0;
        out.push({ ok: false, fatal: true, error: new RangeError(`incoming message of ${size} bytes exceeds ${this.maxMessageBytes}`) });
        return out;
      }
      if (buf.length - offset - 4 < size) break;
      const body = buf.subarray(offset + 4, offset + 4 + size);
      offset += 4 + size;
      try {
        out.push({ ok: true, value: JSON.parse(body.toString('utf8')) });
      } catch (error) {
        out.push({ ok: false, fatal: false, error });
      }
    }
    // Copy the remainder so the consumed part of a large buffer can be freed.
    buf = offset === 0 ? buf : Buffer.from(buf.subarray(offset));
    this.chunks = buf.length ? [buf] : [];
    this.length = buf.length;
    return out;
  }
}
