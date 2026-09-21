import { describe, expect, it } from 'vitest';
import {
  buildRewindPreviewState,
  isCommitReadyRewindState,
  rewindCommitBindOpts,
} from '@/session/rewindPreview';

describe('rewindPreview model', () => {
  it('maps file rewind previews to the default confirm state', () => {
    const draftQuotes = [{ text: 'quoted context', sourcePath: 'docs/spec.md' }];
    const state = buildRewindPreviewState(
      'm2',
      'retry this',
      {
        canRewind: true,
        filesChanged: ['apps/mobile/App.tsx'],
        insertions: 3,
        deletions: 1,
      },
      draftQuotes,
      'ordered marked body',
    );

    expect(state).toEqual({
      kind: 'default',
      clientId: 'm2',
      draftText: 'retry this',
      draftQuotes,
      draftOrderedBody: 'ordered marked body',
      filesChanged: ['apps/mobile/App.tsx'],
      insertions: 3,
      deletions: 1,
    });
    expect(isCommitReadyRewindState(state)).toBe(true);
  });

  it('treats checkpoint soft failures as history-only rewind, matching desktop behavior', () => {
    const state = buildRewindPreviewState('m2', 'retry this', {
      canRewind: false,
      error: 'No file checkpoint found for this message',
      filesChanged: [],
    });

    expect(state).toEqual({
      kind: 'empty',
      clientId: 'm2',
      draftText: 'retry this',
      draftQuotes: [],
      note: 'No file checkpoint found for this message',
    });
    expect(isCommitReadyRewindState(state)).toBe(true);
  });

  it('blocks malformed preview payloads', () => {
    const state = buildRewindPreviewState('m2', 'retry this', { ok: true });

    expect(state.kind).toBe('error');
    expect(isCommitReadyRewindState(state)).toBe(false);
  });

  it('binds conversation-only confirmation so commit cannot restore files', () => {
    const empty = buildRewindPreviewState('m2', 'retry this', {
      canRewind: true,
      conversationOnly: true,
      filesChanged: [],
    });
    const withFiles = buildRewindPreviewState('m2', 'retry this', {
      canRewind: true,
      filesChanged: ['apps/mobile/App.tsx'],
    });

    expect(empty.kind).toBe('empty');
    expect(withFiles.kind).toBe('default');
    if (empty.kind !== 'empty' || withFiles.kind !== 'default') {
      throw new Error('unexpected rewind preview kinds');
    }
    expect(rewindCommitBindOpts(empty)).toEqual({ allowFileRestore: false });
    expect(rewindCommitBindOpts(withFiles)).toBeUndefined();
  });
});
