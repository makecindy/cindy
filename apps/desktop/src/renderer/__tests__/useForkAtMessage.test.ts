// @vitest-environment jsdom
/**
 * useForkAtMessage.test.ts — fork action gating.
 * Running sessions may still fork from stable history; only the target message
 * itself being unstable should block the action.
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';

const navigate = vi.hoisted(() => vi.fn());
const forkAtMessage = vi.hoisted(() => vi.fn());
const saveDraft = vi.hoisted(() => vi.fn());
const emitRefresh = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const getSessionDeviceId = vi.hoisted(() => vi.fn());
const refreshRemoteDeviceSessions = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());
const confirmThree = vi.hoisted(() => vi.fn());
const getForkCapabilities = vi.hoisted(() => vi.fn());
const requestFork = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/lib/httpClient', () => ({
  ApiError: class ApiError extends Error {
    code: string;

    constructor(code = 'UNKNOWN', status = 0, message = code) {
      super(message);
      void status;
      this.code = code;
    }
  },
}));

vi.mock('@/lib/sessionService', () => ({
  forkAtMessage, getForkCapabilities, requestFork,
}));
vi.mock('../components/chat/ForkTargetPicker', () => ({ ForkTargetPicker: () => null }));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft,
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError, success: vi.fn() },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@/features/device-link/remoteProjectsStore', () => ({
  getSessionDeviceId,
}));

vi.mock('@/features/device-link/refreshRemoteSessions', () => ({
  refreshRemoteDeviceSessions,
}));

vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm, confirmThree }),
}));

import { useForkAtMessage } from '../components/chat/useForkAtMessage';
import { SessionNavigationModeProvider } from '../features/cc-agent/embeddedSessionNavigation';
import { ApiError } from '@/lib/httpClient';

describe('useForkAtMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    forkAtMessage.mockResolvedValue({ id: 'forked-session' });
    getSessionDeviceId.mockReturnValue(undefined);
    confirm.mockResolvedValue(true);
    getForkCapabilities.mockResolvedValue({});
    confirmThree.mockResolvedValue('cancel');
  });

  // Lost replies previously left callers with only a failure toast and an unsafe
  // second fork. These unit cases mount the real hook and observe creation IDs,
  // explicit selection, navigation and stale-result rejection.
  it('finds a pending fork with the same request and navigates once', async () => {
    getForkCapabilities.mockResolvedValue({ forkRequestVersion: 1, historyHandoff: true });
    requestFork.mockResolvedValueOnce({ state: 'pending' })
      .mockResolvedValueOnce({ state: 'complete', session: { id: 'found-child' }, outcome: 'native' });
    confirmThree.mockResolvedValueOnce('confirm');
    const { result } = renderHook(() => useForkAtMessage({ sessionId: 'source', messageClientId: 'anchor' }));
    await act(async () => { await result.current(); });
    const [create, status] = requestFork.mock.calls.map(call => call[0]);
    expect(create.action).toBe('create');
    expect(status).toEqual({ ...create, action: 'status' });
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/found-child');
    expect(forkAtMessage).not.toHaveBeenCalled();
  });

  it('requires an explicit model choice before recovering an unavailable history', async () => {
    getForkCapabilities.mockResolvedValue({ forkRequestVersion: 1, historyHandoff: true });
    requestFork.mockRejectedValueOnce(new Error('[REMOTE_AGENT_UNAVAILABLE] offline'))
      .mockResolvedValueOnce({ state: 'complete', session: { id: 'handoff-child' }, outcome: 'history-handoff' });
    confirmThree.mockResolvedValueOnce('tertiary');
    const target = { agentKind: 'pi', model: 'model-c', providerId: 'provider-c', agentDeviceId: null };
    confirm.mockImplementation(async options => {
      if (options.content) options.content.props.onChange(target);
      return true;
    });
    const { result } = renderHook(() => useForkAtMessage({ sessionId: 'source', messageClientId: 'anchor' }));
    await act(async () => { await result.current(); });
    const [native, recovery] = requestFork.mock.calls.map(call => call[0]);
    expect(native.target).toBeUndefined();
    expect(recovery.target).toEqual(target);
    expect(recovery.requestId).not.toBe(native.requestId);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/handoff-child');
  });

  it('keeps the committed request when remote navigation preparation fails', async () => {
    // The host already committed; a list-read failure is not a second create.
    getForkCapabilities.mockResolvedValue({ forkRequestVersion: 1 });
    getSessionDeviceId.mockReturnValue('task-computer');
    requestFork.mockResolvedValue({ state: 'complete', session: { id: 'existing-child' }, outcome: 'native' });
    refreshRemoteDeviceSessions.mockRejectedValueOnce(new Error('list response lost'));
    const { result } = renderHook(() => useForkAtMessage({ sessionId: 'source', messageClientId: 'anchor' }));
    await act(async () => { await expect(result.current()).rejects.toThrow('list response lost'); });
    await act(async () => { await result.current(); });
    expect(requestFork.mock.calls[1]![0].requestId).toBe(requestFork.mock.calls[0]![0].requestId);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/existing-child');
  });

  it('ignores a reply after switching the source task', async () => {
    getForkCapabilities.mockResolvedValue({ forkRequestVersion: 1 });
    let finish!: (value: unknown) => void;
    requestFork.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { result, rerender } = renderHook(({ id }) => useForkAtMessage({ sessionId: id, messageClientId: 'anchor' }),
      { initialProps: { id: 'first' } });
    let running!: Promise<void>;
    await act(async () => { running = result.current(); });
    rerender({ id: 'second' });
    await act(async () => { finish({ state: 'complete', session: { id: 'old-child' } }); await running; });
    expect(navigate).not.toHaveBeenCalled();
    expect(saveDraft).not.toHaveBeenCalled();
  });
  it('reuses the pending request ID after reopening the source task', async () => {
    getForkCapabilities.mockResolvedValue({ forkRequestVersion: 1, historyHandoff: true });
    requestFork.mockResolvedValueOnce({ state: 'unknown' })
      .mockResolvedValueOnce({ state: 'complete', session: { id: 'found-after-reopen' }, outcome: 'native' });
    const first = renderHook(() => useForkAtMessage({ sessionId: 'source', messageClientId: 'anchor' }));
    await act(async () => { await first.result.current(); });
    const initial = requestFork.mock.calls[0]![0];
    first.unmount();
    const reopened = renderHook(() => useForkAtMessage({ sessionId: 'source', messageClientId: 'anchor' }));
    await act(async () => { await reopened.result.current(); });
    expect(requestFork.mock.calls[1]![0].requestId).toBe(initial.requestId);
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/cc-agent/found-after-reopen');
  });

  it('forks when the target history message is stable', async () => {
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
        draftText: 'by the way',
      }),
    );

    await act(async () => {
      await result.current();
    });

    expect(forkAtMessage).toHaveBeenCalledWith('source-session', 'message-1');
    expect(saveDraft).toHaveBeenCalledWith('forked-session', {
      text: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'by the way' }],
          },
        ],
      },
      attachments: [],
    });
    expect(emitRefresh).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/cc-agent/forked-session');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('carries parsed quotes into the prefilled draft as inline chips', async () => {
    const draftDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: {
                text: 'quoted line',
                sourcePath: 'src/a.ts',
                startLine: null,
                endLine: null,
              },
            },
            { type: 'text', text: 'body' },
          ],
        },
      ],
    };
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
        draftDocument,
      }),
    );

    await act(async () => {
      await result.current();
    });

    expect(saveDraft).toHaveBeenCalledWith('forked-session', {
      text: draftDocument,
      attachments: [],
    });
  });

  it('prefills quote-only messages (empty body must not skip saveDraft)', async () => {
    const draftDocument = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'composerQuote',
              attrs: {
                text: 'only quote',
                sourcePath: null,
                startLine: null,
                endLine: null,
              },
            },
          ],
        },
      ],
    };
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
        draftDocument,
      }),
    );

    await act(async () => {
      await result.current();
    });

    expect(saveDraft).toHaveBeenCalledWith('forked-session', {
      text: draftDocument,
      attachments: [],
    });
  });

  it('blocks when the target message itself is unstable', async () => {
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
        forkBlocked: true,
      }),
    );

    await act(async () => {
      await result.current();
    });

    expect(forkAtMessage).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('chat.userMessage.forkBusy');
  });

  it('does not fork or navigate from a sidebar-embedded session view', async () => {
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(SessionNavigationModeProvider, { mode: 'sidebar-embedded', children });
    const { result } = renderHook(
      () =>
        useForkAtMessage({
          sessionId: 'worker-session',
          messageClientId: 'message-1',
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current();
    });

    expect(forkAtMessage).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the Codex state diagnostic when fork preparation fails', async () => {
    forkAtMessage.mockRejectedValueOnce(
      new ApiError('CODEX_FORK_STATE_UNAVAILABLE', 0, 'rollout missing'),
    );
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
      }),
    );

    await act(async () => {
      await expect(result.current()).rejects.toThrow('rollout missing');
    });

    expect(toastError).toHaveBeenCalledWith('chat.userMessage.forkErrors.codexStateUnavailable');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('shows the localized retry message when safe fork preparation is blocked', async () => {
    forkAtMessage.mockRejectedValueOnce(
      new ApiError('CODEX_FORK_STATE_UNAVAILABLE', 0, CODEX_RESUME_NOT_READY_WIRE_MESSAGE),
    );
    const { result } = renderHook(() =>
      useForkAtMessage({
        sessionId: 'source-session',
        messageClientId: 'message-1',
      }),
    );

    await act(async () => {
      await expect(result.current()).rejects.toThrow(CODEX_RESUME_NOT_READY_WIRE_MESSAGE);
    });

    expect(toastError).toHaveBeenCalledWith('chat.errorBanner.codexResumeNotReady');
    expect(toastError).not.toHaveBeenCalledWith(
      'chat.userMessage.forkErrors.codexStateUnavailable',
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
