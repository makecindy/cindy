# ADR 0007: The expert creator's draft tool for Hermes

- **Status:** Accepted (owner, 2026-11-02: "go" on the 3.8 plan)
- **Date:** 2026-11-02
- **Decider:** owner. This adds one server to the Hermes bridge exposure lists (ADR 0003, ADR 0006). ROADMAP 3.8, ADR 0005 step 3.

## Context

ADR 0005 calls for an expert creator: an expert whose one tool drafts a new expert, with the owner approving every new expert before its files are written (option A). The tool can only write inside `~/.cindy-harness/experts/`, and only through a reviewed draft. Cindy tools reach Hermes through the shared local tool bridge (the one Pi uses) and only in full-access sessions (1.5b-5d).

## Decision

- **New first-party server `cindy_experts`** with a single tool, `draft_expert`. It lives in desktop main (`mcp-integrations/expertsMcpServer.ts`), not in `@cindy/mcps`.
  - It checks the draft with the same rules as the loader.
  - It shows the draft to the owner on a card in the calling session and waits for an answer, up to the host-confirm timeout of 9 minutes.
  - **Approve** writes a **new** folder atomically: temp folder, loaded back, then renamed into place. It never overwrites an existing expert.
  - **Reject** or no answer writes nothing.
- **Exposure:**
  - The tool is a fourth list, `HERMES_BRIDGE_EXPERT_SERVERS`.
  - It is mounted only for a Hermes session started as an expert whose `expert.md` lists `tools: [draft_expert]`. For a fresh session, the pending pick counts.
  - Every call re-checks the session's bound expert, so reaching the route without that binding fails closed.
- **Pi is unchanged:**
  - The server rides the shared bridge as a "Hermes-only" provider (`setHermesOnlyBridgeProviders`), so it is served no matter which agent starts the bridge.
  - Pi never mounts it.
  - Pi's provider array, Bot catalogs, and the Claude Code and Codex provider lists do not include it.
- **A draft cannot grant tools or pick another agent.** A written expert has no `tools:` line, so the creator can never create another creator. The owner adds tools by hand.
- The starter expert `docs/experts-examples/expert-creator/` is new prompt text for a new feature (AGENTS.md section 3).

## Consequences

- A full-access Hermes session started as Expert Creator can propose experts. Nothing reaches disk without an Approve click in the app.
- The approval card is a standalone Hermes surface (`HermesExpertDraftCard.tsx`). It does not extend upstream's chat-store interaction union, so the IM `/ctr` takeover never sees it. Approval happens on the desktop only.
- 3.9 (the orchestrator) will ask this expert to create experts. That path keeps the same approval card.
