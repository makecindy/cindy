import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: 'owner-1',
  clearSessionAttention: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  client: { drizzle: {} },
  commitShareImport: vi.fn(),
  cleanupReplacedSessionMediaRefs: vi.fn(async () => undefined),
  compactSessionToolResultsBestEffort: vi.fn(async () => undefined),
  broadcastSessionPatched: vi.fn(),
  recycleSessionWorktreeForStatusChange: vi.fn(async () => undefined),
  notifyGhostSessionEvent: vi.fn(),
  assertStillValid: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      h.handlers.set(channel, handler);
    }),
  },
}));
vi.mock('../../../appBadgeService.js', () => ({
  clearSessionAttention: h.clearSessionAttention,
}));
vi.mock('../../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));
vi.mock('../../../cindy-brain/index.js', () => ({
  notifyGhostSessionEvent: h.notifyGhostSessionEvent,
}));
vi.mock('../../../session-share/sessionShareExport.js', () => ({
  exportSessionShare: vi.fn(),
}));
vi.mock('../../../session-share/sessionShareImport.js', () => ({
  cancelShareDraft: vi.fn(),
  cleanupReplacedSessionMediaRefs: h.cleanupReplacedSessionMediaRefs,
  commitShareImport: h.commitShareImport,
  inspectShareFile: vi.fn(),
  unlockShareDraft: vi.fn(),
}));
vi.mock('../../client/current.js', () => ({
  getDbClient: () => h.client,
  tryGetDbClient: () => h.client,
}));
vi.mock('../../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.owner,
  isAppSessionBoundaryPending: () => false,
}));
vi.mock('../../../cindy-media/refCompensationJournal.js', () => ({
  captureMediaRefCompensationScope: () => ({ assertStillValid: h.assertStillValid }),
}));
vi.mock('../../toolResultCompaction.js', () => ({
  compactSessionToolResultsBestEffort: h.compactSessionToolResultsBestEffort,
}));
vi.mock('../sessions.js', () => ({
  broadcastSessionPatched: h.broadcastSessionPatched,
  captureSessionRecycleScope: () => ({ ownerScope: null, mediaDb: h.client.drizzle }),
  recycleSessionWorktreeForStatusChange: h.recycleSessionWorktreeForStatusChange,
}));

describe('session share replacement compaction', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.owner = 'owner-1';
    h.handlers.clear();
    h.commitShareImport.mockResolvedValue({
      sessionId: 'replacement',
      fidelity: 'full',
      notes: [],
      orcaWorkers: [],
      replacedSessions: [{ id: 'replaced-session' }],
    });
    const { registerSessionShareIpc } = await import('../session-share.js');
    registerSessionShareIpc();
  });

  it('does not clear attention when the replacement transaction fails', async () => {
    h.commitShareImport.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(h.handlers.get('local-db:session-share:commit')?.({}, { draftId: 'draft-1', overwrite: true })).rejects.toThrow();
    expect(h.clearSessionAttention).not.toHaveBeenCalled();
  });

  it('does not clear the new owner attention if the owner changes after commit', async () => {
    h.commitShareImport.mockImplementationOnce(async () => {
      h.owner = 'owner-2';
      return { sessionId: 'replacement', replacedSessions: [{ id: 'replaced-session' }], fidelity: 'full', notes: [], orcaWorkers: [] };
    });
    await expect(h.handlers.get('local-db:session-share:commit')?.({}, { draftId: 'draft-1', overwrite: true })).rejects.toThrow();
    expect(h.clearSessionAttention).not.toHaveBeenCalled();
  });

  it('starts one best-effort compaction after the replaced task is deleted', async () => {
    const handler = h.handlers.get('local-db:session-share:commit');
    expect(handler).toBeTypeOf('function');

    await handler?.({}, { draftId: 'draft-1', overwrite: true });

    expect(h.clearSessionAttention).toHaveBeenCalledExactlyOnceWith('replaced-session', 'explicit');
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledTimes(1);
    expect(h.compactSessionToolResultsBestEffort).toHaveBeenCalledWith({
      client: h.client,
      sessionId: 'replaced-session',
    });
    expect(h.recycleSessionWorktreeForStatusChange).toHaveBeenCalledWith(
      'replaced-session',
      'deleted',
      expect.any(Object),
    );
  });
});
