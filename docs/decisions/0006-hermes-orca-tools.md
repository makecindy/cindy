# ADR 0006 — Orca team tools for Hermes (full-access sessions)

- **Status:** Accepted (owner, 2026-11-02: "1 and 2 is good")
- **Date:** 2026-11-02
- **Decider:** owner; widens ADR 0003's exposure list by one server. ROADMAP 3.7a, ADR 0005 step 2.

## Context

ADR 0003 exposes only `cindy_docs` to Hermes and says not to widen the list without a new
decision. Hermes as an Orca lead (ADR 0005) needs the `cindy_orca` server (`start_team`,
`create_worker`, `send_to_worker`, ...). Cindy tools reach Hermes only in full-access
(`--yolo`) sessions (1.5b-5d).

## Decision

- Add `cindy_orca` to the Hermes bridge as a third list, `HERMES_BRIDGE_COLLAB_SERVERS`.
  It is exposed only when collaboration is enabled globally or the session is already a team
  member, and never when the project disabled `collab` — the same gate Pi uses
  (`piEnvironment.ts`).
- Not exposed: `orca_worker_bridge` (Hermes as a *worker* is later work; the `create_worker`
  tool schema lists only claude-code/codex/pi and is not changed here).
- Orca's own checks stay in force: the host handlers validate every call, and raising worker
  permissions asks the owner.
- The lead/worker instructions Cindy gives other agents reach Hermes as a preamble on the next
  turn after they change (Hermes has no system-prompt slot).
- The session's Orca identity is updated in place on the bridge (as Pi does), so `start_team`
  takes effect on the next tool call; the frozen per-project tool policy cannot be patched.

## Consequences

- A full-access Hermes session with collaboration on can create Orca workers on Claude Code,
  Codex or Pi, which may use paid providers. Workers are visible sessions; the owner sees each.
- Small local models may not drive the multi-step Orca flow; use a strong route for the lead.
