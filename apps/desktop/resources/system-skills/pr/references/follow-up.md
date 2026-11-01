# How the background check decides

Read this when debugging a follow-up, or before changing the schedule or the check. Day-to-day rounds only need SKILL.md.

The schedule fires every 10 minutes. Each time, `scripts/pr-heartbeat-gate.mjs` runs first as the schedule's pre-run check:

- **exit 0:** wake the agent in the bound task; the check's output, including the list of what happened, is attached to the prompt.
- **exit 2:** skip this run. No model call, no tokens, nothing in the task.
- **anything else:** the run is recorded as failed and the user is notified.

Each check saves its decision, reason, detail and list as `lastResult`. The agent reads it with the read-only `--last-result --json`.

## Cost: a small question first

Every check first runs `pr-snapshot.mjs --probe`: one small GraphQL query for the PR's state, head, mergeability, check counts by state, and the newest comment and review. When it matches the last full read, the check stops there (`unchanged`). It reads the PR in full (three or four API calls) only when the probe differs or when one of these holds: an update was released but not yet acknowledged, checks were still running or mergeability was unknown at the last full read, the PR is merged or closed, 30 minutes have passed since the last full read (the probe cannot see edits inside review threads), a new commit's check deadline or a defer is due, or the silence guard is due. A failed probe also falls back to a full read.

## When the agent is woken

The check keeps a `watch`: what the agent has already been told about. It wakes the agent only for news against it, in the spirit of T3 Code's pull request watch:

- **Checks failed:** a check failed (including cancelled, timed out or needing action) that had not failed on this commit before. Reported once per commit and name; a re-run that replaced a failed attempt no longer counts, because the snapshot keeps only the latest run of each check.
- **Checks passed:** all required checks passed (all checks when the repository marks none as required). Non-required checks still running at that moment get one more update when they all finish; later changes to them do not wake.
- **Comments:** new comments, reviews with a body or a verdict, and review-thread comments from anyone except the account the agent uses. Edits count as new. Empty "commented" reviews are skipped; their thread comments carry the content.
- **Conflict:** the branch started to conflict with the base. GitHub's mergeability recomputation ("unknown") neither raises nor clears it.
- **No checks:** 15 minutes after a new commit, no check has reported, although this PR ran checks before.
- **Draft:** the PR became a draft (`draft-entered`) or left draft (`draft-exited`).
- **Merge queue:** the merge queue removed the PR, its group's checks failed, or the group cannot merge. Waiting in the queue does not wake.
- **Merged or closed:** always, until the schedule is deleted (cleanup must happen; a failed cleanup gets another round).

Not woken: pushes, checks starting or running, an unchanged failure, the agent's own comments, comments while only an explicit human approval is pending (`blocked-human`). These advance the watch silently.

- **Comment limit:** after 10 updates in a row that bring only comments, the check asks the agent to stop following (`comment-limit`), which stops reply loops with bots. A push or any check, conflict or queue news resets the count.
- **Defer:** `--defer <minutes>` acknowledges the round and asks for one more wake at that time if nothing happens first (`defer-expired`).
- **Silence guard:** after 24 hours without waking the agent, one look at what the check cannot see (`silence-guard`).
- **Truncated snapshot:** incomplete data never counts as "nothing changed"; the watch does not advance past it.

## Reliability rules

- **Two-phase watch.** A released update stays pending until the agent's `--ack` moves `pendingWatch` into `watch`. If the run never starts or crashes, the same items are released again: three quick retries, then every 30 minutes until acknowledged. Releases less than 5 minutes apart (the host postponing a run) do not count as attempts.
- Pending records only the earliest unacknowledged watch, so a slow agent's `--ack` can only confirm what it was actually told; anything newer is reported again. This relies on one agent turn at a time in the bound task: keep `bindToCurrentSession: true`.
- If the items disappear before the agent acknowledges them (for example a fix was pushed), the pending update is dropped.
- **Snapshot failures** are skipped up to three times in a row before the check fails and the user is notified. A GitHub rate limit backs off until the reset time from the response headers. The same failure is reported at most once a day.
- After the same update goes unacknowledged for three backoff cycles, the detail tells the agent to notify the user.
- **Upgrades.** A state file written by the earlier version of the check (fingerprints, no watch) starts a watch from the current PR without repeating old news. If it still had an unacknowledged change, the agent is woken once (`upgraded`). Retired options (`--no-cadence-throttle`, `--draft-reminder-hours`, `--max-work-pending-passes`) are accepted and ignored so existing schedules keep working.

## Machine-checked hints in the detail

- `round=N`, with checkpoint instructions from round 5 and convergence mode from round 10 (`references/review-convergence.md`).
- **Scope growth:** the diff grew at least 1.5× and by 300+ lines since following started. Machinery grown under review should usually be deleted.
- **Almost there:** only human blockers left and at most two active threads. Finish them, then wait silently.
- **Hotspot:** one file has 8+ review threads. Redesign or declare scope instead of patching further.

## Files

- State: `~/.cache/cindy-pr/<owner>__<repo>-<number>.json` (override with `--state-dir` or `CINDY_PR_STATE_DIR`). It lives outside the worktree because cleanup deletes the worktree.
- `pr-snapshot.mjs`: read-only facts, including merge-queue state, required checks and the viewer; `--probe` prints the small change fingerprint. Not a pre-run hook by itself: its exit codes do not match the hook protocol.
- `pr-cleanup-plan.mjs`: read-only local cleanup plan after merge or close.
