#!/usr/bin/env node
/**
 * Minimal bridge from Codex to Google's Antigravity CLI.
 * Codex orchestrates; Gemini Flash does delegated work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.join(path.dirname(SELF), '..');
const TEMPLATES_DIR = path.join(ROOT, 'templates');
const AGY_BIN = process.env.AGY_BIN || 'agy';
const STATE_DIR_NAME = '.agy-staff';
const DEFAULT_MODEL = { worker: 'gemini-3.7-flash-medium', ask: 'gemini-3.7-flash-low' };
const DEFAULT_TIMEOUT = { worker: '10m', ask: '2m' };
const MAX_TASK_BYTES = 200 * 1024;
const JOB_EXIT = { done: 0, running: 2, error: 3, crashed: 3, canceled: 4 };

class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}
const fail = (message, code = 1) => { throw new CliError(message, code); };

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  return { code: r.status ?? -1, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function repoRoot() {
  const r = sh('git', ['rev-parse', '--show-toplevel']);
  return r.code === 0 && r.out ? r.out : process.cwd();
}
const stateDir = () => path.join(repoRoot(), STATE_DIR_NAME);
const statePath = () => path.join(stateDir(), 'state.json');
function ensureStateDir() {
  const dir = stateDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (sh('git', ['check-ignore', '-q', dir]).code !== 0) {
      const p = sh('git', ['rev-parse', '--git-path', 'info/exclude']);
      if (p.code === 0 && p.out) {
        try { fs.appendFileSync(path.resolve(p.out), `${STATE_DIR_NAME}/\n`); } catch {}
      }
    }
  }
  return dir;
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); }
  catch (e) {
    if (e?.code === 'ENOENT') return { conversations: {}, last: null, jobs: [] };
    if (e instanceof SyntaxError) fail(`state file is corrupt: ${statePath()} — fix or delete it`);
    fail(`cannot read state file ${statePath()}: ${e.message}`);
  }
}
function saveState(state) {
  ensureStateDir();
  const tmp = `${statePath()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, statePath());
}
function durationToMs(value) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value || '');
  if (!m) return null;
  return Math.round(Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]]);
}
function collectTimeout(jobTimeout) {
  const ms = (durationToMs(jobTimeout) ?? 600_000) + 120_000;
  return `${Math.ceil(ms / 60_000)}m`;
}

const VALUE_FLAGS = new Set(['conversation', 'model', 'effort', 'timeout', 'prompt-file']);
const BOOL_FLAGS = new Set(['continue', 'stdin', 'write']);
function tokenize(argv) {
  const tokens = [];
  for (const raw of argv) {
    if (!/\s/.test(raw)) { tokens.push(raw); continue; }
    let cur = '', quote = null, seen = false;
    for (const ch of raw) {
      if (quote) { if (ch === quote) quote = null; else cur += ch; }
      else if (ch === '"' || ch === "'") { quote = ch; seen = true; }
      else if (/\s/.test(ch)) { if (cur || seen) tokens.push(cur); cur = ''; seen = false; }
      else cur += ch;
    }
    if (cur || seen) tokens.push(cur);
  }
  return tokens.filter(Boolean);
}
function parseFlags(tokens) {
  const opts = { _: [] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token.startsWith('--')) { opts._.push(token); continue; }
    const name = token.slice(2);
    if (VALUE_FLAGS.has(name)) {
      const value = tokens[++i];
      if (value === undefined) fail(`flag --${name} needs a value`);
      opts[name] = value;
    } else if (BOOL_FLAGS.has(name)) opts[name] = true;
    else fail(`unknown flag --${name}`);
  }
  return opts;
}
function taskText(opts) {
  const inline = opts._.join(' ').trim();
  const sources = [inline && 'inline text', opts['prompt-file'] && '--prompt-file', opts.stdin && '--stdin'].filter(Boolean);
  if (sources.length > 1) fail(`task text given more than one way (${sources.join(', ')})`);
  if (opts['prompt-file']) {
    try { return fs.readFileSync(opts['prompt-file'], 'utf8').trim(); }
    catch (e) { fail(`cannot read --prompt-file ${opts['prompt-file']}: ${e.message}`); }
  }
  if (opts.stdin) return fs.readFileSync(0, 'utf8').trim();
  return inline;
}
function fillTemplate(name, vars) {
  const file = path.join(TEMPLATES_DIR, `${name}.md`);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { fail(`template not found: ${file}`); }
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}
function gatherContext() {
  const branch = sh('git', ['branch', '--show-current']).out || '(no git branch)';
  return [`Working directory: ${process.cwd()}`, `Git branch: ${branch}`, `Date: ${new Date().toISOString().slice(0, 10)}`].join('\n');
}
function resolveModel(mode, opts) {
  if (opts.effort && !['low', 'medium', 'high'].includes(opts.effort)) fail('--effort must be low|medium|high');
  if (opts.model) return opts.model;
  if (opts.effort) return `gemini-3.7-flash-${opts.effort}`;
  return DEFAULT_MODEL[mode];
}
function resolveRun(mode, opts) {
  const state = loadState();
  let conversation = opts.conversation || null;
  if (!conversation && opts.continue) {
    conversation = state.conversations?.[mode] || null;
    if (!conversation) fail(`--continue given but no previous ${mode} conversation is recorded`);
  }
  if (mode === 'ask' && opts.write) fail('--write is only valid for worker');
  return { mode, model: resolveModel(mode, opts), timeout: opts.timeout || DEFAULT_TIMEOUT[mode], conversation, write: mode === 'worker' && !!opts.write, background: mode === 'worker' };
}
function buildPrompt(mode, opts) {
  const task = taskText(opts);
  if (!task) fail(`${mode} needs a ${mode === 'ask' ? 'question' : 'task description'}`);
  if (Buffer.byteLength(task) > MAX_TASK_BYTES) fail(`task text exceeds ${MAX_TASK_BYTES / 1024}KB`);
  if (mode === 'ask') return fillTemplate('ask', { TASK: task });
  const runMode = opts.write ? 'WRITE ENABLED: you may edit workspace files only as needed for the task. Do not commit.' : 'READ ONLY: do not create, modify, rename, or delete workspace files.';
  return fillTemplate('worker', { TASK: task, CONTEXT: gatherContext(), MODE: runMode });
}

function parseAgyJson(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try { return JSON.parse(stdout.slice(start)); } catch { return null; }
}
function runAgy({ prompt, model, timeout, conversation, useTools }) {
  const args = ['-p', prompt, '--model', model, '--output-format', 'json', '--print-timeout', timeout];
  if (conversation) args.push('--conversation', conversation);
  if (useTools) args.push('--dangerously-skip-permissions');
  const budget = (durationToMs(timeout) ?? 600_000) + 60_000;
  const r = spawnSync(AGY_BIN, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: budget });
  if (r.error?.code === 'ETIMEDOUT') fail(`agy exceeded ${timeout} plus 60s grace`);
  if (r.error) fail(`failed to launch agy (${AGY_BIN}): ${r.error.message}`);
  if (r.signal) fail(`agy was killed by signal ${r.signal}`);
  const stdout = (r.stdout || '').trim(), stderr = (r.stderr || '').trim();
  const payload = parseAgyJson(stdout);
  if (!payload) {
    let msg = `agy did not return parseable JSON (exit ${r.status ?? -1})`;
    if (stdout) msg += `\nstdout: ${stdout.slice(0, 800)}`;
    if (stderr) msg += `\nstderr: ${stderr.slice(0, 800)}`;
    if (/operation not permitted/i.test(stderr)) msg += '\nagy must run unsandboxed: it needs its OAuth files and localhost access.';
    fail(msg);
  }
  return { payload, stderr, exit: r.status ?? 0 };
}
function responseFromAgy(result) {
  const { payload, stderr, exit } = result;
  const status = String(payload.status || '').toUpperCase(), response = String(payload.response || '').trim();
  if (status.includes('TIMEOUT')) fail(`agy timed out (status ${payload.status})`);
  if (response) {
    if ((status && status !== 'SUCCESS') || exit !== 0) {
      process.stderr.write(`agy-staff warning: agy returned a response with status ${payload.status || 'unknown'} (exit ${exit})\n`);
      if (payload.error) process.stderr.write(`agy error: ${payload.error}\n`);
      if (stderr) process.stderr.write(`agy stderr: ${stderr}\n`);
    }
    return response;
  }
  let msg = `agy returned no answer (status ${payload.status || 'unknown'}, exit ${exit})`;
  if (payload.error) msg += `\nagy error: ${payload.error}`;
  if (stderr) msg += `\nagy stderr: ${stderr}`;
  fail(msg);
}

function inGitRepo() {
  const r = sh('git', ['rev-parse', '--is-inside-work-tree']);
  return r.code === 0 && r.out === 'true';
}
function porcelainSnapshot() {
  const r = sh('git', ['status', '--porcelain']);
  if (r.code !== 0) return null;
  return r.out ? r.out.split('\n') : [];
}
function porcelainDelta(before, after) {
  if (!before || !after) return [];
  const prior = new Map(before.map((line) => [line.slice(3), line]));
  return after.filter((line) => prior.get(line.slice(3)) !== line);
}
function writePrecondition() {
  if (!inGitRepo()) { process.stderr.write('agy-staff warning: --write outside a git repository has no automatic rollback boundary.\n'); return; }
  const status = sh('git', ['status', '--porcelain']).out;
  if (status) fail('--write requires a clean git working tree so delegated edits stay isolated and reversible.\nCommit or stash your changes first.\n\n' + status);
}
function readonlyPostcondition(before, after) {
  const delta = porcelainDelta(before, after);
  if (!delta.length) return '';
  return '\n\n[guard] The read-only worker modified the working tree. Treat its result as untrusted until you inspect the diff.\n' + delta.map((line) => `  ${line}`).join('\n') + '\nInspect with `git diff`; revert only the paths introduced by the worker.';
}
function writePostcondition() {
  if (!inGitRepo()) return '';
  const status = sh('git', ['status', '--porcelain']).out;
  if (!status) return '\n\n[guard] --write completed without changing the working tree.';
  const diffStat = sh('git', ['diff', '--stat']).out || '(only untracked files)';
  const untracked = status.split('\n').filter((line) => line.startsWith('??')).map((line) => line.slice(3));
  return '\n\n[guard] Worker changed the working tree. Review the full diff before relying on it.\n' + `git diff --stat:\n${diffStat}` + (untracked.length ? `\nUntracked: ${untracked.join(', ')}` : '') + '\nRollback tracked edits with `git checkout -- <path>`; delete only newly-created untracked files.';
}
function fmtTokens(usage) {
  if (!usage) return 'n/a';
  const parts = [`in=${usage.input_tokens ?? '?'}`, `out=${usage.output_tokens ?? '?'}`];
  if (usage.thinking_tokens) parts.push(`think=${usage.thinking_tokens}`);
  if (usage.cache_read_tokens) parts.push(`cache=${usage.cache_read_tokens}`);
  return parts.join(' ');
}
function executeRun(resolved, prompt) {
  if (resolved.write) writePrecondition();
  const before = resolved.mode === 'worker' && !resolved.write ? porcelainSnapshot() : null;
  const result = runAgy({ prompt, model: resolved.model, timeout: resolved.timeout, conversation: resolved.conversation, useTools: resolved.mode === 'worker' });
  const response = responseFromAgy(result), payload = result.payload;
  const state = loadState();
  state.conversations ||= {};
  if (payload.conversation_id) { state.conversations[resolved.mode] = payload.conversation_id; state.last = { mode: resolved.mode, id: payload.conversation_id }; }
  saveState(state);
  process.stderr.write(`[agy-staff] mode=${resolved.mode} model=${resolved.model} duration=${payload.duration_seconds ?? '?'}s tokens(${fmtTokens(payload.usage)}) conversation=${payload.conversation_id || 'unknown'}\n`);
  if (resolved.mode !== 'worker') return response;
  const guard = resolved.write ? writePostcondition() : readonlyPostcondition(before, porcelainSnapshot());
  return response + guard;
}

function pidAlive(pid) {
  if (!pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function liveJobStatus(job) {
  if (job.status !== 'running') return job.status;
  if (pidAlive(job.pid)) return 'running';
  return fs.existsSync(job.result_file) ? 'done' : 'crashed';
}
function refreshJobs(state) {
  let changed = false;
  for (const job of state.jobs || []) {
    if (job.status === 'running') {
      const status = liveJobStatus(job);
      if (status !== 'running') { job.status = status; job.finished_at ||= new Date().toISOString(); changed = true; }
    }
  }
  if (changed) saveState(state);
}
function startWorker(resolved, prompt) {
  if (resolved.write) writePrecondition();
  const jobId = `worker-${Date.now().toString(36)}${Math.floor(Math.random() * 36).toString(36)}`;
  const jobsDir = path.join(ensureStateDir(), 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const specFile = path.join(jobsDir, `${jobId}.spec.json`), logFile = path.join(jobsDir, `${jobId}.log`), resultFile = path.join(jobsDir, `${jobId}.result.md`);
  fs.writeFileSync(specFile, `${JSON.stringify({ resolved, prompt }, null, 2)}\n`);
  const state = loadState(); state.jobs ||= [];
  state.jobs.push({ id: jobId, mode: 'worker', pid: null, status: 'running', started_at: new Date().toISOString(), finished_at: null, log_file: logFile, result_file: resultFile });
  saveState(state);
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [SELF, '_worker', jobId], { cwd: process.cwd(), detached: true, stdio: ['ignore', logFd, logFd] });
  child.unref(); fs.closeSync(logFd);
  const after = loadState(), record = (after.jobs || []).find((j) => j.id === jobId);
  if (record) { record.pid = child.pid; saveState(after); }
  process.stdout.write(`Started Gemini worker.\njob id: ${jobId} (pid ${child.pid})\nmodel: ${resolved.model}  mode: ${resolved.write ? 'write' : 'read-only'}  timeout: ${resolved.timeout}\nCollect: \`wait ${jobId} --timeout ${collectTimeout(resolved.timeout)}\`\nPeek: \`status ${jobId}\`   Stop: \`cancel ${jobId}\`\n`);
}
function cmdWorkerInternal(jobId) {
  const jobsDir = path.join(stateDir(), 'jobs'), specFile = path.join(jobsDir, `${jobId}.spec.json`), resultFile = path.join(jobsDir, `${jobId}.result.md`);
  const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
  try {
    const output = executeRun(spec.resolved, spec.prompt); fs.writeFileSync(resultFile, `${output}\n`);
    const state = loadState(), job = (state.jobs || []).find((j) => j.id === jobId);
    if (job) { job.status = 'done'; job.finished_at = new Date().toISOString(); saveState(state); }
  } catch (e) {
    const message = e instanceof CliError ? e.message : (e?.stack || String(e));
    try { fs.writeFileSync(resultFile, `Job failed:\n${message}\n`); } catch {}
    const state = loadState(), job = (state.jobs || []).find((j) => j.id === jobId);
    if (job) { job.status = 'error'; job.finished_at = new Date().toISOString(); saveState(state); }
    process.stderr.write(`${message}\n`); process.exitCode = e instanceof CliError ? e.code : 1;
  }
}
function cmdStatus(opts) {
  const state = loadState(); refreshJobs(state); const jobs = loadState().jobs || [], id = opts._[0];
  if (!id) {
    if (!jobs.length) { process.stdout.write('No agy jobs in this repository.\n'); return; }
    process.stdout.write('id | status | started | finished\n');
    for (const job of jobs.slice(-20)) process.stdout.write(`${job.id} | ${job.status} | ${job.started_at} | ${job.finished_at || '-'}\n`);
    return;
  }
  const job = jobs.find((j) => j.id === id); if (!job) fail(`no job ${id} in this repository`);
  process.stdout.write(`${JSON.stringify(job, null, 2)}\n`); process.exitCode = JOB_EXIT[job.status] ?? 1;
}
function cmdResult(opts) {
  const state = loadState(); refreshJobs(state); const jobs = loadState().jobs || [], id = opts._[0];
  const job = id ? jobs.find((j) => j.id === id) : [...jobs].reverse().find((j) => j.status !== 'running');
  if (!job) fail(id ? `no job ${id} in this repository` : 'no finished jobs in this repository');
  if (job.status === 'running') fail(`job ${job.id} is still running — use wait or status`);
  if (!fs.existsSync(job.result_file)) fail(`job ${job.id} has no stored result`);
  process.stdout.write(`# Job ${job.id} (${job.status})\n\n${fs.readFileSync(job.result_file, 'utf8')}`); process.exitCode = JOB_EXIT[job.status] ?? 1;
}
function cmdCancel(opts) {
  const id = opts._[0]; if (!id) fail('cancel needs a job id');
  const state = loadState(), job = (state.jobs || []).find((j) => j.id === id); if (!job) fail(`no job ${id} in this repository`);
  if (job.status !== 'running') { process.stdout.write(`Job ${id} is not running (status: ${job.status}).\n`); return; }
  try { if (job.pid) process.kill(job.pid, 'SIGTERM'); } catch {}
  job.status = 'canceled'; job.finished_at = new Date().toISOString(); saveState(state); process.stdout.write(`Canceled job ${id}.\n`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function cmdWait(opts) {
  const id = opts._[0] || null, timeout = opts.timeout || '100s', budget = durationToMs(timeout); if (budget == null) fail(`invalid --timeout ${timeout}`);
  const lookup = () => { const jobs = loadState().jobs || []; return id ? jobs.find((j) => j.id === id) || null : jobs.at(-1) || null; };
  let job = lookup(); if (!job) fail(id ? `no job ${id} in this repository` : 'no jobs in this repository');
  const start = Date.now(); let lastBeat = start, status = liveJobStatus(job);
  while (status === 'running' && Date.now() - start < budget) {
    await sleep(Math.min(2000, Math.max(1, budget - (Date.now() - start)))); job = lookup(); if (!job) fail('job record disappeared from state.json'); status = liveJobStatus(job);
    if (status === 'running' && Date.now() - lastBeat >= 15_000) { lastBeat = Date.now(); process.stderr.write(`agy-staff: waiting on ${job.id} (${Math.round((Date.now() - start) / 1000)}s)\n`); }
  }
  if (status === 'running') { process.stdout.write(`Job ${job.id} is still running after ${timeout}. Run wait again.\n`); process.exitCode = JOB_EXIT.running; return; }
  const state = loadState(); refreshJobs(state); job = lookup(); status = job.status;
  if (fs.existsSync(job.result_file)) process.stdout.write(`# Job ${job.id} (${status})\n\n${fs.readFileSync(job.result_file, 'utf8')}`);
  else process.stdout.write(`Job ${job.id} finished with status ${status} and no result file.\n`);
  process.exitCode = JOB_EXIT[status] ?? 1;
}
function cmdContinue(opts) {
  const state = loadState(); if (!state.last?.id) fail('no previous agy conversation recorded in this repository');
  const task = taskText(opts); if (!task) fail('continue needs follow-up text');
  const mode = state.last.mode === 'ask' ? 'ask' : 'worker';
  const resolved = resolveRun(mode, { ...opts, conversation: opts.conversation || state.last.id, _: [task] });
  const prompt = mode === 'worker'
    ? `Follow-up in the same conversation:\n\n${task}\n\nMode for this turn: ${resolved.write ? 'WRITE ENABLED: workspace edits are allowed as needed; do not commit.' : 'READ ONLY: do not modify workspace files.'}`
    : `Follow-up in the same conversation:\n\n${task}`;
  if (resolved.background) startWorker(resolved, prompt); else process.stdout.write(`${executeRun(resolved, prompt)}\n`);
}
function printHelp() {
  process.stdout.write('agy-staff minimal companion\n\n  worker [--write] [--effort low|medium|high] [--model ID] [--timeout 10m] "task"\n  ask [--model ID] "question"\n  continue [--write] "follow-up"\n  wait [job-id] [--timeout 100s]\n  status [job-id]\n  result [job-id]\n  cancel <job-id>\n');
}
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') { printHelp(); return; }
  if (command === '_worker') { const id = rest[0]; if (!id) fail('_worker needs a job id'); cmdWorkerInternal(id); return; }
  const opts = parseFlags(tokenize(rest));
  if (command === 'worker' || command === 'ask') {
    const resolved = resolveRun(command, opts), prompt = buildPrompt(command, opts);
    if (resolved.background) startWorker(resolved, prompt); else process.stdout.write(`${executeRun(resolved, prompt)}\n`);
    return;
  }
  if (command === 'continue') return cmdContinue(opts);
  if (command === 'status') return cmdStatus(opts);
  if (command === 'result') return cmdResult(opts);
  if (command === 'cancel') return cmdCancel(opts);
  if (command === 'wait') return await cmdWait(opts);
  fail(`unknown command ${command}`);
}
try { await main(); }
catch (e) { const message = e instanceof CliError ? e.message : (e?.stack || String(e)); process.stderr.write(`agy-staff error: ${message}\n`); process.exitCode = e instanceof CliError ? e.code : 1; }
