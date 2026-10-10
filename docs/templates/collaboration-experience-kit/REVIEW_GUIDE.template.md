# Review Guide

This document defines severity, blocking rules, and the boundary between automation and
human judgment.

## Severity

| Level | Definition | Action |
| --- | --- | --- |
| P0 | Security breach, credential exposure, data loss, broken migration, crash, unsafe external action, or incompatible public contract | Block until fixed |
| P1 | Concrete bug, violated documented rule, missing required evidence, unhandled failure mode, accessibility regression, or misleading UX | Fix in this PR |
| P2 | Style preference, minor naming choice, optional refactor, or non-blocking polish | Track separately or omit |

Do not downgrade a P0 because the diff is small, urgent, internal, or authored by a trusted
contributor.

## Reviewer Questions

1. Does the change do what the summary claims?
2. Are unrelated changes excluded?
3. Is the affected blast radius understood?
4. Are tests meaningful, stable, and connected to observed behavior?
5. Does failure handling preserve user data and recovery ability?
6. Are compatibility, migration, permissions, and rollback considered?
7. Is user-facing language clear, actionable, localized, and consistent?
8. Is every claim of verification backed by a real command, environment, or observation?

## AI Review Boundary

AI review is useful for surfacing missing migration or rollback evidence, security and
permission boundary risks, protocol or stored-data compatibility risks, weak tests, false
confidence, silent behavior changes, accessibility gaps, localization gaps, dual-theme
gaps, cross-platform gaps, and product-language ambiguity that static checks cannot
understand.

AI review does not approve a PR. It supplements CI, deterministic guards, and accountable
human review.
