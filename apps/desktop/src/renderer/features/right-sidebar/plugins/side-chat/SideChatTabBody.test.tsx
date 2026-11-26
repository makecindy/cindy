// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TabKindHostContext } from '../../types';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), invoke: vi.fn(), subscribe: vi.fn(), pin: vi.fn(), confirm: vi.fn(), archive: vi.fn(), status: vi.fn(), merge: vi.fn(), cache: vi.fn(), closeTab: vi.fn(), clearDraft: vi.fn(), discardDraft: vi.fn(), detached: false, t: (key: string) => key }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
// Match the stable translation callback; changing it on every render restarts the metadata read.
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: (props: { sessionIdProp: string; sessionSnapshotProp: unknown; draftKeyProp?: string; awaitingSessionCreation?: boolean; creationFailed?: boolean }) => <div data-testid="editor">{JSON.stringify(props)}</div> }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: mocks.pin, mergeDeviceSessions: mocks.cache, getDeviceName: () => 'Host' } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: mocks.confirm }) }));
vi.mock('@/hooks/useWindowVisible', () => ({ useWindowVisible: () => true, useDocumentVisible: () => true }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/lib/composerDraftStore', () => ({ clearDraft: mocks.clearDraft, discardDraft: mocks.discardDraft }));
vi.mock('@/lib/sessionService', () => ({ setStatus: mocks.status }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => mocks.detached }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => ({ dataOwnerId: 'owner', generation: 1 }), isDataOwnerGenerationCurrent: () => true, isDataOwnerPushCurrent: () => true }));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('../../lib/mergeSidebarWindowBack', () => ({ mergeSidebarWindowBack: mocks.merge }));
vi.mock('../../store', () => ({ closeTab: mocks.closeTab }));
import type { Session } from '@/lib/ccAgent.types';
import { SideChatTabBody } from './SideChatTabBody';
import {
  __resetPendingSideChatsForTest,
  buildPreviewSideChatSession,
  failPendingSideChat,
  getPendingSideChat,
  registerPendingSideChat,
  resolvePendingSideChat,
} from './pendingSideChat';

// Unit regression (2026-10-25): opening a side-chat tab used to show only a navigation
// button. Mount the production panel with one local/remote child and verify it exposes
// the shared editor in place. The previous tests explicitly required a second navigation.
// Remote metadata/patch ordering, visibility and deletion must still gate that editor.
describe('side chat panel lifecycle', () => {
  let close: (() => Promise<boolean>) | null;
  const ctx = { sessionId: 'parent', tabId: 'tab', setCloseInterceptor: (fn: () => Promise<boolean>) => { close = fn; return () => { close = null; }; } } as unknown as TabKindHostContext;
  beforeEach(() => {
    vi.clearAllMocks(); close = null; mocks.detached = false;
    __resetPendingSideChatsForTest();
    mocks.confirm.mockResolvedValue(false); mocks.status.mockResolvedValue(undefined);
    mocks.subscribe.mockReturnValue(() => {});
    mocks.closeTab.mockResolvedValue(undefined);
    mocks.invoke.mockResolvedValue({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model', status: 'active' });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      deviceLink: { invoke: mocks.invoke, onRemotePush: mocks.subscribe },
      localDb: { sessions: { get: vi.fn().mockResolvedValue({ id: 'child', parentSessionId: 'parent', source: 'side-chat', status: 'active' }), archiveLinkedSideChat: mocks.archive }, sessionsPush: { onPatched: mocks.subscribe } },
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
      resolve({ id: 'child', parentSessionId: 'parent', source: 'side-chat', model: 'old-model', status: 'active' });
    });
    const editor = JSON.parse(screen.getByTestId('editor').textContent!);
    expect(editor).toMatchObject({
      sessionIdProp: 'child', navigationMode: 'sidebar-embedded', sidebarTargetSessionId: 'parent',
      sessionSnapshotProp: { id: 'child', model: 'new-model', deviceLinkDeviceId: 'host' },
      viewVisible: true, chatRealtime: true,
    });
    expect(screen.queryByRole('button', { name: 'chat.sideChat.viewCollaboration' })).toBeNull();
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

  // Unit: a recovered linked tab derives the dialog from persisted metadata.
  it('deduplicates linked close confirmation and submits the owning parent', async () => {
    vi.mocked(window.electronAPI.localDb.sessions.get).mockResolvedValue({
      id: 'child', parentSessionId: 'parent', source: 'desktop', sideChatPromoted: true, orcaRole: 'lead', status: 'active',
    } as Awaited<ReturnType<typeof window.electronAPI.localDb.sessions.get>>);
    mocks.confirm.mockResolvedValue(true);
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: null }} ctx={ctx} active />); });
    await expect(Promise.all([close!(), close!()])).resolves.toEqual([true, true]);
    expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      description: 'chat.sideChat.closeDescriptionRunning',
    }));
    expect(mocks.archive).toHaveBeenCalledExactlyOnceWith('child', 'parent');
    expect(mocks.status).not.toHaveBeenCalled();
  });

  // Unit: the real mounted remote panel must distinguish a missing role from an
  // explicit end. A promotion push can arrive before the initial metadata read.
  it('opens the same remote conversation after collaboration ends and restores reveal when it restarts', async () => {
    let resolve!: (value: unknown) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />);
    const push = (patch: Record<string, unknown>) => mocks.subscribe.mock.calls[0][0]({
      deviceId: 'host', channel: 'local-db:sessions:patched', payload: { sessionId: 'child', patch },
    });
    const openName = 'chat.sideChat.openConversation';
    const viewName = 'chat.sideChat.viewCollaboration';
    await act(async () => push({ sideChatPromoted: true }));
    expect(screen.queryByRole('button', { name: openName })).toBeNull();
    await act(async () => resolve({ id: 'child', parentSessionId: 'parent', source: 'desktop', sideChatPromoted: true, orcaRole: 'lead' }));
    expect(screen.getByRole('button', { name: viewName })).toBeTruthy();

    await act(async () => push({ orcaRole: null }));
    expect(screen.queryByRole('button', { name: viewName })).toBeNull();
    expect(screen.getByText('chat.sideChat.openFromTaskList')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: openName }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/cc-agent/child?device=host');

    await act(async () => push({ orcaRole: 'lead' }));
    expect(screen.queryByText('chat.sideChat.openFromTaskList')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: viewName }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/cc-agent/child?device=host', {
      state: { orcaWorkersReveal: { leadSessionId: 'child' } },
    });
  });

  it('opens the editor after retrying a failed metadata read', async () => {
    mocks.invoke.mockRejectedValueOnce(new Error('offline'));
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    expect(screen.queryByTestId('editor')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' })); });
    expect(screen.getByTestId('editor')).toBeTruthy();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('does not confirm ordinary deletion and preserves the conditional delete on failure', async () => {
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    mocks.status.mockRejectedValueOnce(new Error('offline'));
    await expect(close!()).resolves.toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.status).toHaveBeenCalledExactlyOnceWith('child', 'deleted', { kind: 'device-link', deviceId: 'host' }, undefined, 'side-chat');
  });

  // Unit: a lost delete race must stop and get consent before any archive write.
  it('confirms the archive when a guarded delete finds that the task has since linked', async () => {
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    const linked = { id: 'child', parentSessionId: 'parent', sideChatPromoted: true, orcaRole: 'lead', status: 'active' };
    mocks.status.mockImplementationOnce(async () => {
      mocks.invoke.mockResolvedValue(linked);
      throw new Error('[PRECONDITION_FAILED] Task is linked');
    });
    await expect(close!()).resolves.toBe(false);
    expect(mocks.status).toHaveBeenCalledTimes(1);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.some(([, channel]) => channel === 'local-db:sessions:patch-meta')).toBe(false);
  });

  it('retries the scoped archive when reload sees a persisted archive with a still-active Lead', async () => {
    const snapshot = {
      id: 'child', parentSessionId: 'parent', source: 'desktop', sideChatPromoted: true,
      orcaRole: 'lead', status: 'archived',
    };
    mocks.invoke.mockImplementation(async (_device, channel) => channel === 'local-db:sessions:get' ? snapshot : undefined);
    mocks.confirm.mockResolvedValue(true).mockResolvedValueOnce(false);
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    expect(mocks.closeTab).not.toHaveBeenCalled();
    await expect(close!()).resolves.toBe(false);
    expect(mocks.invoke.mock.calls.some(([, channel]) => channel === 'local-db:sessions:patch-meta')).toBe(false);
    await act(async () => {
      await expect(close!()).resolves.toBe(true);
    });
    expect(mocks.invoke).toHaveBeenCalledWith('host', 'local-db:sessions:patch-meta', [
      'child', { status: 'archived', archiveSideChatParentId: 'parent' },
    ]);
  });

  it('does not send a close intent for an archived tab without a confirmation', async () => {
    const archived = { id: 'child', parentSessionId: 'parent', source: 'desktop', sideChatPromoted: true, orcaRole: null, status: 'archived' };
    mocks.invoke.mockResolvedValue(archived);
    await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
    await close!();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([, channel]) => channel === 'local-db:sessions:patch-meta')).toBe(false);
  });

  // Unit: explicitly unsupported and unknown outcomes both keep the tab. A later
  // explicit attempt sends the same scoped request, never an unguarded update.
  it.each(['[INVALID_PARAMS] field not allowed in patch-meta: archiveSideChatParentId', 'timed out'])(
    'preserves the remote follow-up and retries only after another click (%s)', async failure => {
      mocks.invoke.mockImplementation(async (_device, channel) => {
        if (channel === 'local-db:sessions:get') return {
          id: 'child', parentSessionId: 'parent', sideChatPromoted: true, orcaRole: null, status: 'active',
        };
        throw new Error(failure);
      });
      mocks.confirm.mockResolvedValue(true);
      await act(async () => { render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />); });
      await expect(close!()).resolves.toBe(false);
      expect(mocks.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        description: 'chat.sideChat.closeDescription',
      }));
      await expect(close!()).resolves.toBe(false);
      const writes = mocks.invoke.mock.calls.filter(([, channel]) => channel === 'local-db:sessions:patch-meta');
      expect(writes).toHaveLength(2);
      expect(writes[0]).toEqual(['host', 'local-db:sessions:patch-meta', [
        'child', { status: 'archived', archiveSideChatParentId: 'parent' },
      ]]);
      expect(writes[1]).toEqual(writes[0]);
      expect(mocks.status).not.toHaveBeenCalled();
    },
  );

  it('shows a return action in the restricted sidebar window without mounting a chat editor', () => {
    mocks.detached = true;
    render(<SideChatTabBody state={{ sessionId: 'child', deviceId: 'host' }} ctx={ctx} active />);
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.getByText('chat.sideChat.returnToMain')).toBeTruthy();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  // Unit: optimistic pending side chat must mount the editor immediately and keep
  // the same mounted instance + draftKey when the host returns the forked child.
  it.each([null, 'host'])('mounts immediately while pending and keeps the same editor instance on resolution (%s)', async deviceId => {
    const draftKey = 'side-chat-pending:1';
    registerPendingSideChat({
      tabId: 'tab',
      draftKey,
      parentSessionId: 'parent',
      deviceId,
      previewSession: buildPreviewSideChatSession('parent', null, draftKey, deviceId),
      status: 'creating',
      childSession: null,
      hasTransferredAttachments: false,
    });
    const { rerender } = render(<SideChatTabBody state={{ sessionId: null, deviceId }} ctx={ctx} active />);
    const initialEditor = screen.getByTestId('editor');
    expect(JSON.parse(initialEditor.textContent!)).toMatchObject({
      sessionIdProp: draftKey,
      draftKeyProp: draftKey,
      awaitingSessionCreation: true,
      creationFailed: false,
    });

    // patchTabState paints the new tab metadata before the write is accepted.
    rerender(<SideChatTabBody state={{ sessionId: 'child', deviceId }} ctx={ctx} active />);
    expect(screen.getByTestId('editor')).toBe(initialEditor);
    expect(JSON.parse(initialEditor.textContent!)).toMatchObject({
      sessionIdProp: draftKey, awaitingSessionCreation: true,
    });

    await act(async () => {
      resolvePendingSideChat('tab', {
        id: 'child', parentSessionId: 'parent', source: 'side-chat', status: 'active', model: 'forked-model',
      } as Session);
    });
    rerender(<SideChatTabBody state={{ sessionId: 'child', deviceId }} ctx={ctx} active />);
    const resolvedEditor = screen.getByTestId('editor');
    expect(resolvedEditor).toBe(initialEditor);
    expect(JSON.parse(resolvedEditor.textContent!)).toMatchObject({
      sessionIdProp: 'child',
      draftKeyProp: draftKey,
      awaitingSessionCreation: false,
      creationFailed: false,
    });
  });

  it('surfaces retryable failure inline without unmounting the composer and cleans up on close', async () => {
    const onRetry = vi.fn();
    const draftKey = 'side-chat-pending:2';
    registerPendingSideChat({
      tabId: 'tab',
      draftKey,
      parentSessionId: 'parent',
      deviceId: null,
      previewSession: buildPreviewSideChatSession('parent', null, draftKey, null),
      status: 'creating',
      childSession: null,
      hasTransferredAttachments: true,
      onRetry,
    });
    render(<SideChatTabBody state={{ sessionId: null, deviceId: null }} ctx={ctx} active />);
    await act(async () => {
      failPendingSideChat('tab', 'chat.sideChat.notReady');
    });
    expect(screen.getByText('chat.sideChat.notReady')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('editor').textContent!)).toMatchObject({
      creationFailed: true,
      draftKeyProp: draftKey,
    });
    fireEvent.click(screen.getByRole('button', { name: 'commonUi.retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(close!()).resolves.toBe(true);
    });
    expect(mocks.clearDraft).toHaveBeenCalledWith(draftKey);
    expect(mocks.discardDraft).not.toHaveBeenCalled();
    expect(getPendingSideChat('tab')).toBeUndefined();
  });
});
