---
name: pr
description: Carry a GitHub pull request from start to merge in any Git repository - start the work on a fresh branch, open the PR when the user wants it, fix failing checks, merge conflicts and review feedback, follow it in the background, and clean up after merge. Use when the user invokes /pr or gives a PR link, starts a feature or fix that will become a pull request, or asks to open, fix or follow a PR.
---

# PR

Take a change from its first edit to a merged pull request without the user having to supervise. The goal is a mergeable PR, not answering every comment: before each round ask "what still stands between this PR and mergeable?"

Reply in the user's language. Read the reference files only when this file points to them.

**What wins:** the user's explicit instructions and saved preferences first, then the repository's own rules (AGENTS.md, CLAUDE.md, CONTRIBUTING, the PR template), then this Skill's defaults. This Skill adds no commit, test or PR rules of its own.

`<skill-dir>` below is the stable directory of this Skill. The directory you were given may be a temporary link that disappears when Cindy restarts, so resolve it once: run `realpath` on the directory containing this SKILL.md, and if the result contains `/.versions/<bundle>/`, replace that segment with `/.active/` so the background check also survives Cindy updates. Use that path everywhere, especially in the schedule hook. Quote every path.

## Boundaries

- **Decide technical questions yourself** and carry them through: correctness, tests, types, lint, CI, races, performance, error handling, compatibility, security hardening, structure, local architecture trade-offs, reviewer P1/P2 suggestions. Never hand the user an "A or B" technical choice.
- **Ask the user first** only for: product behaviour changes; security, permission or privacy boundaries; splitting the PR; adding new machinery that significantly raises complexity (concurrency, locks, caches, persistence, retries). Give your recommended option, the trade-off and the impact.
- **Tell the user** (do not ask) when a problem stays stuck after repeated attempts; the check output names these cases.
- Deleting machinery that grew during review, reverting, or shrinking back to the PR's original goal is technical convergence. It needs no confirmation and is not "splitting the PR".
- Never push or open a pull request until the user asks for it or agrees. Never approve, merge, enable auto-merge, re-enqueue a merge queue, or take a PR out of draft unless the user authorised it for this repository. Authorisation for one repository never carries to another.
- Never stash, reset, clean, revert or overwrite the user's uncommitted changes. Never force-push.
- Public replies stay short, factual and traceable. Ask before posting anything that takes a product position, discloses sensitive material, or attaches screenshots.
- Requires the GitHub CLI signed in (`gh auth status`) and Node.js. If either is missing, or the repository is not on GitHub, say exactly that; you can still do the local work.

## Where to start

- **No PR yet** (a change to make or finish): sections 1 and 2.
- **An existing PR** (a link or number, `/pr <link>`, "follow <link>", or the current branch's PR): first show its PR card if this task has none (section 4), do a fix round only if something stands in the way (section 3), then start following it in the background (section 4). Following is the default here; skip it only when the user said to just check or look.
- **A background round** (the prompt says so): section 5.

## 1. Start the work

For a change that will become a pull request (not for a question or a read-only investigation):

- **Already isolated:** if the task already works in a worktree or feature branch made for this same change, keep using it. A branch left over from another change does not count: create a task worktree instead of stacking unrelated commits on it. If it is behind the remote default branch, merge that in before continuing.
- **Otherwise create a task worktree:** call `cindy_helper` → `create_task_worktree` (category `control`; pass `repo_dir` when the task directory is not the repository itself). Cindy creates a branch from the freshly fetched remote default branch, binds the worktree to this task and removes it when the task is archived. The task itself does not move: run every shell command from the returned `worktree_path`, use absolute paths inside it for edits, and re-read the repository's rules there (the main checkout may be older). Keep using that path after restarts and context compaction.
- **Fallback** when the tool is unavailable or fails: fetch, then `git worktree add -b <branch> ../<repo-folder>-<slug> origin/<default-branch>` and work there.

## 2. Open the pull request

1. **Ask once, unless the user already asked you to open it** (then go straight to step 2). When the work is done and verified and you are waiting for the user's go-ahead to publish, including when they said "not yet" or "let me look first", ask with the PR card instead of inviting confirmation in text when Cindy's GitHub plugin offers it: `ghost_call` with `ghost_id` `"cindy-github"`, `namespace` `null`, `tool` `"pr_card"` and args `repo`, `head`, `base`, plus `commits` and `files_total` from `git rev-list --count` and `git diff --name-only` against `origin/<base>` (count uncommitted changes too). The title and description are not needed yet. Keep the returned `card_id`, end your reply with one short line pointing at the card without saying where it is (Cindy places it at the end of your reply), and do not ask again in text. The user answers by clicking (a hidden message from the plugin arrives with the choice and the card's `settings`) or by saying so. Ask in one short sentence instead when the plugin is unavailable or the user is talking to you through an IM channel, where cards are not shown.
2. Commit only related files, following the repository's rules. Push the branch, then `gh pr create` (ready for review unless the user chose a draft), filling the repository's PR template truthfully: what changed, how it was verified, risks.
3. **Always show the PR card after creating the PR** (skip only when the plugin is unavailable or the user is in an IM channel). With a card from step 1, first apply its settings: `auto_rename` → `cindy_helper` `call_tool` with `{"name": "set_current_session_title", "args": {"title": "#<number> <PR title>"}}`; `auto_follow` (not for drafts) → start following (section 4); then call `pr_card` with `card_id`, `pr` (the PR URL), and `renamed` / `following` set only for what actually succeeded (wait for those results first; never in parallel with them). Without a card, call `pr_card` with `repo` and `pr` now, then do what its `todo` lists. This card is how the user turns following on or off and sets automatic renaming, so do not replace it with a text summary.
4. Report the PR link in one line. Otherwise rename the task only when the user asks. When you mention a card button or setting, use the label the card shows in the user's language, not the English names in this Skill.
5. Then decide about following it (section 4).

## 3. A fix round

To take over an existing PR, use the link or number given, or the current branch's PR (`gh pr view --json url --jq .url`). Derive `owner/repo` from the URL or `origin`; never assume it. Confirm the PR is open; if its head is a fork you cannot push to, say so and stop. Work on its head branch: if the current directory is a clean checkout of it, use it; otherwise create a task worktree as in section 1 and run `gh pr checkout <number>` inside it.

1. Get facts, do not reconstruct them from memory or flat `gh` output:
   `node "<skill-dir>/scripts/pr-snapshot.mjs" <PR_URL>`. Use its `verdict` and `blockers[]`. If the snapshot fails or is truncated, never claim the PR is clean.
2. Review threads are read per thread, active **and** outdated. For each outdated unresolved thread, check the current HEAD: still a problem → fix it; already fixed or superseded → reply pointing at the commit, then resolve.
3. **Feedback is a symptom, not a task list.** Before editing, attribute each comment to the invariant it reveals, group comments by that invariant (a failure family), and fix every path of the family, including ones nobody pointed at. Fix one family at a time, not one thread at a time. Method: `references/review-convergence.md`.
4. **Wait for the round to be complete.** After a push, if a bot reviewer that reviewed earlier commits has not yet reviewed the new head, end the round with `--defer 15` (at most once per push; see `references/review-convergence.md` §5). Then fix everything from the round together.
5. **CI:** read `gh pr checks` and `gh run view <run-id> --log-failed`. Failures unrelated to this PR (they also fail on the base branch) are baseline problems: do not mix fixes for them into this PR. Re-run only a confirmed flake, once (`gh run rerun <run-id> --failed`); a second failure is real.
6. **Conflicts or a stale base:** merge the base branch into the PR branch (`git fetch origin <base>`, `git merge origin/<base>`), resolve, test. Do not rebase a shared PR branch.
7. Verify with the narrowest tests, lint and type checks that cover the change, following the repository's rules. Stage only related files.
8. **One push per round.** Check the PR is still open, then `git push` once with all of this round's commits; confirm with `gh pr view --json commits` that they landed. Every extra intermediate push makes every bot review an intermediate state again.
9. Reply in each thread you handled (what changed, which commit) before resolving it: `gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=<thread-id>`. Where the reviewer is mistaken or the comment is stale, reply with evidence and resolve; do not distort the product to please a comment.
10. Re-run the snapshot to confirm: active and outdated unresolved threads are both zero, checks are green or pending on the new head.

Hard convergence lines (the check output repeats them with the current round number):

- **Do not grow machinery to satisfy reviewers.** If a fix would add concurrency, locks, caches, persistence or retries, first ask "if this whole mechanism were deleted, would the PR's original goal still hold?" If yes, delete it and shrink back. Only if no, ask the user before writing it.
- **Checkpoint:** when a previous fix missed the symmetric half of a path, or the same predicate appears for the third time, stop and do the checkpoint in `references/review-convergence.md` §2 before the next fix.
- **Round 5** with new serious findings: the checkpoint is mandatory. **Round 10:** convergence mode, batch whole families and keep going (it is not a stop condition), and tell the user the round count, the failure families and the chosen path once.

## 4. Following in the background

**When to follow:** when the user asked you to (including `/pr <link>` and the PR card's "Auto-follow until merged" button), or when the card's "Follow after opening" setting or their saved preference says so. With a PR card, its button and setting are the offer: do not also ask in text. Without one, after opening a ready PR, offer it once in one short sentence: you can keep following it in the background, fixing CI and review feedback and telling them when it is ready or needs them. If the user answers "always" or "never", save that preference where your memory tools allow and do not ask again. Do not follow draft PRs unless asked: a draft is still being worked on. A draft's card offers "Mark ready for review" instead; the plugin converts it itself and, when the card's setting says so, then asks you to start following.

If this task has no PR card for this PR yet (for example `/pr <link>` or "follow <link>"), show one first with `pr_card` (`repo`, `pr`) when the plugin offers it, and keep its `card_id` for the schedule prompt.

Use `cindy_scheduler` (`list_tools` with category `scheduler`, then `call_tool`). First `schedule_list` without a status filter and look for a schedule whose prompt or `preRunHook.command` contains this exact PR URL (host, owner/repo and number). If one exists, keep it; do not create a second. Otherwise call `schedule_create`, filling only the placeholders:

```json
{
  "name": "PR #<number>",
  "prompt": "Follow <PR_URL> with the pr Skill (background round). Checkout: <worktree path> (branch <branch>).",
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

- Add a line to the prompt only for facts specific to this PR that cannot be derived (for example a reviewer the user named), and `PR card: <card_id>.` when there is one. General procedure lives in this Skill, not in the prompt.
- The hook is a check that ships with Cindy: mount it directly, never generate one with `schedule_set_pre_run_hook` or copy the script. Do not pass `workingDir`.
- **Model.** When the card's settings or the click event carry `follow_model`, the user chose the model for following: pass its `model_agent_kind` as `modelAgentKind`, plus `providerId`, `model`, `effort` (omit when empty) and `fastMode` from it, then confirm them in the `schedule_get` read-back. Without `follow_model`, pass none of these so each round uses this task's model. If the scheduler rejects the chosen model, say so in one line and create the schedule without it rather than guessing another.
- The hook path must be the resolved stable `<skill-dir>` (it contains `/.active/`). Never put a path under the system temp directory (for example one containing `cindy-claude-skills-`) in the hook: it disappears when Cindy restarts and every check then fails. Resolve it right before creating the schedule: run `realpath` on the base directory Cindy gave when this Skill was loaded and apply the `/.active/` rule above. If that directory no longer exists, load this Skill again for a fresh one. Never search the disk for it.
- `notify` values are JSON booleans. On `INVALID_ARGS`, fix the arguments once from the returned schema; if it fails again, report it.
- A returned id is not proof. Read it back with `schedule_get`, confirm its `preRunHook.command` points at the stable path, and confirm it appears in `schedule_list`. Tell the user in one line that following started and how to stop it ("say stop following", or the card's Stop button), and update the card with `following: true`.
- Leave `cronExpr` and `intervalMs` alone afterwards. The check paces itself: it looks at GitHub less often the longer the PR stays quiet and returns to every 10 minutes as soon as anything changes. How the check decides is described in `references/follow-up.md`.

## 5. Background round

The schedule wakes this task only when the check found something worth a look. Each round:

1. Run `node "<skill-dir>/scripts/pr-snapshot.mjs" <PR_URL>` and `node "<skill-dir>/scripts/pr-heartbeat-gate.mjs" <PR_URL> --last-result --json`. Act on both; the `detail` carries the reason, the round number and any convergence instructions, which you must follow.
2. Do the work:
   - **Technical work** (`NEEDS_WORK`, review threads, CI, conflicts, base sync): a fix round (section 3). Never just `--ack` with unresolved technical blockers.
   - **Ready, approved, or only waiting for review, approval or merge:** nothing to fix. The first time the PR becomes ready, tell the user once; afterwards stay silent. Waiting for approval or merge is not a decision for the user.
   - **Draft:** fix technical problems that do not change what is being discussed; tell the user once what the draft is waiting for, then `--defer 240`.
   - **`silence-guard`:** a periodic look at what the check cannot see. Decide whether to merge in the base, re-run, close or nudge, rather than staying silent just because nothing changed.
   - **Merged or closed:** report it in one line, then `schedule_delete` this schedule (delete, never pause), then clean up (section 6).
3. If the prompt names a PR card, refresh it before finishing: `pr_card` with `card_id`, `repo` and `pr`. It reads the current CI, review and merge state itself.
4. Finish every round with `node "<skill-dir>/scripts/pr-heartbeat-gate.mjs" <PR_URL> --ack`, or `--defer <minutes>` (which implies `--ack`) only in these cases: waiting for a user decision (240, after asking), blocked on something you cannot move (240, say what you are waiting for), or waiting for this push's bot reviewers (15, at most once per push).

**Notifications.** The schedule runs silently. Call `schedule_notify_current_run` (then write one short message) only when the user should know now: the PR became ready to merge for the first time, it was merged or closed, you need their decision, or the check reports a problem stuck for several backoff cycles. Never notify to say nothing changed, and never nag about pending approval or merge.

If the user asks to stop (the card's Stop button sends this request too), delete the schedule and update the card with `following: false`.

**Draft and ready.** When the user asks in text to mark a draft ready, run `gh pr ready <PR_URL>`, refresh the card (`pr_card` with `card_id`, `repo`, `pr`) and apply its follow setting as after opening. When they ask to turn a PR back into a draft, run `gh pr ready --undo <PR_URL>`; if it was being followed, stop following as above, then refresh the card.

## 6. Cleanup after merge or close

Run `node "<skill-dir>/scripts/pr-cleanup-plan.mjs" <PR_URL> --worktree <checkout> --fetch` from the primary checkout and follow its read-only plan:

- Only remove a worktree or local branch the plan says is safe (`canCleanupLocal`). Never delete remote branches or long-lived branches.
- `cindy_managed_worktree`: the worktree belongs to a Cindy task (including one made by `create_task_worktree`); Cindy removes it when that task is archived. Leave it.
- A dirty target worktree: list what is uncommitted and let the user decide; never stash or force-delete it.
- Closed without merging: ask the user before removing anything.
