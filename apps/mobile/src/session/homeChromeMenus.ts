import type {
  ChromeActionMenuItem,
  NativePullDownAction,
} from "@/platform/chrome";
import type {
  HomeListSortBy,
  HomeStatusFilter,
} from "@/session/homeListPriority";
import type { HomeProjectOrder } from "@/session/homeProjectOrder";
import { canBrowseMobileHomeDevice, type MobileHomeDeviceFilterItem } from "@/session/mobileHome";
import {
  activeContentFilterCount,
  HOME_DIALOGUE_FILTER_KEY,
  HOME_LAST_ACTIVITY_FILTERS,
  HOME_TASK_INFO_FIELDS,
  HOME_VENDOR_FILTERS,
  toggleProjectFilter,
  toggleTaskInfoField,
  type HomeLastActivityFilter,
  type HomeListViewMode,
  type HomeProjectFilter,
  type HomeTaskInfoField,
  type HomeVendorFilter,
} from "@/session/homeDisplaySettings";

export type { HomeListSortBy, HomeProjectOrder, HomeStatusFilter };

function markedLabel(label: string, on: boolean): string {
  return on ? `✓ ${label}` : label;
}

export function buildHomeScopeMenuItems(
  filters: readonly MobileHomeDeviceFilterItem[],
  allConversationsLabel: string,
): ChromeActionMenuItem[] {
  const allFilter = filters.find((item) => item.deviceId === null) ?? null;
  const deviceFilters = filters.filter(
    (item) => item.deviceId !== null && canBrowseMobileHomeDevice(item),
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

export const HOME_SCOPE_COLLECTION_PREFIX = "scope.collection:";

export function parseHomeScopePullDownAction(
  id: string,
): { kind: "select"; filterId: string } | { kind: "collection"; collectionId: string } {
  if (id.startsWith(HOME_SCOPE_COLLECTION_PREFIX)) {
    return { kind: "collection", collectionId: id.slice(HOME_SCOPE_COLLECTION_PREFIX.length) };
  }
  return { kind: "select", filterId: id };
}

export function buildHomeScopePullDownActions(
  filters: readonly MobileHomeDeviceFilterItem[],
  allConversationsLabel: string,
  collections: readonly { id: string; title: string }[] = [],
): NativePullDownAction[] {
  const allFilter = filters.find((item) => item.deviceId === null) ?? null;
  const deviceFilters = filters.filter(
    (item) => item.deviceId !== null && canBrowseMobileHomeDevice(item),
  );
  const items: NativePullDownAction[] = [];
  if (allFilter) {
    items.push(
      checkable(allFilter.id, allConversationsLabel, allFilter.selected),
    );
  }
  for (const collection of collections) {
    items.push({
      id: `${HOME_SCOPE_COLLECTION_PREFIX}${collection.id}`,
      title: collection.title,
    });
  }
  for (const item of deviceFilters) {
    if (!item.deviceId) continue;
    items.push(checkable(item.id, item.label, item.selected));
  }
  return items;
}

/* ============================== 显示菜单 ============================== */

/**
 * 显示菜单与桌面侧栏 SidebarFilterPopover 同结构:一级是「设置项 + 当前值」行,具体选项
 * 在子菜单里;三段依次是 分组 / 任务排序 / 项目排序,任务状态 / 筛选,显示 / 任务信息。
 * 当前值放在一级行的 subtitle:Cindy 自绘菜单(安卓 / 旧 iOS 包)显示在标题下方;系统
 * UIMenu 的子菜单不显示 subtitle,选中项在子菜单内打勾。
 */
export interface HomeDisplayMenuState {
  groupByProject: boolean;
  groupDialogue: boolean;
  sortBy: HomeListSortBy;
  projectOrder: HomeProjectOrder;
  statusFilter: HomeStatusFilter;
  projectFilter: HomeProjectFilter;
  vendorFilter: HomeVendorFilter;
  lastActivityFilter: HomeLastActivityFilter;
  viewMode: HomeListViewMode;
  taskInfoFields: readonly HomeTaskInfoField[];
}

export type HomeDisplayPatch = Partial<Omit<HomeDisplayMenuState, "taskInfoFields">> & {
  taskInfoFields?: HomeTaskInfoField[];
};

export interface HomeDisplayMenuProject {
  key: string;
  title: string;
  /** 多台电脑时用于区分同名项目(设备名)。 */
  subtitle?: string;
  count: number;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

const MENU = "devices.list.menu";
const SORT_OPTIONS: readonly HomeListSortBy[] = ["priority", "recency", "created"];
const PROJECT_ORDER_OPTIONS: readonly HomeProjectOrder[] = ["activity", "custom"];
const STATUS_OPTIONS: readonly HomeStatusFilter[] = ["active", "archived", "all"];
const VIEW_OPTIONS: readonly HomeListViewMode[] = ["text", "list"];
const PROJECT_FILTER_PREFIX = "filter.project:";

function section(id: string, subactions: NativePullDownAction[]): NativePullDownAction {
  return { displayInline: true, id, subactions, title: "" };
}

function submenu(
  id: string,
  title: string,
  value: string,
  image: string,
  subactions: NativePullDownAction[],
): NativePullDownAction {
  return { id, image, subactions, subtitle: value, title };
}

/**
 * 项目行只给明确选中的打勾,「全部」时只勾「所有项目」。系统菜单点保持展开的复选项会就地翻转
 * 勾选;若「全部」时每行都打勾,点一项(语义是只看它)反而会显示成取消它。
 */
function projectExplicitlySelected(filter: HomeProjectFilter, key: string): boolean {
  return filter !== "all" && filter.includes(key);
}

function sortLabelKey(sortBy: HomeListSortBy): string {
  return `${MENU}.sortBy.${sortBy}`;
}

export function homeTaskInfoSummary(
  fields: readonly HomeTaskInfoField[],
  t: Translate,
): string {
  return fields.length > 0
    ? fields.map((field) => t(`${MENU}.taskInfo.${field}`)).join(t(`${MENU}.summarySeparator`))
    : t(`${MENU}.summaryNone`);
}

export function buildHomeDisplayPullDownActions(input: {
  state: HomeDisplayMenuState;
  /** 项目筛选的候选:完整项目集,不受最近活跃等筛选收窄。 */
  projects: readonly HomeDisplayMenuProject[];
  dialogueCount: number;
  t: Translate;
}): NativePullDownAction[] {
  const { state, t } = input;
  const groupSummary = [
    state.groupByProject ? t(`${MENU}.groupProject`) : null,
    state.groupDialogue ? t(`${MENU}.groupDialogue`) : null,
  ].filter(Boolean).join(t(`${MENU}.summarySeparator`)) || t(`${MENU}.summaryNone`);
  const filterCount = activeContentFilterCount({
    projects: state.projectFilter,
    vendor: state.vendorFilter,
    lastActivity: state.lastActivityFilter,
  });
  const projectValue = state.projectFilter === "all"
    ? t(`${MENU}.filterAll`)
    : t(`${MENU}.filterSelectedProjects`, { count: state.projectFilter.length });

  const organize: NativePullDownAction[] = [
    submenu("group", t(`${MENU}.groupHeading`), groupSummary, "list.bullet.indent", [
      checkable("group.project", t(`${MENU}.groupProject`), state.groupByProject, true),
      checkable("group.dialogue", t(`${MENU}.groupDialogue`), state.groupDialogue, true),
    ]),
    submenu("sort", t(`${MENU}.sortHeading`), t(sortLabelKey(state.sortBy)), "arrow.up.arrow.down",
      SORT_OPTIONS.map((sortBy) => ({
        ...checkable(`sort.${sortBy}`, t(sortLabelKey(sortBy)), state.sortBy === sortBy),
        ...(sortBy === "priority" ? { subtitle: t(`${MENU}.sortByPriorityTip`) } : {}),
      }))),
  ];
  if (state.groupByProject) {
    organize.push(submenu(
      "projectOrder",
      t(`${MENU}.projectOrderHeading`),
      t(`${MENU}.projectOrder.${state.projectOrder}`),
      "list.number",
      PROJECT_ORDER_OPTIONS.map((order) => ({
        ...checkable(`projectOrder.${order}`, t(`${MENU}.projectOrder.${order}`), state.projectOrder === order),
        ...(order === "custom" ? { subtitle: t(`${MENU}.projectOrderManualTip`) } : {}),
      })),
    ));
  }

  const projectRows: NativePullDownAction[] = [
    {
      ...checkable(`${PROJECT_FILTER_PREFIX}${HOME_DIALOGUE_FILTER_KEY}`, t(`${MENU}.dialogueFolder`),
        projectExplicitlySelected(state.projectFilter, HOME_DIALOGUE_FILTER_KEY), true),
      subtitle: String(input.dialogueCount),
    },
    ...input.projects.map((project) => ({
      ...checkable(`${PROJECT_FILTER_PREFIX}${project.key}`, project.title,
        projectExplicitlySelected(state.projectFilter, project.key), true),
      subtitle: [project.subtitle, String(project.count)].filter(Boolean).join(" · "),
    })),
  ];
  const filter = submenu(
    "filter",
    t(`${MENU}.filterHeading`),
    filterCount > 0 ? t(`${MENU}.filterSummaryActive`, { count: filterCount }) : t(`${MENU}.summaryNone`),
    "line.3.horizontal.decrease.circle",
    [
      submenu("filter.projects", t(`${MENU}.filterProjectsHeading`), projectValue, "folder", [
        section("filter.projects.allGroup", [
          // 「所有项目」是重置动作:选完收起菜单。
          checkable("filter.projects.all", t(`${MENU}.filterAllProjects`), state.projectFilter === "all"),
        ]),
        section("filter.projects.list", projectRows),
      ]),
      submenu("filter.vendor", t(`${MENU}.filterVendorHeading`), t(`${MENU}.filterVendor.${state.vendorFilter}`), "cpu",
        HOME_VENDOR_FILTERS.map((vendor) =>
          checkable(`filter.vendor.${vendor}`, t(`${MENU}.filterVendor.${vendor}`), state.vendorFilter === vendor))),
      submenu("filter.lastActivity", t(`${MENU}.filterLastActivityHeading`),
        t(`${MENU}.filterLastActivity.${state.lastActivityFilter}`), "calendar",
        HOME_LAST_ACTIVITY_FILTERS.map((range) =>
          checkable(`filter.lastActivity.${range}`, t(`${MENU}.filterLastActivity.${range}`),
            state.lastActivityFilter === range))),
      section("filter.resetGroup", [{
        disabled: filterCount === 0,
        id: "filter.reset",
        image: "arrow.counterclockwise",
        title: t(`${MENU}.filterReset`),
      }]),
    ],
  );

  return [
    section("organize", organize),
    section("narrow", [
      submenu("status", t(`${MENU}.statusHeading`), t(`${MENU}.status.${state.statusFilter}`), "checklist",
        STATUS_OPTIONS.map((status) =>
          checkable(`status.${status}`, t(`${MENU}.status.${status}`), state.statusFilter === status))),
      filter,
    ]),
    section("appearance", [
      submenu("view", t(`${MENU}.displayHeading`), t(`${MENU}.view.${state.viewMode}`),
        state.viewMode === "text" ? "text.justify.left" : "list.bullet.rectangle.portrait",
        VIEW_OPTIONS.map((mode) =>
          checkable(`view.${mode}`, t(`${MENU}.view.${mode}`), state.viewMode === mode))),
      submenu("taskInfo", t(`${MENU}.taskInfoHeading`), homeTaskInfoSummary(state.taskInfoFields, t), "info.circle",
        HOME_TASK_INFO_FIELDS.map((field) =>
          checkable(`taskInfo.${field}`, t(`${MENU}.taskInfo.${field}`), state.taskInfoFields.includes(field), true))),
    ]),
  ];
}

/** 菜单动作 → 偏好补丁;未知 id 返回 null(调用方忽略)。 */
export function homeDisplayActionPatch(
  id: string,
  state: HomeDisplayMenuState,
): HomeDisplayPatch | null {
  if (id === "group.project") return { groupByProject: !state.groupByProject };
  if (id === "group.dialogue") return { groupDialogue: !state.groupDialogue };
  if (id === "filter.reset") return { lastActivityFilter: "all", projectFilter: "all", vendorFilter: "all" };
  if (id === "filter.projects.all") return { projectFilter: "all" };
  if (id.startsWith(PROJECT_FILTER_PREFIX)) {
    const key = id.slice(PROJECT_FILTER_PREFIX.length);
    return key ? { projectFilter: toggleProjectFilter(state.projectFilter, key) } : null;
  }
  const [head, value] = splitActionId(id);
  switch (head) {
    case "sort":
      return SORT_OPTIONS.includes(value as HomeListSortBy) ? { sortBy: value as HomeListSortBy } : null;
    case "projectOrder":
      return PROJECT_ORDER_OPTIONS.includes(value as HomeProjectOrder)
        ? { projectOrder: value as HomeProjectOrder }
        : null;
    case "status":
      return STATUS_OPTIONS.includes(value as HomeStatusFilter) ? { statusFilter: value as HomeStatusFilter } : null;
    case "filter.vendor":
      return HOME_VENDOR_FILTERS.includes(value as HomeVendorFilter)
        ? { vendorFilter: value as HomeVendorFilter }
        : null;
    case "filter.lastActivity":
      return HOME_LAST_ACTIVITY_FILTERS.includes(value as HomeLastActivityFilter)
        ? { lastActivityFilter: value as HomeLastActivityFilter }
        : null;
    case "view":
      return VIEW_OPTIONS.includes(value as HomeListViewMode) ? { viewMode: value as HomeListViewMode } : null;
    case "taskInfo":
      return HOME_TASK_INFO_FIELDS.includes(value as HomeTaskInfoField)
        ? { taskInfoFields: toggleTaskInfoField(state.taskInfoFields, value as HomeTaskInfoField) }
        : null;
    default:
      return null;
  }
}

function splitActionId(id: string): [string, string] {
  const index = id.lastIndexOf(".");
  return index < 0 ? [id, ""] : [id.slice(0, index), id.slice(index + 1)];
}
