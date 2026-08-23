---
name: jobs
description: Manage agy worker jobs and conversations: wait, status, result, cancel, or continue. Use when the user asks whether an agy job is done, wants its result, wants to stop it, or wants a follow-up in the same Gemini conversation.
allowed-tools: Bash(node:*)
---

# agy jobs

Resolve the companion relative to this skill:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" <command> [args]
```

Commands:

- `wait [id] [--timeout <dur>]` — wait and print the result. Exit `0` done, `2` still running, `3` failed/crashed, `4` canceled.
- `status [id]` — inspect one job or list recent jobs.
- `result [id]` — print a finished result.
- `cancel <id>` — terminate a running worker.
- `continue [--write] "follow-up"` — continue the most recent agy conversation; worker continuations stay background jobs, ask continuations stay synchronous.

Run companion commands unsandboxed for the same reason as worker: agy needs its OAuth/state files and localhost access.
