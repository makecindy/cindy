# Domain Docs

## Layout

This repo uses a single domain context:

- Root `CONTEXT.md` is the glossary for cross-module domain language.
- Root `docs/adr/` contains architectural decisions that apply across modules.

## Before exploring

Read:

1. Root `CONTEXT.md`
2. Relevant ADRs in `docs/adr/`
3. The repository rules in `AGENTS.md` and the task-specific documents it links

If a term is defined in `CONTEXT.md`, use that canonical term rather than a
synonym. If a proposed design conflicts with an ADR, call out the conflict
instead of silently overriding it.

`/domain-modeling` owns changes to the glossary and ADRs. Create additional
domain docs only when a genuinely separate context emerges; do not split by
package merely because this is a monorepo.
