// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../types';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), invoke: vi.fn(), subscribe: vi.fn(), pin: vi.fn(), confirm: vi.fn(), status: vi.fn(), merge: vi.fn(), cache: vi.fn(), detached: false, t: (key: string) => key }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
// Match the stable translation callback; changing it on every render restarts the metadata read.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: (props: { sessionIdProp: string; sessionSnapshotProp: unknown }) => <div data-testid="editor">{JSON.stringify(props)}</div> }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: mocks.pin, mergeDeviceSessions: mocks.cache, getDeviceName: () => 'Host' } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/hooks/useWindowVisible', () => ({ useWindowVisible: () => true, useDocumentVisible: () => true }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/lib/composerDraftStore', () => ({ discardDraft: vi.fn() }));
vi.mock('@/lib/sessionService', () => ({ setStatus: mocks.status }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => mocks.detached }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('../../lib/mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: mocks.merge }));
import { SideChatTabBody } from './SideChatTabBody';

// Unit: a hidden remote child has no list row. Its host metadata must be read before the
// full-page entry is enabled. Closing must honor cancellation; the panel has no second editor.
describe('side chat panel lifecycle', () => {
  let close: (() => Promise<boolean>) | null;
  const ctx = { sessionId: 'parent', tabId: 'tab', setCloseInterceptor: (fn: () => Promise<boolean>) => { close = fn; return () => { close = null; }; } } as unknown as TabKindHostContext;
  beforeEach(() => {
    vi.clearAllMocks(); close = null; mocks.detached = false;
    mocks.confirm.mockResolvedValue(false); mocks.status.mockResolvedValue(undefined);
    mocks.subscribe.mockReturnValue(() => {});
    mocks.invoke.mockResolvedValue({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model' });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { deviceLink: { invoke: mocks.invoke, onRemotePush: mocks.subscribe } } });
  });
  afterEach(cleanup);

  it('opens a full task page only after its remote branch metadata is available', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'local-db:sessions:get', ['child']);
    await act(async () => {
      mocks.subscribe.mock.calls[0][0]({ deviceId: 'host', channel: 'local-db:sessions:patched', payload: { sessionId: 'child', patch: { model: 'new-model' } } });
      resolve({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model' });
    });
    expect(screen.queryByTestId('editor')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'chat.sideChat.openPage' }));
    // Unit #6529: reopening a hidden branch must preserve its host in the URL,
    // even if the renderer restarts before the asynchronous mirror cache writes.
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent/child?device=host');
    expect(mocks.cache).toHaveBeenCalledWith('host', 'Host', [expect.objectContaining({ id: 'child', model: 'new-model' })]);
    expect(mocks.cache.mock.invocationCallOrder[0]).toBeLessThan(mocks.navigate.mock.invocationCallOrder[0]);
    expect(mocks.pin).toHaveBeenCalledWith('host', 'child');
  });

  it('cancels without deleting, and a failed remote deletion keeps the panel open', async () => {
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    await expect(close!()).resolves.toBe(false);
    expect(mocks.status).not.toHaveBeenCalled();
    mocks.confirm.mockResolvedValue(true); mocks.status.mockRejectedValueOnce(new Error('offline'));
    await expect(close!()).resolves.toBe(false);
    expect(mocks.status).toHaveBeenCalledWith('child', 'deleted', { kind: 'device-link', deviceId: 'host' });
  });

  it('shows a return action in the restricted sidebar window without mounting a chat editor', () => {
    mocks.detached = true;
    render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText('chat.sideChat.returnToMain')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
