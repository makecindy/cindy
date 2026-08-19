// @vitest-environment jsdom

/**
 * sidebarAttentionBadge.test.ts
 * ---------------------------------------------------------------------------
 * 回归覆盖：
 * - 右侧状态槽优先级必须是 error > awaiting > running > 完成未读(done)。
 *   error 与 awaiting 拆成两档(红 / TapTap 蓝),同为"需要处理"压过 spinner。
 * - plan / ask-user / permission prompt 可能在会话仍标记 running 时到达，
 *   左侧状态图标的关注状态点在这种状态下仍必须可见。
 */

import { createElement } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  projectSidebarSessionActivity,
  resolveSidebarRightStatus,
} from '../features/cc-agent/sidebar/sidebarRightStatus';
import { SessionStatusIcon } from '../features/cc-agent/sidebar/SessionStatusIcon';

const sidebarState = vi.hoisted(() => ({
  hasDraft: false,
  hasPausedQueue: false,
}));

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useComposerDraftPresence', () => ({
  useComposerDraftPresence: () => sidebarState.hasDraft,
}));

vi.mock('@/hooks/useSessionPausedQueue', () => ({
  useSessionPausedQueue: () => sidebarState.hasPausedQueue,
}));

vi.mock('@/components/sidebar/VendorIcon', () => ({
  VendorIcon: () => createElement('span', { 'data-testid': 'vendor-icon' }),
  agentKindToVendor: (kind: string | null | undefined) =>
    kind === 'codex' ? 'codex' : kind === 'pi' ? 'pi' : 'cc',
}));

afterEach(() => {
  cleanup();
  sidebarState.hasDraft = false;
  sidebarState.hasPausedQueue = false;
});

const session = {
  id: 'session-1',
  agentKind: 'cc',
  status: 'active',
} as Session;

function attentionDot(container: HTMLElement): Element | undefined {
  // SessionStatusIcon 的角标现在是 AttentionDot(全端统一色表:card-status-* token)。
  return Array.from(container.querySelectorAll('span')).find((node) => {
    const className = node.getAttribute('class') ?? '';
    return className.includes('bg-[var(--card-status-');
  });
}

describe('sidebar right status priority', () => {
  it('keeps error/awaiting above running and running above unread-done', () => {
    const resolve = (input: Parameters<typeof projectSidebarSessionActivity>[0]) =>
      resolveSidebarRightStatus(projectSidebarSessionActivity(input));
    // error(chat 侧错误终止)压过 running 与其它一切
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'error',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('error');
    const runningWithStaleError = projectSidebarSessionActivity({
      sessionId: 'session-1',
      attentionKind: 'error',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    });
    expect(runningWithStaleError).toMatchObject({
      phase: 'error',
      attention: true,
      currentTurnActive: true,
    });
    expect(resolveSidebarRightStatus(runningWithStaleError)).toBe('error');
    // device-link 镜像可以同时保留 stale error 与新一轮运行 facet；本地
    // isRunning 对远程会话恒 false，仍须让左侧 vendor mark 保持呼吸。
    const remoteRunningWithStaleError = projectSidebarSessionActivity({
      sessionId: 'remote-session',
      liveActivity: {
        phase: 'error',
        currentTurnActive: true,
        source: 'live',
      },
      attentionKind: undefined,
      isUrgentFromContext: true,
      isRunning: false,
      hasAttentionNotification: false,
    });
    expect(remoteRunningWithStaleError).toMatchObject({
      phase: 'error',
      attention: true,
      currentTurnActive: true,
    });
    expect(resolveSidebarRightStatus(remoteRunningWithStaleError)).toBe('error');
    // 定时任务失败未读(attentionKind 缺失,由 urgency context 注入)同样是 error 档
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: undefined,
      isUrgentFromContext: true,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('error');
    expect(projectSidebarSessionActivity({
      sessionId: 'session-1',
      liveActivity: { phase: 'running' },
      attentionKind: undefined,
      isUrgentFromContext: true,
      isRunning: false,
      hasAttentionNotification: false,
    })).toMatchObject({
      phase: 'error',
      attention: true,
      currentTurnActive: true,
    });
    // automation failure urgency is durable outside the notification store:
    // after restart, unread expiry or acknowledgement it must still stay red.
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: undefined,
      isUrgentFromContext: true,
      isRunning: false,
      hasAttentionNotification: false,
    })).toBe('error');
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'done',
      isUrgentFromContext: true,
      isRunning: false,
      hasAttentionNotification: false,
    })).toBe('error');
    // awaiting(ask-user / 权限 / 计划审阅)压过 running,但低于 error
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'awaiting',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('awaiting');
    // running 压过完成未读
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'done',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('running');
    // 完成未读(含 attentionKind 缺失的定时任务未读)→ done
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'done',
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: true,
    })).toBe('done');
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: undefined,
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: true,
    })).toBe('done');
    // 没有任何 attention → time
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: undefined,
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: false,
    })).toBe('time');
    // attention 已被查看清零(hasAttentionNotification=false)时,残留 kind 不生效
    expect(resolve({
      sessionId: 'session-1',
      attentionKind: 'error',
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: false,
    })).toBe('time');
  });
});

describe('sidebar attention badge', () => {
  it('renders attention badge while the session is running', () => {
    const { container } = render(
      createElement(SessionStatusIcon, {
        session,
        isRunning: true,
        isAttached: false,
        hasAttentionNotification: true,
        isActive: false,
      }),
    );

    expect(attentionDot(container)).toBeDefined();
  });

  it('does not render attention badge when there is no notification', () => {
    const { container } = render(
      createElement(SessionStatusIcon, {
        session,
        isRunning: true,
        isAttached: false,
        hasAttentionNotification: false,
        isActive: false,
      }),
    );

    expect(attentionDot(container)).toBeUndefined();
  });
});

describe('sidebar draft indicator', () => {
  it('uses the dedicated high-contrast color for unsent content', () => {
    sidebarState.hasDraft = true;

    const { getByTitle } = render(
      createElement(SessionStatusIcon, {
        session,
        isRunning: false,
        isAttached: false,
        hasAttentionNotification: false,
        isActive: false,
      }),
    );

    expect(getByTitle('ccAgent.sidebar.hasDraft').className).toContain(
      'text-[var(--sidebar-draft-indicator)]',
    );
  });
});
