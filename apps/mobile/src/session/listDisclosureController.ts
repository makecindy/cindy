import { listDisclosureMotion } from '@/theme/tokens';

/**
 * 列表展开 / 收起过渡的窗口控制器(纯逻辑,不依赖 React / Reanimated,便于直接单测)。
 * 视图层见 listDisclosureTransition.tsx:ListDisclosureScope 持有开关状态并在行登记完
 * 布局动画后调用 commitRegisteredLevel。
 */

/** 0 = 关闭;1 = cell 与分组块;2 = 另加分组块内部的逐行包裹。 */
export type DisclosureLevel = 0 | 1 | 2;

export type DisclosureController = {
  pending: Array<() => void>;
  registered: DisclosureLevel;
  requested: DisclosureLevel;
  setLevel: ((level: DisclosureLevel) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
};

/**
 * 窗口在最后一次变更落地后再保留一段:数据类变更(归档 / 置顶)写入 store 后还要经过
 * 列表重算才提交,留足余量,动画结束前不收回布局动画。
 */
export const DISCLOSURE_WINDOW_TAIL_MS = listDisclosureMotion.duration + 300;

export function createDisclosureController(): DisclosureController {
  return { pending: [], registered: 0, requested: 0, setLevel: null, timer: null };
}

function scheduleClose(controller: DisclosureController) {
  if (controller.timer) clearTimeout(controller.timer);
  controller.timer = setTimeout(() => {
    controller.timer = null;
    controller.registered = 0;
    controller.requested = 0;
    controller.setLevel?.(0);
  }, DISCLOSURE_WINDOW_TAIL_MS);
}

/**
 * 打开(或延长)过渡窗口。系统「减弱动态效果」的约定是只有明确为 false 才播放动画
 * (偏好还没查到的 null 也按不播处理),所以 motionAllowed 由调用方按该约定传入。
 * 返回 false 表示不能开窗口(不播动画 / 列表不在屏上),调用方应直接执行变更。
 */
export function openDisclosureWindow(controller: DisclosureController, level: DisclosureLevel, motionAllowed: boolean): boolean {
  if (!motionAllowed || !controller.setLevel) return false;
  scheduleClose(controller);
  if (level > controller.requested) {
    controller.requested = level;
    controller.setLevel(level);
  }
  return true;
}

/**
 * 请求带过渡地执行 apply:窗口开着且行已登记好动画就立刻执行,否则排队,等行登记完成
 * (commitRegisteredLevel)后按调用顺序执行。已有排队的变更时一律排队,保证乐观写入与
 * 失败回滚按调用顺序落地。
 */
export function runDisclosure(controller: DisclosureController, apply: () => void, level: DisclosureLevel, motionAllowed: boolean) {
  if (!openDisclosureWindow(controller, level, motionAllowed)
    || (controller.registered >= level && controller.pending.length === 0)) {
    apply();
    return;
  }
  controller.pending.push(apply);
}

/** 行已按 level 登记好布局动画(同一次提交的 layout effect 里调用):执行排队的变更。 */
export function commitRegisteredLevel(controller: DisclosureController, level: DisclosureLevel) {
  controller.registered = level;
  if (controller.pending.length === 0) return;
  // 窗口已关闭时仍有排队的变更(极端慢渲染),直接落地,不能卡住。
  if (level > 0) scheduleClose(controller);
  const queued = controller.pending;
  controller.pending = [];
  queued.forEach((apply) => apply());
}

/** 列表卸载:窗口复位并把排队的变更直接落地。 */
export function detachDisclosureScope(controller: DisclosureController) {
  controller.setLevel = null;
  controller.registered = 0;
  controller.requested = 0;
  if (controller.timer) {
    clearTimeout(controller.timer);
    controller.timer = null;
  }
  const queued = controller.pending;
  controller.pending = [];
  queued.forEach((apply) => apply());
}
