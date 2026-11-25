// Tests for helper/host.js success rules, with fake ffmpeg scripts (no real media).
// ffmpeg 9.0.2 with -n exits 0 and writes nothing when the output already exists,
// so "exit code 0" alone must never count as success, and an output this run did
// not create must never be removed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { startHost } from '../../helper/host.js';
import { encode, FrameDecoder } from '../../helper/lib/framing.js';

let base;
let home;
const fakes = {};

const FAKE = {
  // another process created the output in the race window; ffmpeg refuses but exits 0
  race: 'out="${@: -1}"; printf x > "$out"; echo "File \'$out\' already exists. Exiting." >&2; exit 0',
  // exit 0 with output but no progress=end
  noEnd: 'out="${@: -1}"; printf data > "$out"; printf "out_time_us=1000000\\nprogress=continue\\n"; exit 0',
  // crash after writing part of the output
  crash: 'out="${@: -1}"; printf part > "$out"; echo "boom" >&2; exit 1',
  ok: 'out="${@: -1}"; printf data > "$out"; printf "out_time_us=1000000\\nprogress=continue\\nout_time_us=2000000\\nprogress=end\\n"; exit 0',
  // still running when the host is told to stop
  slow: 'out="${@: -1}"; printf part > "$out"; printf "out_time_us=500000\\nprogress=continue\\n"; exec sleep 30',
};

before(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ms-helper-host-')));
  home = path.join(base, 'home');
  fs.mkdirSync(home);
  for (const [name, body] of Object.entries(FAKE)) {
    const p = path.join(base, `ffmpeg-${name}`);
    fs.writeFileSync(p, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    fakes[name] = p;
  }
});

after(() => fs.rmSync(base, { recursive: true, force: true }));

async function session(ffmpeg, requests) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const host = startHost({ stdin, stdout, home, config: { ffmpeg } });
  const dec = new FrameDecoder();
  const msgs = [];
  stdout.on('data', (c) => msgs.push(...dec.push(c).map((m) => m.value)));
  for (const r of requests) stdin.write(encode(r));
  stdin.end();
  await host.done;
  return msgs;
}

function input(name) {
  const p = path.join(home, name);
  fs.writeFileSync(p, 'ts');
  return p;
}

test('exit 0 with "already exists" is a failure: inputs and the foreign output are kept', async () => {
  const inp = input('race.ts');
  const msgs = await session(fakes.race, [{ id: '1', op: 'remux', input: inp, deleteInput: true }]);
  const last = msgs.at(-1);
  assert.equal(last.type, 'error');
  assert.equal(last.code, 'FFMPEG_FAILED');
  assert.ok(fs.existsSync(inp), 'input must not be deleted');
  assert.ok(fs.existsSync(path.join(home, 'race.mp4')), 'an output this run did not create must not be removed');
});

test('exit 0 without progress=end is a failure: input kept, our partial output removed', async () => {
  const inp = input('noend.ts');
  const msgs = await session(fakes.noEnd, [{ id: '1', op: 'remux', input: inp, deleteInput: true }]);
  assert.equal(msgs.at(-1).code, 'FFMPEG_FAILED');
  assert.ok(fs.existsSync(inp));
  assert.ok(!fs.existsSync(path.join(home, 'noend.mp4')));
});

test('non-zero exit is a failure with the stderr tail in the message', async () => {
  const inp = input('crash.ts');
  const msgs = await session(fakes.crash, [{ id: '1', op: 'remux', input: inp, deleteInput: true }]);
  const last = msgs.at(-1);
  assert.equal(last.code, 'FFMPEG_FAILED');
  assert.match(last.message, /exit code 1/);
  assert.match(last.message, /boom/);
  assert.ok(fs.existsSync(inp));
  assert.ok(!fs.existsSync(path.join(home, 'crash.mp4')));
});

test('success streams progress, returns { output, size } and then deletes the input', async () => {
  const inp = input('good.ts');
  const msgs = await session(fakes.ok, [{ id: 'j', op: 'remux', input: inp, deleteInput: true, durationSec: 2 }]);
  assert.deepEqual(msgs, [
    { id: 'j', type: 'progress', outTimeSec: 1, percent: 50 },
    { id: 'j', type: 'progress', outTimeSec: 2, percent: 100 },
    { id: 'j', type: 'result', output: path.join(home, 'good.mp4'), size: 4 },
  ]);
  assert.ok(!fs.existsSync(inp));
});

test('shutdown kills a running ffmpeg, removes its partial output and keeps the input', async () => {
  const inp = input('slow.ts');
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const host = startHost({ stdin, stdout, home, config: { ffmpeg: fakes.slow } });
  const dec = new FrameDecoder();
  const msgs = [];
  const firstProgress = new Promise((resolve) => {
    stdout.on('data', (c) => {
      msgs.push(...dec.push(c).map((m) => m.value));
      if (msgs.some((m) => m.type === 'progress')) resolve();
    });
  });
  stdin.write(encode({ id: 's', op: 'remux', input: inp, deleteInput: true }));
  await firstProgress;
  const t0 = Date.now();
  await host.shutdown();
  assert.ok(Date.now() - t0 < 1500, 'shutdown must not wait for the 30 s job');
  assert.equal(msgs.at(-1).code, 'FFMPEG_FAILED');
  assert.match(msgs.at(-1).message, /SIGKILL/);
  assert.ok(fs.existsSync(inp));
  assert.ok(!fs.existsSync(path.join(home, 'slow.mp4')));
  stdin.end();
});

test('one connection serves several requests and answers each id exactly once', async () => {
  const a = input('a.ts');
  const msgs = await session(fakes.ok, [
    { id: 'x', op: 'remux', input: a },
    { id: 'y', op: 'nope' },
    { op: 'remux' },
    { id: 'z', op: 'remux', input: '/etc/hosts.ts' },
  ]);
  const finals = msgs.filter((m) => m.type !== 'progress');
  assert.deepEqual(finals.map((m) => [m.id, m.type, m.code]).sort(), [
    [null, 'error', 'BAD_REQUEST'],
    ['x', 'result', undefined],
    ['y', 'error', 'BAD_REQUEST'],
    ['z', 'error', 'BAD_PATH'],
  ]);
});
