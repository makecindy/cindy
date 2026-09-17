import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  countHomeSuggestionSessions,
  isRemoteTaskSuggestionId,
  remoteTaskSuggestionsMode,
  REMOTE_TASK_SUGGESTION_BATCHES,
} from "@/session/remoteTaskSuggestionsModel";
import type { MobileHomePresentation } from "@/session/mobileHome";
import type { RemoteSessionListItem } from "@/session/sessionList";

// Source-fragment assertions must also work with Windows CRLF checkouts.
const readTextLf = (...args: Parameters<typeof readFileSync>): string =>
  String(readFileSync(...args)).replace(/\r\n/g, "\n");

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


describe("home recommendation connection readiness", () => {
  it("hides both modes after disconnect despite a retained online device snapshot", () => {
    const source = readTextLf(resolve(process.cwd(), "app/devices/index.tsx"), "utf8");
    const expression = source.match(/ready: ([\s\S]*?),\n  \}\);\n  const newSessionDeviceOptions/)?.[1];
    expect(expression).toBeTruthy();
    const evaluateReady = new Function("status", "activeConnectionIssue", "recoveringDeviceIds", "selectedDeviceId", `
      const unresponsiveDevices = new Set(), rawDeviceConnectionStates = {};
      const initialHomeLoading = false, initialHomeError = null, connectionError = null;
      const indexedSearch = { status: 'idle' }, newSessionDisabled = false;
      const deviceModels = [{ deviceId: 'computer', canOpen: true }];
      const home = { primaryDevice: { deviceId: 'computer' } };
      const taskSuggestionsDeviceId = selectedDeviceId ?? home.primaryDevice.deviceId;
      return ${expression};
    `);
    const ready = (status: string, issue: unknown = null, recovering: string[] = [], selected: string | null = 'computer') =>
      evaluateReady(status, issue, new Set(recovering), selected);
    for (const count of [0, 3]) {
      expect(mode(count, { ready: ready("online") })).toBe(count === 0 ? "empty" : "footer");
      expect(mode(count, { ready: ready("stopped") })).toBeNull();
      expect(mode(count, { ready: ready("connecting") })).toBeNull();
      expect(mode(count, { ready: ready("online", { kind: "unstable" }) })).toBeNull();
      // All-devices and explicitly selected-device views share the target recovery gate.
      for (const selected of [null, "computer"]) {
        expect(mode(count, { ready: ready("online", null, ["computer"], selected) })).toBeNull();
        expect(mode(count, { ready: ready("online", null, ["another-computer"], selected) })).toBe(count === 0 ? "empty" : "footer");
        expect(mode(count, { ready: ready("online", null, [], selected) })).toBe(count === 0 ? "empty" : "footer");
      }
      expect(mode(count, { ready: ready("online") })).toBe(count === 0 ? "empty" : "footer");
    }
  });
});

describe("recommendation route target", () => {
  it("passes the checked computer explicitly for both empty and template actions", () => {
    const source = readTextLf(resolve(process.cwd(), "app/devices/index.tsx"), "utf8");
    const openBody = source.match(/const openNewSession = useCallback\([^\n]*=> \{([\s\S]*?)\n  \}, \[guardedPush, home.primaryDevice/)?.[1];
    const suggestedBody = source.match(/const openSuggestedSession = useCallback\([^\n]*=> \{([\s\S]*?)\n  \}, \[openNewSession/)?.[1];
    expect(openBody).toBeTruthy();
    expect(suggestedBody).toBeTruthy();
    expect(source.match(/onSelect=\{openSuggestedSession\}/g)).toHaveLength(2);
    expect(source.match(/onNewSession=\{\(\) => openSuggestedSession\(\)\}/g)).toHaveLength(2);
    const open = new Function("project", "suggestion", "explicitDeviceId", "guardedPush", `
      const home = { primaryDevice: { deviceId: 'fallback', label: 'Fallback' } };
      const selectedDeviceId = null;
      const newSessionDeviceOptions = [{ deviceId: 'checked', name: 'Checked' }];
      const serializeNewSessionDeviceOptions = JSON.stringify;
      const setError = (error) => { throw new Error(error); }, t = (key) => key;
      ${openBody}
    `);
    const suggested = new Function("suggestion", "openNewSession", "taskSuggestionsDeviceId", suggestedBody!);
    for (const suggestion of [undefined, "findFile"]) {
      let route: { params: Record<string, string> } | undefined;
      suggested(suggestion, (project: unknown, id: unknown, deviceId: unknown) =>
        open(project, id, deviceId, (value: typeof route) => { route = value; }), "checked");
      expect(route?.params).toMatchObject({ deviceId: "checked", deviceName: "Checked", deviceExplicit: "1" });
      expect(route?.params.suggestion).toBe(suggestion);
    }
  });
});
