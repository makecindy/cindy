import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { makerChatStore } from '@/lib/makerChatStore';
import { clearSessionAttention, getSessionAttentionKind } from '@/lib/sessionAttentionStore';
import { openPluginTaskTab } from '@/features/right-sidebar/lib/openPluginTaskTab';
import { openUrlInSidebarBrowser } from '@/features/right-sidebar/lib/openInSidebarBrowser';

vi.mock('@/lib/sessionsBus', () => ({ emitPatch: vi.fn() }));
const windowRole = vi.hoisted(() => ({ secondary: false, sidebar: false }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => windowRole.secondary }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => windowRole.sidebar }));
vi.mock('@/features/right-sidebar/lib/openPluginTaskTab', () => ({ openPluginTaskTab: vi.fn(async () => {}) }));
vi.mock('@/features/right-sidebar/lib/openInSidebarBrowser', () => ({ openUrlInSidebarBrowser: vi.fn(async () => {}) }));
vi.mock('@/lib/toast', () => ({ toast: { info: vi.fn() } }));

const sessionId = 'make-ingress';
let created: (payload: unknown, ownerStamp?: unknown) => void;
let remote: (payload: unknown) => void;
let taskView: typeof created;
let preview: typeof created;
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
  vi.clearAllMocks();
  windowRole.secondary = false; windowRole.sidebar = false;
  setDataOwnerGeneration('make-owner', 1);
  const subscribe = () => () => {};
  vi.stubGlobal('window', {
    electronAPI: {
      ghosts: {
        onTaskViewOpen: (cb: typeof created) => { taskView = cb; return () => {}; },
        onPreviewOpen: (cb: typeof created) => { preview = cb; return () => {}; },
      },
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
  // 同一主进程广播只允许一个 renderer 落页签；原有消息点测试不覆盖插件开页。
  // 最小失败输入：副任务窗口收到 taskView/preview 广播（unit，无真实窗口）。
  it.each(['primary', 'secondary', 'sidebar'] as const)('routes plugin page broadcasts only in the primary renderer: %s', async (role) => {
    windowRole.secondary = role === 'secondary'; windowRole.sidebar = role === 'sidebar';
    taskView({ instanceId: 'sim', sessionId });
    preview({ name: 'Simulator', url: 'http://127.0.0.1:5000', sessionId });
    await Promise.resolve();
    expect(openPluginTaskTab).toHaveBeenCalledTimes(role === 'primary' ? 1 : 0);
    expect(openUrlInSidebarBrowser).toHaveBeenCalledTimes(role === 'primary' ? 1 : 0);
    if (role === 'primary')
      expect(openPluginTaskTab).toHaveBeenLastCalledWith(sessionId, 'sim', {
        userInitiated: false,
      });
    taskView({ instanceId: 'sim', sessionId, focus: true });
    await Promise.resolve();
    expect(openPluginTaskTab).toHaveBeenCalledTimes(role === 'primary' ? 2 : 0);
    if (role === 'primary')
      expect(openPluginTaskTab).toHaveBeenLastCalledWith(sessionId, 'sim', {
        userInitiated: true,
      });
  });
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
