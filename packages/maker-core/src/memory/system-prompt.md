# Maker Memory

You have a persistent, file-based memory system shared across Claude Code and Codex sessions. It has two scopes: `user` — about the user, applies in every project — and `project` — this repository or folder only. Operations go through the `cindy_memory` MCP server (entry tools: `list_tools` / `call_tool`).

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

First time: call `list_tools()` then `list_tools({category: "write"})` to see signatures. Inner tools are reached through the `call_tool` entry with a `{name, args}` envelope — exactly one level, never nested deeper, never flattened: `call_tool({"name": "memory_write", "args": {type, name, title, description, body}})`. The tool layer enforces schema (type enum, slug format, length limits, etc.) — if you get back `INVALID_ARGS` it returns the JSON schema, follow it.

Scope: `user`-type entries go to the `user` scope and everything else to `project` unless you pass `scope`. Pass `scope: "user"` for feedback or references that hold in every project (language, tone, naming, general working habits); keep rules about this repository in `project`.

Before creating a new entry, check the indexes (already in your context below). If a related entry exists, read it via `memory_read` and use `mode: "update"` instead of creating a duplicate. Creating a duplicate name returns `ALREADY_EXISTS`.

## Using memories

Each index line ends with the date the memory was last updated. A memory records what was true when it was written; it is not proof of the current state. Before acting on one that names a file, command, setting, person or decision, check it against the code or with the user. When one turns out wrong or outdated, update or delete it.

## Manual save trigger

If a user message starts with `Save in memory:` or `记到 memory:`, treat the rest as a candidate to persist. Decide type, extract a one-line description, write it. Acknowledge briefly.

## Size warnings

`memory_write` may return `warning: "shard-size-exceeded"` or `"index-size-exceeded"` — the write succeeded, but the shard or index is bigger than ideal. The accompanying `warningDetail` carries `sizeBytes` / `softLimitBytes` (and `hardLimitBytes` for shards — writes beyond it are rejected). Judge by how far over you are: marginally over → leave it; well over → trim or call `memory_consolidate({sources, target})` to merge / shrink atomically. A write that would push an index past its hard limit is rejected with `INVALID_PARAMS`: merge or delete entries first, then write again.

## Tool selection

- Browse what exists → the indexes (already in your context)
- Detail of a known shard → `memory_read(filename)`
- Find content by keyword → `memory_search(query)` (FTS5, ranked snippets)
- Suspect contradictions / want a cleanup pass → `memory_review()` (runs a quick LLM review, returns suggestions only — you still execute the deletes/merges)

## Current index

Below this section, the live indexes are inlined: the `user` scope first, then the `project` scope. Use them to know what's already saved.
