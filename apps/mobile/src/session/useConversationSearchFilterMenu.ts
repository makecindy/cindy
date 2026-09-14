import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  usesNativePullDownMenu,
  type NativePullDownAction,
} from "@/platform/chrome";
import {
  buildConversationSearchFilterPullDownActions,
  dispatchConversationSearchFilterAction,
  type ConversationSearchFilterMenuHandlers,
  type ConversationSearchFilterMenuState,
} from "@/session/conversationSearchFilterMenu";

export function useConversationSearchFilterMenu({
  activeCount,
  agentKind,
  lastActivity,
  lockedProjects,
  onAgentKindChange,
  onLastActivityChange,
  onProjectsChange,
  onReset,
  onSortChange,
  onStatusChange,
  projectSelection,
  projects,
  sortBy,
  status,
}: ConversationSearchFilterMenuState & ConversationSearchFilterMenuHandlers): {
  filterActions: readonly NativePullDownAction[] | undefined;
  onFilterAction: ((id: string) => void) | undefined;
} {
  const { t } = useTranslation();
  const native = usesNativePullDownMenu();
  const actions = useMemo(
    () =>
      buildConversationSearchFilterPullDownActions({
        activeCount,
        agentHeading: t("devices.list.search.filter.agentHeading"),
        agentKind,
        agentLabels: {
          all: t("devices.list.search.filter.agent.all"),
          cc: t("devices.list.search.filter.agent.cc"),
          codex: t("devices.list.search.filter.agent.codex"),
          pi: t("devices.list.search.filter.agent.pi"),
        },
        allProjectsLabel: t("devices.list.search.filter.allProjects"),
        lastActivity,
        lastActivityHeading: t(
          "devices.list.search.filter.lastActivityHeading",
        ),
        lastActivityLabels: {
          "1d": t("devices.list.search.filter.lastActivity.1d"),
          "3d": t("devices.list.search.filter.lastActivity.3d"),
          "7d": t("devices.list.search.filter.lastActivity.7d"),
          "30d": t("devices.list.search.filter.lastActivity.30d"),
          all: t("devices.list.search.filter.lastActivity.all"),
        },
        lockedProjects,
        projectSelection,
        projects,
        projectsHeading: t("devices.list.search.filter.projectsHeading"),
        resetLabel: t("devices.list.search.filter.reset"),
        sortBy,
        sortHeading: t("devices.list.search.filter.sortHeading"),
        sortLabels: {
          activityAsc: t("devices.list.search.filter.sort.activityAsc"),
          activityDesc: t("devices.list.search.filter.sort.activityDesc"),
          relevance: t("devices.list.search.filter.sort.relevance"),
        },
        status,
        statusHeading: t("devices.list.search.filter.statusHeading"),
        statusLabels: {
          active: t("devices.list.search.filter.status.active"),
          all: t("devices.list.search.filter.status.all"),
          archived: t("devices.list.search.filter.status.archived"),
        },
      }),
    [
      activeCount,
      agentKind,
      lastActivity,
      lockedProjects,
      projectSelection,
      projects,
      sortBy,
      status,
      t,
    ],
  );
  const onFilterAction = useCallback(
    (id: string) => {
      dispatchConversationSearchFilterAction(
        id,
        { projectSelection },
        {
          onAgentKindChange,
          onLastActivityChange,
          onProjectsChange,
          onReset,
          onSortChange,
          onStatusChange,
        },
      );
    },
    [
      onAgentKindChange,
      onLastActivityChange,
      onProjectsChange,
      onReset,
      onSortChange,
      onStatusChange,
      projectSelection,
    ],
  );

  if (!native) return { filterActions: undefined, onFilterAction: undefined };
  return { filterActions: actions, onFilterAction };
}
