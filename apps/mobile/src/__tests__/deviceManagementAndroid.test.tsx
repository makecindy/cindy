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
    return null;
  },
  Text: ({ children }: { children?: ReactNode }) => createElement("span", null, children),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/theme", async () => {
  const tokens = await import("@/theme/tokens");
  return { ...tokens, useTheme: () => ({ colors: tokens.lightColors, mode: "light" }) };
});

import { DeviceInformationFields } from "@/device-link/DeviceInformationFields";
import { DeviceManagementList } from "@/device-link/DeviceManagementList";

function device(id: string, online: boolean): DeviceView {
  return { deviceId: id, name: `Mac ${id}`, online } as DeviceView;
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
        rows: [{ device: target, statusDetail: "just now", statusLabel: "Online" }],
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

  it("shows only the status when online and status · detail when offline", () => {
    renderToStaticMarkup(
      createElement(DeviceManagementList, {
        busy: false,
        onDelete: vi.fn(),
        onOpen: vi.fn(),
        onRename: vi.fn(),
        rows: [
          { device: device("on", true), statusDetail: "just now", statusLabel: "Online" },
          { device: device("off", false), statusDetail: "2h ago", statusLabel: "Offline" },
        ],
      }),
    );
    const contents = captured.texts.map((text) => text.children);
    expect(contents).toContain("Online");
    expect(contents).not.toContain("Online · just now");
    expect(contents).toContain("Offline · 2h ago");
    const offlineName = captured.texts.find((text) => text.children === "Mac off");
    const onlineName = captured.texts.find((text) => text.children === "Mac on");
    expect(offlineName?.style.color).toBe(lightColors.textSecondary);
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
});
