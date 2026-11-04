import { describe, expect, it } from 'vitest';

import {
  buildWorkLouderCodexPublishedTasks,
  type WorkLouderCodexPublishSession,
} from '../workLouderCodexTaskPublish';
import { WORKLOUDER_CODEX_TASK_OPTION_LIMIT } from '../../../../../shared/workLouderCodex';

/*
 * 测试价值
 * - 生产入口与可观察结果：buildWorkLouderCodexPublishedTasks -> Work Louder publishTasks payload；
 *   MACHINE_ALL 下远程任务必须不会因本地任务过多而消失。
 * - Bug／规则依据：all 与指定设备复现；publisher 的 100 条 local-first 截断会饿死远程任务。
 * - 现有覆盖缺口：machineSwitcher 只测选择顺序，agentIslandRemoteSessions 只测 setRemoteSessions，
 *   taskSlots 只测 main 端 cap；没有 renderer publisher 的行为覆盖。
 * - 最小失败输入：100 条 ordinary active local + 1 条 active remote，空 visibleProjection；
 *   旧实现输出 100 条 local，remote 不在 payload。
 * - tier：unit；实测耗时 3.2s（本机单独运行）。
 */

function local(index: number, overrides: Partial<WorkLouderCodexPublishSession> = {}) {
  return {
    id: `local-${index}`,
    title: `Local ${index}`,
    pinnedAt: null,
    userSendAt: String(1_000 + index),
    status: 'active',
    ...overrides,
  } satisfies WorkLouderCodexPublishSession;
}

function remote(
  id: string,
  overrides: Partial<WorkLouderCodexPublishSession> = {},
) {
  return {
    id,
    title: id,
    pinnedAt: null,
    userSendAt: '5000',
    status: 'active',
    deviceLinkDeviceId: 'device-a',
    ...overrides,
  } satisfies WorkLouderCodexPublishSession;
}

const idsOf = (tasks: ReturnType<typeof buildWorkLouderCodexPublishedTasks>) =>
  tasks.map((task) => task.id);

describe('buildWorkLouderCodexPublishedTasks', () => {
  it('keeps a remote task in the all-scope catalog when local rows fill the budget', () => {
    const locals = Array.from({ length: 100 }, (_, index) => local(index));
    const tasks = buildWorkLouderCodexPublishedTasks(
      [...locals, remote('remote-new')],
      [],
      [],
    );

    expect(tasks).toHaveLength(WORKLOUDER_CODEX_TASK_OPTION_LIMIT);
    expect(idsOf(tasks)).toContain('remote-new');
    expect(tasks.filter((task) => task.id.startsWith('local-'))).toHaveLength(99);
    expect(tasks.at(-1)?.id).toBe('remote-new');
  });

  it('leaves a single remote or local-only catalog unchanged', () => {
    expect(
      idsOf(buildWorkLouderCodexPublishedTasks([remote('remote-only')], [], [])),
    ).toEqual(['remote-only']);

    const locals = Array.from({ length: 100 }, (_, index) => local(index));
    expect(idsOf(buildWorkLouderCodexPublishedTasks(locals, [], []))).toEqual(
      locals.map((session) => session.id),
    );
  });

  it('keeps at most six remote rows in the shared 100-row budget', () => {
    const locals = Array.from({ length: 100 }, (_, index) => local(index));
    const remotes = Array.from({ length: 8 }, (_, index) => remote(`remote-${index}`));
    const tasks = buildWorkLouderCodexPublishedTasks([...locals, ...remotes], [], []);
    const remoteIds = tasks
      .map((task) => task.id)
      .filter((id) => id.startsWith('remote-'));

    expect(tasks).toHaveLength(WORKLOUDER_CODEX_TASK_OPTION_LIMIT);
    expect(remoteIds).toEqual(['remote-0', 'remote-1', 'remote-2', 'remote-3', 'remote-4', 'remote-5']);
    expect(tasks.filter((task) => task.id.startsWith('local-'))).toHaveLength(94);
  });

  it('preserves sidebarOrder and catalogEligible for visible projections', () => {
    const archived = local(99, { id: 'archived', status: 'archived', title: 'Archived' });
    const active = local(0);
    const remoteTask = remote('remote-visible');
    const tasks = buildWorkLouderCodexPublishedTasks(
      [active, remoteTask],
      [archived],
      ['archived', 'local-0', 'remote-visible'],
    );

    expect(tasks[0]).toMatchObject({
      id: 'archived',
      sidebarOrder: 0,
      catalogEligible: false,
    });
    expect(tasks.find((task) => task.id === 'local-0')).toMatchObject({ sidebarOrder: 1 });
    expect(tasks.find((task) => task.id === 'remote-visible')).toMatchObject({
      sidebarOrder: 2,
    });
  });
});
