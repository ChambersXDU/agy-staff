---
name: worker
description: Delegate a task to Google's Antigravity CLI as a fast Gemini Flash worker. Use when the user invokes $agy:worker or asks Codex to offload a parallelizable task to agy/Gemini to save Codex time or quota. Good fits: repo exploration, broad file reading, test/debug analysis, second opinions, lightweight research, and well-scoped edits.
argument-hint: '[--write] [--effort low|medium|high] [--model <id>] [--timeout <dur>] [--continue] [--prompt-file <path>|--stdin] "task"'
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*)
---

# agy worker

Codex remains the orchestrator; Gemini Flash is delegated compute.

Run:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" worker [flags] "task"
```

Run the companion **unsandboxed**. Antigravity needs localhost access and its OAuth/state files.

## Defaults

- Background job.
- `gemini-3.7-flash-medium`.
- Read-only workspace semantics.
- agy tool access is enabled so the worker can inspect the repo, run commands, and use agy-native tools.

Use `--write` only when the task should edit files. A write run requires a clean git working tree when inside a repository and reports the resulting diff summary.

## Delegation style

Pass the user's task and authorizations through faithfully. Add only the context needed to make the subtask independently executable. Do not wrap routine tasks in a fixed persona: the task itself should specify the desired role, scope, evidence, or output format when those matter.

Prefer workers for breadth and throughput; keep final judgment with Codex. For independent subtasks, start multiple workers in parallel, then collect each result separately. Verify high-impact claims or edits before building on them.

## Collecting

The start output prints a job id and exact `wait <id> --timeout <n>m` command. Run one background wait per job. Job management and continuation are in `../jobs/SKILL.md`.

## Flags

- `--write` — allow workspace edits; requires a clean git tree when available.
- `--effort low|medium|high` — maps to `gemini-3.7-flash-<effort>`.
- `--model <id>` — pass an explicit agy model id instead of the default.
- `--timeout <dur>` — agy print timeout, default `10m`.
- `--continue` / `--conversation <id>` — resume worker context.
- `--prompt-file <path>` / `--stdin` — avoid shell quoting for long tasks.

Security note: read-only is a prompt contract plus git-delta detection, not a sandbox. The worker runs agy with tool permissions. For untrusted repositories, PRs, or issue content, use an isolated checkout/container with no valuable credentials.
