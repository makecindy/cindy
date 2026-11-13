// - 生产入口与可观察结果:createUserRevealMarker 的标记消费结果(MainLayout 用它决定
//   rightTabsUserToggle,后者决定切任务时要不要动原生窗口宽度)。
// - Bug / 规则依据:用户跨任务开栏只对发起它的那次导航有效;目标被别的任务顶掉时,
//   标记不能留给以后普通切到该任务的导航,否则那次切任务会把窗口拉宽。
// - 现有覆盖缺口:MainLayout 整体没有渲染级单测,标记生命周期只能在这里钉住。
// - 最小失败输入:mark('a') 后先 commit('b') 再 commit('a'),旧实现第二次返回 true。
// - tier:unit。
import { expect, it } from 'vitest';

import { createUserRevealMarker } from '../userRevealMarker';

it('consumes the marker for the task the user asked to reveal', () => {
  const marker = createUserRevealMarker();
  expect(marker.consume('task-a')).toBe(false);
  marker.mark('task-a');
  expect(marker.consume('task-a')).toBe(true);
  expect(marker.consume('task-a')).toBe(false);
});

it('keeps the reveal for its own task when another task is merely re-declared', () => {
  const marker = createUserRevealMarker();
  marker.mark('task-a');
  // 同任务的普通重声明(例如 subagentsAvailable 解析完)不是落点:标记继续等。
  expect(marker.consume('task-b')).toBe(false);
  expect(marker.target()).toBe('task-a');
  expect(marker.consume('task-a')).toBe(true);
  expect(marker.target()).toBe(null);
});

it('drops a superseded reveal instead of handing it to a later task switch', () => {
  const marker = createUserRevealMarker();
  marker.mark('task-a');
  // 慢查询期间用户去了别的任务:落地提交把标记作废。
  marker.cancel();
  // 以后再普通切到 task-a 不能算用户开栏。
  expect(marker.consume('task-a')).toBe(false);
});

it('drops the marker when the navigation loses its landing', () => {
  const marker = createUserRevealMarker();
  marker.mark('task-a');
  // 导航还悬着时用户去了设置页：这次手势没有落点。
  marker.cancel();
  expect(marker.consume('task-a')).toBe(false);
});
