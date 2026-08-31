import type { NativePullDownAction } from "@/platform/chrome";
import {
  nextConversationSearchProjectSelection,
  type ConversationSearchProjectOption,
  type ConversationSearchProjectSelection,
} from "@/session/conversationSearch";
import type {
  ConversationSearchAgentFilter,
  ConversationSearchLastActivityFilter,
  ConversationSearchSortBy,
  ConversationSearchStatusFilter,
} from "@cindy/maker-shared/conversation-search";

export const SEARCH_FILTER_PROJECT_ITEM_PREFIX = "project.item:";

const SORT_OPTIONS: ConversationSearchSortBy[] = [
  "relevance",
  "activityDesc",
  "activityAsc",
];
const STATUS_OPTIONS: ConversationSearchStatusFilter[] = [
  "active",
  "archived",
  "all",
];
const AGENT_OPTIONS: ConversationSearchAgentFilter[] = [
  "all",
  "cc",
  "codex",
  "pi",
];
const LAST_ACTIVITY_OPTIONS: ConversationSearchLastActivityFilter[] = [
  "1d",
  "3d",
  "7d",
  "30d",
  "all",
];

export type ConversationSearchFilterActionResult =
  | { kind: "agent"; value: ConversationSearchAgentFilter }
  | { kind: "ignore" }
  | { kind: "lastActivity"; value: ConversationSearchLastActivityFilter }
  | { kind: "projects"; value: ConversationSearchProjectSelection }
  | { kind: "reset" }
  | { kind: "sort"; value: ConversationSearchSortBy }
  | { kind: "status"; value: ConversationSearchStatusFilter };

export type ConversationSearchFilterMenuState = {
  activeCount: number;
  agentKind: ConversationSearchAgentFilter;
  lastActivity: ConversationSearchLastActivityFilter;
  lockedProjects: boolean;
  projectSelection: ConversationSearchProjectSelection;
  projects: readonly ConversationSearchProjectOption[];
  sortBy: ConversationSearchSortBy;
  status: ConversationSearchStatusFilter;
};

export type ConversationSearchFilterMenuHandlers = {
  onAgentKindChange(value: ConversationSearchAgentFilter): void;
  onLastActivityChange(value: ConversationSearchLastActivityFilter): void;
  onProjectsChange(value: ConversationSearchProjectSelection): void;
  onReset(): void;
  onSortChange(value: ConversationSearchSortBy): void;
  onStatusChange(value: ConversationSearchStatusFilter): void;
};

function checkable(
  id: string,
  title: string,
  on: boolean,
  extras: { keepPresented?: boolean; subtitle?: string } = {},
): NativePullDownAction {
  return {
    id,
    state: on ? "on" : "off",
    title,
    ...(extras.subtitle ? { subtitle: extras.subtitle } : {}),
    ...(extras.keepPresented === false ? {} : { keepPresented: true }),
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

function matchOption<T extends string>(
  prefix: string,
  id: string,
  options: readonly T[],
): T | null {
  if (!id.startsWith(prefix)) return null;
  const value = id.slice(prefix.length) as T;
  return options.includes(value) ? value : null;
}

export function buildConversationSearchFilterPullDownActions(
  input: ConversationSearchFilterMenuState & {
    agentLabels: Record<ConversationSearchAgentFilter, string>;
    allProjectsLabel: string;
    lastActivityHeading: string;
    lastActivityLabels: Record<ConversationSearchLastActivityFilter, string>;
    projectsHeading: string;
    resetLabel: string;
    sortHeading: string;
    sortLabels: Record<ConversationSearchSortBy, string>;
    statusHeading: string;
    statusLabels: Record<ConversationSearchStatusFilter, string>;
    agentHeading: string;
  },
): NativePullDownAction[] {
  const groups: NativePullDownAction[] = [];
  if (input.activeCount > 0) {
    groups.push({
      id: "reset",
      title: input.resetLabel,
    });
  }
  groups.push(
    inlineGroup(
      "sort",
      input.sortHeading,
      SORT_OPTIONS.map((value) =>
        checkable(
          `sort.${value}`,
          input.sortLabels[value],
          input.sortBy === value,
        ),
      ),
    ),
  );
  groups.push(
    inlineGroup(
      "status",
      input.statusHeading,
      STATUS_OPTIONS.map((value) =>
        checkable(
          `status.${value}`,
          input.statusLabels[value],
          input.status === value,
        ),
      ),
    ),
  );
  if (!input.lockedProjects && input.projects.length > 0) {
    const selected =
      input.projectSelection === "all" ? null : new Set(input.projectSelection);
    const showDevice =
      new Set(input.projects.map((project) => project.deviceId)).size > 1;
    groups.push(
      inlineGroup("projects", input.projectsHeading, [
        checkable(
          "project.all",
          input.allProjectsLabel,
          input.projectSelection === "all",
        ),
        ...input.projects.map((project) =>
          checkable(
            `${SEARCH_FILTER_PROJECT_ITEM_PREFIX}${project.key}`,
            project.title,
            selected?.has(project.key) === true,
            {
              subtitle:
                showDevice && project.deviceName
                  ? `${project.deviceName} · ${project.count}`
                  : String(project.count),
            },
          ),
        ),
      ]),
    );
  }
  groups.push(
    inlineGroup(
      "agent",
      input.agentHeading,
      AGENT_OPTIONS.map((value) =>
        checkable(
          `agent.${value}`,
          input.agentLabels[value],
          input.agentKind === value,
        ),
      ),
    ),
  );
  groups.push(
    inlineGroup(
      "lastActivity",
      input.lastActivityHeading,
      LAST_ACTIVITY_OPTIONS.map((value) =>
        checkable(
          `lastActivity.${value}`,
          input.lastActivityLabels[value],
          input.lastActivity === value,
        ),
      ),
    ),
  );
  return groups;
}

export function applyConversationSearchFilterAction(
  id: string,
  current: Pick<ConversationSearchFilterMenuState, "projectSelection">,
): ConversationSearchFilterActionResult {
  if (id === "reset") return { kind: "reset" };
  if (id === "project.all") return { kind: "projects", value: "all" };
  if (id.startsWith(SEARCH_FILTER_PROJECT_ITEM_PREFIX)) {
    return {
      kind: "projects",
      value: nextConversationSearchProjectSelection(
        current.projectSelection,
        id.slice(SEARCH_FILTER_PROJECT_ITEM_PREFIX.length),
      ),
    };
  }
  const sort = matchOption("sort.", id, SORT_OPTIONS);
  if (sort) return { kind: "sort", value: sort };
  const status = matchOption("status.", id, STATUS_OPTIONS);
  if (status) return { kind: "status", value: status };
  const agent = matchOption("agent.", id, AGENT_OPTIONS);
  if (agent) return { kind: "agent", value: agent };
  const lastActivity = matchOption("lastActivity.", id, LAST_ACTIVITY_OPTIONS);
  if (lastActivity) return { kind: "lastActivity", value: lastActivity };
  return { kind: "ignore" };
}

export function dispatchConversationSearchFilterAction(
  id: string,
  current: Pick<ConversationSearchFilterMenuState, "projectSelection">,
  handlers: ConversationSearchFilterMenuHandlers,
): void {
  const result = applyConversationSearchFilterAction(id, current);
  switch (result.kind) {
    case "reset":
      handlers.onReset();
      return;
    case "sort":
      handlers.onSortChange(result.value);
      return;
    case "status":
      handlers.onStatusChange(result.value);
      return;
    case "agent":
      handlers.onAgentKindChange(result.value);
      return;
    case "lastActivity":
      handlers.onLastActivityChange(result.value);
      return;
    case "projects":
      handlers.onProjectsChange(result.value);
      return;
    case "ignore":
      return;
  }
}
