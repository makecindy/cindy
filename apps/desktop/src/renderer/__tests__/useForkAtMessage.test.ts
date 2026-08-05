// @vitest-environment jsdom
/**
 * useForkAtMessage.test.ts — fork action gating.
 * Running sessions may still fork from stable history; only the target message
 * itself being unstable should block the action.
 */
import { act, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigate = vi.hoisted(() => vi.fn());
const forkAtMessage = vi.hoisted(() => vi.fn());
const saveDraft = vi.hoisted(() => vi.fn());
const emitRefresh = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const getSessionDeviceId = vi.hoisted(() => vi.fn());
const refreshRemoteDeviceSessions = vi.hoisted(() => vi.fn());
const confirm = vi.hoisted(() => vi.fn());

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
  forkAtMessage,
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft,
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitRefresh,
}));

vi.mock('@/lib/toast', () => ({
  toast: { error: toastError },
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
  useConfirmDialog: () => ({ confirm }),
}));

import { useForkAtMessage } from '../components/chat/useForkAtMessage';
import { SessionNavigationModeProvider } from '../features/cc-agent/embeddedSessionNavigation';
import { ApiError } from '@/lib/httpClient';

describe('useForkAtMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    forkAtMessage.mockResolvedValue({ id: 'forked-session' });
    getSessionDeviceId.mockReturnValue(undefined);
    confirm.mockResolvedValue(true);
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
});
