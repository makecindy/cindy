# How the background check decides

Read this when debugging a follow-up, or before changing the schedule or the check. Day-to-day rounds only need SKILL.md.

The schedule fires every 10 minutes. Each time, `scripts/pr-heartbeat-gate.mjs` runs first as the schedule's pre-run check:

- **exit 0:** wake the agent in the bound task; the check's output is attached to the prompt.
- **exit 2:** skip this run. No model call, no tokens, nothing in the task.
- **anything else:** the run is recorded as failed and the user is notified.

Each check saves its decision, reason and detail as `lastResult`. The agent reads it with the read-only `--last-result --json`, together with a fresh snapshot, and decides from both whether to notify.

## Pacing (cadence)

The check paces itself, so the schedule never needs editing. Based on how long the PR has been quiet since its last real change, it decides how often it actually queries GitHub; the 10-minute firings in between are skipped without any API call (`cadence-throttle`):

| Quiet for | Checks GitHub every |
|---|---|
| < 30 min | 10 min |
| < 2 h | 1 h |
| < 8 h | 4 h |
| < 3 days | 8 h |
| longer | 1 day |

It stays at 10 minutes while there is work (`NEEDS_WORK`), an unacknowledged change, an active defer, a merge-queue entry, or a merged/closed PR waiting for cleanup. Drafts never drop below the pace their reminder needs. Any real change brings it straight back to 10 minutes. The price is the same as a slower schedule: the quieter a PR has been, the later a new event is noticed (at most one interval). `--suggest` prints the current pace; `--no-cadence-throttle` turns pacing off for setups that adjust the schedule themselves.

## When the agent is woken

- **Merged or closed:** always, until the schedule is deleted (cleanup must happen; a failed cleanup gets another round).
- **First check:** to establish a baseline.
- **Truncated snapshot:** incomplete data never counts as "nothing changed".
- **Different from the last acknowledged state:** a real change, or a change released earlier that was never acknowledged with `--ack` (`retry-unacked`). The fingerprint ignores per-run noise (fetch times, check run URLs and start times) and GitHub's asynchronous mergeability recomputation; a real conflict appearing or disappearing still counts. Checks and review threads are fingerprinted separately because CI changes do not update the PR's `updatedAt`. Only while CI is failing, the base branch's head is part of the fingerprint, so a fix on the base branch wakes the PR without waking healthy PRs on every base push. The detail lists `changedFields=[...]`.
- **`NEEDS_WORK` with no change:** woken twice for the same state, then every 30 minutes (`work-pending-backoff`). Backoff limits cost; it does not mean there is no work, and the detail repeats that technical blockers must be pushed forward.
- **Only explicit human-approval threads left** (no red CI, conflict or stale base): skipped as `blocked-human`; later external changes are absorbed silently.
- **Ready, waiting for CI, waiting for humans, or draft, with no change:** skipped.
- **Silence guard:** after 24 hours without waking the agent, one look at what the fingerprint cannot see (`silence-guard`).
- **Draft reminder:** while the PR is a draft, once a day (`draft-reminder`); entering or leaving draft wakes immediately (`draft-entered`, `draft-exited`).
- **`--defer`:** holds wake-ups until the given time, except for real changes, which still break through.

## Reliability rules

- **Two-phase fingerprint.** A released change stays pending until the agent's `--ack`. If the run never starts or crashes, the next check releases it again: three quick retries, then every 30 minutes until acknowledged. Releases less than 5 minutes apart (the host postponing a run) do not count as attempts.
- Pending records only the earliest unacknowledged change, so a slow agent's `--ack` can only confirm a state that was actually released to it. This relies on one agent turn at a time in the bound task: keep `bindToCurrentSession: true`.
- **Snapshot failures** are skipped up to three times in a row before the check fails and the user is notified. A GitHub rate limit backs off until the reset time from the response headers. The same failure is reported at most once a day.
- After the same change goes unacknowledged, or the same state stays stuck, for three backoff cycles, the detail tells the agent to notify the user.

## Machine-checked hints in the detail

- `round=N`, with checkpoint instructions from round 5 and convergence mode from round 10 (`references/review-convergence.md`).
- **Scope growth:** the diff grew at least 1.5× and by 300+ lines since following started. Machinery grown under review should usually be deleted.
- **Almost there:** only human blockers left and at most two active threads. Finish them, then wait silently.
- **Hotspot:** one file has 8+ review threads. Redesign or declare scope instead of patching further.

## Files

- State: `~/.cache/cindy-pr/<owner>__<repo>-<number>.json` (override with `--state-dir` or `CINDY_PR_STATE_DIR`). It lives outside the worktree because cleanup deletes the worktree.
- `pr-snapshot.mjs`: read-only facts, including merge-queue state. Not a pre-run hook by itself: its exit codes do not match the hook protocol.
- `pr-cleanup-plan.mjs`: read-only local cleanup plan after merge or close.
