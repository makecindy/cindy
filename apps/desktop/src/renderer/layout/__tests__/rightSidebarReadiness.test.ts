/**
 * 测试价值
 * - 生产入口与可观察结果：MainLayout 喂给 LayoutRoot 的 `sidebarExpansionReady`；
 *   它决定面板能不能据此调整窗口宽度。
 * - 规则依据：docs/dev-rules/desktop-development.md「只有用户亲手开／关侧栏才调整
 *   主窗口矩形」——任务语境要等该任务的开合存档读进来，无任务语境的全局具名页没有存档可等。
 * - 现有覆盖缺口：LayoutRoot 用例直接传 ready，没有覆盖这个判据本身。
 * - 最小失败输入：窗口在 `/plugins` 上，只有全局具名页可用、没有任何任务会话。
 * - tier：unit，纯函数。
 */
import { expect, it } from 'vitest';
import { rightSidebarExpansionReady } from '../rightSidebarReadiness';

const ready = {
  windowLoaded: true,
  detached: false,
  taskSidebarAvailable: false,
  tabsRestored: false,
  globalViewAvailable: false,
};

it('treats a task-free global view as ready without waiting for a restore', () => {
  expect(rightSidebarExpansionReady({ ...ready, globalViewAvailable: true })).toBe(true);
});

it('keeps the bootstrap gate while a task sidebar waits for its remembered state', () => {
  expect(
    rightSidebarExpansionReady({ ...ready, taskSidebarAvailable: true, globalViewAvailable: true }),
  ).toBe(false);
  expect(
    rightSidebarExpansionReady({
      ...ready,
      taskSidebarAvailable: true,
      tabsRestored: true,
      globalViewAvailable: true,
    }),
  ).toBe(true);
});

it('is never ready before main reports the pane state or while detached', () => {
  expect(
    rightSidebarExpansionReady({ ...ready, windowLoaded: false, globalViewAvailable: true }),
  ).toBe(false);
  expect(rightSidebarExpansionReady({ ...ready, detached: true, globalViewAvailable: true })).toBe(
    false,
  );
  expect(rightSidebarExpansionReady(ready)).toBe(false);
});
