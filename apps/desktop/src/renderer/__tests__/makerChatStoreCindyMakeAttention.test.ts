import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearSessionAttention, getSessionAttentionKind } from '@/lib/sessionAttentionStore';

vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));

const sessionId = 'make-ingress';
let created: (payload: unknown, ownerStamp?: unknown) => void;
let remote: (payload: unknown) => void;
let leave: (() => void) | undefined;

function message(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'completion',
    clientId: 'completion',
    sessionId,
    role: 'assistant',
    content: '',
    createdAt: '2026-09-20T01:00:00.000Z',
    agentMeta: {
      cindyMakeCompletion: {
        reportedAt: 100,
        lastAction: 'build',
        personal: { status, buildId: 'build' },
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  setDataOwnerGeneration('make-owner', 1);
  const subscribe = () => () => {};
  vi.stubGlobal('window', {
    electronAPI: {
      maker: {
        onEvent: subscribe,
        onStatusChanged: subscribe,
        onInputProjection: subscribe,
        onInteractionRequest: subscribe,
        onInteractionDismissed: subscribe,
      },
      localDb: {
        messages: {
          onCreated: (cb: typeof created) => {
            created = cb;
            return () => {};
          },
        },
      },
      deviceLink: {
        onRemotePush: (cb: typeof remote) => {
          remote = cb;
          return () => {};
        },
      },
      onUsageMessageTurnCost: subscribe,
    },
  });
  makerChatStore.initGlobalListeners();
});

afterEach(() => {
  leave?.();
  leave = undefined;
  makerChatStore.purgeSession(sessionId);
  makerChatStore.__teardownGlobalListeners();
  clearSessionAttention(sessionId, { intent: 'explicit' });
  setDataOwnerGeneration(null);
  vi.unstubAllGlobals();
});

describe('Make result dots at the real message ingress', () => {
  it.each(['local', 'remote'])(
    'updates %s dots without mounting the card or running an Agent',
    (origin) => {
      const push = (status: string) => {
        const payload = { sessionId, message: message(status) };
        if (origin === 'local') created(payload);
        else remote({ channel: 'local-db:messages:created', payload });
      };
      push('packaging');
      push('failed');
      expect(getSessionAttentionKind(sessionId)).toBe('error');
      clearSessionAttention(sessionId);
      expect(getSessionAttentionKind(sessionId)).toBe('error');
      push('waiting');
      expect(getSessionAttentionKind(sessionId)).toBeUndefined();
      push('ready');
      expect(getSessionAttentionKind(sessionId)).toBe('done');
      clearSessionAttention(sessionId);
      push('ready');
      expect(getSessionAttentionKind(sessionId)).toBeUndefined();
      expect(makerChatStore.getSnapshot(sessionId).messages).toHaveLength(1);
    },
  );

  it('does not mark a viewed success unread, but does mark a viewed failure', () => {
    leave = makerChatStore.enterView(sessionId);
    created({ sessionId, message: message('ready') });
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    created({ sessionId, message: message('failed') });
    expect(getSessionAttentionKind(sessionId)).toBe('error');
  });

  it('ignores old-account pushes and updates to a card before a later user message', () => {
    created(
      { sessionId, message: message('failed') },
      { dataOwnerId: 'old-owner', ownerGeneration: 0 },
    );
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
    created({ sessionId, message: message('packaging') });
    created({
      sessionId,
      message: message('packaging', {
        id: 'new-user',
        clientId: 'new-user',
        role: 'user',
        content: 'continue',
        agentMeta: null,
      }),
    });
    created({ sessionId, message: message('failed') });
    expect(getSessionAttentionKind(sessionId)).toBeUndefined();
  });
});
