/**
 * 测试价值
 * - 生产入口与可观察结果：createPassiveRevealMarker（MainLayout 记「这次后台开栏是程序动作」、
 *   在声明落地任务时消费）；观察第一次落地是否拿到被动来源、别的任务落地会不会吃掉它。
 * - 规则依据：PR #9943 的窗口宽度口径——只有用户亲手开/关右栏才改主窗口矩形，程序开栏不占宽度。
 * - 现有覆盖缺口：userRevealMarker 覆盖用户手势，没有覆盖程序开栏的跨任务记账。
 * - 最小失败输入：插件给后台任务 B 开栏，用户先落到 A 再落到 B；标记不能丢、也不能提前被吃掉。
 * - tier：unit，纯内存。
 */
import { expect, it } from 'vitest';
import { createPassiveRevealMarker } from '../passiveRevealMarker';

it('survives landings on other tasks and is consumed by the first one it named', () => {
  const marker = createPassiveRevealMarker();
  marker.mark('task-b');
  expect(marker.consume('task-a')).toBe(false);
  expect(marker.consume('task-b')).toBe(true);
  // 只对第一次声明有效：之后普通切换按记忆恢复，不再当成程序动作。
  expect(marker.consume('task-b')).toBe(false);
});

it('drops the marker when the same task is taken down by the program', () => {
  const marker = createPassiveRevealMarker();
  marker.mark('task-b');
  marker.drop('task-b');
  expect(marker.consume('task-b')).toBe(false);
});

it('keeps only the recent targets', () => {
  const marker = createPassiveRevealMarker();
  for (let index = 0; index < 40; index++) marker.mark(`task-${index}`);
  expect(marker.consume('task-0')).toBe(false);
  expect(marker.consume('task-39')).toBe(true);
});
