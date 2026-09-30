import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MobileHomeDeviceFilterItem } from "@/session/mobileHome";

vi.mock("react-native", () => ({
  Platform: { OS: "android" },
  NativeModules: {},
  UIManager: { getViewManagerConfig: () => ({}) },
}));
vi.mock("@react-native-menu/menu", () => ({ MenuView: () => null }));
vi.mock("@/theme", () => ({ useTheme: () => ({ colors: {} }) }));
vi.mock("@/platform/chrome/AnchoredPullDownMenu", () => ({ AnchoredPullDownMenu: () => null }));

import { usesNativePullDownMenu } from "@/platform/chrome/NativePullDownMenu";
import { buildPullDownMenuSections } from "@/platform/chrome/pullDownMenuModel";
import {
  buildHomeDisplayPullDownActions,
  buildHomeScopePullDownActions,
} from "@/session/homeChromeMenus";

const readSource = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

function filter(
  overrides: Partial<MobileHomeDeviceFilterItem>,
): MobileHomeDeviceFilterItem {
  return {
    available: true,
    deviceId: "mac",
    id: "device:mac",
    label: "My Mac",
    selected: false,
    sessionCount: 1,
    state: "ready",
    ...overrides,
  } as MobileHomeDeviceFilterItem;
}

const displayInput = {
  groupByProject: true,
  groupByProjectLabel: "By project",
  groupDialogue: false,
  groupDialogueLabel: "Dialogue",
  groupHeading: "Group",
  projectOrder: "custom" as const,
  projectOrderActivityLabel: "Activity",
  projectOrderCustomLabel: "Manual",
  projectOrderHeading: "Project order",
  showProjectOrder: true,
  sortBy: "priority" as const,
  sortByPriorityLabel: "Priority",
  sortByTimeLabel: "Time",
  sortHeading: "Sort",
  statusActiveLabel: "Active",
  statusAllLabel: "All",
  statusArchivedLabel: "Archived",
  statusFilter: "archived" as const,
  statusHeading: "Status",
};

describe("Android home chrome menus follow the iOS pull-down", () => {
  it("always opens the anchored pull-down on Android", () => {
    expect(usesNativePullDownMenu()).toBe(true);
  });

  it("keeps the scope items, order and checks without device status", () => {
    const actions = buildHomeScopePullDownActions(
      [
        filter({ deviceId: null, id: "all", label: "All", selected: false }),
        filter({ selected: true }),
        filter({ available: false, deviceId: "win", id: "device:win", label: "Win", state: "offline" }),
      ],
      "All tasks",
      [{ id: "teammates", title: "Teammates" }],
    );
    const sections = buildPullDownMenuSections(actions);
    expect(sections).toHaveLength(1);
    const android = sections[0].rows;
    expect(android).toEqual(actions);
    expect(android.map((action) => [action.id, action.title, action.state])).toEqual([
      ["all", "All tasks", "off"],
      ["scope.collection:teammates", "Teammates", undefined],
      ["device:mac", "My Mac", "on"],
      ["device:win", "Win", "off"],
    ]);
    for (const action of android) {
      expect(action).not.toHaveProperty("subtitle");
      expect(action).not.toHaveProperty("image");
    }
  });

  it("renders the display groups as titled sections in iOS order with the same checks", () => {
    const actions = buildHomeDisplayPullDownActions(displayInput);
    const iosLeaves = actions.flatMap((group) => group.subactions ?? []);
    const sections = buildPullDownMenuSections(actions);
    // 每个带标题的内联分组对应一段带标题的分组,和 iOS UIMenu 一样。
    expect(sections.map((section) => section.title)).toEqual(
      actions.map((group) => group.title.trim() || undefined),
    );
    const android = sections.flatMap((section) => section.rows);
    expect(android).toEqual(iosLeaves);
    expect(android.map((action) => [action.id, action.state])).toEqual([
      ["groupByProject", "on"],
      ["groupDialogue", "off"],
      ["sort.recency", "off"],
      ["sort.priority", "on"],
      ["projectOrder.activity", "off"],
      ["projectOrder.custom", "on"],
      ["status.active", "off"],
      ["status.archived", "on"],
      ["status.all", "off"],
    ]);
  });

  it("wires the Android header to the same pull-down actions as the iOS header", () => {
    const home = readSource("src/session/HomeSurface.tsx");
    const androidHeader = home.slice(
      home.indexOf("{nativeHomeHeader ? null : ("),
      home.indexOf("{searchOpen || !!searchQuery.trim()"),
    );
    expect(androidHeader).toContain("actions={homeScopePullDownActions}");
    expect(androidHeader).toContain("onAction={handleHomeScopeAction}");
    expect(androidHeader).toContain("actions={homeDisplayPullDownActions}");
    // 自绘范围 / 显示设置面板只在包里没有 MenuView 时兜底。
    expect(androidHeader).toContain("onPress={nativeHomeMenus ? () => undefined : openDeviceMenu}");
    expect(androidHeader).toContain("onPress={nativeHomeMenus ? () => undefined : openDisplaySettings}");
    const iosHeader = home.slice(home.indexOf("<HomeNativeStackHeader"), home.indexOf("/>", home.indexOf("<HomeNativeStackHeader")));
    expect(iosHeader).toContain("scopeActions={homeScopePullDownActions}");
    expect(iosHeader).toContain("displayActions={homeDisplayPullDownActions}");
  });

  it("routes settings pickers and local-log options through the pull-down on Android", () => {
    const settings = readSource("app/settings.tsx");
    // 只按 MenuView 是否可用分流,不按平台:Android 与 iOS 同走系统下拉,自绘 sheet / Alert 仅作回退。
    expect(settings).not.toMatch(/Platform\.OS\s*===\s*['"]ios['"]/);
    expect(settings).toContain("onPress={usesNativePullDownMenu() ? () => undefined : openAppearancePicker}");
    expect(settings).toContain("onPress={usesNativePullDownMenu() ? () => undefined : openLanguagePicker}");
    expect(settings).toContain("onPress={usesNativePullDownMenu() ? undefined : () => Alert.alert(t('settings.localLogs.options')");
    expect(settings.match(/<NativePullDownMenu/g)).toHaveLength(3);
  });
});
