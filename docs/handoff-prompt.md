# Prompt for the next agent

Paste everything below the line into the new agent session to start immediately. Full state details and root cause analysis are in `docs/handoff.md`.

---

You are taking over development on a private, single-user fork of Cindy.

REPO PATH: `/Users/turko/=ai space=/=Projects_Main=/Cindy` (always quote all paths: contains spaces and "="). Branch `main`, remote `origin`.

READ IN THIS ORDER BEFORE CHANGING ANY FILES:
1. `AGENTS.md` (overrides everything).
2. `docs/handoff.md` (full state, active defect diagnosis, checklist, and file paths).
3. `ROADMAP.md` (source of truth for task progress) and the top 2 entries of `STATUS.md`.

---

### YOUR IMMEDIATE MISSION: Fix Hermes Model Selection UI Reversion

**Symptom:**
When starting a new task in Cindy desktop, selecting `qwen 8b (lmstudio-local)` in the model picker, and sending "hi":
- Qwen 8B actually replies back (the backend correctly routes to the local LM Studio instance).
- BUT the UI model display (header and/or composer pill) reverts back to `hermes-default` (`Hermes home default (deepseek-flash)`).

**Where to investigate:**
1. `apps/desktop/src/renderer/components/new-chat/ChatInput.tsx`:
   - `const activeModel = sessionId ? session?.model ?? draftModel : draftModel;`
   - When typing begins, provisional session creation writes `hermes-default` to SQLite in `apps/desktop/src/main/localDb/sessionOpening.ts`.
   - Check why `handleModelChange` / `performModelChange` does not persist the updated `newModelId` (`qwen3-8b`) to the provisional session in the DB immediately upon dropdown selection.
2. `apps/desktop/src/main/maker-ipc/register.ts`:
   - Look at `bootstrapSession(o)` and `lazyCreateSession` on first message send: verify whether `o.model` arrives as `'qwen3-8b'` or `'hermes-default'`. Ensure `sessions.model` in SQLite is updated with the user's explicit selection and broadcast via `broadcastSessionPatched(o.id, { model: o.model })`.
3. `apps/desktop/src/main/maker-ipc/sessionHermesTurnUsage.ts` & `turn-complete` pipeline:
   - Ensure `sessionHermesTurnUsage` or turn completion does not inadvertently reset `sessions.model` to the Hermes home default.

---

### HARD CONSTRAINTS (from AGENTS.md)
- **Node 22 only:** `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- **Never reference, read, write, or list `~/.hermes`** — only `~/.hermes-cindy`.
- **Keep gates green before every commit:**
  ```bash
  export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  pnpm typecheck
  pnpm test:runner
  node scripts/test-workspaces.mjs --tier unit --related --workspace-concurrency=1
  pnpm check:test-hygiene
  ```
- **Desktop dev app restart command:**
  ```bash
  pnpm restart:desktop:remote --region=global
  ```
- **Every session ends with:**
  1. `ROADMAP.md` task row updated.
  2. `STATUS.md` dated entry at the top with files changed, verification label, and mutation checks.
  3. Signed commit with DCO (`git commit -s`), pushed to `origin main`.
