import { describe, expect, it } from "vitest";
import {
  countHomeSuggestionSessions,
  isRemoteTaskSuggestionId,
  remoteTaskSuggestionsMode,
  REMOTE_TASK_SUGGESTION_BATCHES,
} from "@/session/remoteTaskSuggestionsModel";
import type { MobileHomePresentation } from "@/session/mobileHome";
import type { RemoteSessionListItem } from "@/session/sessionList";

const emptyHome = { pinned: [], chats: [], projects: [] };
const item = (sessionCount?: number) =>
  ({
    session: { id: "task" },
    ...(sessionCount ? { automationGroup: { sessionCount } } : {}),
  }) as RemoteSessionListItem;
const mode = (sessionCount: number, extra = {}) =>
  remoteTaskSuggestionsMode({
    sessionCount,
    totalSessionCount: sessionCount,
    ready: true,
    hasSearchOrFilter: false,
    ...extra,
  });

describe("remote task suggestions visibility", () => {
  it("shows the full welcome only for a genuinely empty list", () => {
    expect(mode(0)).toBe("empty");
    expect(mode(0, { totalSessionCount: 5 })).toBeNull();
    expect(mode(0, { hasSearchOrFilter: true })).toBeNull();
  });
  it("shows 1–3 filtered sessions, hides at 4, and reappears at 3", () => {
    expect(
      [1, 2, 3, 4, 8, 3].map((count) =>
        mode(count, {
          hasSearchOrFilter: true,
          totalSessionCount: 20,
        }),
      ),
    ).toEqual(["footer", "footer", "footer", null, null, "footer"]);
  });
  it("does not offer tasks on an unavailable or unsettled device", () => {
    for (const count of [0, 1, 3, 4])
      expect(mode(count, { ready: false })).toBeNull();
  });
  it("counts sessions inside projects, rather than visible folder headers", () => {
    const home = {
      ...emptyHome,
      projects: [
        {
          sessionCount: 4,
          sessions: [],
          deviceId: "computer",
          deviceName: "Computer",
          key: "project",
          title: "Project",
          subtitle: "",
          workingDir: "/project",
          latestActivityAt: "",
          pendingInteractionCount: 0,
        },
      ],
    } as Pick<MobileHomePresentation, "pinned" | "chats" | "projects">;
    expect(mode(countHomeSuggestionSessions(home))).toBeNull();
  });
  it("includes collapsed pinned sessions and automation runs", () => {
    expect(
      countHomeSuggestionSessions({
        ...emptyHome,
        pinned: [item(), item()],
        chats: [item(2)],
      }),
    ).toBe(4);
    expect(
      mode(countHomeSuggestionSessions({ ...emptyHome, chats: [item(4)] })),
    ).toBeNull();
  });
  it("uses indexed search results instead of the unfiltered home count, including zero results", () => {
    const home = { ...emptyHome, chats: [item(), item(), item(), item()] };
    expect(countHomeSuggestionSessions(home, [item()])).toBe(1);
    expect(countHomeSuggestionSessions(home, [])).toBe(0);
  });
});

describe("suggestion route IDs", () => {
  it("accepts only known task templates, not arbitrary route content", () => {
    for (const id of REMOTE_TASK_SUGGESTION_BATCHES.flat())
      expect(isRemoteTaskSuggestionId(id)).toBe(true);
    for (const value of [
      undefined,
      "",
      "unknown",
      ["findFile"],
      "deleteEverything",
    ])
      expect(isRemoteTaskSuggestionId(value)).toBe(false);
  });
});
