# PROJECT_NAME Agent Entry

This file is the shared entry for human contributors and coding agents. Keep it short:
route by risk here, and put detailed rules in their owning documents.

## Repository Boundary

- This repository owns OWNED_DIRECTORIES.
- Do not modify EXTERNAL_REPOS_OR_SERVICES unless the task explicitly authorizes it.
- Treat generated files, lockfiles, credentials, local preferences, and user data as
  protected paths.

## Rule Routing

Read the matching rule before changing code or documentation:

| Change touches | Required reading |
| --- | --- |
| First contribution or unfamiliar module | REPO_MAP |
| Environment, dependencies, or a new checkout | ENVIRONMENT_SETUP |
| High-risk auth, storage, migration, protocol, permissions, or release paths | MODULE_RULE |
| User-facing interface, motion, layout, or copy | DESIGN_RULES |
| Public workflow, branch, commit, review, or merge behavior | WORKFLOW_RULES |

Add one row per high-risk area. If a rule does not change how a contributor acts, do not
add it here.

## Standard Flow

1. Confirm the goal, repository boundary, current branch, and dirty state.
2. Read the routed rules and the real implementation before editing.
3. Keep each change focused; do not mix unrelated fixes.
4. Run RELATED_TEST_GATE, TYPECHECK_GATE, and FORMAT_GATE.
5. Review the complete diff before commit.
6. Record scope, verification, unverified items, risks, and rollback evidence in the PR.

Use SIGNOFF_MECHANISM for every commit when the project requires contribution attribution.

## Safety Baseline

- Never commit credentials, tokens, private endpoints, or authorization files.
- Do not run destructive, irreversible, external, or user-visible actions without explicit
  authorization.
- Preserve unrelated user changes; never recover a workspace by discarding them silently.
- Stop and ask when a task touches security boundaries, data migration, protocol
  compatibility, release infrastructure, or another project's owned service.
- Report verified items and unverified items separately; do not describe an assumption as
  a test result.
