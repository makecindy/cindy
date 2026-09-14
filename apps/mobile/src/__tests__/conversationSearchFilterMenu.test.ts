import { describe, expect, it } from "vitest";
import {
  applyConversationSearchFilterAction,
  buildConversationSearchFilterPullDownActions,
  SEARCH_FILTER_PROJECT_ITEM_PREFIX,
} from "@/session/conversationSearchFilterMenu";
import type { ConversationSearchProjectOption } from "@/session/conversationSearch";

function project(
  patch: Partial<ConversationSearchProjectOption> &
    Pick<ConversationSearchProjectOption, "key" | "title">,
): ConversationSearchProjectOption {
  return {
    count: 1,
    deviceId: "dev-a",
    deviceName: "Mac",
    workingDir: "/tmp",
    ...patch,
  };
}

const labels = {
  agentHeading: "Agent",
  agentLabels: {
    all: "全部",
    cc: "Claude Code",
    codex: "Codex",
    pi: "Pi",
  },
  allProjectsLabel: "所有项目",
  lastActivityHeading: "最近活动",
  lastActivityLabels: {
    "1d": "1 天",
    "3d": "3 天",
    "7d": "7 天",
    "30d": "30 天",
    all: "不限",
  },
  projectsHeading: "项目",
  resetLabel: "重置",
  sortHeading: "排序",
  sortLabels: {
    activityAsc: "最早活跃",
    activityDesc: "最近活跃",
    relevance: "相关度",
  },
  statusHeading: "状态",
  statusLabels: {
    active: "活跃",
    all: "全部",
    archived: "已归档",
  },
} as const;

describe("conversation search filter menu", () => {
  it("groups sort, status, projects, agent and last activity, and keeps option rows presented", () => {
    const actions = buildConversationSearchFilterPullDownActions({
      ...labels,
      activeCount: 0,
      agentKind: "all",
      lastActivity: "all",
      lockedProjects: false,
      projectSelection: "all",
      projects: [
        project({ key: "dev-a:/Users/dash/cindy", title: "Cindy", count: 1 }),
        project({ key: "dev-a:/tmp/other", title: "other", count: 17 }),
      ],
      sortBy: "relevance",
      status: "all",
    });

    expect(actions.map((item) => item.id)).toEqual([
      "sort",
      "status",
      "projects",
      "agent",
      "lastActivity",
    ]);
    expect(actions.find((item) => item.id === "reset")).toBeUndefined();
    expect(
      actions.every((item) => item.preferredElementSize === "medium"),
    ).toBe(true);
    expect(
      actions
        .find((item) => item.id === "sort")
        ?.subactions?.map((item) => item.id),
    ).toEqual(["sort.relevance", "sort.activityDesc", "sort.activityAsc"]);
    expect(
      actions.find((item) => item.id === "sort")?.subactions?.[0],
    ).toMatchObject({
      keepPresented: true,
      state: "on",
      title: "相关度",
    });
    expect(
      actions
        .find((item) => item.id === "projects")
        ?.subactions?.map((item) => item.id),
    ).toEqual([
      "project.all",
      `${SEARCH_FILTER_PROJECT_ITEM_PREFIX}dev-a:/Users/dash/cindy`,
      `${SEARCH_FILTER_PROJECT_ITEM_PREFIX}dev-a:/tmp/other`,
    ]);
  });

  it("adds reset when filters are active and hides projects when locked", () => {
    const actions = buildConversationSearchFilterPullDownActions({
      ...labels,
      activeCount: 2,
      agentKind: "cc",
      lastActivity: "7d",
      lockedProjects: true,
      projectSelection: "all",
      projects: [project({ key: "hidden", title: "Hidden" })],
      sortBy: "activityDesc",
      status: "active",
    });

    expect(actions.map((item) => item.id)).toEqual([
      "reset",
      "sort",
      "status",
      "agent",
      "lastActivity",
    ]);
    expect(actions[0]).toEqual({ id: "reset", title: "重置" });
    expect(
      actions
        .find((item) => item.id === "agent")
        ?.subactions?.find((item) => item.id === "agent.cc")?.state,
    ).toBe("on");
  });

  it("applies exclusive filters, project toggles, and reset", () => {
    expect(
      applyConversationSearchFilterAction("sort.activityAsc", {
        projectSelection: "all",
      }),
    ).toEqual({
      kind: "sort",
      value: "activityAsc",
    });
    expect(
      applyConversationSearchFilterAction("status.archived", {
        projectSelection: "all",
      }),
    ).toEqual({
      kind: "status",
      value: "archived",
    });
    expect(
      applyConversationSearchFilterAction("reset", { projectSelection: ["a"] }),
    ).toEqual({ kind: "reset" });
    expect(
      applyConversationSearchFilterAction("project.all", {
        projectSelection: ["a"],
      }),
    ).toEqual({
      kind: "projects",
      value: "all",
    });
    expect(
      applyConversationSearchFilterAction(
        `${SEARCH_FILTER_PROJECT_ITEM_PREFIX}dev-a:/repo`,
        { projectSelection: "all" },
      ),
    ).toEqual({
      kind: "projects",
      value: ["dev-a:/repo"],
    });
    expect(
      applyConversationSearchFilterAction("nope", { projectSelection: "all" }),
    ).toEqual({ kind: "ignore" });
  });
});
