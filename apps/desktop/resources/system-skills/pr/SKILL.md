---
name: autofix
description: Fix a GitHub pull request's failing checks, merge conflicts and review feedback, then keep following it in the background until it is merged or closed. Use when the user invokes /autofix or asks to fix or follow a PR, and right after you open a ready (non-draft) pull request in this task, without asking first.
---

# Autofix

Make the pull request mergeable without the user having to supervise it. The goal is a mergeable PR, not answering every comment: before each round ask "what still stands between this PR and mergeable?"

Reply in the user's language. Read the reference files only when this file points to them.

`<skill-dir>` below is the directory containing this SKILL.md. Use it as shown, without resolving symlinks. If it contains `/.versions/<bundle>/`, replace that segment with `/.active/` so the background check survives Cindy updates. Quote every path.

## Boundaries

- **Decide technical questions yourself** and carry them through: correctness, tests, types, lint, CI, races, performance, error handling, compatibility, security hardening, structure, local architecture trade-offs, reviewer P1/P2 suggestions. Never hand the user an "A or B" technical choice.
- **Ask the user first** only for: product behaviour changes; security, permission or privacy boundaries; splitting the PR; adding new machinery that significantly raises complexity (concurrency, locks, caches, persistence, retries). Give your recommended option, the trade-off and the impact.
- **Tell the user** (do not ask) when a problem stays stuck after repeated attempts; the check output names these cases.
- Deleting machinery that grew during review, reverting, or shrinking back to the PR's original goal is technical convergence. It needs no confirmation and is not "splitting the PR".
- Never approve, merge, enable auto-merge, re-enqueue a merge queue, or take a PR out of draft unless the user authorised it for this repository. Authorisation for one repository never carries to another.
- Never stash, reset, clean, revert or overwrite the user's uncommitted changes. Never force-push.
- Public replies stay short, factual and traceable. Ask before posting anything that takes a product position, discloses sensitive material, or attaches screenshots.

## 1. Target and checkout

- Take the PR from the invocation (URL or number). Without one, use the PR you just opened, or the current branch's PR (`gh pr view --json url --jq .url`). Derive `owner/repo` from the URL or `origin`; never assume it.
- Requires the GitHub CLI signed in (`gh auth status`) and Node.js. If either is missing, or the PR is not on GitHub, tell the user exactly that and stop.
- Confirm the PR is open. If its head is a fork you cannot push to, say so and stop.
- Work on the PR's head branch. If the current directory is a clean checkout of it, use it. Otherwise create a worktree next to the repository (`git worktree add --detach ../<repo-folder>-autofix-<number>`, then `gh pr checkout <number>` inside it) and fix its root with `git -C <path> rev-parse --show-toplevel`.

## 2. A fix round

1. Get facts, do not reconstruct them from memory or flat `gh` output:
   `node "<skill-dir>/scripts/pr-snapshot.mjs" <PR_URL>`. Use its `verdict` and `blockers[]`. If the snapshot fails or is truncated, never claim the PR is clean.
2. Review threads are read per thread, active **and** outdated. For each outdated unresolved thread, check the current HEAD: still a problem → fix it; already fixed or superseded → reply pointing at the commit, then resolve.
3. **Feedback is a symptom, not a task list.** Before editing, attribute each comment to the invariant it reveals, group comments by that invariant (a failure family), and fix every path of the family, including ones nobody pointed at. Fix one family at a time, not one thread at a time. Method: `references/review-convergence.md`.
4. **Wait for the round to be complete.** After a push, if a bot reviewer that reviewed earlier commits has not yet reviewed the new head, end the round with `--defer 15` (at most once per push; see `references/review-convergence.md` §5). Then fix everything from the round together.
5. **CI:** read `gh pr checks` and `gh run view <run-id> --log-failed`. Failures unrelated to this PR (they also fail on the base branch) are baseline problems: do not mix fixes for them into this PR. Re-run only a confirmed flake, once (`gh run rerun <run-id> --failed`); a second failure is real.
6. **Conflicts or a stale base:** merge the base branch into the PR branch (`git fetch origin <base>`, `git merge origin/<base>`), resolve, test. Do not rebase a shared PR branch.
7. Verify with the narrowest tests, lint and type checks that cover the change. Follow the repository's own rules for commits, tests and PRs (for example AGENTS.md, CLAUDE.md, CONTRIBUTING, the PR template); this Skill adds none of its own. Stage only related files.
8. **One push per round.** Check the PR is still open, then `git push` once with all of this round's commits; confirm with `gh pr view --json commits` that they landed. Every extra intermediate push makes every bot review an intermediate state again.
9. Reply in each thread you handled (what changed, which commit) before resolving it: `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>`. Where the reviewer is mistaken or the comment is stale, reply with evidence and resolve; do not distort the product to please a comment.
10. Re-run the snapshot to confirm: active and outdated unresolved threads are both zero, checks are green or pending on the new head.

Hard convergence lines (the check output repeats them with the current round number):

- **Do not grow machinery to satisfy reviewers.** If a fix would add concurrency, locks, caches, persistence or retries, first ask "if this whole mechanism were deleted, would the PR's original goal still hold?" If yes, delete it and shrink back. Only if no, ask the user before writing it.
- **Checkpoint:** when a previous fix missed the symmetric half of a path, or the same predicate appears for the third time, stop and do the checkpoint in `references/review-convergence.md` §2 before the next fix.
- **Round 5** with new serious findings: the checkpoint is mandatory. **Round 10:** convergence mode, batch whole families and keep going (it is not a stop condition), and tell the user the round count, the failure families and the chosen path once.

## 3. Start following

After the first round (and right after you open a ready PR yourself), create one background follow-up bound to this task. Do not ask; the user invoking `/autofix` or asking you to open the PR is the authorisation. Skip this for draft PRs unless the user asked you to follow the draft.

Use `cindy_scheduler` (`list_tools` with category `scheduler`, then `call_tool`). First `schedule_list` without a status filter and look for a schedule whose prompt or `preRunHook.command` contains this exact PR URL (host, owner/repo and number). If one exists, keep it; do not create a second. Otherwise call `schedule_create`, filling only the placeholders:

```json
{
  "name": "Autofix #<number>",
  "prompt": "Follow <PR_URL> with the autofix Skill (background round). Checkout: <worktree path> (branch <branch>).",
  "cronExpr": "*/10 * * * *",
  "intervalMs": 600000,
  "timezone": "<the user's IANA time zone>",
  "recurring": true,
  "bindToCurrentSession": true,
  "silentWhenIdle": true,
  "agentKind": "<claude-code, codex or pi: the agent running this task>",
  "notify": { "desktop": true, "feishu": false },
  "preRunHook": {
    "command": "node \"<skill-dir>/scripts/pr-heartbeat-gate.mjs\" <PR_URL>",
    "timeoutMs": 180000
  }
}
```

- Add a line to the prompt only for facts specific to this PR that cannot be derived (for example a reviewer the user named). General procedure lives in this Skill, not in the prompt.
- The hook is a check that ships with Cindy: mount it directly, never generate one with `schedule_set_pre_run_hook` or copy the script. Do not pass `workingDir`, `model` or `effort`.
- `notify` values are JSON booleans. On `INVALID_ARGS`, fix the arguments once from the returned schema; if it fails again, report it.
- A returned id is not proof. Read it back with `schedule_get` and confirm it appears in `schedule_list`. Report the outcome to the user: following started (with the schedule id) or not, and why.
- Leave `cronExpr` and `intervalMs` alone afterwards. The check paces itself: it looks at GitHub less often the longer the PR stays quiet and returns to every 10 minutes as soon as anything changes. How the check decides is described in `references/follow-up.md`.

## 4. Background round

The schedule wakes this task only when the check found something worth a look. Each round:

1. Run `node "<skill-dir>/scripts/pr-snapshot.mjs" <PR_URL>` and `node "<skill-dir>/scripts/pr-heartbeat-gate.mjs" <PR_URL> --last-result --json`. Act on both; the `detail` carries the reason, the round number and any convergence instructions, which you must follow.
2. Do the work:
   - **Technical work** (`NEEDS_WORK`, review threads, CI, conflicts, base sync): a fix round (section 2). Never just `--ack` with unresolved technical blockers.
   - **Ready, approved, or only waiting for review, approval or merge:** nothing to fix. The first time the PR becomes ready, tell the user once; afterwards stay silent. Waiting for approval or merge is not a decision for the user.
   - **Draft:** fix technical problems that do not change what is being discussed; tell the user once what the draft is waiting for, then `--defer 240`.
   - **`silence-guard`:** a periodic look at what the check cannot see. Decide whether to merge in the base, re-run, close or nudge, rather than staying silent just because nothing changed.
   - **Merged or closed:** report it in one line, then `schedule_delete` this schedule (delete, never pause), then clean up (section 5).
3. Finish every round with `node "<skill-dir>/scripts/pr-heartbeat-gate.mjs" <PR_URL> --ack`, or `--defer <minutes>` (which implies `--ack`) only in these cases: waiting for a user decision (240, after asking), blocked on something you cannot move (240, say what you are waiting for), or waiting for this push's bot reviewers (15, at most once per push).

**Notifications.** The schedule runs silently. Call `schedule_notify_current_run` (then write one short message) only when the user should know now: the PR became ready to merge for the first time, it was merged or closed, you need their decision, or the check reports a problem stuck for several backoff cycles. Never notify to say nothing changed, and never nag about pending approval or merge.

If the user asks to stop, delete the schedule.

## 5. Cleanup after merge or close

Run `node "<skill-dir>/scripts/pr-cleanup-plan.mjs" <PR_URL> --worktree <checkout> --fetch` from the primary checkout and follow its read-only plan:

- Only remove a worktree or local branch the plan says is safe (`canCleanupLocal`). Never delete remote branches or long-lived branches.
- `cindy_managed_worktree`: the worktree belongs to a Cindy task; Cindy removes it when that task is archived. Leave it.
- A dirty target worktree: list what is uncommitted and let the user decide; never stash or force-delete it.
- Closed without merging: ask the user before removing anything.
