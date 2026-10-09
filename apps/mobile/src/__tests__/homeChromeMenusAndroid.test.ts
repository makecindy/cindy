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
import { buildPullDownMenuSections, resolvePullDownSubmenu } from "@/platform/chrome/pullDownMenuModel";
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
  dialogueCount: 2,
  projects: [{ count: 1, key: "p1", title: "cindy" }],
  state: {
    groupByProject: true,
    groupDialogue: false,
    lastActivityFilter: "all" as const,
    projectFilter: "all" as const,
    projectOrder: "custom" as const,
    sortBy: "priority" as const,
    statusFilter: "archived" as const,
    taskInfoFields: ["time" as const],
    vendorFilter: "all" as const,
    viewMode: "list" as const,
  },
  t: (key: string) => key,
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

  it("renders the display menu as the same setting rows and submenus as iOS", () => {
    const actions = buildHomeDisplayPullDownActions(displayInput);
    const sections = buildPullDownMenuSections(actions);
    // 三段无标题分组 = iOS UIMenu 的三段分隔;每行是进入子菜单的设置项,标题下显示当前值。
    expect(sections.map((section) => section.title)).toEqual([undefined, undefined, undefined]);
    const rows = sections.flatMap((section) => section.rows);
    expect(rows).toEqual(actions.flatMap((group) => group.subactions ?? []));
    expect(rows.map((action) => [action.id, action.subtitle, !!action.subactions?.length])).toEqual([
      ["group", "devices.list.menu.groupProject", true],
      ["sort", "devices.list.menu.sortBy.priority", true],
      ["projectOrder", "devices.list.menu.projectOrder.custom", true],
      ["status", "devices.list.menu.status.archived", true],
      ["filter", "devices.list.menu.summaryNone", true],
      ["view", "devices.list.menu.view.list", true],
      ["taskInfo", "devices.list.menu.taskInfo.time", true],
    ]);
    const sort = resolvePullDownSubmenu(actions, ["sort"]);
    expect(sort?.subactions?.map((action) => [action.id, action.state])).toEqual([
      ["sort.priority", "on"],
      ["sort.recency", "off"],
      ["sort.created", "off"],
    ]);
    const projects = resolvePullDownSubmenu(actions, ["filter", "filter.projects"]);
    expect(buildPullDownMenuSections(projects?.subactions ?? []).map((section) => section.rows.map((row) => row.id)))
      .toEqual([["filter.projects.all"], ["filter.project:dialogue", "filter.project:p1"]]);
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
    // 自绘范围面板只在包里没有 MenuView 时兜底;显示菜单兜底用同一份菜单模型的自绘下拉。
    expect(androidHeader).toContain("onPress={nativeHomeMenus ? () => undefined : openDeviceMenu}");
    expect(androidHeader).toContain("<HomeDisplayMenu actions={homeDisplayPullDownActions} onAction={handleDisplayAction}>");
    const iosHeader = home.slice(home.indexOf("<HomeNativeStackHeader"), home.indexOf("/>", home.indexOf("<HomeNativeStackHeader")));
    expect(iosHeader).toContain("scopeActions={homeScopePullDownActions}");
    // iOS 系统顶栏的菜单项属于顶栏选项:传结构稳定的同一份菜单,后台同步不重建顶栏(会关掉菜单)。
    expect(iosHeader).toContain("displayActions={stableDisplayActions}");
    expect(home).toContain("useStableValue(homeDisplayPullDownActions, pullDownActionsEqual)");
    const nativeHeader = readSource("src/platform/chrome/HomeNativeStackHeader.tsx");
    expect(nativeHeader).toContain("export const HomeNativeStackHeader = memo(");
    // 三层菜单(分组 → 选项)只能走 Stack.Toolbar.Menu;MenuView 的 iOS 原生层只转两层。
    expect(nativeHeader).toContain('<Stack.Toolbar.Menu icon="ellipsis"');
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
