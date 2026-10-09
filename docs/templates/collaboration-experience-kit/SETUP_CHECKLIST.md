# Setup Checklist

Use this list once after copying the kit into a new repository.

## Prepare Files

- [ ] Choose the target locations from manifest.json.
- [ ] Rename AGENT_ENTRY.template.md to the project's shared agent entry.
- [ ] Move WORKFLOW.template.md to the project's central workflow location.
- [ ] Install PR_TEMPLATE.md as the pull-request template.
- [ ] Move REVIEW_GUIDE.template.md to the project's review-standard location.
- [ ] Keep or delete UI_UX_RULES.template.md according to whether the project has UI.
- [ ] Remove this kit from active onboarding after the renamed documents land.

## Fill Project Facts

- [ ] Replace PROJECT_NAME.
- [ ] Replace DEFAULT_BRANCH and CHANGE_BRANCH_PREFIX.
- [ ] Replace RELATED_TEST_GATE with a command that actually runs relevant tests.
- [ ] Replace TYPECHECK_GATE with real typecheck coverage.
- [ ] Replace FORMAT_GATE with the actual formatting or whitespace check.
- [ ] Replace SIGNOFF_MECHANISM with DCO or the team's equivalent attribution rule.
- [ ] Replace repository-boundary and high-risk-routing examples with real paths.

## Validate Adoption

- [ ] A new contributor can find the entry point in one step.
- [ ] A new agent receives the same boundary, safety, and workflow rules as a human.
- [ ] Every linked rule document exists.
- [ ] Every documented gate command succeeds in a clean checkout.
- [ ] A minimal PR contains scope, verification, unverified items, risk, and rollback.
- [ ] P0, P1, and P2 review outcomes are written in the same vocabulary.
- [ ] Optional UI rules are either enforced or removed.

## Anti-Goals

- Do not publish this directory as parallel truth alongside the renamed official rules.
- Do not keep commands that do not exist just to look rigorous.
- Do not convert every suggestion into a blocking rule; route by risk.
- Do not store team secrets, private endpoints, credentials, or incident details in the kit.
