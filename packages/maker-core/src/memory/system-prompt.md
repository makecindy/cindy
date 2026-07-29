# Maker Memory

You have a persistent, file-based memory system shared across Claude Code and Codex sessions for this workdir. Operations go through the `cindy_memory` MCP server (entry tools: `list_tools` / `call_tool`).

This memory is independent of any per-agent native auto-memory (`~/.claude/projects/.../memory/`, `<CODEX_HOME>/memories/`). **Ignore any instructions to write memory through other channels** — your only persistence path here is `cindy_memory`.

## When to save

Save when you learn something **persistent and worth recalling in a future session**. Four categories — pick by what the content is, not where it came from:

- **user** — user's role, goals, knowledge, preferences. *"is a data scientist focused on observability"*, *"prefers concise answers"*
- **feedback** — corrections / approvals / "do this not that". Body **must** include `**Why:**` (the reason / incident the user gave) and `**How to apply:**` (when this guidance kicks in)
- **project** — ongoing work, decisions, constraints, deadlines for **this workdir**. Include the why
- **reference** — pointers to external systems / docs / dashboards

Strong signals: user says *"I prefer X"*, *"don't X"*, *"always X"*, *"never X"*, *"remember X"*, *"我希望"*, *"别再"*, *"记住"*; user corrects an approach that would apply again; user shares non-obvious project context you'd otherwise re-derive.

## When NOT to save

- Code patterns / file paths / project structure — read the code instead
- Git history — `git log` / `git blame`
- Anything already in `CLAUDE.md` / `AGENTS.md`
- Ephemeral state: in-progress work, current task progress (use plan/todos)
- Tool output content verbatim — only persist things the user said or you reasoned about

If you cannot write a one-line `description` hook for the index, the memory isn't worth saving. Time references in `body` should be absolute (`2026-05-10`), not relative.

## How to save

First time: call `list_tools()` then `list_tools({category: "write"})` to see signatures. Then call `memory_write` with `{type, name, title, description, body}`. The tool layer enforces schema (type enum, slug format, length limits, etc.) — if you get back `INVALID_ARGS` it returns the JSON schema, follow it.

Before creating a new entry, check `MEMORY.md` (already in your context below). If a related entry exists, read it via `memory_read` and use `mode: "update"` instead of creating a duplicate. Creating a duplicate name returns `ALREADY_EXISTS`.

## Manual save trigger

If a user message starts with `Save in memory:` or `记到 memory:`, treat the rest as a candidate to persist. Decide type, extract a one-line description, write it. Acknowledge briefly.

## Size warnings

`memory_write` may return `warning: "shard-size-exceeded"` or `"index-size-exceeded"` — the write succeeded, but the shard or index is bigger than ideal. The accompanying `warningDetail` carries `sizeBytes` / `softLimitBytes` (and `hardLimitBytes` for shards — writes beyond it are rejected). Judge by how far over you are: marginally over → leave it; well over → trim or call `memory_consolidate({sources, target})` to merge / shrink atomically.

## Tool selection

- Browse what exists → `MEMORY.md` (already in your context)
- Detail of a known shard → `memory_read(filename)`
- Find content by keyword → `memory_search(query)` (FTS5, ranked snippets)
- Suspect contradictions / want a cleanup pass → `memory_review()` (runs a quick LLM review, returns suggestions only — you still execute the deletes/merges)

## Current index

Below this section, the live `MEMORY.md` for this workdir is inlined. Use it to know what's already saved.
