/**
 * 测试价值
 * - 生产入口与可观察结果：withTeammateHomeGuard（scheduler-host/index.ts 包在唯一的 runner 外面）。伙伴被
 *   交到别的电脑后，这台电脑上它项目里的定时任务记为「跳过」，不运行也不删除；伙伴回来后照常运行；
 *   普通项目与别的伙伴的项目不受影响。
 * - 规则依据：cloud-companions.md §2.1 第 5 条（交出后旧电脑不再运行它的自动化）。
 * - 现有覆盖缺口：降级只拦了 V1 例行任务，项目自动化没有任何主力电脑判断；暂停、删除的伙伴也没有。
 * - 最小失败输入：工作目录是降级伙伴项目的一条自动化。
 * - tier：unit（fake runner，无调度器与数据库）。
 */
import { expect, it, vi } from 'vitest';
import type { FireContext, Schedule } from '@cindy/maker-scheduler';

import { withTeammateHomeGuard } from '../teammateHomeGuard.js';

const project = (folder: string) => `/Users/me/Library/Application Support/Cindy/owners/o1/bots/${folder}/workspace`;
const schedule = (workingDir: string) => ({ id: 's1', source: 'project', workingDir }) as unknown as Schedule;
const ctx = { runId: 'r1' } as unknown as FireContext;

it('skips the automations of a teammate that runs on another computer, and runs them again once it is back', async () => {
  const runner = { fire: vi.fn(async () => ({ sessionId: 'task-1' })) };
  let demoted = ['bot_mia'];
  const guarded = withTeammateHomeGuard(runner, () => demoted);

  expect(await guarded.fire(schedule(project('bot_mia')), ctx)).toEqual({ sessionId: '', skipped: true, resultText: expect.any(String) });
  expect(runner.fire).not.toHaveBeenCalled();
  // Another teammate's project and an ordinary project still run.
  expect(await guarded.fire(schedule(project('bot_leo')), ctx)).toEqual({ sessionId: 'task-1' });
  expect(await guarded.fire(schedule('/Users/me/code/app'), ctx)).toEqual({ sessionId: 'task-1' });

  demoted = [];
  expect(await guarded.fire(schedule(project('bot_mia')), ctx)).toEqual({ sessionId: 'task-1' });
  expect(runner.fire).toHaveBeenCalledTimes(3);
});

// PR #9314 review: a paused teammate (also one paused in V1 before its upgrade) and a deleted
// teammate kept their project automations firing; only the hand-over was checked.
it('skips the automations of a paused or deleted teammate', async () => {
  const runner = { fire: vi.fn(async () => ({ sessionId: 'task-1' })) };
  const states: Record<string, 'active' | 'stopped' | 'deleted'> = {
    [project('bot_mia')]: 'stopped', [project('bot_old')]: 'deleted', [project('bot_leo')]: 'active',
  };
  const guarded = withTeammateHomeGuard(runner, () => [], async (dir) => states[dir ?? ''] ?? null);

  expect(await guarded.fire(schedule(project('bot_mia')), ctx)).toMatchObject({ skipped: true });
  expect(await guarded.fire(schedule(project('bot_old')), ctx)).toMatchObject({ skipped: true });
  expect(runner.fire).not.toHaveBeenCalled();
  expect(await guarded.fire(schedule(project('bot_leo')), ctx)).toEqual({ sessionId: 'task-1' });
});
