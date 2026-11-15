// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../types';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), invoke: vi.fn(), subscribe: vi.fn(), pin: vi.fn(), confirm: vi.fn(), status: vi.fn(), merge: vi.fn(), cache: vi.fn(), closeTab: vi.fn(), detached: false, t: (key: string) => key }));
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
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => true, isDataOwnerPushCurrent: () => true }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('../../lib/mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: mocks.merge }));
vi.mock('../../store', () => ({ closeTab: mocks.closeTab }));
import { SideChatTabBody } from './SideChatTabBody';

// Unit regression (2026-10-25): opening a side-chat tab used to show only a navigation
// button. Mount the production panel with one local/remote child and verify it exposes
// the shared editor in place. The previous tests explicitly required a second navigation.
// Remote metadata/patch ordering, visibility and deletion must still gate that editor.
describe('side chat panel lifecycle', () => {
  let close: (() => Promise<boolean>) | null;
  const ctx = { sessionId: 'parent', tabId: 'tab', setCloseInterceptor: (fn: () => Promise<boolean>) => { close = fn; return () => { close = null; }; } } as unknown as TabKindHostContext;
  beforeEach(() => {
    vi.clearAllMocks(); close = null; mocks.detached = false;
    mocks.confirm.mockResolvedValue(false); mocks.status.mockResolvedValue(undefined);
    mocks.subscribe.mockReturnValue(() => {});
    mocks.closeTab.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model' });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      deviceLink: { invoke: mocks.invoke, onRemotePush: mocks.subscribe },
      localDb: { sessionsPush: { onPatched: mocks.subscribe } },
    } });
  });
  afterEach(cleanup);

  it('opens the embedded editor after reading its remote branch, preserving newer patches', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'local-db:sessions:get', ['child']);
    await act(async () => {
      mocks.subscribe.mock.calls[0][0]({ deviceId: 'host', channel: 'local-db:sessions:patched', payload: { sessionId: 'child', patch: { model: 'new-model' } } });
      resolve({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model' });
    });
    const editor = JSON.parse(screen.getByTestId('editor').textContent!);
    expect(editor).toMatchObject({
      sessionIdProp: 'child', navigationMode: 'sidebar-embedded', sidebarTargetSessionId: 'parent',
      sessionSnapshotProp: { id: 'child', model: 'new-model', deviceLinkDeviceId: 'host' },
      viewVisible: true, chatRealtime: true,
    });
    expect(screen.queryByRole('button', { name: 'chat.sideChat.openPage' })).toBeNull();
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.cache).toHaveBeenCalledWith('host', 'Host', [expect.objectContaining({ id: 'child', model: 'new-model' })]);
    expect(mocks.pin).toHaveBeenCalledWith('host', 'child');
  });

  it('keeps the local editor mounted but suspends visible work when its tab or shell is hidden', () => {
    const { rerender } = render(<SideChatTabBody state={{ sessionId: 'child', deviceId: null }} ctx={ctx} active />);
    const editor = screen.getByTestId('editor');
    expect(JSON.parse(editor.textContent!)).toMatchObject({ sessionIdProp: 'child', viewVisible: true, chatRealtime: true });
    rerender(<SideChatTabBody state={{ sessionId: 'child', deviceId: null }} ctx={ctx} active={false} />);
    expect(screen.getByTestId('editor')).toBe(editor);
    expect(JSON.parse(editor.textContent!)).toMatchObject({ viewVisible: false, chatRealtime: false, disableAutofocus: true });
    rerender(<SideChatTabBody state={{ sessionId: 'child', deviceId: null }} ctx={ctx} active shellVisible={false} />);
    expect(screen.getByTestId('editor')).toBe(editor);
    expect(JSON.parse(editor.textContent!)).toMatchObject({ viewVisible: false, chatRealtime: false });
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('opens the editor after retrying a failed metadata read', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    expect(screen.queryByTestId('editor')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' })); });
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
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
