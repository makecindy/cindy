import { describe, expect, it } from "vitest";
import {
  buildHomeDisplayMenuItems,
  buildHomeDisplayPullDownActions,
  buildHomeScopeMenuItems,
  buildHomeScopePullDownActions,
  homeDisplayMenuPatch,
  parseHomeScopePullDownAction,
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
  it("nests open and rename under each native device scope item", () => {
    const actions = buildHomeScopePullDownActions(
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
      {
        openLabel: "打开",
        renameLabel: "重命名",
        showTasksLabel: "查看任务",
      },
    );

    expect(actions.map((item) => item.id)).toEqual(["all", "scope.submenu:mac"]);
    expect(actions[1]?.subactions?.map((item) => item.id)).toEqual([
      "mac",
      "scope.open:d1",
      "scope.rename:d1",
    ]);
    expect(parseHomeScopePullDownAction("scope.open:d1")).toEqual({
      kind: "open",
      deviceId: "d1",
    });
    expect(parseHomeScopePullDownAction("scope.rename:d1")).toEqual({
      kind: "rename",
      deviceId: "d1",
    });
    expect(parseHomeScopePullDownAction("mac")).toEqual({
      kind: "select",
      filterId: "mac",
    });
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

  it("maps display rows and toggle/exclusive patches", () => {
    const items = buildHomeDisplayMenuItems({
      groupByProject: true,
      groupByProjectLabel: "按项目分组",
      groupDialogue: false,
      groupDialogueLabel: "按对话分组",
      projectOrder: "activity",
      projectOrderActivityLabel: "按活动",
      projectOrderCustomLabel: "手动",
      showProjectOrder: true,
      sortBy: "priority",
      sortByPriorityLabel: "按优先级",
      sortByTimeLabel: "按时间",
      statusActiveLabel: "进行中",
      statusAllLabel: "全部",
      statusArchivedLabel: "已归档",
      statusFilter: "active",
    });

    expect(items.map((item) => item.key)).toEqual([
      "groupByProject",
      "groupDialogue",
      "sort.recency",
      "sort.priority",
      "projectOrder.activity",
      "projectOrder.custom",
      "status.active",
      "status.archived",
      "status.all",
    ]);
    expect(items.find((item) => item.key === "groupByProject")?.label).toBe(
      "✓ 按项目分组",
    );
    expect(items.find((item) => item.key === "sort.priority")?.label).toBe(
      "✓ 按优先级",
    );
    expect(
      homeDisplayMenuPatch("groupDialogue", {
        groupByProject: true,
        groupDialogue: false,
      }),
    ).toEqual({ groupDialogue: true });
    expect(
      homeDisplayMenuPatch("status.archived", {
        groupByProject: true,
        groupDialogue: false,
      }),
    ).toEqual({ statusFilter: "archived" });
  });

  it("hides project-order rows when grouping is off", () => {
    const items = buildHomeDisplayMenuItems({
      groupByProject: false,
      groupByProjectLabel: "按项目分组",
      groupDialogue: false,
      groupDialogueLabel: "按对话分组",
      projectOrder: "activity",
      projectOrderActivityLabel: "按活动",
      projectOrderCustomLabel: "手动",
      showProjectOrder: true,
      sortBy: "recency",
      sortByPriorityLabel: "按优先级",
      sortByTimeLabel: "按时间",
      statusActiveLabel: "进行中",
      statusAllLabel: "全部",
      statusArchivedLabel: "已归档",
      statusFilter: "all",
    });
    expect(items.some((item) => item.key.startsWith("projectOrder."))).toBe(
      false,
    );
  });

  it("compacts the native display menu so the last status row can fit", () => {
    const actions = buildHomeDisplayPullDownActions({
      groupByProject: true,
      groupByProjectLabel: "按项目分组",
      groupDialogue: false,
      groupDialogueLabel: "对话归为一组",
      groupHeading: "分组",
      projectOrder: "activity",
      projectOrderActivityLabel: "按最近活动",
      projectOrderCustomLabel: "手动",
      projectOrderHeading: "项目顺序",
      showProjectOrder: true,
      sortBy: "recency",
      sortByPriorityLabel: "优先级",
      sortByTimeLabel: "按时间排序",
      sortHeading: "任务排序",
      statusActiveLabel: "活跃",
      statusAllLabel: "全部",
      statusArchivedLabel: "已归档",
      statusFilter: "active",
      statusHeading: "状态",
    });

    expect(actions.map((item) => item.id)).toEqual([
      "group",
      "sort",
      "projectOrder",
      "status",
    ]);
    expect(
      actions.every((item) => item.preferredElementSize === "medium"),
    ).toBe(true);
    expect(actions.at(-1)?.subactions?.map((item) => item.id)).toEqual([
      "status.active",
      "status.archived",
      "status.all",
    ]);
  });
});
