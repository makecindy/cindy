import { describe, expect, it } from 'vitest';

import {
  capabilitiesFor,
  migrateLegacyTurnTarget,
  parseReviewJumpTarget,
  parseReviewSourceDescriptor,
  type ReviewSourceDescriptor,
} from '../reviewSource';

describe('review source descriptor', () => {
  it.each<ReviewSourceDescriptor>([
    { kind: 'unstaged' },
    { kind: 'staged' },
    { kind: 'commit', commitOid: 'a'.repeat(40) },
    { kind: 'branch', baseRef: 'origin/main' },
    { kind: 'last-turn' },
    { kind: 'turn-set', targetSessionId: 'worker', changeSetIds: ['set-1'] },
  ])('round-trips a valid $kind descriptor', (descriptor) => {
    expect(parseReviewSourceDescriptor(descriptor)).toEqual(descriptor);
  });

  it('rejects unsafe or incomplete persisted descriptors', () => {
    expect(parseReviewSourceDescriptor({ kind: 'branch', baseRef: '-unsafe' })).toBeNull();
    expect(parseReviewSourceDescriptor({ kind: 'commit', commitOid: '' })).toBeNull();
    expect(
      parseReviewSourceDescriptor({
        kind: 'turn-set',
        targetSessionId: 'worker',
        changeSetIds: [],
      }),
    ).toBeNull();
    expect(parseReviewSourceDescriptor({ kind: 'unknown' })).toBeNull();
  });

  it('parses finite jump targets and rejects malformed persisted values', () => {
    expect(parseReviewJumpTarget({ diffId: null, path: 'src/a.ts', nonce: 4 })).toEqual({
      diffId: null,
      path: 'src/a.ts',
      nonce: 4,
    });
    expect(
      parseReviewJumpTarget({ diffId: 'unstaged: spaced ', path: ' spaced ', nonce: 5 }),
    ).toEqual({
      diffId: 'unstaged: spaced ',
      path: ' spaced ',
      nonce: 5,
    });
    expect(parseReviewJumpTarget({ diffId: null, path: null, nonce: Number.NaN })).toBeNull();
    expect(parseReviewJumpTarget({ diffId: null, path: null, nonce: 1.5 })).toBeNull();
    expect(parseReviewJumpTarget({ diffId: 42, path: null, nonce: 1 })).toBeNull();
  });

  it('migrates legacy turn state without retaining malformed ids', () => {
    expect(
      migrateLegacyTurnTarget({
        changeSetIds: ['set-1'],
        selectedDiffId: 'unstaged:src/a.ts',
        selectedPath: 'src/a.ts',
        requestNonce: 7,
        targetSessionId: 'worker',
      }),
    ).toEqual({
      descriptor: { kind: 'turn-set', targetSessionId: 'worker', changeSetIds: ['set-1'] },
      jumpTarget: { diffId: 'unstaged:src/a.ts', path: 'src/a.ts', nonce: 7 },
    });
    expect(
      migrateLegacyTurnTarget({
        changeSetIds: Array.from({ length: 17 }, (_, index) => String(index)),
      }),
    ).toBeNull();
    expect(
      parseReviewSourceDescriptor({
        kind: 'turn-set',
        targetSessionId: 'worker',
        changeSetIds: ['x'.repeat(257)],
      }),
    ).toBeNull();
  });
});

describe('review source capabilities', () => {
  it('keeps live git sources interactive while historical snapshots are read-only', () => {
    expect(capabilitiesFor({ kind: 'unstaged' })).toMatchObject({
      canDiscardHunk: true,
      canCommit: true,
      canPush: true,
      canRichPreview: true,
      canOpenFile: true,
      canSwitchSource: true,
      showBranchInfo: true,
    });
    expect(capabilitiesFor({ kind: 'last-turn' })).toMatchObject({
      canDiscardHunk: false,
      canCommit: true,
      canPush: true,
      canRichPreview: true,
      canOpenFile: true,
    });
    expect(
      capabilitiesFor({ kind: 'turn-set', targetSessionId: null, changeSetIds: ['set-1'] }),
    ).toEqual({
      canDiscardHunk: false,
      canCommit: false,
      canPush: false,
      canRichPreview: false,
      canOpenFile: false,
      canSwitchSource: true,
      showBranchInfo: false,
    });
  });
});
