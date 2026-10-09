import { describe, expect, it } from "vitest";
import type { NativePullDownAction } from "@/platform/chrome";
import {
  buildHomeDisplayPullDownActions,
  buildHomeScopeMenuItems,
  buildHomeScopePullDownActions,
  parseHomeScopePullDownAction,
  homeDisplayActionPatch,
  type HomeDisplayMenuState,
} from "@/session/homeChromeMenus";
import type { MobileHomeDeviceFilterItem } from "@/session/mobileHome";

function filter(
  patch: Partial<MobileHomeDeviceFilterItem> &
    Pick<MobileHomeDeviceFilterItem, "id" | "label">,
): MobileHomeDeviceFilterItem {
  return {
    available: true,
    deviceId: null,
    selected: false,
    sessionCount: 0,
    state: "online",
    statusLabel: "",
    waitingCount: 0,
    ...patch,
  };
}

describe("home chrome menus", () => {
  it("keeps cached offline and unknown computers without granting revoked access", () => {
    const filters = ["offline", "unknown", "access_revoked", "remote_disabled"].map((state) =>
      filter({ id: state, label: state, deviceId: state, available: false, state, sessionCount: 2 }));
    expect(buildHomeScopeMenuItems(filters, "All").map((item) => item.key)).toEqual(["offline", "unknown"]);
    expect(buildHomeScopePullDownActions(filters, "All").map((item) => item.id)).toEqual(["offline", "unknown"]);
  });
  it("selects native device scopes directly without a management submenu", () => {
    const actions = buildHomeScopePullDownActions([
      filter({ id: "all", label: "全部任务" }),
      filter({ id: "mac", label: "MacBook", deviceId: "d1", selected: true }),
      filter({ id: "offline", label: "旧电脑", deviceId: "d2", available: false }),
    ], "全部任务");

    expect(actions).toEqual([
      { id: "all", title: "全部任务", state: "off" },
      { id: "mac", title: "MacBook", state: "on" },
    ]);
    expect(actions.every((item) => !item.subactions)).toBe(true);
  });

  it("places host-advertised collections beside All Sessions", () => {
    const actions = buildHomeScopePullDownActions(
      [
        filter({ id: "all", label: "全部任务", selected: true }),
        filter({ id: "mac", label: "MacBook", deviceId: "d1" }),
      ],
      "所有任务",
      [{ id: "teammates", title: "所有伙伴" }],
    );

    expect(actions.map((item) => item.id)).toEqual([
      "all",
      "scope.collection:teammates",
      "mac",
    ]);
    expect(parseHomeScopePullDownAction("scope.collection:teammates")).toEqual({
      kind: "collection",
      collectionId: "teammates",
    });
    expect(actions[2]).toEqual({ id: "mac", title: "MacBook", state: "off" });
    expect(parseHomeScopePullDownAction("mac")).toEqual({ kind: "select", filterId: "mac" });
  });

  it("lists all-conversations and available devices, marking the selected one", () => {
    const items = buildHomeScopeMenuItems(
      [
        filter({ id: "all", label: "全部任务", selected: true }),
        filter({
          id: "mac",
          label: "MacBook",
          deviceId: "d1",
          selected: false,
        }),
        filter({
          id: "offline",
          label: "旧电脑",
          deviceId: "d2",
          available: false,
        }),
      ],
      "全部任务",
    );

    expect(items.map((item) => item.key)).toEqual(["all", "mac"]);
    expect(items[0]?.label).toBe("✓ 全部任务");
    expect(items[1]?.label).toBe("MacBook");
  });

  const displayState: HomeDisplayMenuState = {
    groupByProject: true,
    groupDialogue: false,
    lastActivityFilter: "all",
    projectFilter: "all",
    projectOrder: "activity",
    sortBy: "recency",
    statusFilter: "active",
    taskInfoFields: ["time"],
    vendorFilter: "all",
    viewMode: "list",
  };
  // 用 key 本身当文案,断言不依赖具体语言。
  const t = (key: string, options?: Record<string, unknown>) =>
    options?.count === undefined ? key : `${key}:${String(options.count)}`;
  const build = (state: Partial<HomeDisplayMenuState> = {}) =>
    buildHomeDisplayPullDownActions({
      dialogueCount: 4,
      projects: [
        { count: 3, key: "p1", subtitle: "MacBook", title: "cindy" },
        { count: 1, key: "p2", title: "dash" },
      ],
      state: { ...displayState, ...state },
      t,
    });
  const find = (actions: readonly NativePullDownAction[], id: string): NativePullDownAction | undefined => {
    for (const action of actions) {
      if (action.id === id) return action;
      const nested = action.subactions ? find(action.subactions, id) : undefined;
      if (nested) return nested;
    }
    return undefined;
  };

  it("mirrors the desktop display menu: setting rows with current values and submenus", () => {
    const actions = build();
    expect(actions.map((item) => item.id)).toEqual(["organize", "narrow", "appearance"]);
    expect(actions.every((item) => item.displayInline && !item.preferredElementSize)).toBe(true);
    expect(actions.flatMap((item) => item.subactions?.map((row) => row.id) ?? [])).toEqual([
      "group",
      "sort",
      "projectOrder",
      "status",
      "filter",
      "view",
      "taskInfo",
    ]);
    expect(find(actions, "group")?.subtitle).toBe("devices.list.menu.groupProject");
    expect(find(actions, "sort")?.subtitle).toBe("devices.list.menu.sortBy.recency");
    expect(find(actions, "sort")?.subactions?.map((item) => item.id)).toEqual([
      "sort.priority",
      "sort.recency",
      "sort.created",
    ]);
    expect(find(actions, "sort.priority")?.subtitle).toBe("devices.list.menu.sortByPriorityTip");
    expect(find(actions, "filter")?.subtitle).toBe("devices.list.menu.summaryNone");
    expect(find(actions, "filter.reset")?.disabled).toBe(true);
    expect(find(actions, "view")?.subtitle).toBe("devices.list.menu.view.list");
    expect(find(actions, "taskInfo")?.subtitle).toBe("devices.list.menu.taskInfo.time");
    expect(find(actions, "taskInfo")?.subactions?.map((item) => [item.id, item.state, item.keepPresented])).toEqual([
      ["taskInfo.time", "on", true],
      ["taskInfo.pr", "off", true],
      ["taskInfo.worktree", "off", true],
      ["taskInfo.tokens", "off", true],
      ["taskInfo.cost", "off", true],
    ]);
  });

  it("hides project sorting when tasks are not grouped by project", () => {
    expect(find(build({ groupByProject: false }), "projectOrder")).toBeUndefined();
    expect(find(build({ groupByProject: false, groupDialogue: false }), "group")?.subtitle)
      .toBe("devices.list.menu.summaryNone");
  });

  it("lists every project plus chats in the project filter with counts", () => {
    const projects = find(build({ projectFilter: ["p2"] }), "filter.projects");
    expect(projects?.subtitle).toBe("devices.list.menu.filterSelectedProjects:1");
    const rows = projects?.subactions?.flatMap((item) => item.subactions ?? []) ?? [];
    expect(rows.map((item) => [item.id, item.state, item.subtitle])).toEqual([
      ["filter.projects.all", "off", undefined],
      ["filter.project:dialogue", "off", "4"],
      ["filter.project:p1", "off", "MacBook · 3"],
      ["filter.project:p2", "on", "1"],
    ]);
    // 「全部」时只勾「所有项目」(它是重置动作,点完收起);项目行只给明确选中的打勾。
    const allRows = find(build(), "filter.projects")?.subactions?.flatMap((item) => item.subactions ?? []) ?? [];
    expect(allRows.map((item) => [item.id, item.state, !!item.keepPresented])).toEqual([
      ["filter.projects.all", "on", false],
      ["filter.project:dialogue", "off", true],
      ["filter.project:p1", "off", true],
      ["filter.project:p2", "off", true],
    ]);
    const active = build({ lastActivityFilter: "7d", projectFilter: ["p2"], vendorFilter: "codex" });
    expect(find(active, "filter")?.subtitle).toBe("devices.list.menu.filterSummaryActive:3");
    expect(find(active, "filter.reset")?.disabled).toBe(false);
  });

  it("summarizes task info in the order the user checked it", () => {
    expect(find(build({ taskInfoFields: ["cost", "time"] }), "taskInfo")?.subtitle).toBe(
      "devices.list.menu.taskInfo.cost" + "devices.list.menu.summarySeparator" + "devices.list.menu.taskInfo.time",
    );
    expect(find(build({ taskInfoFields: [] }), "taskInfo")?.subtitle).toBe("devices.list.menu.summaryNone");
  });

  it("maps menu actions to preference patches", () => {
    expect(homeDisplayActionPatch("group.dialogue", displayState)).toEqual({ groupDialogue: true });
    expect(homeDisplayActionPatch("group.project", displayState)).toEqual({ groupByProject: false });
    expect(homeDisplayActionPatch("sort.created", displayState)).toEqual({ sortBy: "created" });
    expect(homeDisplayActionPatch("projectOrder.custom", displayState)).toEqual({ projectOrder: "custom" });
    expect(homeDisplayActionPatch("status.archived", displayState)).toEqual({ statusFilter: "archived" });
    expect(homeDisplayActionPatch("filter.vendor.pi", displayState)).toEqual({ vendorFilter: "pi" });
    expect(homeDisplayActionPatch("filter.lastActivity.30d", displayState)).toEqual({ lastActivityFilter: "30d" });
    expect(homeDisplayActionPatch("filter.project:p1", displayState)).toEqual({ projectFilter: ["p1"] });
    expect(homeDisplayActionPatch("filter.project:p1", { ...displayState, projectFilter: ["p1"] }))
      .toEqual({ projectFilter: "all" });
    expect(homeDisplayActionPatch("filter.projects.all", { ...displayState, projectFilter: ["p1"] }))
      .toEqual({ projectFilter: "all" });
    expect(homeDisplayActionPatch("filter.reset", displayState)).toEqual({
      lastActivityFilter: "all",
      projectFilter: "all",
      vendorFilter: "all",
    });
    expect(homeDisplayActionPatch("view.text", displayState)).toEqual({ viewMode: "text" });
    expect(homeDisplayActionPatch("taskInfo.pr", displayState)).toEqual({ taskInfoFields: ["time", "pr"] });
    expect(homeDisplayActionPatch("taskInfo.time", displayState)).toEqual({ taskInfoFields: [] });
    expect(homeDisplayActionPatch("sort.bogus", displayState)).toBeNull();
    expect(homeDisplayActionPatch("group", displayState)).toBeNull();
  });
});
