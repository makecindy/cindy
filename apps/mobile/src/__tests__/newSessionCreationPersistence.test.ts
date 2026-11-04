import type { Dispatch, SetStateAction } from 'react';
import { prepareNewSessionCreation, newSessionCreationPreparationServices } from '@/session/prepareNewSessionCreation';
import type { NewSessionDraft } from '@/session/newSession';
import type { WorktreeCreateRequest } from '@/session/newSessionWorktree';
import { newSessionAttachment, newSessionDraft } from './fixtures/newSession';
import { beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '../auth/authOwnerGeneration';
import type { MobileMakerTransport, MobileWorktreeCreateResult } from '../device-link/mobileMakerTransport';
import type { DurableOutboxRecord } from '../session/durableOutbox';
import type { MobileLocalAttachmentUploadCandidate } from '../session/mobileLocalAttachmentUpload';
import { retainOutboxFile, durableOutboxUploadUri, removeRetainedOutboxFiles } from '../session/durableOutboxFiles';
import { cancelledCreationDraft, outboxCreationRetryIdentity } from '../session/cancelledCreationDraft';
import { buildOutboxItem } from '../session/sessionOutbox';
import { persistNewSessionCreationDraft, persistNewSessionDraftEdit } from '../session/persistNewSessionCreationDraft';
import { returnNewSessionToEdit } from '../session/returnNewSessionToEdit';
import { mergeNewSessionEditFollowUps } from '../session/mergeNewSessionEditFollowUps';
import { discardMobileUploadedAttachment } from '../session/mobileAttachmentUpload';
import { createDurableOutboxDelivery } from '../session/durableOutboxDelivery';
import type { InputProjection, QueuedRemoteMessage } from '../session/types';

const disk = vi.hoisted(() => ({ data: new Map<string, string>(), fail: false, failRemove: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getAllKeys: async () => [...disk.data.keys()],
  getItem: async (key: string) => disk.data.get(key) ?? null,
  setItem: async (key: string, value: string) => {
    if (disk.fail) throw new Error('disk unavailable');
    disk.data.set(key, value);
  },
  removeItem: async (key: string) => {
    if (disk.failRemove) throw new Error('remove unavailable');
    disk.data.delete(key);
  },
} }));
const files = vi.hoisted(() => ({ retained: new Map<string, string>(), sequence: 0, beforeCopy: async () => {} }));
vi.mock('../session/durableOutboxFiles', () => {
  const uri = (record: DurableOutboxRecord, upload: { fileName: string }) => `file:///outbox/${record.item.clientId}/${upload.fileName}`;
  return {
    durableOutboxUploadUri: uri, removeOutboxFiles: vi.fn(async () => {}),
    outboxAttachmentNeedsLocalBytes: (file: { path: string }) => file.path.startsWith('cindy-oss-attach://') || file.path.startsWith('cindy-peer-attach://'),
    retainOutboxFile: vi.fn(async (record: DurableOutboxRecord, slot: number, source: MobileLocalAttachmentUploadCandidate) => {
      await files.beforeCopy();
      const upload = { slot, fileName: `slot-${slot}-${++files.sequence}.png`, name: source.name, size: source.size, kind: source.kind };
      files.retained.set(uri(record, upload), source.uri);
      return upload;
    }),
    removeRetainedOutboxFiles: vi.fn(async (record: DurableOutboxRecord) => {
      for (const upload of record.uploads) files.retained.delete(uri(record, upload));
    }),
  };
});
vi.mock('../session/mobileAttachmentUpload', () => ({ discardMobileUploadedAttachment: vi.fn() }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(7) }));
import { getCurrentMobileOutboxRecords, mobileDurableOutbox, persistCancelledCreationDraft } from '../session/mobileDurableOutbox';
import { completeNewSessionDurableEdit, getNewSessionCreationTask, hasLiveNewSessionCreation, holdNewSessionCreationDraft, prepareNewSessionCreationForEdit, restoreNewSessionDurableEdit, startNewSessionCreation } from '../session/newSessionCreation';
import { remoteSessionStore } from '../session/remoteSessionStore';
import { listPendingPrecreatedWorktrees, recoverPendingPrecreatedWorktrees, registerPendingPrecreatedWorktree } from '../session/precreatedWorktreeRecovery';
import { completePrecreatedWorktreeRecovery } from '../session/completePrecreatedWorktreeRecovery';
import { appendNewSessionEditComposer, findNewSessionEditDraft, withNewSessionCreationRemoval } from '../session/newSessionCreation';

// Unit: call the production submission boundary with real durable storage and file retention.
// Creation-recovery rules require bytes to survive reservation failures, lost replies,
// deletion and resubmission; source fragments previously hid parser and type mismatches.
function worktreeCreatedResult(request: WorktreeCreateRequest): MobileWorktreeCreateResult {
  return { ok: true, meta: { ...request, path: '/repo/.cindy-worktrees/new', branch: 'cindy/new',
    createdAt: '2026-10-23T00:00:00.000Z' } };
}

beforeEach(async () => {
  setMobileAuthOwner(null);
  remoteSessionStore.clear();
  await mobileDurableOutbox.activate('');
  disk.data.clear();
  disk.fail = false;
  vi.mocked(discardMobileUploadedAttachment).mockClear();
  disk.failRemove = false;
  files.retained.clear();
  files.sequence = 0;
  files.beforeCopy = async () => {};
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
});

function harness(previous: DurableOutboxRecord | null = null) {
  let sequence = 0;
  const draft = newSessionDraft({ agentKind: 'codex', workspaceKind: 'project', workingDir: '/repo', model: 'model',
    providerId: null, effort: 'high', permissionMode: 'ask', fastMode: false, firstMessage: 'keep my input' });
  const bindings = {
    effectiveDraft: { ...draft, ...previous?.creation?.draft },
    outboxRecoveryRef: { current: previous },
    getCurrentMobileOutboxRecords, mobileDurableOutbox, outboxCreationRetryIdentity, buildOutboxItem,
    selectedDeviceId: 'pc', selectedDeviceName: 'PC', authOwnerAtCreate: getMobileAuthOwner(),
    worktreeAccountId: 'alice', creatingWorktree: true,
    worktreeIntent: { applicable: true, enabled: true, eligibility: { status: 'eligible' as const, baseRepo: '/repo', sourceBranch: 'main' }, sourceBranch: 'main',
      target: { deviceId: 'pc', workingDir: '/repo' }, branchPreferenceKey: 'pc/repo', branchPreferenceSyncKey: 'generation' },
    isCurrentOwner: () => true, ensureDeviceAlive: () => true, isWorktreeCreateIntentCurrent: () => true,
    createNewSessionId: () => `session-${++sequence}`, createOutboxClientId: () => 'message',
    runtimeOptions: { permissionOptions: [] }, prePlanPermissionModeRef: { current: null },
    planModeCapability: false, planModeDraftOn: false,
    holdNewSessionCreationDraft, holdPrecreatedWorktreeRegistration: () => () => {},
    sendAttachments: [newSessionAttachment()],
    attachmentPreviews: {}, getUploadedSource: (_id: string): MobileLocalAttachmentUploadCandidate | undefined => ({ uri: 'file:///photo.png', name: 'photo.png', size: 3, kind: 'image' }),
    persistNewSessionCreationDraft,
    removeRetainedOutboxFiles, releaseUploadedSources: vi.fn(),
    outboxAttachmentNeedsLocalBytes: () => true,
    registerPendingPrecreatedWorktree: vi.fn(async (..._args: Parameters<typeof registerPendingPrecreatedWorktree>) => true), forgetPendingPrecreatedWorktree: vi.fn(),
    maker: { getSession: vi.fn(async () => null), worktree: {
      suggestName: vi.fn(async () => ({ name: 'new' })),
      create: vi.fn(async (request: WorktreeCreateRequest): Promise<MobileWorktreeCreateResult> => worktreeCreatedResult(request)),
      discardPrecreated: vi.fn(async () => ({ discarded: true as const })),
    } },
    t: (key: string) => key, setError: vi.fn(), setDraft: vi.fn<Dispatch<SetStateAction<NewSessionDraft>>>(),
    resolveWorktreeCreateErrorKey: () => 'session.new.worktreeDetectFailed',
  };
  const run = async () => {
    const releases: Array<() => void> = [];
    try {
      return await prepareNewSessionCreation({
        ...bindings, onHoldDurableCreation: release => releases.push(release),
        onHoldPrecreatedRegistration: release => releases.push(release),
      }, { ...newSessionCreationPreparationServices, ...bindings });
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
  return { bindings, run };
}

it.each(['reservation-fails', 'create-rejected', 'reply-lost', 'leaves-during-create'] as const)(
  'keeps the latest restored draft reachable when resubmission stops before handoff: %s', async scenario => {
    await harness().run();
    const original = getCurrentMobileOutboxRecords()[0];
    const previous = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
    restoreNewSessionDurableEdit(previous);
    const leaveForm = completeNewSessionDurableEdit(previous.item.sessionId, previous.deviceId)!;
    const h = harness(previous);
    h.bindings.createNewSessionId = () => 'replacement-session';
    h.bindings.effectiveDraft.firstMessage = 'updated input before retry';
    if (scenario === 'reservation-fails') h.bindings.registerPendingPrecreatedWorktree.mockResolvedValueOnce(false);
    else if (scenario === 'create-rejected') h.bindings.maker.worktree.create.mockResolvedValueOnce({ ok: false, error: { kind: 'failure', message: 'worktree failed' } });
    else if (scenario === 'reply-lost') {
      h.bindings.registerPendingPrecreatedWorktree.mockImplementation(registerPendingPrecreatedWorktree);
      h.bindings.maker.worktree.create.mockRejectedValueOnce(new Error('reply lost'));
    } else {
      h.bindings.maker.worktree.create.mockImplementationOnce(async () => {
        leaveForm();
        expect(getNewSessionCreationTask('replacement-session')).toBeNull();
        expect(hasLiveNewSessionCreation('replacement-session')).toBe(true);
        expect(remoteSessionStore.getSessions()).toEqual([]);
        return { ok: false, error: { kind: 'failure', message: 'worktree failed' } };
      });
    }
    await h.run();
    if (scenario !== 'leaves-during-create') {
      // The claim follows record replacement, so an open editor keeps exclusivity.
      expect(getNewSessionCreationTask('replacement-session')).toBeNull();
      expect(remoteSessionStore.getSessions()).toEqual([]);
      leaveForm();
    }
    expect(h.bindings.setError).toHaveBeenCalledOnce();
    expect(getNewSessionCreationTask(previous.item.sessionId)).toBeNull();
    expect(getNewSessionCreationTask('replacement-session')).toMatchObject({ readyForEdit: 'durable',
      draft: { firstMessage: 'updated input before retry' }, attachments: [{ id: 'photo' }] });
    expect(remoteSessionStore.getSessions()).toEqual([]);
    expect(hasLiveNewSessionCreation('replacement-session')).toBe(false);

    if (scenario === 'reply-lost') {
      const result = await recoverPendingPrecreatedWorktrees(getMobileAuthOwner().accountId, {
        openLink: async () => {}, discardPrecreated: async () => ({ discarded: true }),
        cancelPrecreated: async () => ({ discarded: true }), isSessionClaimed: async () => false,
        shouldDefer: record => hasLiveNewSessionCreation(record.sessionId),
        onDiscarded: completePrecreatedWorktreeRecovery,
      });
      expect(result.recovered).toBe(1);
      expect(await listPendingPrecreatedWorktrees(getMobileAuthOwner().accountId)).toEqual([]);
    }

    // Only the replacement is persisted; a cold process can still restore its latest text and attachments.
    await mobileDurableOutbox.activate('');
    await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
    const saved = getCurrentMobileOutboxRecords()[0];
    expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
    expect(saved).toMatchObject({ storageSessionId: original.item.sessionId, suspended: true, state: 'failed',
      creation: { editReady: true, draft: { firstMessage: 'updated input before retry', workingDir: '/repo' } },
      item: { sessionId: 'replacement-session', clientId: original.item.clientId, attachmentSlots: [{ id: 'photo' }] },
      uploads: [{ slot: 0, name: 'photo.png', fileName: expect.stringMatching(/^slot-0-\d+\.png$/) }] });
    expect(getNewSessionCreationTask('replacement-session')?.readyForEdit).toBe('durable');
    const leaveReopenedForm = completeNewSessionDurableEdit('replacement-session', 'pc');
    expect(getNewSessionCreationTask('replacement-session')).toBeNull();
    leaveReopenedForm!();
    expect(getNewSessionCreationTask('replacement-session')?.readyForEdit).toBe('durable');
  });

it.each(['switch-during-cleanup', 'suspend-fails'] as const)('persists the send fence before cleanup: %s', async scenario => {
  await harness().run();
  const saved = getCurrentMobileOutboxRecords()[0];
  const owner = getMobileAuthOwner();
  const recoveryKey = 'recovery-key-account-switch-1234';
  const ledger = { sessionId: saved.item.sessionId, deviceId: saved.deviceId,
    path: saved.creation!.draft.workingDir, recoveryKey, createdAt: Date.now(), phase: 'precreated' as const };
  await registerPendingPrecreatedWorktree(owner.accountId, ledger);
  let finishDiscard!: (ack: { discarded: true }) => void;
  const discard = vi.fn(() => {
    const persisted = [...disk.data.values()].map(raw => JSON.parse(raw))
      .find(value => value.item?.sessionId === saved.item.sessionId);
    expect(persisted.suspended).toBe(true);
    expect(persisted.creation.cancelled).toBeUndefined();
    return new Promise<{ discarded: true }>(resolve => { finishDiscard = resolve; });
  });
  startNewSessionCreation({
    sessionId: saved.item.sessionId, deviceId: saved.deviceId, deviceName: 'PC',
    draft: saved.creation!.draft, attachments: [], planModeArm: false, legacyPlanRestore: null,
    precreatedWorktree: { path: ledger.path, recoveryKey, originalWorkingDir: '/repo', createdAt: ledger.createdAt },
    precreatedWorktreeAccountId: owner.accountId,
    confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    authGateHint: 'not authenticated', onUnauthenticated: () => {},
    transport: { openLink: async () => {}, subscribe: async () => {},
      maker: { worktree: { discardPrecreated: discard } } as unknown as MobileMakerTransport },
  });
  await vi.waitFor(() => expect(getNewSessionCreationTask(saved.item.sessionId)?.status).toBe('create-failed'));
  if (scenario === 'suspend-fails') disk.fail = true;
  const pending = prepareNewSessionCreationForEdit(saved.item.sessionId);
  if (scenario === 'suspend-fails') {
    await expect(pending).rejects.toThrow('disk unavailable');
    expect(discard).not.toHaveBeenCalled();
    expect(getCurrentMobileOutboxRecords()[0].suspended).toBe(false);
    expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([ledger]);
    disk.fail = false;
    return;
  }
  await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
  setMobileAuthOwner('bob', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const bobRecord = { ...saved, accountId: getMobileAuthOwner().accountKey };
  await mobileDurableOutbox.add(bobRecord);
  const diskBeforeReply = new Map(disk.data);
  finishDiscard({ discarded: true });
  await expect(pending).resolves.toBeNull();
  expect(getNewSessionCreationTask(saved.item.sessionId)).toBeNull();
  expect(getCurrentMobileOutboxRecords()).toEqual([bobRecord]);
  expect(disk.data).toEqual(diskBeforeReply);
  expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([ledger]);

  // A cold reload after switching back must not make the old path sendable.
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, creation: { draft: saved.creation!.draft } });
  expect(getNewSessionCreationTask(saved.item.sessionId)).toBeNull();
  const result = await recoverPendingPrecreatedWorktrees(owner.accountId, {
    openLink: async () => {}, discardPrecreated: async () => ({ discarded: true }),
    cancelPrecreated: async () => ({ discarded: true }), isSessionClaimed: async () => false,
    shouldDefer: record => getNewSessionCreationTask(record.sessionId) !== null,
    onDiscarded: completePrecreatedWorktreeRecovery,
  });
  expect(result.recovered).toBe(1);
  expect(await listPendingPrecreatedWorktrees(owner.accountId)).toEqual([]);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, state: 'failed',
    creation: { cancelled: true, draft: { workingDir: '/repo' } }, item: saved.item, uploads: saved.uploads });
  expect(getNewSessionCreationTask(saved.item.sessionId)?.readyForEdit).toBe('durable');
});

it('persists the draft and attachments before reserving and dispatching worktree creation', async () => {
  const h = harness();
  h.bindings.registerPendingPrecreatedWorktree.mockImplementation(async () => {
    const saved = [...disk.data.values()].map((value) => JSON.parse(value) as DurableOutboxRecord)[0];
    expect(saved).toMatchObject({ suspended: true, item: { text: 'keep my input' },
      creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo' } },
      uploads: [{ slot: 0, name: 'photo.png', fileName: expect.stringMatching(/^slot-0-\d+\.png$/) }] });
    return true;
  });
  await h.run();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledOnce();
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: false,
    creation: { originalWorkingDir: '/repo', draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
});

it('recovers the input after a lost create reply and cold outbox activation', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockRejectedValueOnce(new Error('reply lost'));
  await h.run();
  expect(h.bindings.setError).toHaveBeenCalledWith('session.new.worktreeCleanupPending');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true, state: 'failed',
    item: { text: 'keep my input', attachmentSlots: [{ id: 'photo' }] },
    uploads: [{ slot: 0, name: 'photo.png', fileName: expect.stringMatching(/^slot-0-\d+\.png$/) }],
    creation: { cancelled: true, draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
});

it('does not reserve or dispatch a worktree if saving its draft fails', async () => {
  const h = harness();
  disk.fail = true;
  await expect(h.run()).rejects.toThrow('disk unavailable');
  expect(h.bindings.registerPendingPrecreatedWorktree).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(h.bindings.removeRetainedOutboxFiles).toHaveBeenCalledOnce();
});

it('keeps the original durable input when patching the successful worktree path fails', async () => {
  const h = harness();
  h.bindings.maker.worktree.create.mockImplementationOnce(async (request) => {
    disk.fail = true;
    return worktreeCreatedResult(request);
  });
  await expect(h.run()).rejects.toThrow('disk unavailable');
  disk.fail = false;
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: true,
    creation: { draft: { workingDir: '/repo', firstMessage: 'keep my input' } } });
  await persistCancelledCreationDraft({ sessionId: 'session-1', deviceId: 'pc' });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it.each([true, false])('reprobes a restored directory instead of submitting old eligibility (enabled=%s)', async (enabled) => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  Object.assign(h.bindings.worktreeIntent, { enabled, eligibility: { status: 'ineligible', reason: 'alreadyInWorktree' } });
  h.bindings.creatingWorktree = false;
  expect(await h.run()).toBeUndefined();
  expect(h.bindings.setDraft).toHaveBeenCalledOnce();
  const update = h.bindings.setDraft.mock.calls[0][0];
  const restored = typeof update === 'function' ? update(h.bindings.effectiveDraft) : update;
  expect(restored).toMatchObject({ workingDir: '/repo', firstMessage: 'keep my input' });
  expect(h.bindings.maker.getSession).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBe(true);
});

it('retries a cancelled draft under one durable key and patches its new worktree path', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  const cancelled = await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(cancelled);
  h.bindings.createNewSessionId = () => 'retry-session';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ storageSessionId: 'session-1',
    item: { sessionId: 'retry-session', clientId: 'message' }, suspended: true,
    creation: { editReady: true, draft: { workingDir: '/repo/.cindy-worktrees/new' } } });
  expect(getCurrentMobileOutboxRecords()[0].creation?.cancelled).toBeUndefined();
});

it.each([false, true])('transfers restored draft ownership before host creation (save fails: %s)', async saveFails => {
  await harness().run();
  const original = getCurrentMobileOutboxRecords()[0];
  const previous = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const leaveForm = completeNewSessionDurableEdit(previous.item.sessionId, previous.deviceId)!;
  const h = harness(previous);
  h.bindings.createNewSessionId = () => 'retry-handoff';
  await h.run();
  const record = getCurrentMobileOutboxRecords()[0];
  expect(record.suspended).toBe(true);
  expect(getNewSessionCreationTask('retry-handoff')).toBeNull();
  disk.fail = saveFails;
  const openLink = vi.fn(async () => {
    const saved = getCurrentMobileOutboxRecords()[0];
    expect(saved).toMatchObject({ suspended: false, state: 'queued' });
    expect(saved.creation?.editReady).toBeUndefined();
  });
  startNewSessionCreation({
    sessionId: record.item.sessionId, firstMessageClientId: record.item.clientId,
    deviceId: record.deviceId, deviceName: 'PC', draft: record.creation!.draft,
    attachments: [], planModeArm: false, legacyPlanRestore: null,
    confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    authGateHint: 'not authenticated', onUnauthenticated: () => {},
    transport: { openLink, subscribe: async () => {}, handoffFirstMessage: async () => {},
      maker: {} as MobileMakerTransport },
  });
  leaveForm();
  await vi.waitFor(() => expect(getNewSessionCreationTask('retry-handoff')?.status).toBe('create-failed'));
  expect(openLink).toHaveBeenCalledTimes(saveFails ? 0 : 1);
  expect(getCurrentMobileOutboxRecords()[0]).toMatchObject({ suspended: saveFails, state: saveFails ? 'failed' : 'queued' });
  expect(getCurrentMobileOutboxRecords()[0].creation?.editReady).toBe(saveFails ? true : undefined);
  disk.fail = false;
  setMobileAuthOwner(null);
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  if (saveFails) expect(getNewSessionCreationTask('retry-handoff')?.readyForEdit).toBe('durable');
  else expect(getNewSessionCreationTask('retry-handoff')).toBeNull();
});

it('preserves a directory explicitly selected by the user while cancellation completes', async () => {
  await harness().run();
  const previous = getCurrentMobileOutboxRecords()[0];
  await mobileDurableOutbox.update(previous, cancelledCreationDraft(previous));
  const h = harness(previous);
  h.bindings.effectiveDraft.workingDir = '/other-repo';
  h.bindings.worktreeIntent.eligibility.baseRepo = '/other-repo';
  h.bindings.createNewSessionId = () => 'user-retry';
  await h.run();
  expect(h.bindings.setDraft).not.toHaveBeenCalled();
  expect(h.bindings.maker.worktree.create).toHaveBeenCalledWith(expect.objectContaining({
    baseRepo: '/other-repo',
  }));
  expect(getCurrentMobileOutboxRecords()[0].creation?.originalWorkingDir).toBe('/other-repo');
});

// Regression: deleting only the mirror let the durable bridge recreate an
// undeletable task. Exercise the production removal with real persisted bytes.
async function saveDraftFixture() {
  const draft = { agentKind: 'codex' as const, workspaceKind: 'project' as const,
    workingDir: '/repo', model: 'model', providerId: null, effort: 'high',
    permissionMode: 'ask', fastMode: false, firstMessage: 'keep my input' };
  return (await persistNewSessionCreationDraft({
    record: { version: 1, accountId: getMobileAuthOwner().accountKey, deviceId: 'pc', createdAt: 1,
      state: 'queued', uploads: [], creation: { draft, originalWorkingDir: '/repo', deviceName: 'PC', planModeArm: false, restorePermissionMode: null },
      item: buildOutboxItem({ clientId: 'message', sessionId: 'session-1', text: draft.firstMessage,
        permissionModeAtSend: 'ask', quotesEncoded: false, agentReferences: [], pastedTextRanges: [], slashCommandRanges: [],
        readyAttachments: [{ id: 'photo', path: 'cindy-oss-attach://photo', name: 'photo.png', ext: 'png', size: 3, category: 'image', mimeType: 'image/png' }],
        readyPreviews: [], claimedUploads: [] }),
    },
    recovering: null, isCurrent: () => true,
    getUploadedSource: () => ({ uri: 'file:///photo.png', name: 'photo.png', size: 3, kind: 'image' }),
  }))!;
}

// Unit regression for manual edits after recovery (2026-10-17): the old form
// changed only React state, so reopening restored deleted text and attachments.
// Real store + production edit entry cover persistence and ordered writes here;
// the React hook suite covers the form handoff, which prior removal tests miss.
it('persists rapid partial deletion and attachment removal before resubmit and cold recovery', async () => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const leave = completeNewSessionDurableEdit(saved.item.sessionId, 'pc')!;
  await Promise.all([
    persistNewSessionDraftEdit(saved, { firstMessage: 'keep my' }),
    persistNewSessionDraftEdit(saved, { removeAttachmentId: 'photo' }),
    persistNewSessionDraftEdit(saved, { firstMessage: 'keep' }),
  ]);
  leave();
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const recovered = findNewSessionEditDraft('pc')!;
  expect(recovered.creation?.draft.firstMessage).toBe('keep');
  expect(recovered.item.text).toBe('keep');
  expect(recovered.item.attachmentSlots).toEqual([]);
  expect(recovered.item.slotMeta).toEqual([]);
  expect(recovered.uploads).toEqual([]);
  expect(files.retained.size).toBe(0);
  const submitted = await persistNewSessionCreationDraft({ record: recovered, recovering: recovered,
    getUploadedSource: () => undefined, isCurrent: () => true });
  expect(submitted?.item.text).toBe('keep');
  expect(submitted?.uploads).toEqual([]);
});

it('removes one recovered attachment while preserving the remaining bytes and upload slot on resubmit', async () => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  await saveFollowUpFixture(first);
  const merged = (await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc'))!;
  const deletedUri = durableOutboxUploadUri(merged, merged.uploads[0]);
  const keptUri = durableOutboxUploadUri(merged, merged.uploads[1]);
  const edited = (await persistNewSessionDraftEdit(merged, { removeAttachmentId: 'photo' }))!;
  expect(edited.item.attachmentSlots.map(a => a?.id)).toEqual(['second-photo']);
  expect(edited.uploads[0].slot).toBe(0);
  expect(files.retained.has(deletedUri)).toBe(false);
  expect(files.retained.has(keptUri)).toBe(true);
  const resent = (await persistNewSessionCreationDraft({ record: edited, recovering: edited,
    getUploadedSource: () => undefined, isCurrent: () => true }))!;
  expect(resent.uploads).toHaveLength(1);
  expect(files.retained.get(durableOutboxUploadUri(resent, resent.uploads[0]))).toBe(keptUri);
});

it.each(['text-first', 'attachment-first'] as const)('clearing recovered input deletes the record, including late edits and cold reload: %s', async order => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const leave = completeNewSessionDurableEdit(saved.item.sessionId, 'pc')!;
  const changes = [{ firstMessage: '' }, { removeAttachmentId: 'photo' }];
  if (order === 'attachment-first') changes.reverse();
  await Promise.all(changes.map(change => persistNewSessionDraftEdit(saved, change)));
  expect(await persistNewSessionDraftEdit(saved, { firstMessage: 'late edit' })).toBeNull();
  leave();
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(mobileDurableOutbox.getSnapshot()).toEqual([]);
  expect(disk.data.size).toBe(0);
  expect(files.retained.size).toBe(0);
  expect(findNewSessionEditDraft('pc')).toBeUndefined();
  expect(getNewSessionCreationTask(saved.item.sessionId)).toBeNull();
});

it.each(['save', 'remove'] as const)('reports failed draft %s without deleting still-owned bytes', async failure => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const empty = await persistNewSessionDraftEdit(saved, { firstMessage: '' });
  disk.fail = failure === 'save';
  disk.failRemove = failure === 'remove';
  await expect(persistNewSessionDraftEdit(empty!, failure === 'save'
    ? { firstMessage: 'changed' } : { removeAttachmentId: 'photo' })).rejects.toThrow('unavailable');
  expect(mobileDurableOutbox.getSnapshot()[0]).toBe(empty);
  expect(files.retained.size).toBe(1);
  disk.fail = false;
  disk.failRemove = false;
  const submitted = await persistNewSessionCreationDraft({ recovering: empty,
    record: { ...empty!, creation: { ...empty!.creation!, draft: { ...empty!.creation!.draft, firstMessage: 'current form' } },
      item: { ...empty!.item, text: 'current form', attachmentSlots: [], slotMeta: [] } },
    getUploadedSource: () => undefined, isCurrent: () => true });
  expect(submitted?.item.text).toBe('current form');
  expect(submitted?.uploads).toEqual([]);
});

it.each(['account', 'deleted', 'handed-off'] as const)('does not edit or recreate records after %s', async change => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  if (change === 'deleted') await mobileDurableOutbox.remove(saved);
  if (change === 'handed-off') await mobileDurableOutbox.update(saved, { suspended: false, state: 'queued' });
  const pending = persistNewSessionDraftEdit(saved, { firstMessage: '' });
  if (change === 'account') setMobileAuthOwner('bob');
  if (change === 'deleted') await expect(pending).resolves.toBeNull();
  else await expect(pending).rejects.toThrow(change === 'account' ? 'OUTBOX_OWNER_CHANGED' : 'OUTBOX_STALE_WRITE');
  expect(mobileDurableOutbox.getSnapshot()[0]?.item.text).toBe(change === 'deleted' ? undefined : saved.item.text);
});

it.each(['deleted', 'archived'])('retires saved recovery on %s, including editor release and cold reload', async status => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  expect(findNewSessionEditDraft('pc', '/repo')).toEqual(saved);
  expect(findNewSessionEditDraft('other-pc')).toBeUndefined();
  expect(findNewSessionEditDraft('pc', '/other-repo')).toBeUndefined();
  const leave = completeNewSessionDurableEdit(saved.item.sessionId, 'pc')!;
  expect(findNewSessionEditDraft('pc')).toBeUndefined();
  const remote = vi.fn();
  await withNewSessionCreationRemoval(saved.item.sessionId, 'pc', status, remote);
  leave();
  expect(remote).not.toHaveBeenCalled();
  expect(getCurrentMobileOutboxRecords()).toEqual([]);
  expect(mobileDurableOutbox.getSnapshot()[0].cleanupOutcome).toBe('cancelled');
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(restoreNewSessionDurableEdit(mobileDurableOutbox.getSnapshot()[0])).toBe(false);
  expect(findNewSessionEditDraft('pc')).toBeUndefined();
  expect(remoteSessionStore.getSessions()).toEqual([]);
});

it('keeps a saved draft if durable deletion fails', async () => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  disk.fail = true;
  await expect(withNewSessionCreationRemoval(saved.item.sessionId, 'pc', 'deleted', vi.fn())).rejects.toThrow('disk unavailable');
  disk.fail = false;
  expect(findNewSessionEditDraft('pc')).toEqual(saved);
});

it.each([false, true])('preserves the current composer in the durable recovery before handoff (save fails: %s)', async fails => {
  const original = await saveDraftFixture();
  const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const file = { ...saved.item.attachmentSlots[0]!, id: 'new-file', name: 'new.png', path: 'cindy-oss-attach://new' };
  disk.fail = fails;
  const transfer = appendNewSessionEditComposer(saved.item.sessionId, 'pc', {
    text: 'also keep my unsent input', attachments: [file], notice: 'one upload needs to be selected again',
    getUploadedSource: () => ({ uri: 'file:///composer/new.png', name: 'new.png', size: 3, kind: 'image' }),
  });
  if (fails) {
    await expect(transfer).rejects.toThrow('disk unavailable');
    expect(getCurrentMobileOutboxRecords()[0]).toEqual(saved);
    expect(files.retained.size).toBe(1); // Only the pre-existing first attachment survives rollback.
    disk.fail = false;
    return;
  }
  expect(await transfer).toEqual([]);
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const restored = findNewSessionEditDraft('pc')!;
  expect(restored.creation?.draft.firstMessage).toBe('keep my input\n\nalso keep my unsent input');
  expect(restored.creation?.notice).toBe('one upload needs to be selected again');
  expect(restored.item.attachmentSlots.map(file => file?.id)).toEqual(['photo', 'new-file']);
  expect(restored.uploads[0]).toEqual(saved.uploads[0]);
  expect(restored.uploads[1]).toMatchObject({ slot: 1, name: 'new.png', size: 3, kind: 'image' });
  expect(restored.item.slotMeta).toHaveLength(2);
  const resubmitted = await persistNewSessionCreationDraft({
    record: { ...restored, item: { ...restored.item, sessionId: 'resubmitted' }, storageSessionId: restored.item.sessionId },
    recovering: restored, isCurrent: () => true,
    getUploadedSource: () => undefined, // Old chat has unmounted; only durable bytes remain.
  });
  expect(getCurrentMobileOutboxRecords()).toEqual([resubmitted]);
  expect(resubmitted?.uploads).toHaveLength(2);
  expect(resubmitted?.item.text).toBe(restored.item.text);
  expect(retainOutboxFile).toHaveBeenCalledWith(expect.anything(), 1, expect.objectContaining({
    uri: durableOutboxUploadUri(restored, restored.uploads[1]), name: 'new.png',
  }));
});

// Regression: incomplete/late attachment transfers must not replace recovery or
// leak newly retained copies. The original draft and its bytes stay intact.
it.each(['copy-fails', 'missing-source', 'deleted', 'account-change'] as const)(
  'rolls back only new attachment copies when composer transfer cannot finish: %s', async outcome => {
    const original = await saveDraftFixture();
    const saved = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
    const retainedBefore = new Map(files.retained);
    const attachments = ['one', 'two'].map(id => ({ ...saved.item.attachmentSlots[0]!, id,
      path: `cindy-peer-attach://${id}` }));
    let copies = 0;
    files.beforeCopy = async () => {
      if (++copies !== 2) return;
      if (outcome === 'copy-fails') throw new Error('copy unavailable');
      if (outcome === 'deleted') {
        await withNewSessionCreationRemoval(saved.item.sessionId, 'pc', 'deleted', vi.fn());
      }
      if (outcome === 'account-change') {
        setMobileAuthOwner('bob', 'global');
        await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
      }
    };
    const transfer = appendNewSessionEditComposer(saved.item.sessionId, 'pc', {
      text: 'unsent', attachments,
      getUploadedSource: id => outcome === 'missing-source' && id === 'two' ? undefined
        : { uri: `file:///composer/${id}.png`, name: `${id}.png`, size: 3, kind: 'image' },
    });
    await expect(transfer).rejects.toThrow();
    expect(files.retained).toEqual(retainedBefore);
    if (outcome === 'account-change') {
      expect(getCurrentMobileOutboxRecords()).toEqual([]);
      setMobileAuthOwner('alice', 'global');
      await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
    }
    if (outcome === 'deleted') {
      expect(findNewSessionEditDraft('pc')).toBeUndefined();
      expect(mobileDurableOutbox.getSnapshot()[0].cleanupOutcome).toBe('cancelled');
    } else {
      expect(getCurrentMobileOutboxRecords()).toEqual([saved]);
    }
  });

it.each(['success', 'not-found', 'network-error', 'superseded', 'account-change'] as const)(
  'retires outbox recovery only after authoritative removal: %s', async outcome => {
    await saveDraftFixture();
    const saved = await mobileDurableOutbox.update(getCurrentMobileOutboxRecords()[0], { state: 'failed' });
    let current = true;
    const remove = vi.fn(async () => {
      if (outcome === 'superseded') current = false;
      if (outcome === 'account-change') setMobileAuthOwner('bob', 'global');
      if (outcome === 'not-found') throw new Error('[NOT_FOUND] missing');
      if (outcome === 'network-error') throw new Error('offline');
      return { id: saved.item.sessionId };
    });
    const result = withNewSessionCreationRemoval(saved.item.sessionId, 'pc', 'deleted', remove, () => current);
    if (outcome === 'not-found') await expect(result).rejects.toThrow('NOT_FOUND');
    else if (outcome === 'network-error') await expect(result).rejects.toThrow('offline');
    else if (outcome === 'account-change') await expect(result).rejects.toThrow('STALE_AUTH_OWNER');
    else await result;
    expect(remove).toHaveBeenCalledOnce();
    expect(mobileDurableOutbox.getSnapshot()[0].cleanupOutcome).toBe(
      outcome === 'success' || outcome === 'not-found' ? 'cancelled' : undefined);
  });

it('persists the real creation error through return to edit and cold recovery', async () => {
  const record = await saveDraftFixture();
  // P1 #6281: a second send used a separate ledger row which recovery ignored.
  // Unit: actual return-to-edit must preserve that message before navigation.
  await mobileDurableOutbox.add({ ...record, creation: undefined, uploads: [], createdAt: 2,
    item: { ...record.item, clientId: 'follow-up', text: 'second message', attachmentSlots: [], slotMeta: [] } });
  startNewSessionCreation({
    sessionId: record.item.sessionId, firstMessageClientId: record.item.clientId,
    deviceId: record.deviceId, deviceName: 'PC', draft: record.creation!.draft,
    attachments: [], planModeArm: false, legacyPlanRestore: null,
    confirmUnauthenticated: async () => ({ unauthenticated: true, fresh: null }),
    authGateHint: 'Provider setup required', onUnauthenticated: () => {},
    transport: { openLink: async () => {}, subscribe: async () => {}, handoffFirstMessage: async () => {},
      maker: {} as MobileMakerTransport },
  });
  await vi.waitFor(() => expect(getNewSessionCreationTask(record.item.sessionId)?.status).toBe('create-failed'));
  await returnNewSessionToEdit({ sessionId: record.item.sessionId, deviceId: record.deviceId,
    isCurrent: () => true, onReady: () => {} });
  expect(getCurrentMobileOutboxRecords()[0].error).toBe('Provider setup required');
  expect(getCurrentMobileOutboxRecords()[0].creation?.draft.firstMessage).toBe('keep my input\n\nsecond message');
  expect(getCurrentMobileOutboxRecords()).toHaveLength(1);
  setMobileAuthOwner(null);
  await mobileDurableOutbox.activate('');
  setMobileAuthOwner('alice', 'global');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(findNewSessionEditDraft('pc')?.error).toBe('Provider setup required');
});

// P1 #6281: previous tests covered only unsent composer input, not independently
// queued messages. Unit production consolidation checks order, byte ownership,
// interrupted writes and deletion/account races with the real durable store.
async function saveFollowUpFixture(first: DurableOutboxRecord, pendingUpload = false) {
  const record: DurableOutboxRecord = { ...first, createdAt: 2, creation: undefined,
    item: { ...first.item, clientId: 'follow-up', text: 'second message',
      attachmentSlots: [pendingUpload ? null : { ...first.item.attachmentSlots[0]!, id: 'second-photo' }] }, uploads: [] };
  record.uploads.push(await retainOutboxFile(record, 0, { uri: 'file:///second.png', name: 'second.png', kind: 'image', size: 3 }));
  await mobileDurableOutbox.add(record);
  return record;
}

// #6281 unit: retry-opened background failures lack editReady/cancelled.
// Existing recovery cases start with cancelledCreationDraft and miss this input.
// Exercise the shared production recovery + editing + cold reload, not a route copy.
it.each([false, true])('persists edits to a retry-opened creation (follow-up: %s)', async followUp => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, { state: 'failed', suspended: true });
  if (followUp) await saveFollowUpFixture(first);
  const recovered = (await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc'))!;
  expect(recovered.creation?.draft.firstMessage).toBe(followUp ? 'keep my input\n\nsecond message' : 'keep my input');
  const leave = completeNewSessionDurableEdit(first.item.sessionId, 'pc');
  expect(leave).toBeTypeOf('function');
  const edited = (await persistNewSessionDraftEdit(recovered, { firstMessage: 'remaining' }))!;
  await persistNewSessionDraftEdit(edited, { removeAttachmentId: 'photo' });
  leave!();
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const restored = findNewSessionEditDraft('pc')!;
  expect(restored.creation?.draft.firstMessage).toBe('remaining');
  expect(restored.item.attachmentSlots.map(a => a?.id)).toEqual(followUp ? ['second-photo'] : []);
  if (followUp) await persistNewSessionDraftEdit(restored, { removeAttachmentId: 'second-photo' });
  await persistNewSessionDraftEdit(restored, { firstMessage: '' });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  expect(findNewSessionEditDraft('pc')).toBeUndefined();
  expect(getCurrentMobileOutboxRecords()).toEqual([]);
});

it.each([
  { suspended: false }, { state: 'queued' as const }, { enqueueStarted: true },
  { prepared: {} as QueuedRemoteMessage }, { template: {} as QueuedRemoteMessage },
  { cancelRequested: true }, { cleanupOutcome: 'cancelled' as const }, { sendAtMs: 1 },
])('does not turn a non-editable creation into a recovery draft: %j', async patch => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, { state: 'failed', suspended: true, ...patch });
  await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc')).resolves.toBeUndefined();
  expect(mobileDurableOutbox.getSnapshot()).toEqual([first]);
  expect(first.creation?.editReady).toBeUndefined();
});

it.each([false, true])('recovers sent follow-ups before composer input, retaining upload bytes (pending: %s)', async pendingUpload => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const second = await saveFollowUpFixture(first, pendingUpload);
  const other = { ...second, deviceId: 'other-pc', item: { ...second.item, clientId: 'other-device' } };
  await mobileDurableOutbox.add(other);
  await mobileDurableOutbox.add({ ...second, createdAt: 3, uploads: [], item: { ...second.item,
    clientId: 'third', text: 'third message', attachmentSlots: [], slotMeta: [] } });
  const saved = (await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc'))!;
  expect(saved.creation?.draft.firstMessage).toBe('keep my input\n\nsecond message\n\nthird message');
  expect(saved.uploads).toHaveLength(2);
  expect(files.retained.get(durableOutboxUploadUri(saved, saved.uploads[1]))).toBe(durableOutboxUploadUri(second, second.uploads[0]));
  if (pendingUpload) expect(saved.item.attachmentSlots[1]?.path).toBe(durableOutboxUploadUri(saved, saved.uploads[1]));
  await appendNewSessionEditComposer(first.item.sessionId, 'pc', { text: 'still typing', attachments: [] });
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const restored = (await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc'))!;
  expect(restored.creation?.draft.firstMessage).toBe('keep my input\n\nsecond message\n\nthird message\n\nstill typing');
  expect(getCurrentMobileOutboxRecords().filter(r => r.deviceId === 'pc')).toEqual([restored]);
  expect(getCurrentMobileOutboxRecords().find(r => r.deviceId === 'other-pc')).toEqual(other);
  const resent = await persistNewSessionCreationDraft({ record: { ...restored, storageSessionId: first.item.sessionId,
    item: { ...restored.item, sessionId: 'replacement' } }, recovering: restored, isCurrent: () => true,
    getUploadedSource: () => undefined });
  expect(resent?.uploads).toHaveLength(2);
  // Exercise delivery, not just the copied files: local-only recovered slots
  // must be uploaded before the new task receives its message.
  await mobileDurableOutbox.update(resent!, { state: 'queued', suspended: false, error: undefined,
    creation: { ...resent!.creation!, cancelled: undefined, editReady: undefined } });
  const projection = { sessionId: 'replacement', pendingQueue: [] } as unknown as InputProjection;
  const enqueue = vi.fn(async (_record: DurableOutboxRecord) => projection);
  const upload = vi.fn(async (_record: DurableOutboxRecord, retained: { slot: number }) => ({
    ...first.item.attachmentSlots[0]!, id: `fresh-${retained.slot}`, path: `cindy-oss-attach://fresh-${retained.slot}`,
  }));
  await createDurableOutboxDelivery({ store: mobileDurableOutbox, isCurrent: () => true,
    canRun: r => r.deviceId === 'pc', projection: async () => projection,
    session: async () => ({ id: 'replacement', status: 'active' }),
    prepare: async r => ({ clientId: r.item.clientId } as QueuedRemoteMessage), upload, enqueue,
    cancel: async () => true, history: async () => false, applyProjection: () => {}, cleanup: async () => {},
    discardUploads: () => {}, retryable: () => false, describe: String, confirmationMessage: 'confirm', clearedMessage: 'cleared',
  }).run();
  expect(upload).toHaveBeenCalledTimes(2);
  expect(enqueue).toHaveBeenCalledOnce();
  expect(enqueue.mock.calls[0][0].item.attachmentSlots.map(a => a?.path)).toEqual([
    'cindy-oss-attach://fresh-0', 'cindy-oss-attach://fresh-1',
  ]);
});

it.each([false, true])('preserves literal quote markers unless the follow-up encodes product quotes: %s', async quotesEncoded => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const followUp = await saveFollowUpFixture(first);
  const text = '> <!-- cindy-composer-quote -->\n> quoted text\n\nreply';
  await mobileDurableOutbox.update(followUp, { item: { ...followUp.item, text, quotesEncoded } });
  const restored = await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc');
  expect(restored?.creation?.draft.firstMessage).toBe(first.creation!.draft.firstMessage + '\n\n'
    + (quotesEncoded ? '> quoted text\n\nreply' : text));
});

it('finishes interrupted source removal after reload without duplicating merged content', async () => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  await saveFollowUpFixture(first);
  disk.failRemove = true;
  await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc')).rejects.toThrow('remove unavailable');
  expect(getCurrentMobileOutboxRecords()).toHaveLength(2);
  disk.failRemove = false;
  await mobileDurableOutbox.activate('');
  await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  const saved = await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc');
  expect(saved?.creation?.draft.firstMessage).toBe('keep my input\n\nsecond message');
  expect(saved?.uploads).toHaveLength(2);
  expect(getCurrentMobileOutboxRecords()).toEqual([saved]);
});

it.each([false, true])('reclaims only unretained overflow uploads after commit (interrupted: %s)', async interrupted => {
  const original = await saveDraftFixture();
  const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
  const followUp: DurableOutboxRecord = { ...first, creation: undefined, uploads: [], createdAt: 2,
    enqueueStarted: true, item: { ...first.item, clientId: 'many-files', text: 'keep all text',
      attachmentSlots: Array.from({ length: 21 }, (_, i) => ({ ...first.item.attachmentSlots[0]!,
        id: `file-${i}`, path: i === 20 ? first.item.attachmentSlots[0]!.path
          : i === 19 ? 'cindy-oss-attach://unused-overflow' : `/repo/file-${i}.png` })) } };
  await mobileDurableOutbox.add(followUp);
  await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc')).rejects.toThrow('OUTBOX_CREATION_OWNERSHIP_UNRESOLVED');
  expect(getCurrentMobileOutboxRecords()).toHaveLength(2);
  await mobileDurableOutbox.update(followUp, { enqueueStarted: false });
  disk.fail = true;
  await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc', async () => 'test-token')).rejects.toThrow('disk unavailable');
  expect(discardMobileUploadedAttachment).not.toHaveBeenCalled();
  disk.fail = false;
  if (interrupted) {
    disk.failRemove = true;
    await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc', async () => 'test-token')).rejects.toThrow('remove unavailable');
    expect(discardMobileUploadedAttachment).not.toHaveBeenCalled();
    disk.failRemove = false;
    await mobileDurableOutbox.activate('');
    await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
  }
  const saved = await mergeNewSessionEditFollowUps(first.item.sessionId, 'pc', async () => 'test-token');
  expect(saved?.item.attachmentSlots).toHaveLength(20);
  expect(vi.mocked(discardMobileUploadedAttachment).mock.calls.map(([a]) => a.path)).toEqual(['cindy-oss-attach://unused-overflow']);
  expect(saved?.creation?.notice).toBeTruthy();
  expect(saved?.creation?.draft.firstMessage).toBe('keep my input\n\nkeep all text');
});

it.each(['copy-fails', 'save-fails', 'source-edited', 'deleted', 'account-change'] as const)(
  'keeps source messages and rejects stale consolidation: %s', async outcome => {
    const original = await saveDraftFixture();
    const first = await mobileDurableOutbox.update(original, cancelledCreationDraft(original));
    const second = await saveFollowUpFixture(first);
    const before = new Map(files.retained);
    files.beforeCopy = async () => {
      if (outcome === 'copy-fails') throw new Error('copy unavailable');
      if (outcome === 'save-fails') disk.fail = true;
      if (outcome === 'source-edited') await mobileDurableOutbox.update(second, { item: { ...second.item, text: 'edited' } });
      if (outcome === 'deleted') await withNewSessionCreationRemoval(first.item.sessionId, 'pc', 'deleted', vi.fn());
      if (outcome === 'account-change') { setMobileAuthOwner('bob', 'global'); await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey); }
    };
    await expect(mergeNewSessionEditFollowUps(first.item.sessionId, 'pc')).rejects.toThrow();
    expect(files.retained).toEqual(before);
    disk.fail = false;
    setMobileAuthOwner('alice', 'global');
    await mobileDurableOutbox.activate('');
    await mobileDurableOutbox.activate(getMobileAuthOwner().accountKey);
    if (outcome === 'deleted') {
      expect(getCurrentMobileOutboxRecords()).toEqual([]);
      expect(findNewSessionEditDraft('pc')).toBeUndefined();
    } else {
      expect(getCurrentMobileOutboxRecords()).toHaveLength(2);
      expect(findNewSessionEditDraft('pc')?.creation?.draft.firstMessage).toBe('keep my input');
    }
  },
);
