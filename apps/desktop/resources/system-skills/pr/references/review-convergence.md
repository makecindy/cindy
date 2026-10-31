# Review convergence: failure families, checkpoints, state machines, rounds

Read this when SKILL.md points here: a checkpoint is triggered, a round number crosses 5 or 10, or a change has the shape of an async lifecycle with retries and cancellation.

Background: a real PR once took 37 review rounds, 41 commits and 74 serious findings across three bot reviewers (96 review submissions). About half of the rounds came from the process (fix one comment, push, every bot re-reviews the intermediate state); the other half came from fixes that covered only half of a symmetric path. The aim here is to converge similar PRs in five rounds or fewer.

## 1. Failure families: group feedback by invariant

Put every comment of a round into a failure family: all symptoms of one broken invariant belong to one family, whatever file, entry point or wording the reviewer used. This applies even to a single comment: attribute it to an invariant and fix every path of that invariant, including ones nobody pointed at. Common families:

- **Asymmetric settle paths:** resolve fixed but reject not; the synchronous path fixed but the late or out-of-order path not; before cancel fixed but after cancel not.
- **Late events reactivating:** after cancel or settle, a late start, callback or RPC response revives a finished lifecycle.
- **Double predicates:** one meaning ("has this turn ended?") decided in two or more places that can disagree.
- **Duplicate terminal state:** a completion, failure or cancel event can fire twice, or from two paths.
- **Control signals treated as data:** heartbeats, progress or retry hints handled as model output or business data.
- **Constraints relaxed on retry:** retry or recovery paths skip permission or precondition checks the first path enforces.

A recurrence in the same family is not a new bug; the previous fix did not cover the invariant's paths. More one-line patches only create the next round.

## 2. Convergence checkpoint: stop, produce, then fix

Triggers: (1) the previous fix missed the symmetric half (pointed out or found yourself); (2) the same semantic predicate or guard appears in a third place.

Produce all of the following before the next fix commit:

1. **One-sentence invariant** per family, decidable (for example "after cancel, no late start may reactivate").
2. **Single owner** for each state field: who writes it and its lifecycle. Collapse multiple writers first.
3. **Event × state matrix:** every event (start resolved, start rejected, timeout, cancel, close, out of order, duplicate, late…) against every state, with the expected behaviour in each cell. Empty cells are paths nobody thought about.
4. **Symmetric path audit** against the matrix.
5. **Merge predicates:** one predicate and one cleanup path per meaning, reused by every entry point.
6. **Discriminating tests:** new tests must fail against last round's half-fix. Prefer interleaving and property tests over one isolated regression test per comment.

Post the invariant list in the PR description or a pinned comment. It is the model for you, the acceptance criteria for human reviewers and an anchor for bot reviewers, whose feedback becomes noticeably more focused once invariants are explicit.

Small guards are fine when they come from a specific cell of the matrix, not from guessing at the latest comment.

## 3. Same family again after a checkpoint: escalate, stop patching

If a family recurs after the checkpoint, the model is still guesswork. Choose one, autonomously (this is a technical decision):

- extract an explicit state machine or transition reducer (section 4);
- move the responsibility to a better-placed coordinator;
- shrink the mechanism while keeping the product behaviour;
- declare scope: state in the PR description which cases this PR does not handle, reply to out-of-scope feedback and resolve it.

Splitting the PR is not a standard move. Only when none of the above works, and only after the user agrees.

Adding machinery needs the same care: if the chosen path would add concurrency, locks, caches, persistence or retries (rather than removing or consolidating), first ask whether the PR's original goal still holds without it. If it does, delete and shrink back; that is technical convergence and needs no confirmation. Only if it does not, and you decide to keep or add complex machinery, ask the user first. Reviewers comment on the code that exists, not on the requirement: code that does not exist draws no comments. (A UI fallback once grew a disk cache, then a lock for the cache's race, then a reclamation protocol for the lock; after 25 rounds the whole lock subsystem was deleted and the diff shrank from +3644 to +1091 lines before merging.)

## 4. Explicit state machines: when and how

Shape: an async lifecycle with retries or backoff, cancellation and concurrent entry points.

- One owner for the state: `Idle → Starting → Active → Backoff → Starting`, with `Cancelling` and `Settled` as side states.
- Normalise every external input into events: `startResolved`, `startRejected`, `timeout`, `turnStarted`, `outputProduced`, `overloaded`, `cancel`, `close`, `permissionChanged`, `turnCompleted`, `lateEvent`.
- One pure transition function returns the next state and the effects: interrupt or not, retry or not, write a tombstone or not, emit the terminal event or not, release the dispatch lock or not.
- Property tests against combinatorial explosion: at most one live attempt; a cancelled attempt never runs tools; exactly one terminal event per turn; an attempt that produced output is never replayed; foreign or late events never settle the current request; every accepted attempt eventually settles or enters bounded retry.

## 5. Rounds: the machine-checked details

Cross-round state is owned by the check's state file (`~/.cache/cindy-pr/<owner>__<repo>-<number>.json`), written deterministically by `pr-heartbeat-gate.mjs`: `headOid`, `roundCount`, `reviewersSeen`, `deferredHeadOid`. Do not derive these from a snapshot: its `reviews(last: 50)` window fills up with inline replies, and a defer's `nextAllowAt` is consumed by any wake-up that breaks through.

- **Reviewers to wait for:** `reviewersSeen[]` (every review author the check has seen across rounds, unaffected by the 50-review window), minus the PR author (their inline replies count as reviews) and minus humans (their timing is unpredictable).
- **Is the round complete?** Each snapshot review carries `commitOid`. The round is complete when every bot in that set has a review on `latestCommitOid`.
- **Wait at most once per push.** If the state file's `deferredHeadOid` equals the snapshot's `latestCommitOid`, this head already used its wait: whatever woke you (defer expiry, CI change, another bot's review), start fixing with the feedback you have. Bots sometimes skip a push; waiting forever would stall the PR. A new head resets the allowance.
- **Round count:** `max(state roundCount, snapshot estimate)`. The check increments `roundCount` per new head and, when it starts following an existing PR, seeds it from the number of distinct reviewed commits. The snapshot estimate is the number of distinct `commitOid` values in `reviews[]`; if the window is full (50), use the commit count (`gh pr view <PR> --json commits --jq '.commits | length'`) as a conservative upper bound.

## 6. Hard lines

- **Round 5 with new serious findings:** complete the section 2 checkpoint before fixing; from then on, group every round into families before fixing.
- **Round 10:** stop patching. Choose a section 3 path and carry it out yourself, and tell the user once: the round count, the failure families and the path chosen. Splitting the PR and adding machinery still need the user's agreement first. The question is always "what makes this PR mergeable", never "how do I answer this comment".
