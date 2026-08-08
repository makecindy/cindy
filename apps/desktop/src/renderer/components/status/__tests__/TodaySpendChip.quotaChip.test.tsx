// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeSubscriptionUsageSnapshot } from '../../../../shared/claudeSubscriptionUsage';
import type { RateLimitSnapshot } from '@/hooks/useAccountUsage';

const mocks = vi.hoisted(() => ({
  claudeSnapshot: null as ClaudeSubscriptionUsageSnapshot | null,
  accountUsage: null as RateLimitSnapshot | null,
  displaySnapshot: { messages: [] as Array<Record<string, unknown>> },
  openExternal: vi.fn(() => Promise.resolve()),
  refreshCodexRateLimits: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'zh-CN', resolvedLanguage: 'zh-CN' },
    t: (key: string, options: Record<string, string | number> = {}) => {
      const templates: Record<string, string> = {
        'todaySpend.openClaudeUsage': '打开 Claude 用量页面',
        'todaySpend.claude.weeklyLabel': '周限',
        'todaySpend.claude.modelWeeklyLabel': '{{model}} 周限',
        'todaySpend.claude.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.claude.limitWarning': '接近套餐限额',
        'todaySpend.claude.limitRejected': '已触发套餐限额，请求可能被拒绝',
        'todaySpend.codex.limitWindow': '限额',
        'todaySpend.codex.windowSegment': '{{label}} 剩余 {{remaining}}',
        'todaySpend.sessionCostLabel': '本任务 {{cost}}',
        'todaySpend.unit.day': '天',
        'todaySpend.unit.hour': '小时',
        'todaySpend.unit.minute': '分钟',
        'todaySpend.unit.second': '秒',
      };
      return (templates[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) =>
        String(options[name] ?? ''),
      );
    },
  }),
}));

vi.mock('@/hooks/useApiKey', () => ({
  useApiKey: () => ({ hasSavedKey: false, isReconciling: false }),
}));
vi.mock('@/hooks/useClaudeOAuthConnected', () => ({
  useClaudeOAuthConnected: () => true,
}));
vi.mock('@/hooks/useClaudeSessionRoute', () => ({
  useClaudeSessionRoute: () => null,
}));
vi.mock('@/hooks/useSessionUsageMoney', () => ({
  useSessionUsageMoney: () => ({
    actualMoney: null,
    estimatedValueMoney: null,
    totalMoney: null,
  }),
}));
vi.mock('@/hooks/useSessionTokens', () => ({ useSessionTokens: () => null }));
vi.mock('@/hooks/useAccountUsage', () => ({
  requestCodexAccountRefresh: vi.fn(),
  useAccountUsage: () => mocks.accountUsage,
}));
vi.mock('@/hooks/useClaudeAccountUsage', () => ({ useClaudeAccountUsage: () => null }));
vi.mock('@/hooks/useModelAccessCreditUsage', () => ({ useModelAccessCreditUsage: () => null }));
vi.mock('@/hooks/useClaudeSubscriptionUsage', () => ({
  requestClaudeSubscriptionRefresh: vi.fn(),
  useClaudeSubscriptionUsage: () => mocks.claudeSnapshot,
}));
vi.mock('@/hooks/useCodexRuntimeRoute', () => ({
  useCodexRuntimeRoute: () => ({ authInjection: null }),
}));
vi.mock('@/hooks/useCodexRateLimits', () => ({
  useCodexRateLimits: () => ({
    snapshot: null,
    refresh: mocks.refreshCodexRateLimits,
  }),
}));
vi.mock('@/hooks/useXaiRateLimit', () => ({ useXaiRateLimit: () => null }));
vi.mock('@/components/chat/ChatDisplaySnapshotContext', () => ({
  useChatDisplaySnapshot: () => mocks.displaySnapshot,
}));
vi.mock('@/lib/makerChatStore', () => ({
  makerChatStore: {
    getSnapshot: () => mocks.displaySnapshot,
    subscribe: () => () => undefined,
  },
}));

import { TodaySpendChip } from '../TodaySpendChip';

const NOW_MS = Date.UTC(2026, 7, 2, 0, 0, 0);
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function setClaudeUsage(fiveHourUsed: number, weeklyUsed: number) {
  mocks.claudeSnapshot = {
    source: 'oauth-endpoint',
    subscriptionType: 'max',
    fiveHour: {
      utilization: fiveHourUsed,
      resetsAt: (NOW_MS + 5 * HOUR_MS) / 1000,
    },
    sevenDay: {
      utilization: weeklyUsed,
      resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
    },
  };
}

function renderClaudeSubscriptionChip() {
  return render(
    <TodaySpendChip
      vendorKey="cc"
      providerId="anthropic"
      modelId="claude-opus-5[1m]"
      sessionId="session-1"
    />,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  mocks.accountUsage = null;
  mocks.displaySnapshot.messages = [];
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { openExternal: mocks.openExternal },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('TodaySpendChip Claude 订阅额度段着色', () => {
  it('正常段不着色，且完整保留原有动态倒计时文字', () => {
    setClaudeUsage(1, 4);
    const { container } = renderClaudeSubscriptionChip();

    const segments = Array.from(container.querySelectorAll<HTMLElement>('[data-quota-severity]'));
    expect(segments.map((segment) => segment.textContent)).toEqual([
      '5小时 剩余 99%',
      '6天 剩余 96%',
    ]);
    expect(segments.every((segment) => segment.dataset.quotaSeverity === 'normal')).toBe(true);
    expect(segments.every((segment) => !segment.getAttribute('class'))).toBe(true);
    expect(container.querySelector('[data-quota-critical-dot]')).toBeNull();

    const text = screen.getByRole('button', { name: '打开 Claude 用量页面' }).textContent ?? '';
    expect(text).toContain('5小时 剩余 99%');
    expect(text).toContain('6天 剩余 96%');
    expect(text).not.toContain('5h');
    expect(text).not.toContain('周');
  });

  it('76% 已用量只把对应段染成琥珀色，不显示圆点', () => {
    setClaudeUsage(76, 20);
    const { container } = renderClaudeSubscriptionChip();

    const warningSegment = container.querySelector<HTMLElement>('[data-quota-severity="warn"]');
    expect(warningSegment?.textContent).toBe('5小时 剩余 24%');
    expect(warningSegment?.className).toContain('text-[var(--quota-bar-warn)]');
    expect(
      screen.getByRole('button', {
        name: '打开 Claude 用量页面 接近套餐限额',
      }),
    ).toBeTruthy();
    expect(container.querySelector('[data-quota-critical-dot]')).toBeNull();
  });

  it('可见窗口利用率 50% 但服务端为 warning 时段显示琥珀色且不重复整 chip 告警', () => {
    setClaudeUsage(50, 20);
    mocks.claudeSnapshot!.fiveHour!.severity = 'warning';
    const { container } = renderClaudeSubscriptionChip();

    const warningSegment = container.querySelector<HTMLElement>('[data-quota-severity="warn"]');
    expect(warningSegment?.textContent).toBe('5小时 剩余 50%');
    expect(warningSegment?.className).toContain('text-[var(--quota-bar-warn)]');
    expect(warningSegment?.getAttribute('aria-label')).toBe('5小时 剩余 50% 接近套餐限额');
    expect(screen.getByRole('button', { name: /打开 Claude 用量页面/ }).className).not.toContain(
      '--error-fg',
    );
  });

  it('可见窗口利用率 50% 但服务端为 critical 时段显示红色', () => {
    setClaudeUsage(50, 20);
    mocks.claudeSnapshot!.fiveHour!.severity = 'critical';
    const { container } = renderClaudeSubscriptionChip();

    const criticalSegment = container.querySelector<HTMLElement>('[data-quota-severity="crit"]');
    expect(criticalSegment?.textContent).toBe('5小时 剩余 50%');
    expect(criticalSegment?.className).toContain('text-[var(--quota-bar-crit)]');
    expect(criticalSegment?.getAttribute('aria-label')).toBe(
      '5小时 剩余 50% 已触发套餐限额，请求可能被拒绝',
    );
    expect(screen.getByRole('button', { name: /打开 Claude 用量页面/ }).className).not.toContain(
      '--error-fg',
    );
  });

  it('可见窗口利用率 50% 且服务端等级缺省时保持普通段', () => {
    setClaudeUsage(50, 20);
    const { container } = renderClaudeSubscriptionChip();

    const normalSegment = container.querySelector<HTMLElement>('[data-quota-severity="normal"]');
    expect(normalSegment?.textContent).toBe('5小时 剩余 50%');
    expect(normalSegment?.getAttribute('class')).toBeNull();
    expect(normalSegment?.getAttribute('aria-label')).toBeNull();
  });

  it('93% 已用量只把对应段染红，不叠加圆点等附加装饰(维护者产品结论)', () => {
    setClaudeUsage(93, 20);
    const { container } = renderClaudeSubscriptionChip();

    const criticalSegment = container.querySelector<HTMLElement>('[data-quota-severity="crit"]');
    expect(criticalSegment?.textContent).toBe('5小时 剩余 7%');
    expect(criticalSegment?.className).toContain('text-[var(--quota-bar-crit)]');
    expect(
      screen.getByRole('button', {
        name: '打开 Claude 用量页面 已触发套餐限额，请求可能被拒绝',
      }),
    ).toBeTruthy();

    // 2026-08-05 dashhuang APPROVE 附带结论:红色段前不再叠加红点。
    expect(container.querySelector('[data-quota-critical-dot]')).toBeNull();

    const normalSegment = container.querySelector<HTMLElement>('[data-quota-severity="normal"]');
    expect(normalSegment?.textContent).toBe('6天 剩余 80%');
    expect(normalSegment?.getAttribute('class')).toBeNull();
    expect(normalSegment?.parentElement?.querySelector('[data-quota-critical-dot]')).toBeNull();
    expect(screen.getByRole('button', { name: /打开 Claude 用量页面/ }).className).not.toContain(
      '--error-fg',
    );
  });

  it('可见段仅为警告色但隐藏总周限已严重告警时保留整 chip 告警兜底', () => {
    setClaudeUsage(76, 95);
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 20,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    const segments = Array.from(container.querySelectorAll<HTMLElement>('[data-quota-severity]'));
    expect(segments).toHaveLength(2);
    expect(segments.map((segment) => segment.dataset.quotaSeverity)).toEqual(['warn', 'normal']);
    expect(container.textContent).toContain('5小时 剩余 24%');
    expect(container.textContent).toContain('Opus 6天 剩余 80%');
    expect(container.textContent).not.toContain('剩余 5%');
    // 兜底告警只染色不加段落，等级文案必须并入 trigger 可达名称供读屏播报。
    const button = screen.getByRole('button', {
      name: '打开 Claude 用量页面 接近套餐限额 已触发套餐限额，请求可能被拒绝',
    });
    expect(button.className).toContain('text-[var(--quota-bar-crit)]');
  });

  it('可见窗口均正常但隐藏总周限为 warning 时显示琥珀色兜底', () => {
    setClaudeUsage(20, 20);
    mocks.claudeSnapshot!.sevenDay!.severity = 'warning';
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 20,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    const segments = Array.from(container.querySelectorAll<HTMLElement>('[data-quota-severity]'));
    expect(segments.map((segment) => segment.dataset.quotaSeverity)).toEqual(['normal', 'normal']);
    const buttonClass = screen.getByRole('button', {
      name: '打开 Claude 用量页面 接近套餐限额',
    }).className;
    expect(buttonClass).toContain('text-[var(--quota-bar-warn)]');
    expect(buttonClass).not.toContain('--quota-bar-crit');
    expect(buttonClass).not.toContain('--error-fg');
  });

  it('rejected 状态在可见窗口均正常时仍显示红色兜底', () => {
    setClaudeUsage(20, 20);
    mocks.claudeSnapshot!.rateLimitStatus = 'rejected';
    const { container } = renderClaudeSubscriptionChip();

    const segments = Array.from(container.querySelectorAll<HTMLElement>('[data-quota-severity]'));
    expect(segments.map((segment) => segment.dataset.quotaSeverity)).toEqual(['normal', 'normal']);
    const buttonClass = screen.getByRole('button', {
      name: '打开 Claude 用量页面 已触发套餐限额，请求可能被拒绝',
    }).className;
    expect(buttonClass).toContain('text-[var(--quota-bar-crit)]');
    expect(buttonClass).not.toContain('--quota-bar-warn');
  });

  it('隐藏总周限利用率仅 50% 但服务端为 critical 时仍显示红色兜底', () => {
    setClaudeUsage(76, 50);
    mocks.claudeSnapshot!.sevenDay!.severity = 'critical';
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 20,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    expect(container.textContent).toContain('5小时 剩余 24%');
    expect(container.textContent).toContain('Opus 6天 剩余 80%');
    expect(container.textContent).not.toContain('周限 剩余 50%');
    expect(screen.getByRole('button', { name: /打开 Claude 用量页面/ }).className).toContain(
      'text-[var(--quota-bar-crit)]',
    );
  });

  it('隐藏总周限利用率 50% 且服务端为 normal 时保持原有警告段展示', () => {
    setClaudeUsage(76, 50);
    mocks.claudeSnapshot!.sevenDay!.severity = 'normal';
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 20,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    const warningSegment = container.querySelector<HTMLElement>('[data-quota-severity="warn"]');
    expect(warningSegment?.textContent).toBe('5小时 剩余 24%');
    expect(container.textContent).not.toContain('周限 剩余 50%');
    expect(screen.getByRole('button', { name: /打开 Claude 用量页面/ }).className).not.toContain(
      '--error-fg',
    );
  });

  it('当前模型 scoped 周限已有红色段时不重复显示整 chip 告警兜底', () => {
    setClaudeUsage(20, 95);
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 93,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    const criticalSegment = container.querySelector<HTMLElement>('[data-quota-severity="crit"]');
    expect(criticalSegment?.textContent).toBe('Opus 6天 剩余 7%');
    expect(criticalSegment?.className).toContain('text-[var(--quota-bar-crit)]');
    // 兜底被可见红段压制时，可达名称也只保留可见段的一份等级文案。
    expect(
      screen.getByRole('button', {
        name: '打开 Claude 用量页面 已触发套餐限额，请求可能被拒绝',
      }).className,
    ).not.toContain('--error-fg');
  });

  it('可见警告段与隐藏窗口的警告级告警等强时不重复显示整 chip 告警兜底', () => {
    setClaudeUsage(76, 20);
    mocks.claudeSnapshot!.sevenDay!.severity = 'warning';
    mocks.claudeSnapshot!.scoped = [
      {
        utilization: 20,
        modelDisplayName: 'Opus',
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    ];
    const { container } = renderClaudeSubscriptionChip();

    const warningSegment = container.querySelector<HTMLElement>('[data-quota-severity="warn"]');
    expect(warningSegment?.textContent).toBe('5小时 剩余 24%');
    expect(container.textContent).not.toContain('周限 剩余 80%');
    expect(
      screen.getByRole('button', { name: '打开 Claude 用量页面 接近套餐限额' }).className,
    ).not.toContain('--error-fg');
  });

  it('非 Claude 订阅计费形态不挂载额度严重度 span', () => {
    setClaudeUsage(93, 76);
    mocks.accountUsage = {
      primary: {
        usedPercent: 93,
        windowMinutes: 300,
        resetsAt: (NOW_MS + 5 * HOUR_MS) / 1000,
      },
      secondary: {
        usedPercent: 76,
        windowMinutes: 10_080,
        resetsAt: (NOW_MS + 6 * DAY_MS) / 1000,
      },
    };
    const { container } = render(
      <TodaySpendChip
        vendorKey="cc"
        providerId="openai"
        modelId="chatgpt/gpt-5.5"
        sessionId="session-1"
      />,
    );

    expect(container.textContent).toContain('5小时 剩余 7%');
    expect(container.textContent).toContain('6天 剩余 24%');
    expect(container.querySelector('[data-quota-severity]')).toBeNull();
    expect(container.querySelector('[data-quota-critical-dot]')).toBeNull();
  });
});
