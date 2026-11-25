// Tests for helper/lib/paths.js — the path rules in docs/helper-protocol.md
// "경로 규칙(보안)". A temp dir under os.tmpdir() stands in for $HOME. On macOS
// os.tmpdir() is under /var, a symlink to /private/var, so these tests also
// prove that home itself is realpath'd before the "under $HOME" comparison.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateInput,
  resolveOutput,
  defaultOutputName,
  INPUT_EXTS,
  OUTPUT_EXTS,
} from '../../helper/lib/paths.js';

let home; // lexical path, as $HOME would be given
let realHome;
let outside; // a sibling of home, outside it
let evil; // `${home}-evil`: shares home's string prefix but is outside it

const code = (c) => (err) => err.code === c;

before(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-helper-paths-'));
  home = path.join(base, 'home');
  outside = path.join(base, 'outside');
  evil = `${home}-evil`;
  for (const d of [home, outside, evil, path.join(home, 'Downloads'), path.join(home, 'dir.mp4')]) fs.mkdirSync(d, { recursive: true });
  realHome = fs.realpathSync(home);
  const files = {
    [path.join(home, 'Downloads', 'clip.ts')]: 'ts',
    [path.join(home, 'Downloads', 'UPPER.TS')]: 'ts',
    [path.join(home, 'Downloads', 'notes.txt')]: 'txt',
    [path.join(home, 'Downloads', 'sub.vtt')]: 'WEBVTT',
    [path.join(outside, 'x.ts')]: 'ts',
    [path.join(evil, 'x.ts')]: 'ts',
  };
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(f, body);
  fs.symlinkSync(path.join(outside, 'x.ts'), path.join(home, 'Downloads', 'link-out.ts'));
  fs.symlinkSync(path.join(home, 'Downloads', 'notes.txt'), path.join(home, 'Downloads', 'link-txt.mp4'));
  fs.symlinkSync(path.join(home, 'Downloads', 'clip.ts'), path.join(home, 'Downloads', 'link-in.ts'));
});

after(() => {
  fs.rmSync(path.dirname(home), { recursive: true, force: true });
});

test('allowed extension lists match the spec', () => {
  assert.deepEqual([...INPUT_EXTS].sort(), ['.aac', '.m4a', '.m4s', '.m4v', '.mkv', '.mov', '.mp3', '.mp4', '.srt', '.ts', '.vtt', '.webm']);
  assert.deepEqual([...OUTPUT_EXTS].sort(), ['.m4a', '.mkv', '.mp3', '.mp4']);
});

test('validateInput returns the real path of a regular file under home', () => {
  const got = validateInput(path.join(home, 'Downloads', 'clip.ts'), home);
  assert.equal(got, path.join(realHome, 'Downloads', 'clip.ts'));
});

test('validateInput accepts upper-case extensions and subtitle files', () => {
  assert.equal(validateInput(path.join(home, 'Downloads', 'UPPER.TS'), home), path.join(realHome, 'Downloads', 'UPPER.TS'));
  assert.equal(validateInput(path.join(home, 'Downloads', 'sub.vtt'), home), path.join(realHome, 'Downloads', 'sub.vtt'));
});

test('validateInput follows a symlink that stays under home', () => {
  assert.equal(validateInput(path.join(home, 'Downloads', 'link-in.ts'), home), path.join(realHome, 'Downloads', 'clip.ts'));
});

test('validateInput rejects a relative path', () => {
  assert.throws(() => validateInput('Downloads/clip.ts', home), code('BAD_PATH'));
});

test('validateInput rejects an existing file outside home', () => {
  assert.throws(() => validateInput(path.join(outside, 'x.ts'), home), code('BAD_PATH'));
});

test('validateInput rejects a sibling directory that only shares home as a string prefix', () => {
  assert.throws(() => validateInput(path.join(evil, 'x.ts'), home), code('BAD_PATH'));
});

test('validateInput rejects .. traversal out of home', () => {
  assert.throws(() => validateInput(path.join(home, '..', 'outside', 'x.ts'), home), code('BAD_PATH'));
});

test('validateInput rejects a symlink under home that points outside it', () => {
  assert.throws(() => validateInput(path.join(home, 'Downloads', 'link-out.ts'), home), code('BAD_PATH'));
});

test('validateInput checks the extension of the real file, not only of the link', () => {
  assert.throws(() => validateInput(path.join(home, 'Downloads', 'link-txt.mp4'), home), code('BAD_PATH'));
});

test('validateInput rejects a disallowed extension', () => {
  assert.throws(() => validateInput(path.join(home, 'Downloads', 'notes.txt'), home), code('BAD_PATH'));
});

test('validateInput rejects a directory even with an allowed extension', () => {
  assert.throws(() => validateInput(path.join(home, 'dir.mp4'), home), code('BAD_PATH'));
});

test('validateInput reports a missing file under home as NOT_FOUND', () => {
  assert.throws(() => validateInput(path.join(home, 'Downloads', 'missing.ts'), home), code('NOT_FOUND'));
});

test('validateInput reports a missing file outside home as BAD_PATH without probing it', () => {
  assert.throws(() => validateInput('/tmp/x-does-not-exist-ms-helper.ts', home), code('BAD_PATH'));
});

test('validateInput rejects non-string and NUL-containing paths', () => {
  assert.throws(() => validateInput(42, home), code('BAD_REQUEST'));
  assert.throws(() => validateInput(undefined, home), code('BAD_REQUEST'));
  assert.throws(() => validateInput(path.join(home, 'a\0.ts'), home), code('BAD_PATH'));
});

// ---- resolveOutput: pure, existence is injected ----

const DIR = '/Users/u/Downloads';
const existsIn = (...names) => {
  const set = new Set(names.map((n) => path.join(DIR, n)));
  return (p) => set.has(p);
};

test('defaultOutputName: remux changes only the extension', () => {
  assert.equal(defaultOutputName(`${DIR}/clip.ts`, 'remux'), 'clip.mp4');
  assert.equal(defaultOutputName(`${DIR}/song.aac`, 'remux'), 'song.m4a');
  assert.equal(defaultOutputName(`${DIR}/song.AAC`, 'remux'), 'song.m4a');
  assert.equal(defaultOutputName(`${DIR}/song.m4a`, 'remux'), 'song.m4a');
  assert.equal(defaultOutputName(`${DIR}/song.mp3`, 'remux'), 'song.mp3');
  assert.equal(defaultOutputName(`${DIR}/a.b.webm`, 'remux'), 'a.b.mp4');
});

test('defaultOutputName: merge strips a trailing ".video" then uses .mp4', () => {
  assert.equal(defaultOutputName(`${DIR}/movie.video.mp4`, 'merge'), 'movie.mp4');
  assert.equal(defaultOutputName(`${DIR}/movie.VIDEO.ts`, 'merge'), 'movie.mp4');
  assert.equal(defaultOutputName(`${DIR}/movie.ts`, 'merge'), 'movie.mp4');
  assert.equal(defaultOutputName(`${DIR}/my.video.clip.mp4`, 'merge'), 'my.video.clip.mp4');
});

test('resolveOutput puts the default name in the first input folder', () => {
  assert.equal(resolveOutput(`${DIR}/clip.ts`, undefined, 'remux', existsIn('clip.ts')), `${DIR}/clip.mp4`);
  assert.equal(resolveOutput(`${DIR}/movie.video.mp4`, undefined, 'merge', existsIn('movie.video.mp4')), `${DIR}/movie.mp4`);
});

test('resolveOutput never overwrites: it appends (1), (2), ... before the extension', () => {
  assert.equal(resolveOutput(`${DIR}/clip.ts`, undefined, 'remux', existsIn('clip.ts', 'clip.mp4')), `${DIR}/clip (1).mp4`);
  assert.equal(resolveOutput(`${DIR}/clip.ts`, undefined, 'remux', existsIn('clip.mp4', 'clip (1).mp4')), `${DIR}/clip (2).mp4`);
  // the default name can equal the input itself
  assert.equal(resolveOutput(`${DIR}/a.mp4`, undefined, 'remux', existsIn('a.mp4')), `${DIR}/a (1).mp4`);
});

test('resolveOutput accepts a requested absolute path in the same folder', () => {
  assert.equal(resolveOutput(`${DIR}/clip.ts`, `${DIR}/Nice Name.mkv`, 'remux', existsIn()), `${DIR}/Nice Name.mkv`);
  assert.equal(resolveOutput(`${DIR}/clip.ts`, `${DIR}/Nice Name.mkv`, 'remux', existsIn('Nice Name.mkv')), `${DIR}/Nice Name (1).mkv`);
});

test('resolveOutput accepts a bare file name and places it in the first input folder', () => {
  assert.equal(resolveOutput(`${DIR}/clip.ts`, 'out.mp4', 'remux', existsIn()), `${DIR}/out.mp4`);
});

test('resolveOutput rejects a requested output in another folder', () => {
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, '/Users/u/Desktop/out.mp4', 'remux', existsIn()), code('BAD_PATH'));
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, `${DIR}/sub/out.mp4`, 'remux', existsIn()), code('BAD_PATH'));
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, `${DIR}/../out.mp4`, 'remux', existsIn()), code('BAD_PATH'));
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, 'sub/out.mp4', 'remux', existsIn()), code('BAD_PATH'));
});

test('resolveOutput rejects output extensions outside the allowed list', () => {
  for (const bad of ['out.ts', 'out.exe', 'out', '.mp4', 'out.mp4.sh']) {
    assert.throws(() => resolveOutput(`${DIR}/clip.ts`, bad, 'remux', existsIn()), code('BAD_PATH'), bad);
  }
});

test('resolveOutput limits merge outputs to video containers (.mp4, .mkv)', () => {
  assert.equal(resolveOutput(`${DIR}/v.mp4`, 'out.mkv', 'merge', existsIn()), `${DIR}/out.mkv`);
  assert.throws(() => resolveOutput(`${DIR}/v.mp4`, 'out.m4a', 'merge', existsIn()), code('BAD_PATH'));
  assert.throws(() => resolveOutput(`${DIR}/v.mp4`, 'out.mp3', 'merge', existsIn()), code('BAD_PATH'));
});

test('resolveOutput rejects a non-string requested output and NUL bytes', () => {
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, 5, 'remux', existsIn()), code('BAD_REQUEST'));
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, 'a\0.mp4', 'remux', existsIn()), code('BAD_PATH'));
});

test('resolveOutput rejects an unknown kind', () => {
  assert.throws(() => resolveOutput(`${DIR}/clip.ts`, undefined, 'transcode', existsIn()), code('BAD_REQUEST'));
});
