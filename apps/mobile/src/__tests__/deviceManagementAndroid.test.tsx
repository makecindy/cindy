import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeviceView } from "@cindy/device-link";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { lightColors } from "@/theme/tokens";

type Captured = Record<string, unknown>;
const captured = vi.hoisted(() => ({
  icons: [] as { name: string; props: Captured }[],
  listItems: [] as Captured[],
  pressables: [] as Captured[],
  texts: [] as { children: unknown; style: Captured }[],
}));

function flatten(style: unknown): Captured {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === "object" ? (style as Captured) : {};
}

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  Pressable: (props: Captured & { children?: ReactNode }) => {
    captured.pressables.push(props);
    return createElement("div", null, props.children);
  },
  RefreshControl: () => null,
  ScrollView: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
}));
vi.mock("@/components/AppText", () => ({
  Text: ({ children, style }: { children?: ReactNode; style?: unknown }) => {
    captured.texts.push({ children, style: flatten(style) });
    return createElement("span", null, children);
  },
}));
vi.mock("lucide-react-native", () => {
  const icon = (name: string) => (props: Captured) => {
    captured.icons.push({ name, props });
    return null;
  };
  return { Monitor: icon("Monitor"), Pencil: icon("Pencil"), Trash2: icon("Trash2") };
});
vi.mock("@/platform/gestureHandler", () => ({
  ClassicSwipeable: ({
    children,
    renderLeftActions,
    renderRightActions,
  }: {
    children?: ReactNode;
    renderLeftActions(): ReactNode;
    renderRightActions(): ReactNode;
  }) => createElement("div", null, renderLeftActions(), children, renderRightActions()),
}));
vi.mock("@expo/ui", () => ({
  ListItem: (props: Captured) => {
    captured.listItems.push(props);
    return createElement("div", null, props.children as ReactNode);
  },
  Host: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("@expo/ui/swift-ui", () => {
  const container = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  const SwipeActions = Object.assign(container, { Actions: container });
  return { Button: container, Circle: () => null, HStack: container, List: container, Section: container, SwipeActions, Text: container };
});
vi.mock("@expo/ui/swift-ui/modifiers", () => {
  const modifier = () => ({});
  return { accessibilityLabel: (label: string) => ({ label }), disabled: modifier, font: modifier,
    foregroundStyle: modifier, frame: modifier, labelStyle: modifier, listRowBackground: modifier,
    listStyle: modifier, refreshable: modifier, scrollContentBackground: modifier, tint: modifier };
});
vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (key: string, options?: { name?: string }) => options?.name ? `${key}: ${options.name}` : key }),
}));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors, mode: "light" }),
    useThemedStyles: <T,>(make: (colors: typeof tokens.lightColors) => T) => make(tokens.lightColors),
  };
});
vi.mock("@/components/MobilePrimitives", () => ({ StatusDot: () => null }));
vi.mock("@/session/SettingsGroupRows", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  useSettingsRowStyles: () => ({}),
}));

import { DeviceInformationFields } from "@/device-link/DeviceInformationFields";
import { DeviceManagementList } from "@/device-link/DeviceManagementList";
import { DeviceManagementList as IOSDeviceManagementList } from "@/device-link/DeviceManagementList.ios";
import i18n from "@/i18n";

function device(id: string, online: boolean): DeviceView {
  return { deviceId: id, name: `Mac ${id}`, online, lastSeenAt: null } as DeviceView;
}

function row(target: DeviceView, statusLabel: string, statusDetail: string) {
  return { device: target, statusDetail, statusLabel, canOpen: target.online, state: target.online ? "ready" as const : "offline" as const };
}

describe("Android device management follows iOS interactions", () => {
  beforeEach(() => {
    captured.icons = [];
    captured.listItems = [];
    captured.pressables = [];
    captured.texts = [];
  });

  it("uses icon-only swipe actions that keep screen-reader labels", () => {
    const onRename = vi.fn();
    const onDelete = vi.fn();
    const target = device("a", true);
    renderToStaticMarkup(
      createElement(DeviceManagementList, {
        busy: false,
        onDelete,
        onOpen: vi.fn(),
        onRename,
        onRefresh: vi.fn(async () => undefined),
        rows: [row(target, "Online", "just now")],
      }),
    );
    const rename = captured.pressables.find((p) => p.testID === "deviceManagement.rename.a");
    const remove = captured.pressables.find((p) => p.testID === "deviceManagement.delete.a");
    expect(rename).toMatchObject({ accessibilityLabel: "devices.list.menu.renameDevice", accessibilityRole: "button" });
    expect(remove).toMatchObject({ accessibilityLabel: "devices.common.delete", accessibilityRole: "button" });
    const pencil = captured.icons.find((icon) => icon.name === "Pencil");
    const trash = captured.icons.find((icon) => icon.name === "Trash2");
    expect(pencil?.props.color).toBe(lightColors.textPrimary);
    expect(trash?.props.color).toBe(lightColors.destructive);
    // 滑动按钮里不再渲染文字标签。
    const labels = captured.texts.map((text) => text.children);
    expect(labels).not.toContain("devices.common.delete");
    expect(labels).not.toContain("devices.list.menu.renameDevice");
    (rename?.onPress as () => void)();
    (remove?.onPress as () => void)();
    expect(onRename).toHaveBeenCalledWith(target);
    expect(onDelete).toHaveBeenCalledWith(target);
  });

  // 分组列表:离线分组标题已说明「离线」,行内只留时间;在线行显示「状态 · 说明」。名称始终用主字色。
  it("keeps status · detail for online rows and only the time inside the offline group", () => {
    renderToStaticMarkup(
      createElement(DeviceManagementList, {
        busy: false,
        onDelete: vi.fn(),
        onOpen: vi.fn(),
        onRename: vi.fn(),
        onRefresh: vi.fn(async () => undefined),
        rows: [
          row(device("on", true), "Online", "just now"),
          row(device("off", false), "Offline", "2h ago"),
        ],
      }),
    );
    const contents = captured.texts.map((text) => text.children);
    expect(contents).toContain("Online · just now");
    expect(contents).toContain("2h ago");
    expect(contents).not.toContain("Offline · 2h ago");
    const offlineName = captured.texts.find((text) => text.children === "Mac off");
    const onlineName = captured.texts.find((text) => text.children === "Mac on");
    expect(offlineName?.style.color).toBe(lightColors.textPrimary);
    expect(onlineName?.style.color).toBe(lightColors.textPrimary);
  });

  it("puts field labels on the left and values on the right", () => {
    renderToStaticMarkup(
      createElement(DeviceInformationFields, {
        fields: [
          ["name", "My Mac"],
          ["status", "Online"],
        ],
      }),
    );
    expect(captured.listItems).toHaveLength(2);
    const [name] = captured.listItems;
    expect(name.children).toBe("devices.management.fields.name");
    expect(name.supportingText).toBeUndefined();
    const trailing = name.trailing as { props: { children: string; textStyle: Captured } };
    expect(trailing.props.children).toBe("My Mac");
    expect(trailing.props.textStyle).toMatchObject({
      color: lightColors.textSecondary,
      textAlign: "right",
    });
  });

  // Regression: passing no roster made two cached ID-as-name devices indistinguishable.
  // Both production lists must label across sections without changing their action targets.
  it.each([['android', DeviceManagementList], ['ios', IOSDeviceManagementList]] as const)(
    '%s disambiguates unnamed rows and their screen-reader labels using the complete list',
    (platform, List) => {
      const first = { ...device('a', true), name: 'a' };
      const second = { ...device('b', false), name: 'b' };
      const onOpen = vi.fn();
      const html = renderToStaticMarkup(createElement(List, {
        busy: false, rows: [row(first, 'Online', 'just now'), row(second, 'Offline', '2h ago')],
        onOpen, onRename: vi.fn(), onDelete: vi.fn(), onRefresh: vi.fn(async () => undefined),
      }));
      const fallback = i18n.t('devices.cloudCompanion.unknownDevice');
      for (const [index, target] of [first, second].entries()) {
        const name = `${fallback} (${index + 1})`;
        expect(html).toContain(name);
        const item = (platform === 'android' ? captured.pressables : captured.listItems)
          .find((props) => props.testID === `deviceManagement.open.${target.deviceId}`);
        const label = `devices.management.openDevice: ${name}`;
        if (platform === 'android') expect(item?.accessibilityLabel).toBe(label);
        else expect(item?.modifiers).toContainEqual({ label: `${label}, ${target.online ? 'Online · just now' : '2h ago'}` });
        (item?.onPress as () => void)();
        expect(onOpen).toHaveBeenLastCalledWith(target);
      }
    },
  );
});
