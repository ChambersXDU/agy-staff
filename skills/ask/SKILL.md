---
name: ask
description: Ask Google's Antigravity CLI a fast, cheap one-shot question using Gemini Flash Low. Use when the user invokes $agy:ask or explicitly wants a quick Gemini second opinion that does not need repository tools.
argument-hint: '[--model <id>|--effort low|medium|high] [--timeout <dur>] "question"'
allowed-tools: Bash(node:*)
---

# agy ask

For a quick tool-free Gemini answer, run:

```bash
node "<skill-dir>/../../companion/agy-companion.mjs" ask [flags] "question"
```

`ask` is synchronous and defaults to `gemini-3.7-flash-low`. Return the answer as supporting input to the main Codex response; Codex remains responsible for final judgment.
