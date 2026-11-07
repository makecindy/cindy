# iOS task content freezes or becomes transparent

## Evidence and scope (2026-11-07)

A reported incident had a working task title and composer but an empty message
area. Phone logs showed the history reaching four messages with `ready=true` and
`stale=false`; reopening loaded those messages from cache. Those logs did not
record native view attachment and cannot prove the original incident's cause.

The simulator replay reproduced a related, persistent failure during rapid task
switching: history and reveal logs reached the completed state, while the screen
kept displaying the earlier task-loading card. A read-only LLDB inspection found:

- The navigation controller had the expected top `RNSScreen` and no active
  transition coordinator.
- Its `screenView` remained in the stack's `_reactSubviews`, with live content.
- Its actual `view` was a full-screen `_UIReplicantView` snapshot. The live
  `RNSScreenView` was absent from the window hierarchy.

This establishes the simulator failure independently of network, loading-state
and opacity hypotheses. It is consistent with the original symptom, but does not
retroactively supply the missing native evidence from that phone incident.

## Cause and patch

In react-native-screens 4.26.2, `RNSScreenStackView` snapshots every Fabric child
removal. Fabric also uses Remove + Insert to reorder an existing screen within
the same stack, as task route de-duplication can do. A visible screen moved this
way keeps a snapshot as its controller view after remounting; subsequent React
updates happen off screen.

The existing dependency patch now identifies same-stack moves in the mounting
transaction and keeps their UIKit views attached. Real deletion, navigation to
another stack, and dismissal still use the existing snapshot/removal path. This
is a native fix and requires new binaries; do not present it as an OTA-only fix.
The shared dependency fingerprint can change for both platforms even though the
modified implementation is iOS-only.

An upstream report describes the analogous move/snapshot bug in newer versions
with a different snapshot implementation:
<https://github.com/software-mansion/react-native-screens/issues/5079>.
Do not copy its `addSnapshotToView` workaround into the pinned 4.26.2 code, which
uses `setViewToSnapshot` instead.

## Independent reveal-opacity failure

After the navigation fix, opening the composer on a completed replay made only
the message area blank. The keyboard and composer remained interactive. The
native hierarchy still contained the live screen, history slot and all rows;
the list's animated ancestor had `alpha = 0`. JS diagnostics continued to report
`revealed=true` and no pending reveal animation. This is a second failure, not a
remaining navigation snapshot. It more closely matches the original report.

Changing the animated list opacity to the scalar `1` after reveal did not protect
it from a later native layout. Fabric's view layer can reapply retained opacity
props during layout. The fix keeps the history itself opaque, animates an inverse
opacity cover during initial positioning, and removes that cover when reveal
settles. Delayed native writes can then affect only a detached cover, while row
and scroll state remain mounted. The native 300 ms reveal deadline remains.

The mounted `MessageRenderer` regression in
`src/__tests__/messageSourceLabelsRender.test.tsx` completes the reveal, resizes
for the keyboard and injects a late opacity-zero write at the native boundary.
It asserts that the same rows remain mounted without a transparent ancestor.
It fails before the cover change and passes after it. The older extracted scalar
opacity assertion could not detect this native failure and is replaced by this
rendered behavior test; positioning lifecycle tests remain.

## Native regression scenario

Tier: native E2E. JS-only retained-history and reveal tests cannot exercise UIKit
snapshots or Fabric mounting transactions. Use the simulator workflow in
[simulator-debugging.md](simulator-debugging.md), a matching native binary and
`--mock`. No account or real remote computer is needed.

The explicit mock task `visual-entry-replay-N` starts with empty history and
delivers three messages through the production history controller. Its final
message includes N so an old task's result cannot satisfy the assertion.

- N below 60 varies the first delivery across 0, 16, 100, 299, 301 and 1200 ms.
- N at least 20 also stalls the test JS thread for 900 ms during delivery.
- N at least 60 delays the first message for ten seconds, leaving time to switch
  while the task is empty. These timings apply only to the explicit mock task.

For each fresh N, issue these real deep links in quick succession, without
waiting for transitions between them:

1. `cindy://sessions/visual-entry-replay-N?deviceId=cindy-visual-mock-mac`
2. `cindy://sessions/session-primary?deviceId=cindy-visual-mock-mac`
3. The first link again.

Wait up to twenty seconds for **this N's** `Completed replay N.` message and
verify its frame is on screen. Capture the screen on failure before navigating
again. A successful accessibility lookup alone is insufficient: inspect the
pixels, then tap the composer and verify it opens. Also exercise native back and
return to check ordinary screen removal and retained history.

After opening the keyboard, the reply must remain visible above the composer.
If accessibility inspection returns an empty tree, do not call that a passed
text assertion: preserve the tool result and inspect a fresh screenshot and the
native view hierarchy. This occurred once in the fixed replay even though both
screenshots showed the reply above the keyboard.

Use a new suffix for every iteration; replay state lasts until the mock app
process restarts. A run that merely finds a previously completed result is not
a delivery regression test. The replay does not change the debug-recording
preference; enable recording explicitly if collecting the transition logs.

While stuck, a read-only `recursiveDescription` of the key window can distinguish
a stale page snapshot from a message host attachment problem. Inspect the top
controller's `view`, `screenView`, the stack's `_reactSubviews` and
`transitionCoordinator` together. A snapshot during an active removal animation
is expected; a snapshot replacing the still-mounted top screen after the
transition has ended is the failure.

The pre-fix investigation passed twelve unique-result delivery rounds and then
failed the rapid switch/revisit scenario. The saved failing screenshot showed a
loading card, not the original phone's empty composer screen; keep that
distinction when reporting confidence.

## Validation of this change

- The navigation fix passed ten fresh rapid-delivery replays and six fresh
  ten-second delivery replays, with a 900 ms synthetic JS stall. Native inspection
  then showed a real screen/history slot rather than a screen snapshot.
- Composer testing exposed the independent opacity failure after those passes.
- With both fixes, fresh fast and delayed-delivery replays retained their visible
  replies after opening the keyboard. Screenshots and the native hierarchy were
  checked; native back returned to the preceding task with visible content.
  A fresh rapid-switch replay in light appearance also retained the completed
  reply above the keyboard; the earlier replays used dark appearance.
- The four targeted message suites passed 116 tests; mobile TypeScript and
  simulator logcheck passed. The replay deliberately produces JS-stall warnings;
  they are test conditions, not evidence that general UI latency is resolved.
- The native dependency patch changes iOS and Android runtime fingerprints;
  the later JS cover change reuses the already-built native package. No release
  or installation on the user's phone is part of this validation.

### Remaining validation caveats

The initial repository-wide `check:test-hygiene` run stopped on an existing
baseline increase for
`packages/maker-core/src/agents/pi/__tests__/pi-extra-dirs-prompt.test.ts`
(`sourceReads: 0 -> 1`). After merging the updated main branch, the command passed
(351 files within baseline); this fix does not edit that test or its baseline.
The post-merge mobile checks also passed: the original 116 tests, 19 plugin-card
tests covering the incoming main change, and TypeScript. Standalone wall times
were 4.68 s for `messageSourceLabelsRender` and 1.68 s for `messageFollowGesture`.

One final development launch exited before its replay completed. Its native
crash report records `ExpoFabricView.swift:197: The app context has been lost`,
with two concurrent development bundle requests immediately beforehand. This is
different from the captured live-but-transparent and frozen-snapshot failures;
its cause and relationship to the changes are not established. Preserve the
crash evidence instead of counting that replay as passed. Launching the same
installed binary again, waiting for the home page, and then running a fresh
rapid-switch replay passed in light appearance, including keyboard visibility.
The development-runtime crash remains a separate follow-up, not a resolved
finding or proof about the original phone incident.
