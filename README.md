# agy-staff — minimal Gemini workers for Codex

Use the Gemini quota you already have through Google's Antigravity CLI (`agy`) as fast delegated compute for Codex.

```text
Codex (orchestrator)
  ├─ $agy:worker  -> Gemini Flash worker, background
  ├─ $agy:worker  -> another independent worker
  └─ $agy:ask     -> quick tool-free second opinion
```

There is no persona framework. Codex decides what to delegate and writes the task; the wrapper only handles agy invocation, jobs, conversation continuation, and git safety checks.

## What remains

- **`$agy:worker`** — background `gemini-3.7-flash-medium` worker. Read-only by default; `--write` enables scoped edits.
- **`$agy:ask`** — synchronous `gemini-3.7-flash-low` one-shot question.
- **jobs** — `wait`, `status`, `result`, `cancel`, `continue`.
- **git guards** — read-only workers report unexpected tree changes; `--write` requires a clean tree and reports the diff summary.
- **conversation reuse** — follow-ups reuse agy's conversation id instead of resending all context.

Everything else was removed on purpose.

## Install

Install and authenticate Google's Antigravity CLI first, then verify `agy --version` works.

```bash
codex plugin marketplace add https://github.com/ChambersXDU/agy-staff
codex plugin add agy@agy-staff
```

Restart Codex after installing or upgrading the plugin.

## Usage

```text
$agy:ask Give me a second opinion on this API shape

$agy:worker Trace the authentication flow across this repository and return the key files and call chain

$agy:worker --effort high Review the current implementation for concurrency bugs; cite file:line evidence

$agy:worker --write Implement the scoped retry fix we just discussed and run the relevant local tests
```

Independent work should be delegated in parallel: start multiple workers, then collect each job with the `wait` command printed at startup.

## Why this shape

The goal is not to build another multi-agent framework. The goal is to make Gemini Flash behave like inexpensive external subagents:

- Gemini handles breadth, repo reading, parallel exploration, lightweight reviews, and scoped implementation.
- Codex handles decomposition, conflict resolution, high-risk reasoning, and final review.

The wrapper uses Node's standard library only and stores local job state under `.agy-staff/`.

## Safety boundary

`worker` launches agy with tool access and must run unsandboxed because Antigravity needs localhost plus its OAuth/state files.

Read-only mode is **not** an OS sandbox; it is a prompt contract backed by git-delta detection. `--write` is bounded by a clean-tree precondition and post-run diff reporting. For untrusted repositories, PRs, issues, or fetched content, use an isolated checkout/container without valuable credentials.

## Development

```bash
node --test tests/*.test.mjs
```

Tests use a fake `agy` binary and do not call Google services.
