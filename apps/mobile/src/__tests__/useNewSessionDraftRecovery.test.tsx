// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import type { DurableOutboxRecord } from '@/session/durableOutbox';
import { useAutoResumeNewSessionDraft, useNewSessionDurableEdit } from '@/session/useNewSessionDraftRecovery';

const outbox = vi.hoisted(() => ({
  records: [] as DurableOutboxRecord[], listeners: new Set<() => void>(),
  ready: vi.fn(), claim: vi.fn(), release: vi.fn(), find: vi.fn(), merge: vi.fn(),
  saveEdit: vi.fn(),
}));
vi.mock('@/session/mobileDurableOutbox', () => ({
  getCurrentMobileOutboxRecords: () => outbox.records,
  mobileDurableOutbox: {
    ready: outbox.ready,
    subscribe: (listener: () => void) => {
      outbox.listeners.add(listener);
      return () => outbox.listeners.delete(listener);
    },
  },
}));
vi.mock('@/session/newSessionCreation', () => ({
  completeNewSessionDurableEdit: outbox.claim,
  findNewSessionEditDraft: outbox.find,
  subscribeNewSessionCreationTasks: (listener: () => void) => {
    outbox.listeners.add(listener);
    return () => outbox.listeners.delete(listener);
  },
}));
vi.mock('@/session/mergeNewSessionEditFollowUps', () => ({ mergeNewSessionEditFollowUps: outbox.merge }));
vi.mock('@/session/persistNewSessionCreationDraft', () => ({ persistNewSessionDraftEdit: outbox.saveEdit }));
type EditProps = Omit<Parameters<typeof useNewSessionDurableEdit>[0], 'onRestore'>;
type ResumeProps = Omit<Parameters<typeof useAutoResumeNewSessionDraft>[0], 'onResume'>;
let editorActions: ReturnType<typeof useNewSessionDurableEdit>;
function Editor(props: EditProps) {
  const [record, setRecord] = useState<DurableOutboxRecord>();
  const [text, setText] = useState('');
  const recovery = useNewSessionDurableEdit({ ...props, onRestore: saved => {
    setRecord(saved); setText(saved.creation.draft.firstMessage);
  } });
  editorActions = recovery;
  return <><span>{text}</span><span>{record?.error}</span>
    <button onClick={() => { hasInput = true; setText('New input'); recovery.edit({ firstMessage: 'New input' }); }}>Edit</button></>;
}
function BlankForm(props: ResumeProps) {
  const [route, setRoute] = useState('');
  useAutoResumeNewSessionDraft({ ...props, onResume: params => setRoute(`${params.deviceId}/${params.recoverySessionId}`) });
  return <span>{route}</span>;
}
let root: Root;
let container: HTMLDivElement;
let edit: EditProps;
let resume: ResumeProps;
let ready: () => void;
let hasInput: boolean;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
const renderEdit = () => act(async () => root.render(<Editor {...edit} />));
const renderBlank = () => act(async () => root.render(<BlankForm {...resume} />));
const notify = () => act(async () => { for (const listener of outbox.listeners) listener(); });
beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  setMobileAuthOwner('account');
  const owner = getMobileAuthOwner();
  outbox.listeners.clear();
  outbox.release.mockReset();
  outbox.claim.mockReset().mockReturnValue(outbox.release);
  outbox.ready.mockReset().mockReturnValue(new Promise<void>(resolve => { ready = resolve; }));
  outbox.records = [{
    version: 1, accountId: owner.accountKey, deviceId: 'device', state: 'failed', createdAt: 1,
    uploads: [], error: 'Model unavailable', suspended: true,
    item: { sessionId: 'task', clientId: 'first', text: 'Saved draft', attachmentSlots: [],
      quotesEncoded: false, agentReferences: [], pastedTextRanges: [], slashCommandRanges: [],
      permissionModeAtSend: 'auto', slotMeta: [], slotByLocalId: {}, waitingIds: [],
      failedIds: [], enqueueError: null, phase: 'failed' },
    creation: { deviceName: 'PC', planModeArm: false, restorePermissionMode: null, editReady: true,
      draft: { agentKind: 'codex', workspaceKind: 'dialogue', model: 'model', effort: 'medium',
        permissionMode: 'auto', workingDir: '', providerId: 'openai', fastMode: false, firstMessage: 'Saved draft' } },
  }];
  outbox.find.mockReset().mockImplementation(() => outbox.records[0]);
  outbox.merge.mockReset().mockImplementation(async () => outbox.records[0]);
  outbox.saveEdit.mockReset().mockImplementation(async (record, change) => ({
    ...record, creation: { ...record.creation, draft: { ...record.creation.draft, firstMessage: change.firstMessage } },
  }));
  edit = { sessionId: 'task', deviceId: 'device', owner, hasInput: () => hasInput, leaveForeignRecovery: () => false, onEdited: vi.fn() };
  hasInput = false;
  resume = { enabled: true, deviceId: 'device', workingDir: '/repo', owner, hasInput: () => hasInput };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  setMobileAuthOwner(null);
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it('restores text and the saved failure once, preserving edits across renders and notifications', async () => {
  await renderEdit();
  expect(container.textContent).toBe('Edit');
  await act(async () => ready());
  expect(container.textContent).toBe('Saved draftModel unavailableEdit');
  expect(outbox.claim).toHaveBeenCalledExactlyOnceWith('task', 'device');
  act(() => container.querySelector('button')!.click());
  await renderEdit();
  await notify();
  expect(container.textContent).toBe('New inputModel unavailableEdit');
  expect(edit.onEdited).toHaveBeenCalledWith(expect.objectContaining({
    creation: expect.objectContaining({ draft: expect.objectContaining({ firstMessage: 'New input' }) }),
  }));
  expect(outbox.claim).toHaveBeenCalledOnce();
  expect(outbox.release).not.toHaveBeenCalled();
  await act(async () => root.render(null));
  expect(outbox.release).toHaveBeenCalledOnce();
  expect(outbox.listeners.size).toBe(0);
});

it('waits for deletion to be saved, then releases the recovery record without resaving later input', async () => {
  await renderEdit();
  await act(async () => ready());
  let finish!: (value: null) => void;
  outbox.saveEdit.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  editorActions.edit({ firstMessage: '' });
  let flushed = false;
  const flush = editorActions.flush().then(() => { flushed = true; });
  expect(flushed).toBe(false);
  await act(async () => { finish(null); await flush; });
  expect(edit.onEdited).toHaveBeenLastCalledWith(null);
  act(() => container.querySelector('button')!.click());
  expect(outbox.saveEdit).toHaveBeenCalledOnce();
});

it.each(['newer-edit', 'unmount', 'owner-switch', 'failure'] as const)('settles a pending edit without restoring stale form ownership: %s', async event => {
  edit.onError = vi.fn();
  await renderEdit();
  await act(async () => ready());
  let finish!: (value: DurableOutboxRecord) => void;
  let fail!: (error: Error) => void;
  outbox.saveEdit.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  editorActions.edit({ firstMessage: 'older' });
  const pending = editorActions.flush();
  if (event === 'newer-edit') await act(async () => { editorActions.edit({ firstMessage: 'newer' }); await editorActions.flush(); });
  if (event === 'unmount') await act(async () => root.render(null));
  if (event === 'owner-switch') setMobileAuthOwner('bob');
  if (event === 'failure') {
    const error = new Error('disk unavailable');
    await act(async () => { fail(error); await expect(pending).rejects.toThrow('disk unavailable'); });
    expect(edit.onError).toHaveBeenCalledWith(error);
  } else await act(async () => { finish(outbox.records[0]); await pending; });
  expect(edit.onEdited).toHaveBeenCalledTimes(event === 'newer-edit' ? 1 : 0);
  if (event === 'newer-edit') expect(edit.onEdited).toHaveBeenCalledWith(expect.objectContaining({
    creation: expect.objectContaining({ draft: expect.objectContaining({ firstMessage: 'newer' }) }),
  }));
});

it.each(['account', 'device', 'prepared', 'foreign-route', 'unmount', 'owner-switch'] as const)(
  'ignores ineligible or late durable recovery: %s', async change => {
    if (change === 'account') outbox.records[0].accountId = 'other';
    if (change === 'device') outbox.records[0].deviceId = 'other';
    if (change === 'prepared') outbox.records[0].prepared = {} as NonNullable<DurableOutboxRecord['prepared']>;
    if (change === 'foreign-route') edit.leaveForeignRecovery = () => true;
    await renderEdit();
    if (change === 'unmount') await act(async () => root.render(null));
    if (change === 'owner-switch') setMobileAuthOwner('other');
    await act(async () => ready());
    await notify();
    expect(outbox.claim).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain('Saved draft');
  },
);

it('releases the old claim when the route changes and waits for the matching record', async () => {
  await renderEdit();
  await act(async () => ready());
  edit = { ...edit, sessionId: 'next' };
  await renderEdit();
  expect(outbox.release).toHaveBeenCalledOnce();
  outbox.records[0] = { ...outbox.records[0], item: { ...outbox.records[0].item, sessionId: 'next' } };
  await notify();
  expect(outbox.claim).toHaveBeenLastCalledWith('next', 'device');
  expect(outbox.claim).toHaveBeenCalledTimes(2);
});

it('resumes one draft in the selected device and project, without repeating on render or notification', async () => {
  await renderBlank();
  await act(async () => ready());
  expect(container.textContent).toBe('device/task');
  expect(outbox.find).toHaveBeenCalledExactlyOnceWith('device', '/repo');
  await renderBlank();
  await notify();
  expect(outbox.find).toHaveBeenCalledOnce();
});

it.each(['disabled', 'input', 'late-input', 'unmount', 'owner-switch'] as const)(
  'does not resume over a protected or stale form: %s', async change => {
    if (change === 'disabled') resume.enabled = false;
    if (change === 'input') hasInput = true;
    await renderBlank();
    if (change === 'late-input') { hasInput = true; await renderBlank(); }
    if (change === 'unmount') await act(async () => root.render(null));
    if (change === 'owner-switch') setMobileAuthOwner('other');
    await act(async () => ready());
    await notify();
    expect(outbox.find).not.toHaveBeenCalled();
    expect(container.textContent).toBe('');
  },
);

it('uses the latest device after a route change while storage is pending', async () => {
  await renderBlank();
  resume = { ...resume, deviceId: 'other-device' };
  outbox.records[0].deviceId = 'other-device';
  await renderBlank();
  await act(async () => ready());
  expect(outbox.find).toHaveBeenCalledExactlyOnceWith('other-device', '/repo');
  expect(container.textContent).toBe('other-device/task');
  await act(async () => root.render(null));
  expect(outbox.listeners.size).toBe(0);
});

// Cold recovery now waits for queued messages to join the draft. That await
// must not restore stale content, swallow a write failure, or claim twice.
it.each(['storage', 'merge'] as const)('preserves input entered while waiting for %s and leaves the saved draft unclaimed', async waitingFor => {
  const saved = outbox.records[0];
  let finish!: (record: DurableOutboxRecord) => void;
  outbox.merge.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  await renderEdit();
  if (waitingFor === 'merge') await act(async () => ready());
  act(() => container.querySelector('button')!.click());
  await act(async () => { ready(); finish(saved); });
  expect(container.textContent).toBe('New inputEdit');
  expect(outbox.claim).not.toHaveBeenCalled();
  expect(outbox.saveEdit).not.toHaveBeenCalled();
  expect(outbox.records).toEqual([saved]);
  // Clearing the protection later cannot restart this abandoned restoration.
  hasInput = false;
  await notify();
  expect(container.textContent).toBe('New inputEdit');
  expect(outbox.claim).not.toHaveBeenCalled();
  // A separate blank form can still recover the saved record.
  await act(async () => root.render(null));
  await renderEdit();
  expect(container.textContent).toBe('Saved draftModel unavailableEdit');
  expect(outbox.claim).toHaveBeenCalledOnce();
});

it.each(['complete', 'unmount', 'owner-switch', 'save-fails', 'prepared', 'resumed', 'cancel-requested', 'unmarked'] as const)(
  'settles follow-up consolidation before restoring the editor: %s', async outcome => {
    let resolve!: (record: DurableOutboxRecord) => void;
    let reject!: (error: Error) => void;
    outbox.merge.mockReturnValue(new Promise((yes, no) => { resolve = yes; reject = no; }));
    edit.onError = vi.fn();
    await renderEdit();
    await act(async () => ready());
    await notify();
    expect(outbox.merge).toHaveBeenCalledOnce();
    expect(outbox.claim).not.toHaveBeenCalled();
    if (outcome === 'unmount') await act(async () => root.render(null));
    if (outcome === 'owner-switch') setMobileAuthOwner('other');
    if (outcome === 'prepared') outbox.records[0].prepared = {} as NonNullable<DurableOutboxRecord['prepared']>;
    if (outcome === 'resumed') outbox.records[0].suspended = false;
    if (outcome === 'cancel-requested') outbox.records[0].cancelRequested = true;
    if (outcome === 'unmarked') outbox.records[0].creation!.editReady = undefined;
    await act(async () => {
      if (outcome === 'save-fails') reject(new Error('save failed'));
      else resolve(outbox.records[0]);
    });
    expect(outbox.claim).toHaveBeenCalledTimes(outcome === 'complete' ? 1 : 0);
    expect(edit.onError).toHaveBeenCalledTimes(outcome === 'save-fails' ? 1 : 0);
    if (outcome === 'complete') expect(container.textContent).toContain('Saved draft');
    else expect(container.textContent).not.toContain('Saved draft');
  },
);

// #6281: leaving during a delete must not let a blank form claim the old revision.
it.each(['edited', 'cleared', 'failed'] as const)('keeps the edit claim through pending persistence: %s', async outcome => {
  let claimed = false;
  outbox.claim.mockImplementation(() => {
    claimed = true;
    return () => { claimed = false; outbox.release(); for (const listener of outbox.listeners) listener(); };
  });
  outbox.find.mockImplementation(() => claimed ? undefined : outbox.records[0]);
  await renderEdit();
  await act(async () => ready());
  let finish!: (record: DurableOutboxRecord | null) => void;
  let fail!: (error: Error) => void;
  outbox.saveEdit.mockReturnValueOnce(new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  editorActions.edit({ firstMessage: 'remaining text' });
  await renderBlank();
  expect(outbox.release).not.toHaveBeenCalled();
  expect(container.textContent).toBe('');
  await act(async () => {
    if (outcome === 'failed') { fail(new Error('disk unavailable')); return; }
    const record = outbox.records[0];
    outbox.records = outcome === 'cleared' ? [] : [{ ...record, creation: { ...record.creation!,
      draft: { ...record.creation!.draft, firstMessage: 'remaining text' } } }];
    for (const listener of outbox.listeners) listener();
    expect(container.textContent).toBe('');
    finish(outbox.records[0] ?? null);
  });
  expect(outbox.release).toHaveBeenCalledOnce();
  expect(container.textContent).toBe(outcome === 'cleared' ? '' : 'device/task');
  if (outcome === 'edited') {
    await renderEdit();
    expect(container.textContent).toBe('remaining textModel unavailableEdit');
  }
});
