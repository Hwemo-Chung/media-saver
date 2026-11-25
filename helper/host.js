// Media Saver native-messaging host (com.mediasaver.helper).
// Spec: docs/helper-protocol.md. Started by Chrome through helper/host.sh.
//
// stdout is the protocol channel: only framed JSON is ever written to it.
// Children never inherit stdio; diagnostics go to stderr.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { encode, FrameDecoder } from './lib/framing.js';
import { validateInput, resolveOutput, PathError, extOf, SUBTITLE_EXTS } from './lib/paths.js';
import { remuxArgs, mergeArgs } from './lib/ffargs.js';
import { ProgressParser } from './lib/progress.js';

export const VERSION = '1.0.0';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FFMPEG_FALLBACKS = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
const OPEN_BIN = '/usr/bin/open';
const STDERR_KEEP = 8000; // chars of ffmpeg stderr kept per job
const MESSAGE_TAIL = 1500; // chars of that tail put into an error message
const MAX_SUBTITLES = 32;

/** Error carrying a protocol error code. */
export class HostError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function log(...parts) {
  try {
    process.stderr.write(`[media-saver-helper ${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch {
    // stderr gone: nothing left to tell
  }
}

/** Read helper/config.json written by install.sh ({} when absent or unreadable). */
export function loadConfig(dir = HERE) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    return {};
  }
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Absolute ffmpeg path: config.ffmpeg, else the Homebrew locations; null when none runs. */
export function findFfmpeg(config) {
  const candidates = [config.ffmpeg, ...FFMPEG_FALLBACKS].filter((p) => typeof p === 'string' && path.isAbsolute(p));
  return candidates.find(isExecutableFile) ?? null;
}

/** true when something (file, dir, dangling symlink) already occupies p. */
function occupied(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function optional(req, key, type) {
  const v = req[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== type || (type === 'number' && !(Number.isFinite(v) && v >= 0))) {
    throw new HostError('BAD_REQUEST', `${key} must be a ${type === 'number' ? 'non-negative number' : type}`);
  }
  return v;
}

/**
 * Run a command with stdio isolated from ours.
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string, error?: Error}>}
 */
function run(bin, args, { timeoutMs = 10000, maxStdout = 65536 } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref();
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, ...r });
    };
    child.stdout.on('data', (c) => { if (stdout.length < maxStdout) stdout += c; });
    child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-STDERR_KEEP); });
    child.on('error', (error) => finish({ code: null, signal: null, error }));
    child.on('close', (code, signal) => finish({ code, signal }));
  });
}

/**
 * Start serving one Chrome connection.
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, home?: string, config?: object}} [opts]
 * @returns {{done: Promise<void>, shutdown: () => Promise<void>}}
 */
export function startHost({ stdin = process.stdin, stdout = process.stdout, home = os.homedir(), config = loadConfig() } = {}) {
  const children = new Set();
  const jobs = new Set();
  const reserved = new Set(); // lower-cased output paths claimed by running jobs (APFS is case-insensitive)
  let stdoutOpen = true;
  let ffmpegVersionCache = null;

  stdout.on('error', (err) => {
    stdoutOpen = false;
    log('stdout error:', err.code || err.message);
  });

  function send(msg) {
    if (!stdoutOpen) return;
    let buf;
    try {
      buf = encode(msg);
    } catch (err) {
      log('cannot encode response:', err.message);
      buf = encode({ id: msg.id ?? null, type: 'error', code: 'BAD_REQUEST', message: 'response could not be encoded' });
    }
    stdout.write(buf);
  }

  function claimOutput(firstInput, requested, kind) {
    let req = requested;
    if (typeof req === 'string' && path.isAbsolute(req)) {
      // Compare folders by real path, like the inputs (e.g. /var vs /private/var).
      let dir;
      try {
        dir = fs.realpathSync(path.dirname(path.resolve(req)));
      } catch {
        throw new PathError('BAD_PATH', `output folder does not exist: ${path.dirname(req)}`);
      }
      req = path.join(dir, path.basename(req));
    }
    const out = resolveOutput(firstInput, req, kind, (p) => reserved.has(p.toLowerCase()) || occupied(p));
    reserved.add(out.toLowerCase());
    return out;
  }

  /**
   * Run ffmpeg for one job, stream progress, decide success, clean up.
   * Success needs exit 0 AND `progress=end` AND a non-empty output this run created:
   * ffmpeg 9 with -n exits 0 without writing when the output already exists.
   */
  async function runFfmpegJob(id, args, output, durationSec, deleteList) {
    const ffmpeg = findFfmpeg(config);
    if (!ffmpeg) throw new HostError('NO_FFMPEG', 'ffmpeg not found (helper/config.json, /opt/homebrew/bin/ffmpeg, /usr/local/bin/ffmpeg)');
    if (occupied(output)) throw new HostError('BAD_PATH', `output appeared before start: ${output}`);

    const startedAt = Date.now();
    const parser = new ProgressParser(durationSec);
    let stderrTail = '';
    const outcome = await new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        children.delete(child);
        resolve(r);
      };
      const child = spawn(ffmpeg, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      children.add(child);
      child.stdout.on('data', (chunk) => {
        for (const ev of parser.push(chunk)) send({ id, type: 'progress', ...ev });
      });
      child.stderr.on('data', (chunk) => { stderrTail = (stderrTail + chunk).slice(-STDERR_KEEP); });
      child.on('error', (error) => finish({ code: null, signal: null, error }));
      child.on('close', (code, signal) => finish({ code, signal }));
    });

    if (outcome.error) {
      const missing = outcome.error.code === 'ENOENT' || outcome.error.code === 'EACCES';
      throw new HostError(missing ? 'NO_FFMPEG' : 'FFMPEG_FAILED', `cannot start ffmpeg: ${outcome.error.message}`);
    }

    // Exact ffmpeg wording, so a file name or tag echoed in stderr cannot trigger it.
    const alreadyExists = stderrTail.includes(`File '${output}' already exists`);
    let st = null;
    try {
      st = fs.lstatSync(output);
    } catch {
      st = null;
    }
    const size = st && st.isFile() ? st.size : 0;
    const ok = outcome.code === 0 && parser.ended && !alreadyExists && size > 0;

    if (!ok) {
      // Remove a partial output only when this run provably created it.
      const createdByUs = st && st.isFile() && !alreadyExists && st.birthtimeMs > 0 && st.birthtimeMs >= startedAt - 2000;
      if (createdByUs) {
        try {
          fs.unlinkSync(output);
        } catch (err) {
          log('could not remove partial output', output, err.code);
        }
      }
      const why = outcome.signal ? `signal ${outcome.signal}` : `exit code ${outcome.code}`;
      const detail = alreadyExists ? 'output already exists' : (size === 0 && outcome.code === 0 ? 'empty or missing output' : '');
      const tail = stderrTail.trim().slice(-MESSAGE_TAIL);
      throw new HostError('FFMPEG_FAILED', `ffmpeg failed (${why}${detail ? `, ${detail}` : ''})${tail ? `: ${tail}` : ''}`);
    }

    for (const p of deleteList) {
      try {
        fs.unlinkSync(p);
      } catch (err) {
        log('could not delete input', p, err.code);
      }
    }
    return { output, size };
  }

  const ops = {
    async hello() {
      const ffmpeg = findFfmpeg(config);
      if (!ffmpeg) throw new HostError('NO_FFMPEG', 'ffmpeg not found');
      if (!ffmpegVersionCache || ffmpegVersionCache.path !== ffmpeg) {
        const r = await run(ffmpeg, ['-hide_banner', '-version']);
        const m = /ffmpeg version (\S+)/.exec(r.stdout);
        if (r.error || r.code !== 0 || !m) throw new HostError('NO_FFMPEG', `ffmpeg at ${ffmpeg} did not report a version`);
        ffmpegVersionCache = { path: ffmpeg, version: m[1] };
      }
      return { version: VERSION, ffmpeg, ffmpegVersion: ffmpegVersionCache.version, home };
    },

    async remux(id, req) {
      const output = optional(req, 'output', 'string');
      const deleteInput = optional(req, 'deleteInput', 'boolean') ?? false;
      const durationSec = optional(req, 'durationSec', 'number');
      const input = validateInput(req.input, home);
      if (SUBTITLE_EXTS.includes(extOf(input))) throw new HostError('BAD_PATH', 'a subtitle file cannot be remuxed');
      const out = claimOutput(input, output, 'remux');
      try {
        return await runFfmpegJob(id, remuxArgs(input, out), out, durationSec, deleteInput ? [req.input] : []);
      } finally {
        reserved.delete(out.toLowerCase());
      }
    },

    async merge(id, req) {
      const output = optional(req, 'output', 'string');
      const deleteInputs = optional(req, 'deleteInputs', 'boolean') ?? false;
      const durationSec = optional(req, 'durationSec', 'number');
      const audioArg = optional(req, 'audio', 'string');
      if (req.subtitles !== undefined && req.subtitles !== null && !Array.isArray(req.subtitles)) {
        throw new HostError('BAD_REQUEST', 'subtitles must be an array');
      }
      const subsArg = req.subtitles ?? [];
      if (subsArg.length > MAX_SUBTITLES) throw new HostError('BAD_REQUEST', `at most ${MAX_SUBTITLES} subtitles`);
      if (!audioArg && subsArg.length === 0) throw new HostError('BAD_REQUEST', 'merge needs audio or subtitles');

      const video = validateInput(req.video, home);
      if (SUBTITLE_EXTS.includes(extOf(video))) throw new HostError('BAD_PATH', 'video cannot be a subtitle file');
      const audio = audioArg ? validateInput(audioArg, home) : undefined;
      if (audio && SUBTITLE_EXTS.includes(extOf(audio))) throw new HostError('BAD_PATH', 'audio cannot be a subtitle file');
      const subtitles = subsArg.map((s, i) => {
        if (!s || typeof s !== 'object' || typeof s.path !== 'string') throw new HostError('BAD_REQUEST', `subtitles[${i}] needs a path`);
        if (s.lang !== undefined && s.lang !== null && typeof s.lang !== 'string') throw new HostError('BAD_REQUEST', `subtitles[${i}].lang must be a string`);
        const real = validateInput(s.path, home);
        if (!SUBTITLE_EXTS.includes(extOf(real))) throw new HostError('BAD_PATH', `subtitles[${i}] must be .vtt or .srt`);
        return { path: real, lang: s.lang ?? undefined };
      });

      const out = claimOutput(video, output, 'merge');
      const deleteList = deleteInputs ? [req.video, ...(audioArg ? [audioArg] : []), ...subsArg.map((s) => s.path)] : [];
      try {
        return await runFfmpegJob(id, mergeArgs({ video, audio, subtitles, output: out }), out, durationSec, deleteList);
      } finally {
        reserved.delete(out.toLowerCase());
      }
    },

    async reveal(id, req) {
      const real = validateInput(req.path, home);
      const r = await run(OPEN_BIN, ['-R', real]);
      if (r.error || r.code !== 0) {
        if (!occupied(real)) throw new HostError('NOT_FOUND', `no such file: ${req.path}`);
        throw new HostError('BAD_REQUEST', `open -R failed (${r.error ? r.error.message : `exit code ${r.code}`}) ${r.stderr.trim().slice(-300)}`.trim());
      }
      return {};
    },
  };

  function handle(msg) {
    const echoId = msg && typeof msg === 'object' && (typeof msg.id === 'string' || typeof msg.id === 'number') ? msg.id : null;
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send({ id: null, type: 'error', code: 'BAD_REQUEST', message: 'request must be a JSON object' });
      return;
    }
    if (typeof msg.id !== 'string' || msg.id.length === 0) {
      send({ id: echoId, type: 'error', code: 'BAD_REQUEST', message: 'id must be a non-empty string' });
      return;
    }
    if (typeof msg.op !== 'string' || !Object.prototype.hasOwnProperty.call(ops, msg.op)) {
      send({ id: msg.id, type: 'error', code: 'BAD_REQUEST', message: `unknown op: ${String(msg.op)}` });
      return;
    }
    const { id } = msg;
    const job = (async () => {
      try {
        const result = await ops[msg.op](id, msg);
        send({ id, type: 'result', ...result });
      } catch (err) {
        const code = err instanceof HostError || err instanceof PathError ? err.code : 'BAD_REQUEST';
        if (!(err instanceof HostError || err instanceof PathError)) log(`op ${msg.op} crashed:`, err && err.stack);
        else log(`op ${msg.op} ${id} -> ${code}: ${err.message.split('\n')[0].slice(0, 300)}`);
        send({ id, type: 'error', code, message: String(err.message || err).slice(0, 4000) });
      }
    })();
    jobs.add(job);
    job.finally(() => jobs.delete(job));
  }

  const decoder = new FrameDecoder();
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let inputEnded = false;

  async function drain() {
    while (jobs.size) await Promise.allSettled([...jobs]);
  }

  function endOfInput() {
    if (inputEnded) return;
    inputEnded = true;
    drain().then(resolveDone);
  }

  stdin.on('data', (chunk) => {
    for (const r of decoder.push(chunk)) {
      if (r.ok) handle(r.value);
      else if (!r.fatal) send({ id: null, type: 'error', code: 'BAD_REQUEST', message: `invalid JSON: ${r.error.message}` });
      else {
        log('fatal framing error:', r.error.message);
        send({ id: null, type: 'error', code: 'BAD_REQUEST', message: r.error.message });
        stdin.pause();
        endOfInput();
      }
    }
  });
  stdin.on('end', endOfInput);
  stdin.on('close', endOfInput);
  stdin.on('error', (err) => {
    log('stdin error:', err.code || err.message);
    endOfInput();
  });

  /** Kill running ffmpeg processes, let their jobs clean up, then resolve. */
  async function shutdown() {
    for (const child of children) child.kill('SIGKILL');
    await Promise.race([drain(), new Promise((r) => setTimeout(r, 1500).unref())]);
  }

  return { done, shutdown };
}

function isMain() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const host = startHost();
  // Chrome closes stdin on disconnect and then sends SIGTERM; never leave an
  // ffmpeg running behind.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      log(`received ${sig}, stopping`);
      host.shutdown().finally(() => process.exit(0));
    });
  }
  // On normal end of input, let pending stdout writes flush and exit naturally.
  host.done.then(() => { process.exitCode = 0; });
}
