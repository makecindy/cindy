// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { PluginSettingsCard } from "../plugins/PluginSettingsCard";
import { openPluginSettingsClient } from "../plugins/pluginSettingsClient";

/* 测试价值
 * 生产入口与结果：PluginSettingsCard，浏览器授权覆盖/后台期间保留lease，返回后重建原资源且不重放保存。
 * 规则依据：plugin-mobile-implementation 配置与授权；原生预览资源后台停止的既有生命周期。
 * 覆盖缺口：client/资源测试不执行React effect，无法发现AppState造成授权中途销毁或回前台重复提交。
 * 最小输入：一个挂起的授权请求、background→active、一次真实结果；资源/Host均为内存假对象。
 * tier：unit；不启动原生应用、不读用户数据、不验证真实OAuth。
 * 实测耗时：单文件墙钟 1.71s。
 */
const state = vi.hoisted(() => ({
  windowHeight: 800,
  cardStyle: undefined as any,
  appState: "active",
  listener: undefined as undefined | ((value: string) => void),
  web: undefined as any,
  options: [] as any[],
  clients: [] as any[],
  resources: [] as any[],
  inject: vi.fn(),
  colors: {} as Record<string, string>,
}));
vi.mock("react-native", async () => {
  const React = await import("react");
  return {
    useWindowDimensions: () => ({
      width: 390,
      height: state.windowHeight,
      scale: 1,
      fontScale: 1,
    }),
    AppState: {
      get currentState() {
        return state.appState;
      },
      addEventListener: (_: string, fn: any) => {
        state.listener = fn;
        return {
          remove() {
            state.listener = undefined;
          },
        };
      },
    },
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    View: (p: any) => {
      state.cardStyle = Object.assign({}, ...p.style);
      return React.createElement("div", null, p.children);
    },
  };
});
vi.mock("react-native-webview", async () => {
  const React = await import("react");
  return {
    default: React.forwardRef((p: any, ref) => {
      state.web = p;
      React.useImperativeHandle(ref, () => ({
        injectJavaScript: state.inject,
      }));
      return React.createElement("div");
    }),
  };
});
vi.mock("@/theme", () => ({
  motionDuration: { fast: 100, spinnerCycle: 1000 },
  motionEasing: { out: [0, 0, 1, 1] },
  radius: { container: 12 },
  spacing: { lg: 16 },
  useTheme: () => ({ colors: state.colors, mode: "light" }),
}));
vi.mock("../plugins/pluginSettingsResources", () => ({
  preparePluginSettingsResources: vi.fn(async () => {
    const resource = {
      url: "http://127.0.0.1:1/__cindy/fixture-token",
      close: vi.fn(async () => {}),
    };
    state.resources.push(resource);
    return resource;
  }),
}));
vi.mock("../plugins/pluginSettingsClient", () => ({
  openPluginSettingsClient: vi.fn(async (options: any) => {
    state.options.push(options);
    const client = {
      document: {
        pageId: "page",
        files: [{ path: "settings.html", mime: "text/html" }],
      },
      assertCurrent: options.assertCurrent,
      close: vi.fn(async () => {
        options.assertCleanupCurrent();
      }),
      send: vi.fn(async () => ({
        events: [],
        notifications: [],
        confirms: [],
      })),
      fetch: vi.fn(async () => {
        await options.onAuthorize({
          requestId: "auth",
          actionId: "connect",
          expectedRevision: 0,
        });
        return {
          status: 200,
          base64: Buffer.from('{"connected":true}').toString("base64"),
          mime: "application/json",
        };
      }),
    };
    state.clients.push(client);
    return client;
  }),
}));
let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  state.options = [];
  state.clients = [];
  state.resources = [];
  state.windowHeight = 800;
  state.cardStyle = undefined;
  state.appState = "active";
  state.web = undefined;
  vi.useRealTimers();
  vi.clearAllMocks();
});
it.each([false, true])(
  "retains the authorizing lease and delivers notices only to the current identity (replaced=%s)",
  async (replaced) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    let finish!: () => void;
    const authorization = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const ownerGuard = vi.fn();
    const onNotice = vi.fn();
    const props = {
      identity: {
        deviceId: "host",
        instanceId: "plugin",
        expectedInstalledApproval: "approval",
      },
      active: true,
      generation: 1,
      assertCurrent: ownerGuard,
      assertCleanupCurrent: ownerGuard,
      invokeTarget: vi.fn(),
      openSession: vi.fn(),
      onAuthorize: () => authorization,
      onNotice,
    };
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    cleanup = async () => {
      await act(async () => root.unmount());
      element.remove();
    };
    await act(async () =>
      root.render(createElement(PluginSettingsCard, props)),
    );
    expect(state.clients).toHaveLength(1);
    // A poll can finish after the browser covers the page; Host notices are consumed on read.
    let finishPoll!: (value: unknown) => void;
    state.clients[0].send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPoll = resolve;
        }),
    );
    await act(async () => state.web.onLoad());
    await act(async () =>
      state.web.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            settings: "page",
            id: 1,
            command: {
              kind: "fetch",
              path: "/oauth/main/connect",
              method: "POST",
            },
          }),
        },
      }),
    );
    await act(async () => {
      state.appState = "background";
      state.listener?.("background");
    });
    await act(async () =>
      finishPoll({
        events: [],
        confirms: [],
        notifications: [{ text: "Account connected" }],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(1600));
    expect(onNotice).not.toHaveBeenCalled();
    expect(state.clients[0].send).toHaveBeenCalledTimes(1);
    expect(state.clients[0].close).not.toHaveBeenCalled();
    expect(state.resources[0].close).not.toHaveBeenCalled();
    await act(async () => {
      state.appState = "active";
      state.listener?.("active");
      if (replaced)
        root.render(
          createElement(PluginSettingsCard, { ...props, generation: 2 }),
        );
      finish();
    });
    if (replaced) expect(onNotice).not.toHaveBeenCalled();
    else expect(onNotice).toHaveBeenCalledExactlyOnceWith("Account connected");
    expect(state.clients).toHaveLength(2);
    expect(state.clients[0].fetch).toHaveBeenCalledTimes(1);
    expect(state.clients[1].fetch).not.toHaveBeenCalled();
    expect(state.clients[0].close).toHaveBeenCalledTimes(1);
    expect(state.resources[0].close).toHaveBeenCalledTimes(1);
    expect(state.options[0].assertCleanupCurrent).toBe(ownerGuard);
    expect(
      state.inject.mock.calls.some(([script]) =>
        script.includes(Buffer.from('{"connected":true}').toString("base64")),
      ),
    ).toBe(!replaced);
  },
);

// A failed opening and an unacknowledged write previously became the same notice.
it.each(["load", "read", "unknown", "readBridge"] as const)(
  "reports %s in the actual card callback without replaying a request",
  async (context) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onError = vi.fn();
    if (context === "load")
      vi.mocked(openPluginSettingsClient).mockRejectedValueOnce(
        new Error("PLUGIN_SETTINGS_UNAVAILABLE"),
      );
    const root = createRoot(document.createElement("div"));
    cleanup = async () => {
      await act(async () => root.unmount());
    };
    await act(async () =>
      root.render(
        createElement(PluginSettingsCard, {
          identity: {
            deviceId: "host",
            instanceId: "plugin",
            expectedInstalledApproval: "approval",
          },
          active: true,
          generation: 1,
          assertCurrent() {},
          invokeTarget: vi.fn(),
          openSession: vi.fn(),
          onError,
        }),
      ),
    );
    if (context !== "load") {
      const client = state.clients[0];
      client.fetch.mockRejectedValueOnce(
        Object.assign(
          new Error("RESPONSE_LOST"),
          context === "unknown" ? { settingsOutcome: "unknown" } : {},
        ),
      );
      if (context === "readBridge")
        state.inject.mockImplementationOnce(() => {
          throw new Error("native injection unavailable");
        });
      await act(async () =>
        state.web.onMessage({
          nativeEvent: {
            data: JSON.stringify({
              settings: "page",
              id: 1,
              command: {
                kind: "fetch",
                path: "/kv",
                method: context === "unknown" ? "PUT" : "GET",
                ...(context === "unknown" ? { body: "{}" } : {}),
              },
            }),
          },
        }),
      );
      expect(client.fetch).toHaveBeenCalledOnce();
    }
    if (context === "load")
      expect(onError).toHaveBeenCalledWith(expect.any(Error), context);
    else
      expect(onError).toHaveBeenCalledWith(
        expect.any(Error),
        context === "readBridge" ? "read" : context,
        context !== "readBridge",
      );
  },
);

// 用户要求配置卡片有内边距和高度上限；现有授权用例未覆盖页面高度消息。
// unit：同一生产组件依次接收短/长页面高度，再改变窗口尺寸，检查滚动及原会话保留。
it("bounds original settings content and resizes without replacing its document or lease", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const props = {
    identity: {
      deviceId: "host",
      instanceId: "plugin",
      expectedInstalledApproval: "approval",
    },
    active: true,
    generation: 1,
    assertCurrent() {},
    invokeTarget: vi.fn(),
    openSession: vi.fn(),
  };
  const root = createRoot(document.createElement("div"));
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  const render = () => root.render(createElement(PluginSettingsCard, props));
  await act(async () => render());
  const source = state.web.source.uri;
  const reportHeight = async (height: number) =>
    act(async () =>
      state.web.onMessage({
        nativeEvent: { data: JSON.stringify({ settings: "page", height }) },
      }),
    );
  await reportHeight(100);
  expect(state.cardStyle.height).toBe(132);
  expect(state.cardStyle.padding).toBe(16);
  expect(state.web.style.height).toBe(100);
  expect(state.web.scrollEnabled).toBe(false);
  await reportHeight(2000);
  expect(state.cardStyle.height).toBe(400);
  expect(state.web.style.height).toBe(368);
  expect(state.web.scrollEnabled).toBe(true);
  expect(state.web.nestedScrollEnabled).toBe(true);
  state.windowHeight = 600;
  await act(async () => render());
  expect(state.cardStyle.height).toBe(300);
  expect(state.web.style.height).toBe(268);
  state.windowHeight = 1000;
  await act(async () => render());
  expect(state.cardStyle.height).toBe(420);
  expect(state.web.source.uri).toBe(source);
  expect(state.clients).toHaveLength(1);
  expect(state.resources).toHaveLength(1);
  expect(state.clients[0].close).not.toHaveBeenCalled();
});

it("routes external anchors and new windows once, keeps package navigation local, and rejects stale links", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: () => void;
  const onOpenLink = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    identity: {
      deviceId: "host",
      instanceId: "plugin",
      expectedInstalledApproval: "approval",
    },
    active: true,
    generation: 1,
    assertCurrent: vi.fn(),
    invokeTarget: vi.fn(),
    openSession: vi.fn(),
    onOpenLink,
  };
  const element = document.createElement("div"),
    root = createRoot(element);
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  await act(async () => root.render(createElement(PluginSettingsCard, props)));
  const web = state.web;
  expect(
    web.onShouldStartLoadWithRequest({ url: web.source.uri + "#section" }),
  ).toBe(true);
  const url = "https://example.com/console#keys";
  await act(async () => {
    expect(web.onShouldStartLoadWithRequest({ url })).toBe(false);
    web.onOpenWindow({ nativeEvent: { targetUrl: url } });
  });
  expect(onOpenLink).toHaveBeenCalledExactlyOnceWith(url, expect.any(Function));
  await act(async () => {
    finish();
  });
  await act(async () =>
    root.render(
      createElement(PluginSettingsCard, {
        ...props,
        identity: { ...props.identity, instanceId: "other" },
      }),
    ),
  );
  await act(async () => web.onOpenWindow({ nativeEvent: { targetUrl: url } }));
  expect(onOpenLink).toHaveBeenCalledTimes(1);
});

// Regression: downloading the package is not a rendered WebView. Unit callback sequence
// covers the reported spinner-free blank interval, navigation, failure and stale pages.
it("keeps loading through resource preparation until WebView loads, including reload and failure", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const onLoading = vi.fn(),
    onError = vi.fn();
  const props = {
    identity: {
      deviceId: "host",
      instanceId: "plugin",
      expectedInstalledApproval: "approval",
    },
    active: true,
    generation: 1,
    assertCurrent: vi.fn(),
    invokeTarget: vi.fn(),
    openSession: vi.fn(),
    onLoading,
    onError,
  };
  const root = createRoot(document.createElement("div"));
  cleanup = async () => {
    await act(async () => root.unmount());
  };
  await act(async () => root.render(createElement(PluginSettingsCard, props)));
  expect(state.web.source.uri).toBeTruthy();
  expect(onLoading).toHaveBeenLastCalledWith(true);
  const first = state.web;
  await act(async () => first.onLoad());
  expect(onLoading).toHaveBeenLastCalledWith(false);
  await act(async () => first.onLoadStart());
  expect(onLoading).toHaveBeenLastCalledWith(true);
  await act(async () => first.onError());
  expect(onLoading).toHaveBeenLastCalledWith(false);
  expect(onError).toHaveBeenLastCalledWith(expect.any(Error), "load");
  await act(async () =>
    root.render(createElement(PluginSettingsCard, { ...props, generation: 2 })),
  );
  expect(onLoading).toHaveBeenLastCalledWith(true);
  await act(async () => first.onLoad());
  expect(onLoading).toHaveBeenLastCalledWith(true);
});

// Each HTML document restarts its bridge request IDs. A late response must not
// resolve the new document's request with the same ID, or report its old error.
it.each([false, true])(
  "discards pending replies after in-package navigation (failed=%s)",
  async (failed) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const onError = vi.fn();
    const root = createRoot(document.createElement("div"));
    cleanup = async () => {
      await act(async () => root.unmount());
    };
    await act(async () =>
      root.render(
        createElement(PluginSettingsCard, {
          identity: {
            deviceId: "host",
            instanceId: "plugin",
            expectedInstalledApproval: "approval",
          },
          active: true,
          generation: 1,
          assertCurrent() {},
          invokeTarget: vi.fn(),
          openSession: vi.fn(),
          onError,
        }),
      ),
    );
    let finish!: () => void;
    state.clients[0].fetch.mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = () =>
            failed
              ? reject(new Error("OLD_DOCUMENT_FAILED"))
              : resolve({ oldDocument: true });
        }),
    );
    await act(async () =>
      state.web.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            settings: "page",
            id: 1,
            command: { kind: "fetch", path: "/kv", method: "GET" },
          }),
        },
      }),
    );
    await act(async () => state.web.onLoadStart());
    state.inject.mockClear();
    await act(async () => finish());
    expect(state.inject).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    state.clients[0].fetch.mockResolvedValueOnce({ newDocument: true });
    await act(async () =>
      state.web.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            settings: "page",
            id: 1,
            command: { kind: "fetch", path: "/kv", method: "GET" },
          }),
        },
      }),
    );
    expect(state.inject).toHaveBeenCalledWith(
      expect.stringContaining('"newDocument":true'),
    );
    expect(state.clients[0].fetch).toHaveBeenCalledTimes(2);
  },
);

// Production document lifecycle: late polls retain consumed Host notices but cannot
// deliver A's broadcasts or prompts to B; pending native answers belong to A too.
it.each(["poll", "prompt"])("isolates a pending %s across package navigation", async (pending) => {
  vi.useFakeTimers();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (value: any) => void;
  const gate = new Promise<any>((resolve) => { finish = resolve; });
  const onConfirm = vi.fn(() => gate), onNotice = vi.fn(), onError = vi.fn();
  const root = createRoot(document.createElement("div"));
  cleanup = async () => { await act(async () => root.unmount()); };
  await act(async () => root.render(createElement(PluginSettingsCard, {
    identity: { deviceId: "host", instanceId: "plugin", expectedInstalledApproval: "approval" },
    active: true, generation: 1, assertCurrent() {}, invokeTarget: vi.fn(), openSession: vi.fn(), onConfirm, onNotice, onError,
  })));
  const old = { events: [{ sequence: 1, channel: "test", data: "old" }], notifications: [{ text: "Saved on Host" }],
    confirms: [{ id: "first", expiresAt: Date.now() + 60_000 }, { id: "queued", expiresAt: Date.now() + 60_000 }] };
  state.clients[0].send.mockImplementationOnce(() => pending === "poll" ? gate : Promise.resolve(old));
  await act(async () => state.web.onLoad());
  if (pending === "prompt") expect(onConfirm).toHaveBeenCalledTimes(1);
  await act(async () => state.web.onLoadStart());
  state.inject.mockClear();
  await act(async () => finish(pending === "poll" ? old : true));
  expect(state.inject).not.toHaveBeenCalled();
  expect(onNotice).toHaveBeenCalledWith("Saved on Host");
  expect(onConfirm).toHaveBeenCalledTimes(pending === "poll" ? 0 : 1);
  expect(state.clients[0].send.mock.calls.some(([command]: any[]) => command.kind === "confirm")).toBe(false);
  // Host repeats unanswered prompts: they must not reappear on B's next poll.
  state.clients[0].send.mockResolvedValueOnce({ ...old, events: [], notifications: [] });
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(onConfirm).toHaveBeenCalledTimes(pending === "poll" ? 0 : 1);
  expect(onError).not.toHaveBeenCalled();
  expect(onNotice).toHaveBeenCalledTimes(1);
  onConfirm.mockResolvedValueOnce(true);
  state.clients[0].send.mockResolvedValueOnce({ events: [], notifications: [], confirms: [{ id: "new-document", expiresAt: Date.now() + 60_000 }] });
  await act(async () => vi.advanceTimersByTimeAsync(800));
  expect(state.clients[0].send).toHaveBeenCalledWith({ kind: "confirm", requestId: "new-document", accepted: true });
});

it("releases old subscriptions before the new document subscribes, including an in-flight subscribe", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  cleanup = async () => { await act(async () => root.unmount()); };
  await act(async () => root.render(createElement(PluginSettingsCard, {
    identity: { deviceId: "host", instanceId: "plugin", expectedInstalledApproval: "approval" },
    active: true, generation: 1, assertCurrent() {}, invokeTarget: vi.fn(), openSession: vi.fn(),
  })));
  let finish!: () => void;
  state.clients[0].send.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  const subscribe = () => state.web.onMessage({ nativeEvent: { data: JSON.stringify({ settings: "page", id: 1, command: { kind: "subscribe", channels: ["test"] } }) } });
  await act(async () => subscribe());
  await act(async () => state.web.onLoadStart());
  await act(async () => subscribe());
  expect(state.clients[0].send).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(state.clients[0].send.mock.calls.map(([command]: any[]) => command)).toEqual([
    { kind: "subscribe", channels: ["test"] }, { kind: "unsubscribe", channel: "test" }, { kind: "subscribe", channels: ["test"] },
  ]);
});

// #6680 unseen-confirm gap: activate the new Host document before reads/posts,
// without serializing a confirmation-dependent fetch ahead of its cancellation.
// Production component; memory transport, fake clock; tier: unit.
it("activates the Host document before commands and does not deadlock navigation behind a pending fetch", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const root = createRoot(document.createElement("div"));
  cleanup = async () => { await act(async () => root.unmount()); };
  await act(async () => root.render(createElement(PluginSettingsCard, {
    identity: { deviceId: "host", instanceId: "plugin", expectedInstalledApproval: "approval" },
    active: true, generation: 1, assertCurrent() {}, invokeTarget: vi.fn(), openSession: vi.fn(),
  })));
  const client = state.clients[0];
  client.document.documentIsolation = true;
  let activate!: () => void, finishFetch!: (value: unknown) => void;
  client.send.mockImplementationOnce(() => new Promise<void>(resolve => { activate = resolve; }));
  client.fetch.mockImplementationOnce(() => new Promise(resolve => { finishFetch = resolve; }));
  await act(async () => state.web.onLoadStart());
  await act(async () => state.web.onMessage({ nativeEvent: { data: JSON.stringify({ settings: "page", id: 1, command: { kind: "fetch", path: "/kv", method: "PUT", body: '{"label":"A"}' } }) } }));
  expect(client.fetch).not.toHaveBeenCalled();
  await act(async () => activate());
  expect(client.fetch).toHaveBeenCalledWith("/kv", "PUT", '{"label":"A"}');
  await act(async () => state.web.onLoadStart());
  expect(client.send.mock.calls.map(([command]: any[]) => command)).toEqual([{ kind: "document", epoch: 1 }, { kind: "document", epoch: 2 }]);
  state.inject.mockClear();
  await act(async () => finishFetch({ status: 200, mime: "application/json", base64: "e30=" }));
  expect(state.inject).not.toHaveBeenCalled();
});
