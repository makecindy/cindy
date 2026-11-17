/**
 * 测试价值
 * - 生产入口与可观察结果：holdViewedInboxPlacement（TaskInbox 每次分区后调用）。正打开的任务在
 *   收件箱与进行中之间变化时，保持原分区与位置；离开后、或稍后处理/归档这类显式操作立即生效。
 * - 规则依据：task-inbox.md「分区与动作」正在查看的任务不移动（2026-11-18 用户要求：发消息后
 *   左侧焦点不要跟着任务跳到进行中）。
 * - 现有覆盖缺口：此前只钉住优先级档位，运行档会释放钉住，任务随即移到进行中。
 * - 最小失败输入：打开的收件箱任务开始运行。
 * - tier：unit（纯函数）。
 */
import { expect, it } from 'vitest';
import type { TaskInboxSection } from '@cindy/maker-shared/live-task-priority';

import { holdViewedInboxPlacement } from '../taskInboxPlacement';

const groups = (inbox: string[], working: string[], snoozed: string[] = []) =>
  new Map<TaskInboxSection, string[]>([['inbox', inbox], ['working', working], ['snoozed', snoozed], ['archived', []]]);
const id = (value: string) => value;

it('keeps the open task in its section and slot until the user leaves it', () => {
  let placement = holdViewedInboxPlacement(groups(['a', 'open', 'b'], []), id, 'open', null);
  expect(placement).toEqual({ key: 'open', section: 'inbox', index: 1 });

  // The user sends a message: the task now classifies as working, but stays put.
  const sent = groups(['a', 'b'], ['open', 'w']);
  placement = holdViewedInboxPlacement(sent, id, 'open', placement);
  expect(sent.get('inbox')).toEqual(['a', 'open', 'b']);
  expect(sent.get('working')).toEqual(['w']);

  // Leaving it lets the task move; the newly opened task is remembered instead.
  const left = groups(['a', 'b'], ['open', 'w']);
  expect(holdViewedInboxPlacement(left, id, 'a', placement)).toEqual({ key: 'a', section: 'inbox', index: 0 });
  expect(left.get('working')).toEqual(['open', 'w']);
});

it('applies explicit snooze or archive at once', () => {
  const placement = holdViewedInboxPlacement(groups(['open'], []), id, 'open', null);
  const snoozed = groups([], [], ['open']);
  expect(holdViewedInboxPlacement(snoozed, id, 'open', placement)).toEqual({ key: 'open', section: 'snoozed', index: 0 });
  expect(snoozed.get('snoozed')).toEqual(['open']);
  expect(holdViewedInboxPlacement(groups([], []), id, undefined, placement)).toBeNull();
});
