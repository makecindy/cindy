# ADR 0005 — One orchestrator that delegates to experts, plus an expert creator

- **Status:** Accepted (owner, 2026-11-01: "Let's go with that")
- **Date:** 2026-11-01
- **Decider:** owner. Lifts "Autonomous multi-agent orchestration" out of ROADMAP §Parked, under the limits below.

## Context

The owner wants to talk to one orchestrator. It delegates each job to an expert. If no expert fits, a dedicated
*expert creator* writes a new expert from the orchestrator's brief, and the job goes to it.

What exists (read 2026-11-01):

- Experts are files (`~/.cindy-harness/experts/<slug>/expert.md`), loaded by 3.1a; 3.2a starts a Hermes session as an expert.
- Upstream Cindy ships **Orca**: a lead session creates worker sessions (`start_team`, `create_worker`, `send_to_worker`,
  `packages/lizi-mcps/src/xdt-helper/`), each worker a visible session.
- Orca does **not** run with a Hermes lead today: `NewMakerDraftRoute.tsx` hides the collaboration entry for Hermes
  ("hermes Lead v1 不接 Orca Worker"), and the Hermes adapter does not pass `userPrompt` / Orca instructions to Hermes.
- Hermes CLI has its own throwaway helper agents; those are invisible to Cindy and are not the mechanism here.

## Decision

1. **Reuse, don't rebuild.** Orca supplies lead/worker mechanics; experts supply each worker's identity. No new
   orchestration engine.
2. **Build order, each step useful alone:** 3.2 (start a session as an expert) → 3.7 Hermes as an Orca lead →
   3.8 expert creator → 3.9 orchestrator expert.
3. **Approval gate, option A:** the owner approves every *new expert* before its files are written. Delegation to an
   existing expert runs without asking. (Chosen as the recommended default; the owner can tighten it to B — approve
   each delegation too — at any time.)
4. **Limits (fail closed):**
   - Delegation depth 1: orchestrator → expert. An expert never delegates further.
   - Every delegated job is its own visible session (AGENTS.md §6.4, no hidden state).
   - The expert creator can only write inside `~/.cindy-harness/experts/`, and only through a reviewed draft.
   - Each delegated job carries a turn cap; no model switch without the owner (2.4 rule).
5. 3.6 (owner-initiated handoff) stays; it is the manual version of the same path.

## Consequences

- §Parked loses "Autonomous multi-agent orchestration"; Phase 3 gains rows 3.7–3.9.
- Small local models may not plan reliably; the orchestrator expert will probably need a stronger route. Measure in 3.9.
