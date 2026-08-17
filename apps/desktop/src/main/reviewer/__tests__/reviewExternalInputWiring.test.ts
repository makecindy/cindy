import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(
  resolve(import.meta.dirname, '../../maker-ipc/register.ts'),
  'utf8',
);
const reviewStartSource = readFileSync(
  resolve(import.meta.dirname, '../../maker-ipc/reviewStartHandler.ts'),
  'utf8',
);

describe('Review external input wiring', () => {
  it('guards direct send/steer and every input-queue mutation at Main', () => {
    expect(registerSource).toMatch(
      /const assertRemoteInputControlBoundary[\s\S]*?await assertReviewExternalInputAllowed\(sid\);/,
    );
    for (const channel of ['INPUT_ENQUEUE', 'INPUT_STEER', 'INPUT_CLEAR_SESSION']) {
      expect(registerSource).toMatch(
        new RegExp(
          `MAKER_INVOKE\\.${channel}[\\s\\S]{0,700}await assertReviewExternalInputAllowed\\(sid\\);`,
        ),
      );
    }
  });

  it('also rejects local cross-task and Orca delivery into Review tasks', () => {
    expect(registerSource).toMatch(
      /async function sendToSessionInternal[\s\S]*?await assertReviewExternalInputAllowed\(targetSessionId\);/,
    );
    expect(registerSource).toMatch(
      /const dispatchOrEnqueueOrcaInterAgentMessage[\s\S]*?await assertReviewExternalInputAllowed\(params\.targetSessionId\);/,
    );
    expect(registerSource).toMatch(
      /const sendToAgentAccepted[\s\S]*?await assertReviewExternalInputAllowed\(sessionId\);/,
    );
    expect(registerSource).toMatch(
      /const steerToAgentAccepted[\s\S]*?await assertReviewExternalInputAllowed\(sessionId\);/,
    );
  });

  it('keeps the one allowed initial prompt on the host-only direct Session handle', () => {
    expect(reviewStartSource).toContain('const sendResult = await reviewer.send(launch.message');
    expect(reviewStartSource).not.toContain('MAKER_INVOKE.SEND');
    expect(reviewStartSource).not.toContain('MAKER_INVOKE.INPUT_ENQUEUE');
  });

  it('fingerprints reviewed evidence instead of scanning the whole workspace', () => {
    // A full-workspace content hash cannot stay inside its byte budget on a
    // real checkout, and unrelated edits must not invalidate a finished review.
    expect(registerSource).not.toContain(
      'const artifactPaths = [...reviewReadPaths, sourceWorkingDir];',
    );
    // When the change set IS the evidence, its files are bound: Git evidence
    // hashes identity, status and patches, so an ignored deliverable built by
    // the reviewed turn is covered by neither fingerprint otherwise.
    expect(registerSource).toContain(
      'const artifactPaths = [...new Set([...reviewReadPaths, ...changeSetContent.paths])];',
    );
    // A change set that cannot account for its own files is not a usable
    // baseline; publishing against it would skip the truncated remainder.
    // A Git fingerprint is not an exemption — it cannot see ignored files,
    // so a dropped entry that is an ignored deliverable is covered by neither.
    // The change set contributes nothing at all unless it is the selected
    // evidence: an unrelated turn must not refuse the review through the gate,
    // nor bind its own paths into the fingerprint and invalidate the result.
    expect(registerSource).toContain('const changeSetIsReviewed = !evidence.workspace?.dirty');
    // Matched with a regex rather than a literal: the repository checks out
    // with CRLF on Windows, so an embedded \n would never match there.
    expect(registerSource).toMatch(
      /\?\s*reviewChangeSetContentPaths\(evidence\.changeSet, sourceWorkingDir\)\s*:\s*\{ paths: \[\], truncated: false \};/,
    );
    expect(registerSource).toContain('if (changeSetContent.truncated) {');
    // The workspace fingerprint pins HEAD, not the base being compared against,
    // so both gates must recheck the branch baseline as well.
    expect(
      registerSource.match(
        /if \(!\(await reviewBranchBaselineIsCurrent\(source\.id, evidence\.branch\)\)\)/g,
      ),
    ).toHaveLength(2);
    expect(registerSource).not.toContain(
      'if (changeSetContent.truncated && !evidence.workspaceFingerprint) {',
    );
    expect(registerSource).toContain(
      'const artifactFingerprintOptions = { linkConfinementRoot: sourceWorkingDir };',
    );
    expect(registerSource).toContain('const artifactFingerprintIsCurrent = async');
    expect(registerSource).toContain('const completeArtifactFingerprintIsCurrent = ()');
    expect(
      registerSource.match(/if \(!\(await completeArtifactFingerprintIsCurrent\(\)\)\)/g),
    ).toHaveLength(2);
    expect(
      registerSource.indexOf('if (!(await completeArtifactFingerprintIsCurrent()))'),
    ).toBeLessThan(registerSource.indexOf('verifyBeforePublish: async'));
  });

  it('reports a failed branch load instead of claiming there is nothing to review', () => {
    // A context-free worktree exits before the prompt is built, so the
    // prompt-level warning never runs; without this the user is told there is
    // no work when in fact the branch could not be loaded.
    // Regex, not a literal: the repository checks out with CRLF on Windows.
    expect(registerSource).toMatch(
      /evidence\.branchUnavailableReason\s*\?\s*`Review could not load this branch's changes/,
    );
  });

  it('rechecks the exact active source identity before both launch and publish', () => {
    expect(registerSource).toContain('const readCurrentSourceIdentity = async () => {');
    expect(
      registerSource.match(
        /reviewSourceIdentityMatches\(source, await readCurrentSourceIdentity\(\)\)/g,
      ),
    ).toHaveLength(2);

    const verifyBeforeStart = registerSource.indexOf('verifyBeforeStart: async');
    const firstIdentityCheck = registerSource.indexOf(
      'reviewSourceIdentityMatches(source, await readCurrentSourceIdentity())',
      verifyBeforeStart,
    );
    const verifyBeforePublish = registerSource.indexOf('verifyBeforePublish: async');
    expect(firstIdentityCheck).toBeGreaterThan(verifyBeforeStart);
    expect(firstIdentityCheck).toBeLessThan(verifyBeforePublish);
    expect(registerSource.slice(verifyBeforeStart, verifyBeforePublish)).toContain(
      "code: 'source-workspace-changed'",
    );
  });

  it('retries failed startup reconciliation before admitting another Review', () => {
    expect(registerSource.match(/createRetryableReviewStartup\(/g)).toHaveLength(2);
    expect(registerSource).toContain('void ensureReviewStartupReady().catch(() => {});');
    expect(registerSource).toMatch(
      /waitUntilReady: async \(\) => \{\s+await ensureReviewStartupReady\(\);\s+[\s\S]*?await reconcileInterruptedReviews\(\);/,
    );
    const reconcileStart = registerSource.indexOf('const reconcileInterruptedReviews');
    const reconcileEnd = registerSource.indexOf(
      'const sourceHasPersistedRunningReview',
      reconcileStart,
    );
    const reconcileSource = registerSource.slice(reconcileStart, reconcileEnd);
    expect(reconcileSource.indexOf('patchMessageAgentMeta')).toBeLessThan(
      reconcileSource.indexOf('releaseReviewSourceLease'),
    );
  });
});
