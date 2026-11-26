/**
 * 测试价值
 * - 生产入口与可观察结果：createHomeContentFilter（Mobile 首页内容筛选），断言开启
 *   hideAutomations 后同步隐藏 scheduler、历史 `[Schedule] ` 前缀以及伙伴例行任务。
 * - Bug／规则依据：修复 Mobile homeContentFilters.ts 仅判断 source === 'scheduler' 导致的过滤遗漏。
 * - 现有覆盖缺口：此前无单测覆盖 legacy [Schedule] 与伙伴例行任务在 hideAutomations 下的行为。
 * - 最小失败输入：4 条最小 RemoteSessionListItem（普通、scheduler、[Schedule] 前缀、伙伴例行）。
 * - tier：unit（纯内存）。
 */

import { describe, expect, it } from 'vitest';

import { createHomeContentFilter } from '@/session/homeContentFilters';
import type { RemoteSessionListItem } from '@/session/sessionList';

function makeItem(id: string, sessionOverrides: Partial<RemoteSessionListItem['session']>): RemoteSessionListItem {
  return {
    session: {
      id,
      title: sessionOverrides.title ?? id,
      workingDir: '/repo',
      projectDir: '/repo',
      workspaceKind: 'project',
      model: 'claude-sonnet-4-6',
      status: 'active',
      agentKind: 'cc',
      source: 'desktop',
      userSendAt: '2026-11-26T10:00:00.000Z',
      createdAt: '2026-11-26T10:00:00.000Z',
      updatedAt: '2026-11-26T10:00:00.000Z',
      ...sessionOverrides,
    },
    title: sessionOverrides.title ?? id,
    subtitle: '',
    detail: '',
    lastActivityAt: '2026-11-26T10:00:00.000Z',
    pendingInteractionCount: 0,
    scheduleInfo: null,
  };
}

describe('Mobile homeContentFilters hideAutomations', () => {
  it('hides scheduler, legacy [Schedule] prefix, and teammate routine tasks consistently with grouping', () => {
    const filter = createHomeContentFilter({
      projects: 'all',
      vendor: 'all',
      lastActivity: 'all',
      teammates: 'all',
      hideAutomations: true,
    }, Date.parse('2026-11-26T12:00:00.000Z'));

    expect(filter).not.toBeNull();
    const items = [
      makeItem('ordinary', { title: 'User task' }),
      makeItem('scheduler', { title: 'Daily', source: 'scheduler' }),
      makeItem('legacy-sched', { title: '[Schedule] Nightly', source: 'desktop' }),
      makeItem('bot-routine', { title: 'Routine', source: 'bot', companion: { id: 'b1', role: 'routine', routineId: 'r1' } }),
      makeItem('bot-routine-no-id', { title: 'Routine old', source: 'bot', companion: { id: 'b1', role: 'routine' } }),
      makeItem('bot-chat', { title: 'Chat', source: 'bot', companion: { id: 'b1', role: 'conversation' } }),
    ];

    const kept = items.map((item) => filter!(item)).filter((item): item is RemoteSessionListItem => item !== null);
    expect(kept.map((item) => item.session.id)).toEqual(['ordinary', 'bot-chat']);
  });
});
