---
name: learn
description: Distill a reusable Cindy Skill from the current task, a described workflow, or a SkillHub skill through Cindy's review flow when the user directly invokes /learn or /skill:learn in Pi.
---

# Learn

Start Cindy's managed Learn flow. Cindy gathers relevant evidence, creates the Skill in a separate task, and presents a diff for review before saving anything to the user's Skills directory.

Do not create or edit Skill files directly as a substitute for this flow.

Parse the invocation text after `/learn` (or Pi's `/skill:learn` runtime alias) and call `cindy_helper` → `call_tool` once with `name: "start_skill_learning"`:

- With no text, pass `source_kind: "session"` and `input: ""`.
- For `hub:<slug> [instructions]`, pass `source_kind: "hub"`, `hub_slug: <slug>`, `hub_catalog_scope: "market"`, and the remaining text as `input`.
- For `hub:<market|team>:<slug> [instructions]`, use the stated `hub_catalog_scope`.
- Otherwise pass `source_kind: "freetext"` and the full remaining text as `input`.

Do not pass a task ID, working directory, or output path. Cindy binds the current task and owns staging, review, and installation.

After a successful call, briefly tell the user that Learn started and that progress and review will appear in Cindy. Do not poll or call the tool again. If the helper or tool is unavailable, say that this Skill requires Cindy's Learn host; do not bypass its review flow by writing Skill files directly.
