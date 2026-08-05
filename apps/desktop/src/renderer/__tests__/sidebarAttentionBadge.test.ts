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
import { resolveSidebarRightStatus } from '../features/cc-agent/sidebar/sidebarRightStatus';
import { SessionStatusIcon } from '../features/cc-agent/sidebar/SessionStatusIcon';

vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: vi.fn(),
  },
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useComposerDraftPresence', () => ({
  useComposerDraftPresence: () => false,
}));

vi.mock('@/hooks/useSessionPausedQueue', () => ({
  useSessionPausedQueue: () => false,
}));

vi.mock('@/components/sidebar/VendorIcon', () => ({
  VendorIcon: () => createElement('span', { 'data-testid': 'vendor-icon' }),
}));

afterEach(() => {
  cleanup();
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
    // error(chat 侧错误终止)压过 running 与其它一切
    expect(resolveSidebarRightStatus({
      attentionKind: 'error',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('error');
    // 定时任务失败未读(attentionKind 缺失,由 urgency context 注入)同样是 error 档
    expect(resolveSidebarRightStatus({
      attentionKind: undefined,
      isUrgentFromContext: true,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('error');
    // awaiting(ask-user / 权限 / 计划审阅)压过 running,但低于 error
    expect(resolveSidebarRightStatus({
      attentionKind: 'awaiting',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('awaiting');
    // running 压过完成未读
    expect(resolveSidebarRightStatus({
      attentionKind: 'done',
      isUrgentFromContext: false,
      isRunning: true,
      hasAttentionNotification: true,
    })).toBe('running');
    // 完成未读(含 attentionKind 缺失的定时任务未读)→ done
    expect(resolveSidebarRightStatus({
      attentionKind: 'done',
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: true,
    })).toBe('done');
    expect(resolveSidebarRightStatus({
      attentionKind: undefined,
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: true,
    })).toBe('done');
    // 没有任何 attention → time
    expect(resolveSidebarRightStatus({
      attentionKind: undefined,
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: false,
    })).toBe('time');
    // attention 已被查看清零(hasAttentionNotification=false)时,残留 kind 不生效
    expect(resolveSidebarRightStatus({
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
