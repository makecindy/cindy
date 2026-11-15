import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  prependCreated: vi.fn(),
  removeLocal: vi.fn(),
  purgeSession: vi.fn(),
  preview: vi.fn(),
  previewCleared: vi.fn(),
  discard: vi.fn(async () => ({ discarded: true })),
  commit: vi.fn(async () => ({ committed: true })),
}));

vi.mock('@/lib/sessionService', () => ({ create: mocks.create }));
vi.mock('@/lib/sessionsStore', () => ({
  sessionsStore: { prependCreated: mocks.prependCreated, removeLocal: mocks.removeLocal },
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { purgeSession: mocks.purgeSession } }));
vi.mock('@/lib/sessionsBus', () => ({
  emitAutoTitlePreview: mocks.preview,
  emitAutoTitlePreviewCleared: mocks.previewCleared,
}));

import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { Session } from '@/lib/ccAgent.types';
import { groupSessions } from '../lib/projectGrouping';
import { getProvisionalDraftProjectTaskId } from '../lib/provisionalDraftTaskId';

import {
  canOpenProvisionalDraftTask,
  composerDocPlainText,
  discardProvisionalDraftTask,
  ensureProvisionalDraftTask,
  previewProvisionalDraftTitle,
  ProvisionalDraftTaskBusyError,
  provisionalDraftTaskId,
  provisionalDraftTaskIdForCurrentOwner,
  resetProvisionalDraftTaskForTest,
  subscribeProvisionalDraftTask,
  takeProvisionalDraftTask,
  type ProvisionalDraftCreateArgs,
} from '../provisionalDraftTask';

const args = (patch: Partial<ProvisionalDraftCreateArgs> = {}): ProvisionalDraftCreateArgs => ({
  id: 'draft-1',
  agentKind: 'cc',
  model: 'model-a',
  effort: 'high',
  permissionMode: 'auto',
  fastMode: false,
  planModeEnabled: false,
  workingDir: '/repo',
  workspaceKind: 'project',
  extraDirs: [],
  writableDirs: [],
  providerId: null,
  ...patch,
});

describe('provisional draft task', () => {
  beforeEach(() => {
    resetProvisionalDraftTaskForTest();
    vi.clearAllMocks();
    mocks.create.mockImplementation(async (body: { id: string }) => ({ id: body.id, workingDir: '/repo' }));
    (globalThis as { window?: unknown }).window = {
      electronAPI: {
        maker: {
          discardProvisionalSession: mocks.discard,
          commitProvisionalSession: mocks.commit,
        },
      },
    };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('opens one unsent task while typing and reuses it for the same settings', async () => {
    await ensureProvisionalDraftTask(args());
    await ensureProvisionalDraftTask(args());
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1', provisional: true }));
    expect(mocks.prependCreated).toHaveBeenCalledTimes(1);
    expect(provisionalDraftTaskId()).toBe('draft-1');
  });

  it('reopens under the same id when a setting of the task changes', async () => {
    await ensureProvisionalDraftTask(args());
    await ensureProvisionalDraftTask(args({ model: 'model-b' }));
    expect(mocks.discard).toHaveBeenCalledWith('draft-1');
    expect(mocks.removeLocal).toHaveBeenCalledWith('draft-1');
    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.create.mock.calls[1]?.[0]).toMatchObject({ id: 'draft-1', model: 'model-b' });
  });

  it('deletes the task when the input is cleared', async () => {
    await ensureProvisionalDraftTask(args());
    previewProvisionalDraftTitle('Fix the login bug');
    await discardProvisionalDraftTask();
    expect(mocks.discard).toHaveBeenCalledWith('draft-1');
    expect(mocks.previewCleared).toHaveBeenCalledWith('draft-1');
    expect(provisionalDraftTaskId()).toBeNull();
  });

  it('hands the task to the send when the settings still match', async () => {
    await ensureProvisionalDraftTask(args());
    const taken = await takeProvisionalDraftTask(args());
    expect(taken?.id).toBe('draft-1');
    expect(mocks.commit).toHaveBeenCalledWith('draft-1');
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(provisionalDraftTaskId()).toBeNull();
  });

  // Unit regression for the 2026-10-23 sidebar jump: the old tests only checked
  // the final handoff, not grouping during commit or when draft identity clears.
  it('keeps the task in its project throughout the asynchronous send handoff', async () => {
    const row = await ensureProvisionalDraftTask(args()) as Session;
    const placements: string[][] = [];
    const observe = () => placements.push(groupSessions([row], {
      provisionalDraftTaskId: getProvisionalDraftProjectTaskId(),
    }).unclassified.map((s) => s.id));
    mocks.commit.mockImplementationOnce(async () => {
      observe();
      await Promise.resolve();
      observe();
      return { committed: true };
    });
    const unsubscribe = subscribeProvisionalDraftTask(observe);
    try {
      await takeProvisionalDraftTask(args());
      observe();
      expect(placements.length).toBeGreaterThan(0);
      expect(placements.every((ids) => ids.length === 0)).toBe(true);
      // Even a late pre-send snapshot stays in the project; navigation must
      // already treat the id as an ordinary task rather than redirect to /new.
      expect(provisionalDraftTaskId()).toBeNull();
      expect(groupSessions([{ ...row, userSendAt: null }], {
        provisionalDraftTaskId: getProvisionalDraftProjectTaskId(),
      }).projects[0]?.sessions[0]?.id).toBe('draft-1');
      await ensureProvisionalDraftTask(args({ id: 'draft-2' }));
      expect(getProvisionalDraftProjectTaskId()).toBe('draft-2');
      await discardProvisionalDraftTask();
      expect(getProvisionalDraftProjectTaskId()).toBeNull();
    } finally {
      unsubscribe();
    }
  });

  // Empty checks wait in the existing serial queue; resumed input must win
  // even if the timeout fired before an in-flight create finished (unit).
  it('rechecks an empty cleanup when its queued operation actually runs', async () => {
    const opening = ensureProvisionalDraftTask(args());
    let empty = true;
    const discarding = discardProvisionalDraftTask(() => empty);
    empty = false;
    await opening;
    await discarding;
    expect(provisionalDraftTaskId()).toBe('draft-1');
    expect(mocks.discard).not.toHaveBeenCalled();
  });

  it('deletes it first when the send uses different settings, so the normal create can reuse the id', async () => {
    await ensureProvisionalDraftTask(args());
    await expect(takeProvisionalDraftTask(args({ effort: 'low' }))).resolves.toBeNull();
    expect(mocks.discard).toHaveBeenCalledWith('draft-1');
    expect(mocks.commit).not.toHaveBeenCalled();
  });

  it('runs operations in order, so a send never races a half-open task', async () => {
    let release: () => void = () => {};
    mocks.create.mockImplementationOnce(
      (body: { id: string }) =>
        new Promise((resolve) => {
          release = () => resolve({ id: body.id, workingDir: '/repo' });
        }),
    );
    const opening = ensureProvisionalDraftTask(args());
    const taking = takeProvisionalDraftTask(args());
    await vi.waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.commit).not.toHaveBeenCalled();
    release();
    await opening;
    await expect(taking).resolves.toMatchObject({ id: 'draft-1' });
    expect(mocks.commit).toHaveBeenCalledWith('draft-1');
  });

  it('keeps tracking the task when it could not be deleted, instead of reopening the same id', async () => {
    await ensureProvisionalDraftTask(args());
    mocks.discard
      .mockResolvedValueOnce({ discarded: false, remaining: true } as never)
      .mockResolvedValueOnce({ discarded: false, remaining: true } as never);
    await discardProvisionalDraftTask();
    expect(provisionalDraftTaskId()).toBe('draft-1');
    expect(mocks.removeLocal).not.toHaveBeenCalled();
    // A settings change cannot reopen over the still-existing row; the next attempt retries the delete.
    await expect(ensureProvisionalDraftTask(args({ model: 'model-b' }))).resolves.toBeNull();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await ensureProvisionalDraftTask(args({ model: 'model-b' }));
    expect(mocks.create).toHaveBeenCalledTimes(2);
  });

  it('refuses a send that would recreate the same id while the old unsent task still exists', async () => {
    await ensureProvisionalDraftTask(args());
    mocks.discard.mockResolvedValueOnce({ discarded: false, remaining: true } as never);
    await expect(takeProvisionalDraftTask(args({ effort: 'low' }))).rejects.toBeInstanceOf(
      ProvisionalDraftTaskBusyError,
    );
    expect(provisionalDraftTaskId()).toBe('draft-1');
  });

  it('fails the send instead of handing over a task whose account changed while committing', async () => {
    setDataOwnerGeneration('account-a', 1);
    await ensureProvisionalDraftTask(args());
    mocks.commit.mockImplementationOnce(async () => {
      setDataOwnerGeneration('account-b', 2);
      return { committed: false };
    });
    await expect(takeProvisionalDraftTask(args())).rejects.toBeInstanceOf(ProvisionalDraftTaskBusyError);
    setDataOwnerGeneration(null, 0);
  });

  it('never hands another account\'s unsent task to a send after an account switch', async () => {
    setDataOwnerGeneration('account-a', 1);
    await ensureProvisionalDraftTask(args());
    setDataOwnerGeneration('account-b', 2);
    // A new-task page opened in the new account mints its own id instead of reusing this one.
    expect(provisionalDraftTaskIdForCurrentOwner()).toBeNull();
    await expect(takeProvisionalDraftTask(args())).resolves.toBeNull();
    expect(mocks.commit).not.toHaveBeenCalled();
    // Not deleted from the new account's database either.
    expect(mocks.discard).not.toHaveBeenCalled();
    expect(provisionalDraftTaskId()).toBeNull();
    setDataOwnerGeneration(null, 0);
  });

  it('does not open tasks for drafts that run elsewhere or need writable folders', () => {
    expect(canOpenProvisionalDraftTask(args())).toBe(true);
    expect(canOpenProvisionalDraftTask(args({ workspaceKind: 'dialogue', workingDir: undefined }))).toBe(true);
    expect(canOpenProvisionalDraftTask(args({ remoteHostId: 'ssh-1' }))).toBe(false);
    expect(canOpenProvisionalDraftTask(args({ agentDeviceId: 'other' }))).toBe(false);
    expect(canOpenProvisionalDraftTask(args({ writableDirs: ['/out'] }))).toBe(false);
    expect(canOpenProvisionalDraftTask(args({ workingDir: undefined }))).toBe(false);
  });

  it('reads the composer text for the title preview', () => {
    expect(
      composerDocPlainText({
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Fix ' }, { type: 'text', text: 'login' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'today' }] },
        ],
      }),
    ).toBe('Fix login\ntoday');
    expect(composerDocPlainText(null)).toBe('');
  });
});
