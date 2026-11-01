# Handoff — Hermes Model Selection & UI Synchronization

**Target Audience:** Next incoming agent.  
**Priority:** Read `AGENTS.md` first (it overrides everything here). Then review `ROADMAP.md` and `STATUS.md`.  
**Repository State:** Main branch is clean, all 4 gates green, latest commit pushed to `origin main`.

---

## 1. Context & Owner Requirements

- **Single-user fork:** The owner is the sole user, reviewer, and product manager.
- **Working style:**
  - Lead with the next action. Short replies, no preamble, no "let me know" closers.
  - One task per session. Never claim a task is done unless proven at the required level (`typechecked` · `unit-tested` · `live-proven`).
  - Strict Node 22 (`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`).
  - Quote all paths (repo contains spaces and `=`).
  - **Never reference or touch `~/.hermes`** — only `~/.hermes-cindy`.
  - Never defeat permission boundaries, do not persist API keys to disk.
  - Back up any mutated files before touching DB or config.
  - Every session ends with updates to `ROADMAP.md`, `STATUS.md`, signed commit (`git commit -s`), and push.

---

## 2. What Was Done in the Current Run

### A. Dynamic Model Route Resolution (LM Studio / Ollama)
- **Problem:** When selecting local models discovered via LM Studio or Ollama (e.g. `google/gemma-4-26b-a4b-qat` or `opus-doctor-8b`), `resolveModelRoute()` only knew about models explicitly hardcoded in `~/.cindy-harness/routing.yaml`. Un-routed local models returned `null`, falling back to Hermes's default DeepSeek API route and failing with `HTTP 400: The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed ...`.
- **Fix:**
  - `packages/maker-core/src/providers/discovery.ts`: Added in-memory caching of online discovered endpoint models (`getLatestDiscoveredModels()`, `setLatestDiscoveredModels()`).
  - `packages/maker-core/src/providers/model-route-resolver.ts`:
    1. Fixed prefix parsing using `trimmed.startsWith(`${pId}/`)` so multi-segment model paths with slashes (e.g. `lmstudio-local/google/gemma-4-26b-a4b-qat`) resolve without cutting off at the first slash.
    2. Added dynamic endpoint matching: if a model matches any discovered models from online endpoints in `providers.yaml`, it automatically resolves to `--provider custom --base-url <endpoint.baseUrl> -m <model>`.
  - `packages/maker-core/src/providers/__tests__/model-route-resolver.test.ts`: Added unit tests for slash-in-model paths and discovery matching (3/3 passed).

### B. Context Window Guard Bypass
- **Problem:** In `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`, selecting local models triggered a bogus warning: `Context is 10470% full (0 tokens left); the next turns may be cut off` because the guard evaluated Hermes sessions against Cindy's BYOM catalog.
- **Fix:** Added a bypass in `confirmModelSwitchContextGuard` when `runtimeAgentKind === 'hermes' && targetAgentKind === 'hermes'` to allow free model switching.

### C. Foreign Model Sanitization & Header/Pill Fixes
- **Problem:** Grok (`xai/grok-4.6`) and Claude model identifiers previously leaked from Claude Code/Codex drafts into `lastByVendor.hermes`, causing sessions (like `d74fb888`) to have `sessions.model = 'xai/grok-4.6'`. This resulted in:
  1. Header displaying `xai/grok-4.6 17.1k tok`.
  2. Composer pill displaying `Hermes · Model Details Unavailable`.
  3. Dropdown showing action `Set xai/grok-4.6 as the Hermes home default`.
- **Fix:**
  - `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`: Added `agentKind === 'hermes'` to `syncSessionDraftModelPrefs` vendor mapping.
  - `apps/desktop/src/renderer/state/newMakerDraft.ts` & `apps/desktop/src/main/localDb/sessionOpening.ts`: Added foreign prefix sanitization (`xai/`, `claude-`, `gpt-`, `chatgpt/`, `grok`) falling back to `hermes-default`.
  - `apps/desktop/src/renderer/features/cc-agent/HermesSessionModelLabel.tsx`: Foreign models are normalized to `'hermes-default'` in the session title bar.
  - `apps/desktop/src/renderer/components/new-chat/ModelSelector.tsx`: Added `isForeignHermesModelId` guard so `effectiveHermesModel` ignores foreign strings and falls back gracefully.
  - Database repair: Updated legacy session `d74fb888` in `cindy-local-v1.db` to `qwen3-8b` (backed up to `cindy-local-v1.db.bak-20261101-session-fix`).

---

## 3. The Active Defect to Fix Next

### User Report
> *"when i start a new task, and choose qwen 8b, say hi, and model name revert back to hermes deepseek. however qwen 8b replied back, so model selection still has issues. write this down for next agent to fix."*

### What Actually Happened (Execution Succeeded, UI State Reverted)
1. **The turn ran on Qwen 8B:** Because Qwen 8B replied back, the backend routing correctly passed `--provider custom --base-url http://127.0.0.1:1234/v1 -m qwen3-8b` to the Hermes child process.
2. **The UI reverted to `Hermes home default (deepseek-flash)`:**
   - In the session header and composer pill, the displayed model reverted back to `hermes-default` / `deepseek-flash`.

### Root Cause Analysis & Investigation Guide
1. **Provisional Draft vs Persisted Session Model:**
   - In `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`:
     ```typescript
     const activeModel = sessionId ? session?.model ?? draftModel : draftModel;
     ```
   - When the user starts typing, a provisional session is created in SQLite (`cindy-local-v1.db`) with `model = 'hermes-default'`.
   - When the user subsequently picks `qwen3-8b` in the dropdown:
     - Check if `handleModelChange` / `performModelChange` is updating the provisional session's `sessions.model` in SQLite via `window.electronAPI.maker.setModel(sessionId, ...)`.
     - Check `resolveModelChangeLane`: for provisional sessions or before first send, does `performModelChange` return early or fail to persist to the database?
2. **First Message Send & Session Bootstrap Reconciliation:**
   - Look at `apps/desktop/src/main/maker-ipc/register.ts` around `bootstrapSession`:
     - When `lazyCreateSession` runs on first turn send, check what `createOpts.model` contains.
     - In `bootstrapSession`, we added an update to `sessions.model`:
       ```typescript
       if (o.id && o.model) {
         // checks row.model !== o.model, updates sessions.model, and broadcasts session patch
       }
       ```
     - **Check:** Does `o.model` arrive as `'qwen3-8b'` or `'hermes-default'`? If `createOpts.model` was not synchronized from the draft state or if `o.model` fell back to `hermes-default`, `sessions.model` gets overwritten with `hermes-default`!
3. **Turn Done Event & Usage Recorder Overwrite:**
   - In `packages/maker-core/src/agents/hermes/agent.ts`:
     - At turn completion, Hermes emits a `done` event carrying `usage.model`.
     - In `apps/desktop/src/main/maker-ipc/sessionHermesTurnUsage.ts` or `sessionEventPipeline.ts`:
       Does the pipeline inspect the turn model or does it broadcast/update the session with the default route?
   - In `hermes-manager.ts`:
     - Check what `rec.appliedModel` or `rec.launch.model` contains. If `targetModel` was empty string (`HERMES_DEFAULT_MODEL_ID`), ensure it only clears the override when intended.

---

## 4. Actionable Next Steps

1. **Reproduce & Trace in Dev App:**
   - Dev app command: `pnpm restart:desktop:remote --region=global` (ensure Node 22).
   - In Cindy desktop: Click "New Chat" (+). Select Hermes. Select `qwen3-8b (lmstudio-local)`. Type "hi" and send.
   - Inspect dev logs in `apps/desktop/logs/main-*.log` and check console output for `[maker-ipc]`, `setModel`, `bootstrapSession`, and `broadcastSessionPatched`.
   - Inspect SQLite database row:
     ```bash
     sqlite3 "$HOME/Library/Application Support/CindyGlobal-dev2-dev/cindy-local-v1.db" \
       "SELECT id, title, agent_kind, model, updated_at FROM sessions ORDER BY updated_at DESC LIMIT 3;"
     ```
   - Check whether `sessions.model` was saved as `qwen3-8b` or `hermes-default`.
2. **Fix the State Synchronization:**
   - Ensure `ChatInput.tsx` persists model selections on provisional sessions immediately.
   - Ensure `bootstrapSession` in `apps/desktop/src/main/maker-ipc/register.ts` retains `o.model` from the composer draft.
   - Ensure renderer `useSession(sessionId)` receives and retains `model: 'qwen3-8b'` without getting overwritten by catalog fallbacks.
3. **Verify Gates Before Committing:**
   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   pnpm typecheck
   pnpm test:runner
   node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1
   pnpm check:test-hygiene
   ```
4. **Finish Session Protocol:**
   - Update `ROADMAP.md` row 2.2b.
   - Add dated entry in `STATUS.md`.
   - Commit with DCO sign-off: `git commit -s -m "..."`.
   - Push to `origin main`.
