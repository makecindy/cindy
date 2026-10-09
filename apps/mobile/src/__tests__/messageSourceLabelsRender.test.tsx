// @vitest-environment jsdom
/**
 * 消息来源标签渲染:设备(查看者自己发的不标)、插件、共享任务作者(气泡上方)、
 * 脱敏自动化、本机 IM 卡片(保留普通用户操作)。沿用 pluginAttachmentBubble 的 RN 替身。
 */
import { act, createElement, useImperativeHandle, useState } from "react";
import { createRoot } from "react-dom/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

const viewportHarness = vi.hoisted(() => ({
  list: null as any,
  finishReveal: null as any,
  renders: 0,
}));

// Keep the production list, bubble gate, invocation header, and message model.
// Only native surfaces and unrelated heavy viewers are replaced for Node rendering.
vi.mock("react-native", async () => {
  const React = await import("react");
  // onLongPress 映射到 contextmenu,便于测试长按显示来源 ID。
  const view = ({ children, testID, accessibilityLabel, accessibilityHint, onLongPress }: any) =>
    React.createElement(
      "div",
      {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        ...(accessibilityHint ? { "data-hint": accessibilityHint } : {}),
        ...(onLongPress ? { onContextMenu: () => onLongPress() } : {}),
      },
      children,
    );
  class Value {
    constructor(public value: number) {}
    interpolate() {
      return 0;
    }
    setValue() {}
    stopAnimation() {}
  }
  return {
    View: view,
    Text: view,
    Pressable: view,
    ScrollView: view,
    Modal: () => null,
    Image: Object.assign(view, { getSize() {} }),
    ActivityIndicator: view,
    Animated: {
      Value,
      View: view,
      Text: view,
      createAnimatedComponent: (c: any) => c,
      timing: () => ({
        start(callback: any) {
          viewportHarness.finishReveal = callback;
        },
        stop() {},
      }),
      loop: () => ({ start() {}, stop() {} }),
      sequence: () => ({ start() {}, stop() {} }),
    },
    Platform: { OS: "ios", select: (s: any) => s.ios ?? s.default },
    StyleSheet: {
      create: (s: any) => s,
      flatten: (s: any) => s,
      hairlineWidth: 1,
    },
    Easing: { linear: (n: number) => n, bezier: () => (n: number) => n },
    AccessibilityInfo: {},
    Alert: {},
    Linking: {},
    StatusBar: {},
    useWindowDimensions: () => ({
      width: 402,
      height: 874,
      scale: 3,
      fontScale: 1,
    }),
  };
});
vi.mock("@legendapp/list/react-native", () => ({
  LegendList: ({ data, renderItem, ref, ...props }: any) => {
    viewportHarness.renders += 1;
    viewportHarness.list = { ...props, data };
    useImperativeHandle(ref, () => ({
      scrollToEnd() {},
      scrollToOffset() {},
      getState() {
        return undefined;
      },
    }));
    return data.map((item: any, index: number) =>
      createElement("section", { key: item.key }, renderItem({ item, index })),
    );
  },
  useRecyclingState: (initial: any) => useState(initial),
  useViewability: () => {},
}));
vi.mock("lucide-react-native", () => ({
  Database: () => null,
  FileArchive: () => null,
  FileAudio: () => null,
  FileChartColumn: () => null,
  FileCode: () => null,
  FileImage: () => null,
  FileSpreadsheet: () => null,
  FileText: () => null,
  FileVideo: () => null,
  ArrowLeftRight: () => null,
  ArrowUp: () => null,
  Bot: () => null,
  Check: () => null,
  ChevronDown: () => null,
  ChevronRight: () => null,
  ChevronUp: () => null,
  Circle: () => null,
  CircleAlert: () => null,
  CircleCheck: () => null,
  CircleDashed: () => null,
  CircleStop: () => null,
  Copy: () => null,
  Ellipsis: () => null,
  ExternalLink: () => null,
  File: () => null,
  Ghost: () => null,
  Layers: () => null,
  MessageSquare: () => null,
  Monitor: () => null,
  Smartphone: () => null,
  ListTodo: () => null,
  LoaderCircle: () => null,
  PencilLine: () => null,
  RefreshCw: () => null,
  Send: () => null,
  Share: () => null,
  Sparkles: () => null,
  Split: () => null,
  Timer: () => null,
  Trash2: () => null,
  TriangleAlert: () => null,
  Undo2: () => null,
  X: () => null,
}));
vi.mock("react-native-svg", () => ({
  default: () => null,
  Circle: () => null,
}));
vi.mock("react-native-uitextview", () => ({ UITextView: () => null }));
vi.mock("expo-image", () => ({ Image: () => null }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useFocusEffect: vi.fn(),
  useNavigation: () => ({ isFocused: () => true, addListener: () => () => {} }),
}));
vi.mock("@/device-link/DeviceLinkContext", () => ({
  useDeviceLink: () => ({
    status: "offline",
    connectionEpoch: 0,
    getPresenceAvailability: () => false,
    invoke: vi.fn(),
    openLink: vi.fn(),
  }),
  subscribeRemoteBotChanges: () => () => {},
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  const colors = new Proxy({}, { get: () => "#777777" });
  return {
    ...tokens,
    monoFont: "monospace",
    useTheme: () => ({ colors, mode: "light" }),
    useThemedStyles: (make: any) => make(colors),
  };
});
vi.mock("@/components/AppText", async () => ({
  Text: (await import("react-native")).Text,
  MAX_FONT_SIZE_MULTIPLIER: 2,
}));
vi.mock("@/auth/AuthContext", () => ({
  useAuth: () => ({ accountGeneration: 1 }),
}));
vi.mock("@/session/usePluginResultCard", () => ({
  usePluginResultCard: () => ({}),
  useSessionPluginResource: () => ({ title: "Art" }),
}));
vi.mock("@/session/remoteMediaDiskCacheExpo", () => ({
  downloadRemoteMediaShareTemp: vi.fn(),
}));
vi.mock("@/hooks/useReduceMotion", () => ({
  useReduceMotionEnabled: () => true,
}));
vi.mock("@/session/expandedBlockMemory", () => ({
  useFoldableExpandedState: () => [false, vi.fn()],
}));
vi.mock("@/platform/chrome", () => ({
  NativePullDownMenu: () => null,
  showActionMenu: vi.fn(),
  usesNativePullDownMenu: () => false,
  usesSystemActionMenu: () => false,
}));
vi.mock("@/session/MobileComposerInputRow", () => ({
  MobileComposerInputRow: () => null,
  MOBILE_COMPOSER_VOICE_ANCHOR_RIGHT: 0,
  MOBILE_COMPOSER_CONTROL_SIZE: 44,
}));
vi.mock("@/session/ImageLightbox", () => ({ ImageLightbox: () => null }));
vi.mock("@/session/mermaidWebView", () => ({ MermaidDiagram: () => null }));
vi.mock("@/session/mathWebView", () => ({ MathFormulaWebView: () => null }));
vi.mock("@/session/mediaPlayerWebView", () => ({
  RemoteMediaPlayerWebView: () => null,
}));
vi.mock("@/session/MarkdownBlockContent", () => ({
  MarkdownBlockContent: () => null,
}));
vi.mock("@/session/MessageActionSheet", () => ({
  MessageActionSheet: () => null,
}));
vi.mock("@/session/AuthorizationMessageCard", () => ({
  AuthorizationMessageCard: () => null,
}));
vi.mock("@/session/CompanionMessageActions", () => ({
  CompanionMessageActions: () => null,
}));
vi.mock("@/session/CompanionMessageCard", () => ({
  CompanionMessageCard: () => null,
}));
vi.mock("@/session/PendingSendBubble", () => ({
  PendingSendBubble: () => null,
}));
vi.mock("@/session/messageActions", async (original) => ({
  ...(await original<object>()),
  copyMessageText: vi.fn(),
  writeClipboardText: vi.fn(),
}));

import { i18n } from "@/i18n";
import { MessageRenderer } from "@/session/MessageRenderer";
import { buildMobileMessageRenderItems } from "@/session/messageRenderModel";
import { remoteSessionStore } from "@/session/remoteSessionStore";
import type { RemoteMessage } from "@/session/types";

const msg = (
  id: string,
  content: unknown,
  agentMeta: Record<string, unknown> | null,
): RemoteMessage => ({
  id,
  clientId: id,
  sessionId: "s",
  role: "user",
  content,
  toolUseId: null,
  agentMeta,
  createdAt: "2026-01-01T00:00:00Z",
});

function render(
  messages: RemoteMessage[],
  props: Record<string, unknown> = {},
): string {
  const items = buildMobileMessageRenderItems(messages, {}).filter(
    (item) => item.type === "message",
  );
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => root.render(<MessageRenderer items={items} {...props} />));
  const html = host.innerHTML;
  act(() => root.unmount());
  return html;
}

beforeAll(async () => {
  await i18n.changeLanguage("zh-CN");
});

describe("device source label", () => {
  const fromPhone = msg("m1", "hi", {
    sourceDevice: { deviceId: "phone-a", name: "快照名", platform: "mobile" },
  });

  it("is hidden on the phone that sent the message (viewer == sender)", () => {
    const html = render([fromPhone], {
      viewerDeviceId: "phone-a",
      onOpenSourceDevice: vi.fn(),
    });
    expect(html).not.toContain("message.sourceDevice");
    expect(html).not.toContain("从手机");
  });

  it("labels messages sent from another device, outside (above) the bubble", () => {
    const html = render([fromPhone], {
      viewerDeviceId: "phone-b",
      onOpenSourceDevice: vi.fn(),
    });
    expect(html).toContain("从手机「快照名」发送");
    const labelAt = html.indexOf("message.sourceDevice");
    const bubbleAt = html.indexOf("message.userBubble");
    expect(labelAt).toBeGreaterThan(-1);
    expect(labelAt).toBeLessThan(bubbleAt);
  });

  it("never labels host-local input (no sourceDevice)", () => {
    const html = render([msg("m2", "local", null)], {
      viewerDeviceId: "phone-b",
    });
    expect(html).not.toContain("message.sourceDevice");
  });

  it("prefers the live device name and disambiguates same-name devices with a short id", () => {
    remoteSessionStore.setDeviceIdentity([
      { deviceId: "phone-a", name: "iPhone" },
      { deviceId: "phone-c", name: "iPhone" },
    ]);
    try {
      const html = render([fromPhone], { viewerDeviceId: "desktop-1" });
      expect(html).toContain("从手机「iPhone (phone-)」发送");
      expect(html).not.toContain("快照名");
    } finally {
      remoteSessionStore.setDeviceIdentity([]);
    }
  });

  it("uses computer wording for desktop controllers and the generic text without a name", () => {
    const html = render(
      [
        msg("m3", "x", {
          sourceDevice: { deviceId: "mac-1", platform: "desktop" },
        }),
      ],
      { viewerDeviceId: "phone-b" },
    );
    expect(html).toContain("从电脑发送");
  });
});

describe("sender source labels", () => {
  it("renders plugin, shared-task author (above the bubble) and redacted automation labels", () => {
    const html = render([
      msg("p", "plugin text", {
        sourcePlugin: { pluginId: "pl-1", name: "日报" },
      }),
      msg("a", "guest text", {
        sharedTaskAuthor: { displayName: "访客甲", memberId: "m" },
      }),
      msg("s", "heartbeat", { origin: { kind: "scheduler" } }),
    ]);
    expect(html).toContain("由插件「日报」发送");
    expect(html).toContain("由自动化发送");
    const authorAt = html.indexOf("message.sharedAuthor");
    expect(authorAt).toBeGreaterThan(-1);
    // 作者名不再在气泡内:作者标签出现在该条气泡之前。
    const guestBubbleAt = html.indexOf("message.userBubble", authorAt);
    expect(html.indexOf("访客甲")).toBeLessThan(guestBubbleAt);
  });
});

describe("IM source card", () => {
  it("renders local IM rows as a left-aligned Cindy card with the localized platform name", () => {
    const html = render([
      msg("im", "clean text", {
        imSource: {
          im: "feishu",
          userText: "clean text",
          contentFormat: "user-text",
        },
      }),
    ]);
    expect(html).toContain("message.hookSource");
    expect(html).toContain("Cindy · 来自 飞书");
    expect(html).toContain("message.agentBubble");
    expect(html).not.toContain("message.userBubble");
  });

  it("keeps ordinary user actions on local IM rows but not on legacy hook rows (stored prompt)", () => {
    const props = {
      onForkMessage: vi.fn(),
      onPreviewRewind: vi.fn(),
      onDeleteMessage: vi.fn(),
    };
    const first = msg("first", "first question", null);
    const local = render(
      [
        first,
        msg("im", "clean text", {
          imSource: {
            im: "slack",
            userText: "clean text",
            contentFormat: "user-text",
          },
        }),
      ],
      props,
    );
    const legacy = render(
      [
        first,
        msg("hook", "prompt", {
          hookSource: { im: "slack", userText: "question" },
        }),
      ],
      props,
    );
    const count = (html: string) => html.split("message.forkButton").length - 1;
    // 首条普通用户消息本身不挂分叉;本机 IM 行挂,旧 Hook 行不挂。
    expect(count(local)).toBe(1);
    expect(count(legacy)).toBe(0);
  });

  it.each([
    ["slack", "Slack"],
    ["telegram", "Telegram"],
    ["x", "X"],
    ["lark", "Lark"],
    ["discord", "Discord"],
    ["wechat", "微信"],
    ["wecom", "企业微信"],
    ["dingtalk", "钉钉"],
  ])("labels %s as %s", (im, platform) => {
    const html = render([
      msg("h", "prompt", {
        hookSource: { im, userText: "question", channelName: "#general" },
      }),
    ]);
    expect(html).toContain(`Cindy · 来自 ${platform}`);
    expect(html).toContain("#general");
  });
});

describe("source labels reveal their ids on long press", () => {
  function longPress(messages: RemoteMessage[], testID: string): string {
    const items = buildMobileMessageRenderItems(messages, {}).filter(
      (item) => item.type === "message",
    );
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() => root.render(<MessageRenderer items={items} viewerDeviceId="phone-b" />));
    const label = host.querySelector(`[data-testid="${testID}"]`);
    expect(label).not.toBeNull();
    act(() => {
      label!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }));
    });
    const html = host.innerHTML;
    act(() => root.unmount());
    return html;
  }

  it("shows plugin, session and automation ids, like the device label", () => {
    expect(
      longPress([msg("p1", "run", { sourcePlugin: { pluginId: "ghost-github", name: "GitHub" } })], "message.sourcePlugin"),
    ).toContain("插件 ID：ghost-github");
    expect(
      longPress(
        [msg("s1", "go", { origin: { kind: "session", senderSessionId: "sess-9", senderSessionTitle: "检查" } })],
        "message.sessionOrigin",
      ),
    ).toContain("任务 ID：sess-9");
    const teammate = longPress(
      [msg("t1", "go", { origin: { kind: "session", senderSessionId: "sess-2", senderBotId: "bot-7", senderBotName: "Lizi" } })],
      "message.sessionOrigin",
    );
    expect(teammate).toContain("伙伴 ID：bot-7");
    expect(teammate).toContain("任务 ID：sess-2");
    expect(
      longPress(
        [msg("a1", "tick", { origin: { kind: "scheduler", scheduleId: "sch-7", scheduleName: "心跳" } })],
        "message.automationOrigin",
      ),
    ).toContain("自动化 ID：sch-7");
    expect(
      longPress(
        [msg("g1", "hi", { sharedTaskAuthor: { memberId: "mem-3", displayName: "张三" } })],
        "message.sharedAuthor",
      ),
    ).toContain("成员 ID：mem-3");
  });

  it("keeps redacted sources static (no id to reveal)", () => {
    const html = render([msg("r1", "tick", { origin: { kind: "scheduler" } })]);
    expect(html).toContain("由自动化发送");
    expect(html).not.toContain("自动化 ID");
    expect(html).not.toMatch(/data-testid="message.automationOrigin"[^>]*data-hint/);
  });
});

describe('private group reply source', () => {
  it('renders the host group name and id on assistant replies after remote normalization', () => {
    const html = render([{ ...msg('group-private', 'Private reply', {
      sourceGroup: { groupId: 'g-1', name: 'Design' },
      origin: { kind: 'session', senderSessionId: 'lane', senderBotId: 'bot-1' },
    }), role: 'assistant' }]);
    expect(html).toContain('从群聊「Design」发送');
    expect(html).toContain('群聊 ID：g-1');
    expect(html).toContain('message.groupSource');
    expect(render([{ ...msg('ordinary', 'Private', null), role: 'assistant' }])).not.toContain('message.groupSource');
  });
});
