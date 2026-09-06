import type {
  ChromeActionMenuItem,
  NativePullDownAction,
} from "@/platform/chrome";
import type {
  HomeListSortBy,
  HomeStatusFilter,
} from "@/session/homeListPriority";
import type { HomeProjectOrder } from "@/session/homeProjectOrder";
import type { MobileHomeDeviceFilterItem } from "@/session/mobileHome";

export type { HomeListSortBy, HomeProjectOrder, HomeStatusFilter };

export type HomeDisplayMenuKey =
  | "groupByProject"
  | "groupDialogue"
  | "sort.recency"
  | "sort.priority"
  | "projectOrder.activity"
  | "projectOrder.custom"
  | "status.active"
  | "status.archived"
  | "status.all";

function markedLabel(label: string, on: boolean): string {
  return on ? `✓ ${label}` : label;
}

export function buildHomeScopeMenuItems(
  filters: readonly MobileHomeDeviceFilterItem[],
  allConversationsLabel: string,
): ChromeActionMenuItem[] {
  const allFilter = filters.find((item) => item.deviceId === null) ?? null;
  const deviceFilters = filters.filter(
    (item) => item.deviceId !== null && item.available,
  );
  const items: ChromeActionMenuItem[] = [];
  if (allFilter) {
    items.push({
      key: allFilter.id,
      label: markedLabel(allConversationsLabel, allFilter.selected),
    });
  }
  for (const item of deviceFilters) {
    items.push({
      key: item.id,
      label: markedLabel(item.label, item.selected),
    });
  }
  return items;
}

export function buildHomeDisplayMenuItems(input: {
  groupByProject: boolean;
  groupDialogue: boolean;
  groupByProjectLabel: string;
  groupDialogueLabel: string;
  projectOrder: HomeProjectOrder;
  projectOrderActivityLabel: string;
  projectOrderCustomLabel: string;
  showProjectOrder: boolean;
  sortBy: HomeListSortBy;
  sortByPriorityLabel: string;
  sortByTimeLabel: string;
  statusAllLabel: string;
  statusArchivedLabel: string;
  statusActiveLabel: string;
  statusFilter: HomeStatusFilter;
}): ChromeActionMenuItem<HomeDisplayMenuKey>[] {
  const items: ChromeActionMenuItem<HomeDisplayMenuKey>[] = [
    {
      key: "groupByProject",
      label: markedLabel(input.groupByProjectLabel, input.groupByProject),
    },
    {
      key: "groupDialogue",
      label: markedLabel(input.groupDialogueLabel, input.groupDialogue),
    },
    {
      key: "sort.recency",
      label: markedLabel(input.sortByTimeLabel, input.sortBy === "recency"),
    },
    {
      key: "sort.priority",
      label: markedLabel(
        input.sortByPriorityLabel,
        input.sortBy === "priority",
      ),
    },
  ];
  if (input.groupByProject && input.showProjectOrder) {
    items.push(
      {
        key: "projectOrder.activity",
        label: markedLabel(
          input.projectOrderActivityLabel,
          input.projectOrder === "activity",
        ),
      },
      {
        key: "projectOrder.custom",
        label: markedLabel(
          input.projectOrderCustomLabel,
          input.projectOrder === "custom",
        ),
      },
    );
  }
  items.push(
    {
      key: "status.active",
      label: markedLabel(
        input.statusActiveLabel,
        input.statusFilter === "active",
      ),
    },
    {
      key: "status.archived",
      label: markedLabel(
        input.statusArchivedLabel,
        input.statusFilter === "archived",
      ),
    },
    {
      key: "status.all",
      label: markedLabel(input.statusAllLabel, input.statusFilter === "all"),
    },
  );
  return items;
}

export function homeDisplayMenuPatch(
  key: HomeDisplayMenuKey,
  current: {
    groupByProject: boolean;
    groupDialogue: boolean;
  },
): {
  groupByProject?: boolean;
  groupDialogue?: boolean;
  projectOrder?: HomeProjectOrder;
  sortBy?: HomeListSortBy;
  statusFilter?: HomeStatusFilter;
} {
  switch (key) {
    case "groupByProject":
      return { groupByProject: !current.groupByProject };
    case "groupDialogue":
      return { groupDialogue: !current.groupDialogue };
    case "sort.recency":
      return { sortBy: "recency" };
    case "sort.priority":
      return { sortBy: "priority" };
    case "projectOrder.activity":
      return { projectOrder: "activity" };
    case "projectOrder.custom":
      return { projectOrder: "custom" };
    case "status.active":
      return { statusFilter: "active" };
    case "status.archived":
      return { statusFilter: "archived" };
    case "status.all":
      return { statusFilter: "all" };
  }
}

function checkable(
  id: string,
  title: string,
  on: boolean,
  keepPresented = false,
): NativePullDownAction {
  return {
    id,
    title,
    state: on ? "on" : "off",
    ...(keepPresented ? { keepPresented: true } : {}),
  };
}

function inlineGroup(
  id: string,
  title: string,
  subactions: NativePullDownAction[],
): NativePullDownAction {
  return {
    displayInline: true,
    id,
    preferredElementSize: "medium",
    subactions,
    title,
  };
}

export function buildHomeScopePullDownActions(
  filters: readonly MobileHomeDeviceFilterItem[],
  allConversationsLabel: string,
): NativePullDownAction[] {
  const allFilter = filters.find((item) => item.deviceId === null) ?? null;
  const deviceFilters = filters.filter(
    (item) => item.deviceId !== null && item.available,
  );
  const items: NativePullDownAction[] = [];
  if (allFilter) {
    items.push(
      checkable(allFilter.id, allConversationsLabel, allFilter.selected),
    );
  }
  for (const item of deviceFilters) {
    if (!item.deviceId) continue;
    items.push(checkable(item.id, item.label, item.selected));
  }
  return items;
}

export function buildHomeDisplayPullDownActions(input: {
  groupByProject: boolean;
  groupByProjectLabel: string;
  groupDialogue: boolean;
  groupDialogueLabel: string;
  groupHeading: string;
  projectOrder: HomeProjectOrder;
  projectOrderActivityLabel: string;
  projectOrderCustomLabel: string;
  projectOrderHeading: string;
  showProjectOrder: boolean;
  sortBy: HomeListSortBy;
  sortByPriorityLabel: string;
  sortByTimeLabel: string;
  sortHeading: string;
  statusActiveLabel: string;
  statusAllLabel: string;
  statusArchivedLabel: string;
  statusFilter: HomeStatusFilter;
  statusHeading: string;
}): NativePullDownAction[] {
  const groups: NativePullDownAction[] = [
    inlineGroup("group", input.groupHeading, [
      checkable(
        "groupByProject",
        input.groupByProjectLabel,
        input.groupByProject,
        true,
      ),
      checkable(
        "groupDialogue",
        input.groupDialogueLabel,
        input.groupDialogue,
        true,
      ),
    ]),
    inlineGroup("sort", input.sortHeading, [
      checkable(
        "sort.recency",
        input.sortByTimeLabel,
        input.sortBy === "recency",
      ),
      checkable(
        "sort.priority",
        input.sortByPriorityLabel,
        input.sortBy === "priority",
      ),
    ]),
  ];
  if (input.groupByProject && input.showProjectOrder) {
    groups.push(
      inlineGroup("projectOrder", input.projectOrderHeading, [
        checkable(
          "projectOrder.activity",
          input.projectOrderActivityLabel,
          input.projectOrder === "activity",
        ),
        checkable(
          "projectOrder.custom",
          input.projectOrderCustomLabel,
          input.projectOrder === "custom",
        ),
      ]),
    );
  }
  groups.push(
    inlineGroup("status", input.statusHeading, [
      checkable(
        "status.active",
        input.statusActiveLabel,
        input.statusFilter === "active",
      ),
      checkable(
        "status.archived",
        input.statusArchivedLabel,
        input.statusFilter === "archived",
      ),
      checkable(
        "status.all",
        input.statusAllLabel,
        input.statusFilter === "all",
      ),
    ]),
  );
  return groups;
}
