# Handoff: 2026-11-02, from a cloud session to a local Claude session on the owner's laptop

Read `AGENTS.md` first (hard rules), then `ROADMAP.md` Phase 3 and the top `STATUS.md` entries. This file only says where things stand and what to do next.

## Where we are

- **Branch:** `claude/jolly-brown-n5edmp`.
- **Open draft PR:** th3ottoman-png/cindy#8, "Expert creator with owner-approved drafts (ROADMAP 3.8a)".
- `main` already has 3.2a, 3.7a and 3.7b, merged via PR #7.
- **Agreed build order** (ADR 0005): 3.2 → 3.7 Hermes as Orca lead (done) → **3.8 expert creator (in progress)** → 3.9 orchestrator expert.
- **Approval gate:** the owner approves every new expert. Delegation to existing experts runs freely.

## 3.8 status

| Part | Status |
|---|---|
| 3.8a code + tests | `unit-tested` (STATUS 2026-11-02). Owner's Mac: desktop 8 shards green, maker-core, lizi-mcps and orca-workflow green, all on the first PR #8 head |
| Approve path | `live-proven` (owner, 2026-11-02): brief → card → Approve → "UK FM Cold Email Writer" saved, shown in the picker, answered in role |
| Shared-config fix + one-line YAML | `unit-tested` in this session's last commit. Full gates were NOT run here: the session ran out of budget, and the owner said "just push it, I'll run the shards" |
| Reject path | **not yet live-tested** |

### How it works

Key files:
- `packages/maker-core/src/experts/expert-draft.ts`: draft check, renderer, atomic writer.
- `apps/desktop/src/main/mcp-integrations/expertsMcpServer.ts`: tool `draft_expert` on server `cindy_experts`.
- `maker-ipc/expertDraftConfirm.ts`: owner approval wait, 9 minutes.
- `renderer/features/cc-agent/HermesExpertDraftCard.tsx`: the approval card.
- `hermesBridgeHost.ts`: exposure.
- `piEnvironment.ts`: `setHermesOnlyBridgeProviders`.
- The starter expert lives in `docs/experts-examples/expert-creator/`.
- ADR 0007 records the design.

**Gotchas learned live:**
- **New main-process code needs a full app restart.** Quit the app, stop `pnpm dev`, and start again. The renderer hot-reloads; main does not.
- **One `~/.hermes-cindy/config.yaml` is shared by every Hermes session**, and each session home copies it per turn. Per-session shim lists let one session's start delete another's tools.
  - Fix: register every server any session may use.
  - Per session, the bridge mount (`RUNTIME_MCP_NAMES_KEY`) decides. The bridge answers 403 at connect, the shim exits, and Hermes lists no tools.
  - Watch for any visible "MCP server failed" noise in Hermes chats caused by this.
- **Container typecheck:** `apps/mobile` needs `NODE_OPTIONS=--max-old-space-size=7168` in a cloud container. That doesn't apply on the Mac.
- **Desktop unit gate:** run it as 8 shards, `XDT_UNIT_TEST_SHARD=i/8 node scripts/test-workspaces.mjs --tier unit --workspace apps/desktop`. Rerun only a shard that crashed with SIGSEGV (known Debt).

## Next steps, in order

1. **Gates on the last commit** (Node 22 first in PATH):
   - `pnpm typecheck`
   - `pnpm test:runner`
   - `pnpm check:test-hygiene`
   - desktop 8 shards
   - maker-core unit

   If any fail, fix them before anything else.
2. **Finish 3.8b live**:
   - Restart the app.
   - Start an Expert Creator task (Full access, strong model such as `deepseek-v4-pro`).
   - Start any other Hermes task, then return to the creator. It must still have `draft_expert`.
   - Brief a second expert, type a note on the card, and click **Reject**. The creator should relay the note, and `ls ~/.cindy-harness/experts` should show no new folder.
   - Record the result in ROADMAP row 3.8 and in STATUS.
   - If it passes, mark 3.8 `live-proven` and ask the owner to merge PR #8.
3. **Context banner bug** (the owner finds it annoying). It's in ROADMAP Debt.
   - Symptom: in Hermes with `deepseek-v4-pro`, the banner said "368% / 266% full (0 tokens left)" while the footer said 60% / 43%. The banner also offers "Summarise and continue (lmstudio-local/qwen3-8b)". Later in the same task the two agreed (88% vs 87%), so the bad numbers seem to come from early or turn-level token counts against a borrowed limit.
   - Start in `apps/desktop/src/renderer/.../SessionContextGuardBanner.tsx`, `resolveSessionContextLength`. 3.7b already fixed `hermes-default`; this is the routed-API-model case.
   - Do it as its own session and row: one task per session.
4. **Then 3.9 orchestrator expert** (ADR 0005). It lists experts, delegates a job to one as an Orca worker started as that expert, and asks the expert creator when none fits. It needs Hermes as an Orca *worker* (`orca_worker_bridge` plus a `create_worker` schema change), so read ADR 0006 first. Give the owner a short plan before coding.

## Other open items

- **3.2b:** `tools.yaml` and skills, auto-selecting the expert's model, non-Hermes experts.
- **3.5b:**
  - Research Analyst invented sources; it needs web search or a stronger model.
  - Repo Explainer must be run from a project folder.
- **Expert binding:**
  - A pending expert pick binds to *any* fresh Hermes session within 30 minutes.
  - The resume-reset path loses the expert prompt.
- **Hermes team mode:** the draft page still hides it for Hermes. The lead starts teams via `start_team`.

## Owner preferences

- Concise and ADHD-friendly: headers, bullets, short sentences, no em dashes.
- Shell commands in separate `bash` blocks.
- The owner runs heavy tests on the Mac and pastes the output.
- Ask one question only when a real product decision is needed.
