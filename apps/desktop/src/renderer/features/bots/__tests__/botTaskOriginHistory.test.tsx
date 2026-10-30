// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotProfile } from '../botStore';

// PR #7918: mounted source history must discard withdrawn content and stale pages,
// including archived remote tasks absent from the local task list. Unit, deferred IPC reads.
// Separate from roster tests because this component consumes source pushes and file context.
const h = vi.hoisted(() => ({ deviceId: undefined as string | undefined, read: vi.fn(), callbacks: new Map<string, (...args: any[]) => void>() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useBotSettingsTarget', () => ({ useBotSettingsTarget: () => ({ deviceId: h.deviceId }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true, isDataOwnerPushCurrent: () => true }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: () => undefined, remoteProjectsStore: { subscribe: () => () => {} } }));
vi.mock('@/lib/makerChatStore', () => ({ mapServerMessages: (rows: unknown[]) => rows }));
vi.mock('@/components/chat/MessageStream', async () => {
  const { useChatSessionFileValue } = await import('@/components/chat/ChatSessionFileContext');
  return { MessageStream: (props: any) => {
    const file = useChatSessionFileValue(props.fileSessionId, props.workingDir, undefined, props.fileDeviceId);
    return <div><output data-testid="origin">{JSON.stringify(file.origin)}</output>
      {props.messages.map((m: any) => <p key={m.id}>{m.content}</p>)}</div>;
  } };
});
import { BotTaskOriginHistory } from '../BotTaskOriginHistory';
const bot = { id: 'bot', sourceTask: { sourceSessionId: 'source', title: 'Novel', workingDir: '/archive' } } as BotProfile;
const subscribe = (channel: string) => (cb: (...args: any[]) => void) => {
  h.callbacks.set(channel, cb); return () => h.callbacks.delete(channel);
};
beforeEach(() => {
  h.deviceId = undefined; h.read.mockReset(); h.callbacks.clear();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { messages: { list: h.read, onDeleted: subscribe('local-db:messages:deleted') },
      sessionsPush: { onPatched: subscribe('local-db:sessions:patched') }, subagentRuns: { onChanged: subscribe('local-db:subagent-runs:changed') } },
    deviceLink: { invoke: (_device: string, _channel: string, args: unknown[]) => h.read(...args), onRemotePush: subscribe('remote') },
  } });
});
afterEach(cleanup);

it.each([
  ['local-db:messages:deleted', {}, undefined],
  ['local-db:sessions:patched', { patch: { clearedAt: '2026-10-29' } }, undefined],
  ['local-db:sessions:patched', { patch: { status: 'deleted' } }, 'other-computer'],
  ['local-db:subagent-runs:changed', { runId: null }, undefined],
] as const)('invalidates source content on %s (%j, %s) and rejects a late page', async (channel, payload, deviceId) => {
  h.deviceId = deviceId;
  let finishOld!: (rows: unknown[]) => void;
  h.read.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => ({ id: String(i), content: i === 0 ? 'Withdrawn text' : 'kept' })))
    .mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
    .mockResolvedValue([]);
  render(<BotTaskOriginHistory bot={bot} onOpenSession={() => {}} />);
  await screen.findByText('Withdrawn text');
  if (deviceId) expect(screen.getByTestId('origin').textContent).toContain('other-computer');
  fireEvent.click(screen.getByRole('button', { name: 'bots.fromTask.loadMore' }));
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(2));
  act(() => {
    if (deviceId) h.callbacks.get('remote')?.({ deviceId, channel, payload: { sessionId: 'source', ...payload } });
    else h.callbacks.get(channel)?.({ sessionId: 'source', ...payload });
  });
  expect(screen.queryByText('Withdrawn text')).toBeNull();
  await act(async () => { finishOld([{ id: 'late', content: 'Withdrawn late page' }]); });
  await waitFor(() => expect(h.read).toHaveBeenCalledTimes(3));
  expect(screen.queryByText('Withdrawn late page')).toBeNull();
});
