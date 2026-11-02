# Starter experts

Copy any folder here to `~/.cindy-harness/experts/<slug>/` and edit it. Each holds an `expert.md`
(YAML frontmatter plus the system prompt). See ROADMAP Phase 3 for the full layout (`skills/`,
`tools.yaml`, `knowledge/`). These are examples; the loader checks they stay valid
(`packages/maker-core/src/experts/__tests__/starter-experts.test.ts`).

`expert-creator/` is special (ROADMAP 3.8, ADR 0007): it lists `tools: [draft_expert]`, so a
full-access Hermes task started as it can propose new experts. Each draft appears on a card in
that task and is written only when you click Approve.
