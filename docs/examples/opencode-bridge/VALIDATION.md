# Local validation — 2026-10-26

## Scope

- PR #7164 reviewed at `626682a72c19bc698be34013a624ff4521bf9f65`.
- PR #7166 reviewed at `b740abe7ef9a4a6d3374f642e8e4d3a512c4e3b0`.
- This local follow-up adds the versioned companion bridge and setup guide to
  #7166 and changes its preset documentation link. No commit/push or GitHub
  comment/review was performed.

## Results

| Verification | Result |
| --- | --- |
| #7164 model-providers package | 59 files / 1,540 tests passed |
| #7166 model-providers package | 59 files / 1,541 tests passed |
| #7166 preset/link/branding/defaults after the guide URL update | 193 tests passed |
| Both package heads, TypeScript 5.9.3 `tsc --noEmit` | Passed |
| Desktop usage receipts, account reference prices, turn-cost calculator, usage history | 4 files / 100 tests passed |
| Python bridge unit regressions | 10 tests passed, about 0.03 seconds |
| OpenCode 1.19.4 + fixture HTTP model | Nonstream usage/cache, SSE usage, native MCP roundtrip, aggregate usage, upstream failures passed |
| OpenCode 1.19.4 + real local Qwen 2.5 1.5B | Nonstream reply, native MCP echo roundtrip, final SSE usage passed |
| Pythonw launcher | Owned server and bridge started headlessly; health returned version 2.0.0 |
| Installed bridge | Version 2.0.0, model discovery and read-only SQLite telemetry verified |

The existing partial dependency tree had pnpm 11 / TypeScript 7, incompatible
with the repository's pnpm 10 / pinned TypeScript 5.9.3. Validation used a
temporary external toolchain and source-resolution aliases for missing workspace
links; application source, lockfile, global tools, and existing node_modules were
not changed to make the tests pass. The three earlier catalog-import failures
disappeared with the pinned TypeScript API. This is targeted validation, not a
claim that the full Desktop/CI suite passed.

## Regression evidence

- Before: configured `{input:12, output:30}` was exported as all-zero prices.
  Now: declared prices survive; malformed/missing fields are omitted.
- Before: the installed OpenCode schema failed with `no such column: tokens`.
  Now: the current aggregate columns are read through a read-only connection;
  unsupported schemas report unavailable rather than zeros.
- Before: native streaming had no usage; nonstream counted words. Now: actual
  completed OpenCode message counters are mapped to OpenAI usage, including a
  final SSE frame. A completed tool roundtrip reports aggregate usage once.
- Before: tools were advertised but never relayed. Now: real native MCP calls
  suspend until Cindy's matching result arrives. Two-conversation isolation and
  mixed-result rejection are covered by unit tests.
- Before: upstream failures returned HTTP 200 + successful stop. Now: failures
  remain HTTP errors; errors after streaming starts do not emit successful stop.
- Real-model testing also exposed native auto-compaction loops on a small local
  context. Bridge sessions now leave context management to Cindy's harness.

## Limits and outstanding external steps

- The tested custom Qwen 14B model emitted tool-looking JSON as text instead of
  native tool calls. The adapter deliberately rejects a required-tool request in
  that case. The standard local Qwen 1.5B model passed the real roundtrip.
- The installed bridge discovered 566 models: 82 had explicit zero prices and
  one had unknown pricing. The old bridge reported that unknown model as free.
  Discovery and pricing do not prove account access to every hosted model.
- Database telemetry covers **all OpenCode sessions**, not Cindy-only history.
  It is explicitly labeled and provides no invented subscription quotas.
- Real inference was local; no paid provider inference was used for validation.
- Cindy's rendered pricing/Usage History UI was not exercised end-to-end. The
  existing pricing/history pipeline passed its focused tests.
- GitHub approval/format gates were not changed. #7166 still requires maintainer
  product approval; #7164's previous format rejection requires maintainer review
  even though its description already contains the required headings.

The local installed Python files and launch shortcuts were backed up before
replacement. No Cindy database schema or user provider configuration was changed.
