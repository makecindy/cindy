import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ROUTE_NAME,
  findStackedSessionRoute,
  navigateToCollabSession,
  planCollabSessionNavigation,
  type CollabSessionRouteLike,
  type CollabSessionStateLike,
  type CollabSessionTarget,
} from "@/session/collabSessionNavigation";
import { recentTaskKey } from "@/session/recentTasks";
// 真实 router 实现:本 bug 的机制就在它的 PUSH 分支里,用真件跑一遍才能防回归。
import { StackRouter } from "expo-router/build/react-navigation/routers/StackRouter";

// Windows checkout 下源码可能是 CRLF;断言跨平台统一按 LF 归一。
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, "\n");

const lead: CollabSessionTarget = {
  sessionId: "lead-1",
  deviceId: "pc",
  deviceName: "PC",
};
const worker: CollabSessionTarget = {
  sessionId: "worker-1",
  deviceId: "pc",
  deviceName: "PC",
};
const deviceList: CollabSessionTarget = {
  sessionId: "device-list",
  deviceId: "pc",
  deviceName: "PC",
};

const route = (
  target: CollabSessionTarget,
  key: string,
): CollabSessionRouteLike => ({
  name: SESSION_ROUTE_NAME,
  key,
  params: target,
});

const stack = (
  ...routes: CollabSessionRouteLike[]
): CollabSessionStateLike => ({ routes });

function fakeNavigator(state: CollabSessionStateLike | undefined) {
  return {
    getState: () => state,
    push: vi.fn(),
    dismissTo: vi.fn(),
  };
}

describe("collaboration session navigation decision", () => {
  it("falls back (popTo) when the target session is already on the stack", () => {
    const navigator = fakeNavigator(
      stack(route(lead, "L"), route(worker, "W")),
    );

    expect(navigateToCollabSession(navigator, lead, "worker-1")).toBe("popTo");
    // 硬约束:栈里已有目标任务时绝不 push —— 那会把「返回 Lead」变成栈重排。
    expect(navigator.push).not.toHaveBeenCalled();
    expect(navigator.dismissTo).toHaveBeenCalledExactlyOnceWith(lead);
  });

  it("pushes only when the target session is not on the stack yet", () => {
    const navigator = fakeNavigator(
      stack(route(lead, "L"), route(worker, "W")),
    );
    const fresh: CollabSessionTarget = { ...lead, sessionId: "worker-2" };

    expect(navigateToCollabSession(navigator, fresh, "worker-1")).toBe("push");
    expect(navigator.dismissTo).not.toHaveBeenCalled();
    expect(navigator.push).toHaveBeenCalledExactlyOnceWith(fresh);
  });

  it("does nothing on the current session, a missing device or a missing session id", () => {
    const withState = fakeNavigator(stack(route(lead, "L")));

    expect(navigateToCollabSession(withState, lead, "lead-1")).toBe("noop");
    expect(
      navigateToCollabSession(withState, { ...worker, deviceId: "" }, "lead-1"),
    ).toBe("noop");
    expect(
      navigateToCollabSession(
        withState,
        { ...worker, sessionId: "" },
        "lead-1",
      ),
    ).toBe("noop");
    expect(withState.push).not.toHaveBeenCalled();
    expect(withState.dismissTo).not.toHaveBeenCalled();

    // 拿不到导航状态时退化成 push:这是旧行为,不会凭空回退到某个猜测的屏。
    const stateless = fakeNavigator(undefined);
    expect(navigateToCollabSession(stateless, lead, "worker-1")).toBe("push");
    expect(stateless.push).toHaveBeenCalledOnce();
  });

  it("matches the stacked route with the same id the Stack getId derives", () => {
    // 跨电脑的同名任务不算命中;嵌套 navigator 也要找得到。
    const nested: CollabSessionStateLike = {
      routes: [
        route(lead, "L"),
        { name: "tabs", state: stack(route(lead, "NESTED")) },
      ],
    };
    const otherDevice: CollabSessionTarget = { ...lead, deviceId: "other-pc" };

    expect(findStackedSessionRoute(nested, lead)).toBe(true);
    expect(findStackedSessionRoute(nested, otherDevice)).toBe(false);
    expect(planCollabSessionNavigation(nested, lead, "lead-1")).toBe("noop");
    expect(planCollabSessionNavigation(nested, otherDevice, "worker-1")).toBe(
      "push",
    );
    expect(recentTaskKey({ deviceId: "pc", sessionId: "lead-1" })).toBe(
      recentTaskKey(lead),
    );
  });
});

// 用真实 StackRouter 跑一遍 Lead <-> Worker 往返,把生产现象钉成断言:
// 旧口径(每次 push)返回手势落回 Worker;新口径(dismissTo 回退)返回手势落回列表。
describe("collaboration navigation against the real StackRouter", () => {
  const getId = ({ params }: { params?: Record<string, unknown> }) =>
    recentTaskKey(params ?? {});
  const routerConfig = {
    routeNames: [SESSION_ROUTE_NAME],
    routeParamList: {},
    routeGetIdList: { [SESSION_ROUTE_NAME]: getId },
  };
  interface TestRoute {
    key: string;
    name: string;
    params?: Record<string, unknown>;
    state?: unknown;
  }
  interface TestState {
    index: number;
    key: string;
    routeNames: string[];
    routes: TestRoute[];
    preloadedRoutes: TestRoute[];
    stale: boolean;
    type: "stack";
  }
  const startState = (): TestState => ({
    index: 0,
    key: "Stack-root",
    routeNames: [SESSION_ROUTE_NAME],
    routes: [{ ...(route(deviceList, "DEVICES") as TestRoute) }],
    preloadedRoutes: [],
    stale: false,
    type: "stack",
  });
  const sessionIds = (state: TestState) =>
    state.routes.map((item) => String((item.params ?? {}).sessionId));

  const drive = (popToStackedTargets: boolean) => {
    const router = StackRouter({});
    let state = startState();
    const apply = (action: unknown) => {
      const next = router.getStateForAction(
        state as never,
        action as never,
        routerConfig as never,
      );
      if (next) state = next as TestState;
    };
    const open = (target: CollabSessionTarget) => {
      const params = {
        sessionId: target.sessionId,
        deviceId: target.deviceId,
        deviceName: target.deviceName,
      };
      const stacked = state.routes.some(
        (item) =>
          item.name === SESSION_ROUTE_NAME &&
          getId({ params: item.params }) === getId({ params }),
      );
      if (stacked && popToStackedTargets) {
        apply({
          type: "POP_TO",
          payload: { name: SESSION_ROUTE_NAME, params },
        });
        return;
      }
      apply({ type: "PUSH", payload: { name: SESSION_ROUTE_NAME, params } });
    };

    open(lead);
    open(worker);
    open(lead);
    open(worker);
    open(lead);
    const beforeBack = [...sessionIds(state)];
    apply({ type: "GO_BACK" });
    return { beforeBack, afterBack: sessionIds(state) };
  };

  it("reproduces the reordered history when a stacked session is pushed again", () => {
    const legacy = drive(false);
    // 「返回 Lead」把 Lead 提到顶、Worker 掉到它下面 —— 用户看到的「右滑又进了 Worker」。
    expect(legacy.beforeBack).toEqual(["device-list", "worker-1", "lead-1"]);
    expect(legacy.afterBack).toEqual(["device-list", "worker-1"]);
  });

  it("keeps the history truthful when a stacked session is popped back to", () => {
    const fixed = drive(true);
    expect(fixed.beforeBack).toEqual(["device-list", "lead-1"]);
    expect(fixed.afterBack).toEqual(["device-list"]);
  });
});

// 调用点契约:协同跳转必须经过上面的决策口,不能再有裸 push。
describe("collaboration navigation wiring", () => {
  const source = readTextLf(
    resolve(process.cwd(), "app/sessions/[sessionId].tsx"),
    "utf8",
  );
  const start = source.indexOf("const openCollabSession = useCallback");
  const end = source.indexOf("// 来源目录在协同 hook 之后才取得", start);

  it("routes collab navigation through the popTo/push decision", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    expect(source).toContain("} from '@/session/collabSessionNavigation';");
    expect(source).toContain("navigateToCollabSession,");
    expect(source).toContain("type CollabSessionStateLike,");
    expect(block).toContain("navigateToCollabSession(");
    expect(block).toContain("getState: () => navigation.getState(),");
    expect(block).toContain("push: (target) => router.push({");
    expect(block).toContain("dismissTo: (target) => router.dismissTo({");
    // 旧的裸 push(直接拿目标 id 组 params)已不存在:那正是命中「同 id 复用 + 移到栈顶」的那一行。
    expect(block).not.toContain(
      "params: { sessionId: targetSessionId, deviceId, deviceName }",
    );
    // getRootState 只存在于容器 ref,useNavigation 返回的对象上没有:写了就是运行时 TypeError。
    expect(source).not.toContain("navigation.getRootState()");
  });
});
