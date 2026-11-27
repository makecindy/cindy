/**
 * 测试价值
 * - 生产入口与可观察结果：filterSidebarTasks、sidebarContentFilterCount 与 loadHideTaskCreated /
 *   persistHideTaskCreated，断言侧栏筛选隐藏哪些任务及生效维度计数。
 * - Bug／规则依据：修复「隐藏自动化任务」此前只判断 source === 'scheduler' 导致漏掉历史 `[Schedule] `
 *   前缀任务与伙伴例行任务（companion.role === 'routine'）的缺陷，并验证新增「隐藏由其他任务创建的任务」筛选。
 * - 现有覆盖缺口：sidebarTaskFilters.ts 此前无独立单测覆盖 legacy [Schedule] 与伙伴例行任务。
 * - 最小失败输入：包含普通任务、scheduler、legacy `[Schedule] `、伙伴例行（带/不带 routineId）、
 *   伙伴普通对话、createdBySession 任务和 orcaRemoteLead 任务的最小列表。
 * - tier：unit（纯内存，无 React/DOM）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  loadHideTaskCreated,
  persistHideTaskCreated,
  sidebarContentFilterCount,
} from '../../hooks/helpers/sidebarFilterCore';
import { filterSidebarTasks } from '../sidebarTaskFilters';

function makeSession(overrides: Partial<Session> & { id: string }): Session {
  return {
    userId: '',
    title: overrides.id,
    workingDir: '/repo',
    projectDir: '/repo',
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: '2026-11-26T10:00:00.000Z',
    agentKind: 'cc',
    source: 'desktop',
    orcaRole: null,
    parentSessionId: null,
    forkedAtMessageId: null,
    worktreePath: null,
    usedProjectContext: false,
    extraDirs: [],
    createdAt: '2026-11-26T10:00:00.000Z',
    updatedAt: '2026-11-26T10:00:00.000Z',
    ...overrides,
  };
}

const emptyCreators = new Map<string, ReadonlySet<string>>();

describe('filterSidebarTasks', () => {
  it('hides scheduler, legacy [Schedule] prefix, and teammate routine tasks when hideAutomations is enabled', () => {
    const tasks: Session[] = [
      makeSession({ id: 'user-task', title: 'Normal work' }),
      makeSession({ id: 'sched-source', title: 'Daily digest', source: 'scheduler' }),
      makeSession({ id: 'sched-legacy', title: '[Schedule] Nightly build', source: 'desktop' }),
      makeSession({
        id: 'bot-routine',
        title: 'Morning check',
        source: 'bot',
        companion: { id: 'bot-1', role: 'routine', routineId: 'r-1' },
      }),
      makeSession({
        id: 'bot-routine-legacy-host',
        title: 'Legacy routine',
        source: 'bot',
        companion: { id: 'bot-1', role: 'routine' },
      }),
      makeSession({
        id: 'bot-convo',
        title: 'Chat with buddy',
        source: 'bot',
        companion: { id: 'bot-1', role: 'conversation' },
      }),
      makeSession({
        id: 'task-created',
        title: 'PR #42',
        createdBySession: { kind: 'session', sessionId: 'user-task', title: 'Normal work' },
      }),
    ];

    const filtered = filterSidebarTasks(
      tasks,
      { hideAutomations: true, hideTaskCreated: false, creators: 'all', lastActivity: 'all' },
      emptyCreators,
    );
    expect(filtered.map((s) => s.id)).toEqual(['user-task', 'bot-convo', 'task-created']);
  });

  it('hides only task-created sessions when hideTaskCreated is enabled, preserving user and remote Orca Worker tasks', () => {
    const tasks: Session[] = [
      makeSession({ id: 'user-task' }),
      makeSession({
        id: 'task-created',
        createdBySession: { kind: 'session', sessionId: 'user-task', title: 'Parent work' },
      }),
      makeSession({
        id: 'orca-remote-worker',
        orcaRemoteLead: {
          leadDeviceId: 'dev-a',
          leadDeviceName: 'Office Mac',
          leadSessionId: 'lead-1',
          leadTitle: 'Team Lead',
          workerLabel: 'worker-a',
        },
      }),
    ];

    const filtered = filterSidebarTasks(
      tasks,
      { hideAutomations: false, hideTaskCreated: true, creators: 'all', lastActivity: 'all' },
      emptyCreators,
    );
    expect(filtered.map((s) => s.id)).toEqual(['user-task', 'orca-remote-worker']);
  });
});

describe('hideTaskCreated persistence and filter count', () => {
  const originalStorage = globalThis.localStorage;
  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalStorage });
  });

  it('persists hideTaskCreated independently for tasks and inbox modes and counts it in active filters', () => {
    const backing = new Map<string, string>();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k: string) => backing.get(k) ?? null,
        setItem: (k: string, v: string) => { backing.set(k, v); },
        removeItem: (k: string) => { backing.delete(k); },
      },
    });

    expect(loadHideTaskCreated('tasks')).toBe(false);
    expect(loadHideTaskCreated('inbox')).toBe(false);
    persistHideTaskCreated(true, 'tasks');
    expect(loadHideTaskCreated('tasks')).toBe(true);
    expect(loadHideTaskCreated('inbox')).toBe(false);
    persistHideTaskCreated(true, 'inbox');
    persistHideTaskCreated(false, 'tasks');
    expect(loadHideTaskCreated('tasks')).toBe(false);
    expect(loadHideTaskCreated('inbox')).toBe(true);

    expect(sidebarContentFilterCount({
      projects: 'all',
      vendor: 'all',
      lastActivity: 'all',
      creators: 'all',
      hideAutomations: false,
      hideTaskCreated: true,
    })).toBe(1);
  });
});
