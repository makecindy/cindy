/**
 * 测试价值
 * - 生产入口与可观察结果：freezeInboxLayout / snapshotInboxLayout（TaskInbox 在鼠标位于完成按钮上时
 *   调用）。行保持原分区与位置，显式移入或移出稍后处理／已处理立即生效并补位，新任务暂缓。
 * - 规则依据：task-inbox.md「分区与动作」（「完成」单击生效，鼠标停在完成按钮时行保持原位）。
 * - 现有覆盖缺口：此前没有悬停冻结，单击「完成」可能落在刚移动过来的行上。
 * - 最小失败输入：悬停期间一行被完成、一行开始运行、一行新到达。
 * - tier：unit（纯函数）。
 */
import { expect, it } from 'vitest';
import type { TaskInboxSection } from '@cindy/maker-shared/live-task-priority';

import { freezeInboxLayout, snapshotInboxLayout } from '../taskInboxPlacement';

const groups = (inbox: string[], working: string[], snoozed: string[] = []) =>
  new Map<TaskInboxSection, string[]>([['inbox', inbox], ['working', working], ['snoozed', snoozed], ['archived', []]]);
const id = (value: string) => value;

it('keeps rows in place while hovered, closes the gap for settled rows and holds new arrivals', () => {
  const frozen = snapshotInboxLayout(groups(['a', 'b', 'c'], ['w']), id);
  // Meanwhile: b was completed (archived), a started running, c stays, n newly arrived.
  const fresh = new Map<TaskInboxSection, string[]>([
    ['inbox', ['n', 'c']], ['working', ['a', 'w']], ['snoozed', []], ['archived', ['b']],
  ]);
  const shown = freezeInboxLayout(fresh, id, frozen);
  expect(shown.get('inbox')).toEqual(['a', 'c']);
  expect(shown.get('working')).toEqual(['w']);
  expect(shown.get('archived')).toEqual(['b']);
  expect([...shown.values()].flat()).not.toContain('n');
  // Restoring a processed task is explicit too: it leaves its slot and joins the end of its section.
  const restored = freezeInboxLayout(new Map<TaskInboxSection, string[]>([
    ['inbox', ['b', 'a', 'c']], ['working', ['w']], ['snoozed', []], ['archived', []],
  ]), id, snapshotInboxLayout(shown, id));
  expect(restored.get('inbox')).toEqual(['a', 'c', 'b']);
  expect(restored.get('archived')).toEqual([]);
});
