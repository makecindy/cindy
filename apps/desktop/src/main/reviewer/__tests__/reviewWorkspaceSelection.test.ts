import type { IpcMainInvokeEvent } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { assertTrusted, parent, showMessageBox, showOpenDialog } = vi.hoisted(() => ({
  assertTrusted: vi.fn(),
  parent: { isDestroyed: vi.fn(() => false) },
  showMessageBox: vi.fn(),
  showOpenDialog: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => parent },
  dialog: { showMessageBox, showOpenDialog },
}));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: assertTrusted }));

import { selectReviewWorkspace, shouldSelectReviewWorkspace } from '../reviewWorkspaceSelection.js';
import type { LoadedReviewEvidence } from '../reviewEvidence.js';

function emptyEvidence(): Pick<LoadedReviewEvidence, 'workspace' | 'branch' | 'artifacts' | 'focusPath'> {
  return {
    workspace: {
      dirty: false, totalFiles: 0, stagedFiles: 0, unstagedFiles: 0, untrackedFiles: 0,
      disabledReason: null, diffs: { staged: [], unstaged: [] },
    },
    branch: null, artifacts: [], focusPath: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  parent.isDestroyed.mockReturnValue(false);
  assertTrusted.mockImplementation(() => {});
  showMessageBox.mockResolvedValue({ response: 1 });
  showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/repo/actual'] });
});

describe('Review directory selection', () => {
  const event = { sender: {} } as IpcMainInvokeEvent;

  it.each([null, 'non-git'] as const)('recovers the actual checkout from an empty %s source', async (reason) => {
    const evidence = emptyEvidence();
    evidence.workspace!.disabledReason = reason;
    expect(shouldSelectReviewWorkspace(evidence, false)).toBe(true);
    expect(await selectReviewWorkspace(event, '/projects')).toBe('/repo/actual');
  });

  it.each(['git-unavailable', 'no-workdir', 'invalid-worktree', 'remote-session', 'no-session', 'unknown'] as const)(
    'does not hide a %s failure behind a directory picker', (reason) => {
      const evidence = emptyEvidence();
      evidence.workspace!.disabledReason = reason;
      expect(shouldSelectReviewWorkspace(evidence, false)).toBe(false);
    },
  );

  it('preserves explicit targets, existing code changes, and remote caller behavior', () => {
    const evidence = emptyEvidence();
    expect(shouldSelectReviewWorkspace(evidence, true)).toBe(false);
    expect(shouldSelectReviewWorkspace({ ...evidence, workspace: null }, false)).toBe(false);
    expect(shouldSelectReviewWorkspace({ ...evidence, workspace: { ...evidence.workspace!, dirty: true } }, false)).toBe(false);
    expect(shouldSelectReviewWorkspace({ ...evidence, artifacts: [{ kind: 'file', label: 'result.ts' }] }, false)).toBe(false);
    expect(shouldSelectReviewWorkspace({ ...evidence, focusPath: '/repo/file.ts' }, false)).toBe(false);
    expect(shouldSelectReviewWorkspace({ ...evidence, branch: {
      baseRef: 'main', baseOid: 'base', mergeBaseOid: 'base', fileCount: 1, diffs: [], capped: null,
    } }, false)).toBe(false);
  });

  it('uses the directory picked in a native dialog without changing the source task', async () => {
    expect(await selectReviewWorkspace(event, '/repo/main')).toBe('/repo/actual');
    expect(assertTrusted).toHaveBeenCalledWith(event);
    expect(showMessageBox).toHaveBeenCalledWith(parent, expect.objectContaining({ detail: '/repo/main' }));
    expect(showOpenDialog).toHaveBeenCalledWith(parent, expect.objectContaining({ properties: ['openDirectory'] }));
  });

  it('lets the user explicitly review the current tree even without a diff', async () => {
    showMessageBox.mockResolvedValue({ response: 0 });
    expect(await selectReviewWorkspace(event, '/repo/main')).toBe('/repo/main');
    expect(showOpenDialog).not.toHaveBeenCalled();
  });

  it.each(['question', 'picker', 'closed-window'])('cancels cleanly at %s', async (stage) => {
    if (stage === 'question') showMessageBox.mockResolvedValue({ response: 2 });
    if (stage === 'picker') showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    if (stage === 'closed-window') parent.isDestroyed.mockReturnValue(true);
    expect(await selectReviewWorkspace(event, '/repo/main')).toBeNull();
  });

  it('rejects an untrusted caller before opening a directory picker', async () => {
    assertTrusted.mockImplementation(() => { throw new Error('untrusted renderer'); });
    await expect(selectReviewWorkspace(event, '/repo/main')).rejects.toThrow('untrusted renderer');
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(showOpenDialog).not.toHaveBeenCalled();
  });
});
