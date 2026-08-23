import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const COMPANION = path.join(REPO, 'companion', 'agy-companion.mjs');
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-staff-test-'));
  run('git', ['init', '-q'], { cwd: dir });
  run('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  run('git', ['config', 'user.name', 'Test'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');

  const fake = path.join(dir, 'fake-agy');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
const prompt = args[args.indexOf('-p') + 1] || '';
if (process.env.FAKE_AGY_LOG) fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(args) + '\\n');
if (prompt.includes('WRITE_UNEXPECTED')) fs.writeFileSync('unexpected.txt', 'changed\\n');
if (prompt.includes('WRITE_EXPECTED')) fs.writeFileSync('tracked.txt', 'edited\\n');
const convAt = args.indexOf('--conversation');
const conv = convAt >= 0 ? args[convAt + 1] : 'conv-1';
process.stdout.write(JSON.stringify({ status: 'SUCCESS', response: 'fake answer', conversation_id: conv, duration_seconds: 0.1, usage: { input_tokens: 10, output_tokens: 5 } }));
`);
  fs.chmodSync(fake, 0o755);
  run('git', ['add', '.'], { cwd: dir });
  run('git', ['commit', '-qm', 'init'], { cwd: dir });

  const log = path.join(os.tmpdir(), `agy-args-${Date.now()}-${Math.random()}.log`);
  return { dir, log, env: { ...process.env, AGY_BIN: fake, FAKE_AGY_LOG: log } };
}
function companion(fx, args, timeout = 10_000) {
  return run(process.execPath, [COMPANION, ...args], { cwd: fx.dir, env: fx.env, timeout });
}
function jobId(stdout) {
  const m = /job id: (worker-[^\s]+)/.exec(stdout);
  assert.ok(m, `missing job id in: ${stdout}`);
  return m[1];
}

test('ask is synchronous and does not enable tool bypass', () => {
  const fx = makeFixture();
  const r = companion(fx, ['ask', 'hello']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /fake answer/);
  const args = JSON.parse(fs.readFileSync(fx.log, 'utf8').trim());
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.ok(args.includes('gemini-3.7-flash-low'));
});

test('worker is background and wait returns its result', () => {
  const fx = makeFixture();
  const start = companion(fx, ['worker', 'scan repo']);
  assert.equal(start.status, 0, start.stderr);
  const done = companion(fx, ['wait', jobId(start.stdout), '--timeout', '5s'], 8000);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /fake answer/);
  const args = JSON.parse(fs.readFileSync(fx.log, 'utf8').trim().split('\n').at(-1));
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('gemini-3.7-flash-medium'));
});

test('read-only worker detects unexpected edits', () => {
  const fx = makeFixture();
  const start = companion(fx, ['worker', 'WRITE_UNEXPECTED']);
  const done = companion(fx, ['wait', jobId(start.stdout), '--timeout', '5s'], 8000);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /read-only worker modified the working tree/i);
  assert.match(done.stdout, /unexpected\.txt/);
});

test('--write refuses a dirty tree before spawn', () => {
  const fx = makeFixture();
  fs.writeFileSync(path.join(fx.dir, 'tracked.txt'), 'dirty\n');
  const r = companion(fx, ['worker', '--write', 'WRITE_EXPECTED']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a clean git working tree/i);
});

test('--write reports scoped edits on a clean tree', () => {
  const fx = makeFixture();
  const start = companion(fx, ['worker', '--write', 'WRITE_EXPECTED']);
  assert.equal(start.status, 0, start.stderr);
  const done = companion(fx, ['wait', jobId(start.stdout), '--timeout', '5s'], 8000);
  assert.equal(done.status, 0, done.stderr);
  assert.match(done.stdout, /Worker changed the working tree/);
  assert.match(done.stdout, /tracked\.txt/);
});

test('effort selects Flash tier and continue reuses conversation', () => {
  const fx = makeFixture();
  const first = companion(fx, ['worker', '--effort', 'high', 'first']);
  let done = companion(fx, ['wait', jobId(first.stdout), '--timeout', '5s'], 8000);
  assert.equal(done.status, 0, done.stderr);
  const follow = companion(fx, ['continue', 'follow up']);
  assert.equal(follow.status, 0, follow.stderr);
  done = companion(fx, ['wait', jobId(follow.stdout), '--timeout', '5s'], 8000);
  assert.equal(done.status, 0, done.stderr);
  const calls = fs.readFileSync(fx.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls[0].includes('gemini-3.7-flash-high'));
  const second = calls.at(-1), at = second.indexOf('--conversation');
  assert.ok(at >= 0);
  assert.equal(second[at + 1], 'conv-1');
});
