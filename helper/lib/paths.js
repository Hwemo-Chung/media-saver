// Path rules for the helper. Spec: docs/helper-protocol.md "경로 규칙(보안)".
//
// - Input: absolute, realpath under $HOME, a regular file, extension in INPUT_EXTS.
// - Output: in the first input's folder, extension in OUTPUT_EXTS, never an
//   existing name (" (1)", " (2)", ... is appended instead).
// - Default output name: remux changes only the extension; merge drops a
//   trailing ".video" from the video's name and uses .mp4.

import fs from 'node:fs';
import path from 'node:path';

export const INPUT_EXTS = Object.freeze(['.ts', '.mp4', '.m4a', '.m4s', '.m4v', '.aac', '.mp3', '.webm', '.mkv', '.mov', '.vtt', '.srt']);
export const OUTPUT_EXTS = Object.freeze(['.mp4', '.m4a', '.mkv', '.mp3']);
/** Containers a merge (which always carries video) may produce. */
export const MERGE_OUTPUT_EXTS = Object.freeze(['.mp4', '.mkv']);
export const SUBTITLE_EXTS = Object.freeze(['.vtt', '.srt']);
export const AUDIO_EXTS = Object.freeze(['.aac', '.m4a', '.mp3']);

/** Error carrying one of the protocol error codes (BAD_REQUEST, BAD_PATH, NOT_FOUND). */
export class PathError extends Error {
  /** @param {'BAD_REQUEST'|'BAD_PATH'|'NOT_FOUND'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'PathError';
    this.code = code;
  }
}

/** Lower-case extension including the dot ('' when none). */
export function extOf(p) {
  return path.extname(p).toLowerCase();
}

function isInside(child, parent) {
  return child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

function safeRealpath(fsImpl, p) {
  try {
    return fsImpl.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * Validate one input path and return its real path.
 * @param {unknown} p path as sent in the request.
 * @param {string} home the user's home directory.
 * @param {{realpathSync: Function, statSync: Function}} [fsImpl] injectable fs.
 * @returns {string} the realpath of the file.
 * @throws {PathError}
 */
export function validateInput(p, home, fsImpl = fs) {
  if (typeof p !== 'string' || p.length === 0) throw new PathError('BAD_REQUEST', 'path must be a non-empty string');
  if (p.includes('\0')) throw new PathError('BAD_PATH', 'path contains a NUL byte');
  if (!path.isAbsolute(p)) throw new PathError('BAD_PATH', `path must be absolute: ${p}`);
  if (!INPUT_EXTS.includes(extOf(p))) throw new PathError('BAD_PATH', `extension not allowed: ${p}`);

  const homeAbs = path.resolve(home);
  const homeReal = safeRealpath(fsImpl, homeAbs) ?? homeAbs;
  const lexical = path.resolve(p);
  // Lexical check first, so nothing outside $HOME is ever probed on disk.
  if (!isInside(lexical, homeAbs) && !isInside(lexical, homeReal)) {
    throw new PathError('BAD_PATH', `path is outside the home folder: ${p}`);
  }

  let real;
  try {
    real = fsImpl.realpathSync(lexical);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) throw new PathError('NOT_FOUND', `no such file: ${p}`);
    throw new PathError('BAD_PATH', `cannot resolve ${p}: ${err && err.code}`);
  }
  if (!isInside(real, homeReal)) throw new PathError('BAD_PATH', `path resolves outside the home folder: ${p}`);
  if (!INPUT_EXTS.includes(extOf(real))) throw new PathError('BAD_PATH', `real file extension not allowed: ${p}`);

  let st;
  try {
    st = fsImpl.statSync(real);
  } catch {
    throw new PathError('NOT_FOUND', `no such file: ${p}`);
  }
  if (!st.isFile()) throw new PathError('BAD_PATH', `not a regular file: ${p}`);
  return real;
}

/**
 * Default output file name (no folder) for a first input.
 * @param {string} firstInput
 * @param {'remux'|'merge'} kind
 */
export function defaultOutputName(firstInput, kind) {
  const base = path.basename(firstInput);
  const ext = path.extname(base);
  let stem = base.slice(0, base.length - ext.length);
  if (kind === 'merge') {
    if (/\.video$/i.test(stem) && stem.length > '.video'.length) stem = stem.slice(0, -'.video'.length);
    return `${stem}.mp4`;
  }
  const lower = ext.toLowerCase();
  if (lower === '.aac' || lower === '.m4a') return `${stem}.m4a`;
  if (lower === '.mp3') return `${stem}.mp3`;
  return `${stem}.mp4`;
}

/**
 * First free name: p itself, else "stem (1).ext", "stem (2).ext", ...
 * @param {string} p
 * @param {(p: string) => boolean} existsFn
 */
export function uniquePath(p, existsFn, maxTries = 9999) {
  if (!existsFn(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const stem = path.basename(p, ext);
  for (let n = 1; n <= maxTries; n += 1) {
    const candidate = path.join(dir, `${stem} (${n})${ext}`);
    if (!existsFn(candidate)) return candidate;
  }
  throw new PathError('BAD_PATH', `no free output name for ${p}`);
}

/**
 * Resolve where an operation writes its output.
 * @param {string} firstInput validated (real) path of the first input.
 * @param {string|undefined} requestedOutput absolute path in the same folder, or a bare file name.
 * @param {'remux'|'merge'} kind
 * @param {(p: string) => boolean} existsFn true when a path is taken (should not follow symlinks).
 * @returns {string} absolute output path that does not exist yet.
 * @throws {PathError}
 */
export function resolveOutput(firstInput, requestedOutput, kind, existsFn) {
  if (kind !== 'remux' && kind !== 'merge') throw new PathError('BAD_REQUEST', `unknown kind: ${kind}`);
  const dir = path.dirname(firstInput);
  let target;
  if (requestedOutput === undefined || requestedOutput === null || requestedOutput === '') {
    target = path.join(dir, defaultOutputName(firstInput, kind));
  } else {
    if (typeof requestedOutput !== 'string') throw new PathError('BAD_REQUEST', 'output must be a string');
    if (requestedOutput.includes('\0')) throw new PathError('BAD_PATH', 'output contains a NUL byte');
    if (path.isAbsolute(requestedOutput)) {
      target = path.resolve(requestedOutput);
      if (path.dirname(target) !== dir) throw new PathError('BAD_PATH', `output must be in the input's folder (${dir})`);
    } else {
      if (requestedOutput.includes('/') || requestedOutput === '.' || requestedOutput === '..') {
        throw new PathError('BAD_PATH', `output must be an absolute path or a bare file name: ${requestedOutput}`);
      }
      target = path.join(dir, requestedOutput);
    }
  }
  const allowed = kind === 'merge' ? MERGE_OUTPUT_EXTS : OUTPUT_EXTS;
  const name = path.basename(target);
  const ext = extOf(name);
  if (!allowed.includes(ext) || name.length === ext.length) {
    throw new PathError('BAD_PATH', `output extension must be one of ${allowed.join(' ')}: ${name}`);
  }
  if (Buffer.byteLength(name, 'utf8') > 250) throw new PathError('BAD_PATH', 'output name is too long');
  return uniquePath(target, existsFn);
}
