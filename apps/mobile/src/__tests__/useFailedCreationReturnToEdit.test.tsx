// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useFailedCreationReturnToEdit } from '@/session/useFailedCreationReturnToEdit';
import type { NewSessionCreationTask } from '@/session/newSessionCreation';
import type { returnNewSessionToEdit } from '@/session/returnNewSessionToEdit';

const state = vi.hoisted(() => ({ recover: vi.fn(), owner: 1 }));
vi.mock('@/session/returnNewSessionToEdit', () => ({ returnNewSessionToEdit: state.recover }));
vi.mock('@/auth/authOwnerGeneration', () => ({
  getMobileAuthOwner: () => state.owner,
  isMobileAuthOwnerCurrent: (owner: number) => owner === state.owner,
}));
const failedTask = (): NewSessionCreationTask => ({
  sessionId: 'task', deviceId: 'device', deviceName: 'PC', status: 'create-failed',
  startedAt: 1, phase: 'creating', error: 'Model unavailable',
  firstMessageClientId: 'first', attachments: [],
  draft: { agentKind: 'codex', workspaceKind: 'dialogue', model: 'model', effort: 'medium',
    permissionMode: 'auto', workingDir: '', providerId: 'openai', fastMode: false, firstMessage: 'My draft' },
});
type Props = Parameters<typeof useFailedCreationReturnToEdit>[0];
type Recovery = Parameters<typeof returnNewSessionToEdit>[0];
function Screen(props: Props) {
  useFailedCreationReturnToEdit(props);
  return <span>Chat</span>;
}
let root: Root;
let container: HTMLDivElement;
let props: Props;
let pending: Recovery;
let finish: () => void;
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let previousActEnvironment: boolean | undefined;
const render = () => act(async () => root.render(<Screen {...props} />));
beforeEach(() => {
  previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  state.owner = 1;
  state.recover.mockReset().mockImplementation((options: Recovery) => {
    pending = options;
    return new Promise<void>(resolve => { finish = resolve; });
  });
  props = { task: failedTask(), focused: true, connectionEpoch: 1,
    stashDraft: vi.fn(), onReady: vi.fn(), onError: vi.fn() };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

it.each(['running', 'enqueue-failed'] as const)('keeps %s in chat without returning to edit', async status => {
  props.task = { ...failedTask(), status };
  await render();
  expect(container.textContent).toBe('Chat');
  expect(state.recover).not.toHaveBeenCalled();
});

it('automatically recovers creation failure once and hands the saved draft to the form', async () => {
  await render();
  props.task = { ...props.task!, returningToEdit: true };
  await render();
  expect(state.recover).toHaveBeenCalledTimes(1);
  expect(pending.stashDraft).toBe(props.stashDraft);
  const params = { deviceId: 'device', deviceName: 'PC', recoverySessionId: 'task' };
  await act(async () => { pending.onReady(params); finish(); });
  expect(props.onReady).toHaveBeenCalledExactlyOnceWith(params);
  props.task = { ...props.task!, readyForEdit: 'durable', returningToEdit: false };
  await render();
  expect(state.recover).toHaveBeenCalledTimes(1);
});

it.each(['leave', 'blur', 'account', 'task'] as const)('ignores late navigation after %s', async change => {
  await render();
  const old = pending;
  if (change === 'leave') await act(async () => root.render(null));
  if (change === 'blur') { props.focused = false; await render(); }
  if (change === 'account') state.owner += 1;
  if (change === 'task') { props.task = { ...failedTask(), sessionId: 'other' }; await render(); }
  expect(old.isCurrent()).toBe(false);
  old.onReady({ deviceId: 'device', deviceName: 'PC', editSessionId: 'task' });
  expect(props.onReady).not.toHaveBeenCalled();
});

it('starts recovery only when the failed task is focused', async () => {
  props.focused = false;
  await render();
  expect(state.recover).not.toHaveBeenCalled();
  props.focused = true;
  await render();
  expect(state.recover).toHaveBeenCalledTimes(1);
});

// A failure can arrive while the second send is retaining bytes. Navigation
// must wait for that send's durable handoff, not strand it under the old task.
it('waits for an in-progress send before recovering the failed creation', async () => {
  props.sending = true;
  await render();
  expect(state.recover).not.toHaveBeenCalled();
  props.sending = false;
  await render();
  expect(state.recover).toHaveBeenCalledOnce();
  await act(async () => { await pending.onReady({ deviceId: 'device', deviceName: 'PC', recoverySessionId: 'task' }); finish(); });
  expect(props.onReady).toHaveBeenCalledOnce();
});

it('resumes a prepared draft after recovery started on an earlier mount', async () => {
  props.task = { ...failedTask(), returningToEdit: true };
  state.recover.mockResolvedValue(undefined);
  await render();
  props.task = { ...failedTask(), readyForEdit: 'memory' };
  state.recover.mockImplementation(async (options: Recovery) => {
    options.onReady({ deviceId: 'device', deviceName: 'PC', editSessionId: 'task' });
  });
  await render();
  expect(props.onReady).toHaveBeenCalledExactlyOnceWith({
    deviceId: 'device', deviceName: 'PC', editSessionId: 'task',
  });
});

it('reports cleanup failure without a retry loop and resumes after reconnect', async () => {
  const error = new Error('cleanup pending');
  state.recover.mockRejectedValue(error);
  await render();
  expect(props.onError).toHaveBeenCalledExactlyOnceWith(error);
  expect(props.onReady).not.toHaveBeenCalled();
  props.task = { ...failedTask(), returningToEdit: true };
  await render();
  props.task = { ...failedTask(), returningToEdit: false };
  await render();
  expect(state.recover).toHaveBeenCalledTimes(1);
  props.connectionEpoch += 1;
  await render();
  expect(state.recover).toHaveBeenCalledTimes(2);
});

// Replaces the former Alert-action lifecycle cases: recovery now starts automatically.
it.each(['current', 'leave', 'blur', 'account', 'task'] as const)('reports a delayed recovery error only on its current page: %s', async change => {
  let reject!: (error: Error) => void;
  state.recover.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render();
  if (change === 'leave') await act(async () => root.render(null));
  if (change === 'blur') { props.focused = false; await render(); }
  if (change === 'account') state.owner += 1;
  if (change === 'task') { props.task = { ...failedTask(), sessionId: 'other' }; await render(); }
  await act(async () => reject(new Error('cleanup pending')));
  expect(props.onError).toHaveBeenCalledTimes(change === 'current' ? 1 : 0);
  expect(props.onReady).not.toHaveBeenCalled();
});

it('does not lose an in-flight recovery result when the connection changes', async () => {
  let reject!: (error: Error) => void;
  state.recover.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  await render();
  state.recover.mockResolvedValue(undefined); // the shared helper holds the existing recovery
  props.connectionEpoch += 1;
  await render();
  const error = new Error('disk full');
  await act(async () => reject(error));
  expect(props.onError).toHaveBeenCalledExactlyOnceWith(error);
});

it('waits for current composer ownership to transfer before automatic navigation', async () => {
  let saved!: () => void;
  const preserve = vi.fn(() => new Promise<void>(resolve => { saved = resolve; }));
  props = { ...props, beforeNavigate: preserve } as Props;
  state.recover.mockImplementation(async (options: Recovery) => {
    await options.onReady({ deviceId: 'device', deviceName: 'PC', recoverySessionId: 'task' });
  });
  await render();
  expect(props.onReady).not.toHaveBeenCalled();
  expect(preserve).toHaveBeenCalledOnce();
  await act(async () => saved());
  expect(props.onReady).toHaveBeenCalledOnce();
});

it.each(['save-fails', 'leaves'])('does not navigate after composer handoff %s', async outcome => {
  let finishSave!: () => void;
  props.beforeNavigate = () => new Promise<void>((resolve, reject) => {
    finishSave = () => outcome === 'save-fails' ? reject(new Error('disk full')) : resolve();
  });
  state.recover.mockImplementation(async (options: Recovery) => {
    await options.onReady({ deviceId: 'device', deviceName: 'PC', recoverySessionId: 'task' });
  });
  await render();
  if (outcome === 'leaves') { props.focused = false; await render(); }
  await act(async () => finishSave());
  expect(props.onReady).not.toHaveBeenCalled();
  expect(props.onError).toHaveBeenCalledTimes(outcome === 'save-fails' ? 1 : 0);
});
