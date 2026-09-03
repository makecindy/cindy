# Development Workflow

This document is the authoritative workflow for branches, commits, pull requests,
verification, and review escalation.

## Branch Model

1. Update the local DEFAULT_BRANCH before starting a new task.
2. Create a short-lived branch under CHANGE_BRANCH_PREFIX.
3. Keep one pull request focused on one problem.
4. Use a separate worktree or equivalent isolation for complex tasks when available.
5. Never reuse another task's dirty workspace without confirming ownership of its changes.

Direct pushes to DEFAULT_BRANCH require an explicitly authorized maintainer and an
additional independent review. Automation must not treat a bypass permission as approval.

## Local Gates

Run these gates before every committable change:

    RELATED_TEST_GATE
    TYPECHECK_GATE
    FORMAT_GATE

A failed gate blocks commit. If a check cannot run, record the reason and the replacement
evidence; do not weaken or skip the gate to make it pass.

For changes to test selection, dependency manifests, workspace configuration, CI wiring,
or formatter configuration, run the full relevant suite instead of only related tests.

## Commit Requirements

- Write a specific message describing the change, not only its file names.
- Apply SIGNOFF_MECHANISM when contribution attribution is required.
- Never add credentials, machine-local secrets, temporary logs, or authorization files.
- Review the complete diff after formatting and before committing.
- A work-in-progress commit may bypass a gate only to prevent data loss; mark it WIP,
  do not push it, and do not open a mergeable PR until all gates pass.

## Pull Request Evidence

The PR body must answer:

- What changed, and why?
- What is explicitly out of scope?
- What user-visible behavior changed?
- Which automated checks ran, and what were the results?
- Which manual checks ran, on which platform or environment?
- What was not verified, and why?
- What is the risk, impact, rollback, or degradation path?

Small diffs still need evidence. Diff size does not waive migration, security, protocol,
native runtime, data-loss, or compatibility review.

Direct pushes to the default branch require an explicitly authorized maintainer plus an
additional independent adversarial review. Active worktrees must have a clear owner, and
automatic cleanup must not delete a directory still used by an active session.
