/**
 * 协同(Orca)Lead / Worker 之间的任务跳转决策。
 *
 * 为什么不能一律 `router.push`:`sessions/[sessionId]` 配了 `getId`(见 `app/_layout.tsx`),
 * 同一 (deviceId, sessionId) 恒得同一个 route id。expo-router 内联 react-navigation 的
 * StackRouter 在 PUSH 命中「栈里已有同 id route」时不新增,而是把那个 route **从栈中删掉再
 * 追加到栈顶**(`StackRouter.js` 的 `routes.filter(...)` + `routes.push({...route, params})`)。
 * 于是「返回 Lead」并不是回退:Lead 被提到顶,Worker 被挤到它下面,紧接着的返回手势落回
 * Worker;而且每往返一次就改写一次栈内 Screen 顺序 —— Android native-stack 面对「已存在的
 * Screen 换了位置」只能走 fragment 替换生命周期,正是 `sessionDrawerNavigation.ts` 记录的
 * Android crash / 白屏入口。生产表现:往返两轮后右滑返回白屏且点不动。
 *
 * 因此这里的口径是:目标已在栈里 → `dismissTo`(POP_TO,真回退,只截断、不改顺序);
 * 不在栈里 → `push`。两者都不动已有 route 的相对顺序,Android 上也不再进入 Screen 替换。
 */
import { recentTaskKey } from "@/session/recentTasks";

export const SESSION_ROUTE_NAME = "sessions/[sessionId]";

export interface CollabSessionTarget {
  deviceId: string;
  deviceName: string;
  sessionId: string;
}

/** 导航状态里我们关心的那部分(route 形状按未知处理,不绑 react-navigation 类型)。 */
export interface CollabSessionRouteLike {
  key?: unknown;
  name?: unknown;
  params?: unknown;
  /** 嵌套 navigator 的子状态;沿途找得到目标任务才算命中。 */
  state?: CollabSessionStateLike;
}

export interface CollabSessionStateLike {
  routes?: readonly CollabSessionRouteLike[];
  state?: CollabSessionStateLike;
}

export interface CollabSessionNavigator {
  /** 包含本 route 的 navigator 的 state(session 路由直属 root stack,即栈里有哪些任务)。 */
  getState(): CollabSessionStateLike | undefined;
  push(target: CollabSessionTarget): void;
  /** 回退到目标那一屏(expo-router `dismissTo` → StackRouter POP_TO)。 */
  dismissTo(target: CollabSessionTarget): void;
}

export type CollabSessionNavigationPlan = "noop" | "popTo" | "push";

const isTargetRoute = (
  route: CollabSessionRouteLike,
  target: CollabSessionTarget,
): boolean => {
  if (route.name !== SESSION_ROUTE_NAME) return false;
  const params = (route.params ?? {}) as {
    deviceId?: unknown;
    sessionId?: unknown;
  };
  // 与 getId 同一把尺子:deviceId + sessionId。跨电脑的同名任务不算命中。
  return recentTaskKey(params) === recentTaskKey(target);
};

/** 目标任务是否已经在导航栈里(深度优先,兼容嵌套 navigator)。 */
export function findStackedSessionRoute(
  state: CollabSessionStateLike | undefined | null,
  target: CollabSessionTarget,
): boolean {
  for (const route of state?.routes ?? []) {
    if (isTargetRoute(route, target)) return true;
    if (findStackedSessionRoute(route.state, target)) return true;
  }
  return false;
}

export function planCollabSessionNavigation(
  state: CollabSessionStateLike | undefined | null,
  target: CollabSessionTarget,
  currentSessionId: string,
): CollabSessionNavigationPlan {
  // 就在这一屏:什么都不派发(与既有守卫一致)。
  if (
    !target.deviceId ||
    !target.sessionId ||
    target.sessionId === currentSessionId
  )
    return "noop";
  return findStackedSessionRoute(state, target) ? "popTo" : "push";
}

/**
 * 协同跳转的执行口。返回实际采取的动作,便于调用点与测试各自断言。
 *
 * 硬约束:**栈里已有目标任务时只走 dismissTo,绝不 push** —— push 会命中 StackRouter 的
 * 「同 id 复用 + 移到栈顶」,把返回历史改写掉。
 */
export function navigateToCollabSession(
  navigator: CollabSessionNavigator,
  target: CollabSessionTarget,
  currentSessionId: string,
): CollabSessionNavigationPlan {
  const plan = planCollabSessionNavigation(
    navigator.getState(),
    target,
    currentSessionId,
  );
  if (plan === "popTo") navigator.dismissTo(target);
  else if (plan === "push") navigator.push(target);
  return plan;
}
