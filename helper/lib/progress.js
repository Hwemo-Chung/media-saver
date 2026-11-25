// Parser for ffmpeg `-progress pipe:1` output: blocks of key=value lines, each
// block closed by `progress=continue` or `progress=end`.
//
// Time keys, in order of preference:
//   out_time_us  microseconds
//   out_time     HH:MM:SS.micro (may be negative at the very start)
//   out_time_ms  despite the name, also microseconds (ffmpeg quirk, still true in 9.0.2)

const HMS = /^(-)?(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/;

function micro(value) {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  return Number(value.trim()) / 1e6;
}

function hms(value) {
  if (typeof value !== 'string') return null;
  const m = HMS.exec(value.trim());
  if (!m) return null;
  const sec = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] ? -sec : sec;
}

/**
 * Read the output time of one progress block.
 * @param {Record<string, string>} kv keys and values of one block.
 * @returns {number|null} seconds (never negative), or null when no time is known.
 */
export function parseOutTime(kv) {
  const candidates = [micro(kv.out_time_us), hms(kv.out_time), micro(kv.out_time_ms)];
  const sec = candidates.find((v) => v !== null && Number.isFinite(v));
  if (sec === undefined) return null;
  return Math.max(0, sec);
}

/**
 * Build the progress payload. `percent` appears only when durationSec is a
 * positive finite number; it is clamped to 0..100.
 * @param {number} outTimeSec
 * @param {number} [durationSec]
 * @returns {{outTimeSec: number, percent?: number}}
 */
export function toProgress(outTimeSec, durationSec) {
  const out = { outTimeSec: Math.round(outTimeSec * 1000) / 1000 };
  if (typeof durationSec === 'number' && Number.isFinite(durationSec) && durationSec > 0) {
    const pct = Math.min(100, Math.max(0, (outTimeSec / durationSec) * 100));
    out.percent = Math.round(pct * 10) / 10;
  }
  return out;
}

/**
 * Streaming parser: push stdout chunks, get one progress payload per completed
 * block that carries a usable time. `ended` turns true once `progress=end` is
 * seen — ffmpeg prints it only after it has finished writing the output.
 */
export class ProgressParser {
  /** @param {number} [durationSec] */
  constructor(durationSec) {
    this.durationSec = durationSec;
    this.partial = '';
    this.block = {};
    this.ended = false;
  }

  /**
   * @param {string|Buffer} chunk
   * @returns {Array<{outTimeSec: number, percent?: number}>}
   */
  push(chunk) {
    const text = this.partial + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    const lines = text.split('\n');
    this.partial = lines.pop();
    const events = [];
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key !== 'progress') {
        this.block[key] = value;
        continue;
      }
      const sec = parseOutTime(this.block);
      if (sec !== null) events.push(toProgress(sec, this.durationSec));
      if (value === 'end') this.ended = true;
      this.block = {};
    }
    return events;
  }
}
