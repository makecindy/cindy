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

  it('binds Git reviews to readable workspace content outside the Git snapshot', () => {
    expect(registerSource).toContain(
      'const artifactPaths = [...reviewReadPaths, sourceWorkingDir];',
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
    expect(registerSource).not.toContain(
      '...(evidence.workspaceFingerprint ? [] : [sourceWorkingDir])',
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
