import {
  parseGithubPr,
  type SessionPrRef,
  type SessionPrRefAction,
} from "@cindy/maker-shared";

const tasks = new Map<string, SessionPrRef[]>();
/** In-memory UI fixture, reached only from the existing __DEV__ mock provider. */
export function githubPrVisualFixture(channel: string, raw: unknown): unknown {
  if (channel !== "git-context:pr-refs:manage") return undefined;
  const input = raw as { sessionId: string } & (
    SessionPrRefAction | { action: "list" }
  );
  let rows = tasks.get(input.sessionId);
  if (!rows) {
    rows = ["explicit", "legacy", "removed"].map((kind, index) => ({
      id: `mock-pr-${index}`,
      sessionId: input.sessionId,
      owner: "example",
      repo: "project",
      prNumber: index + 1,
      url: `https://github.com/example/project/pull/${index + 1}`,
      firstSeenAt: 1,
      lastSeenAt: 1,
      priority: 3 - index,
      pinned: false,
      manuallyAdded: kind !== "legacy",
      associationSource: kind === "legacy" ? "legacy" : "explicit",
      removedAt: kind === "removed" ? 1 : null,
    }));
    tasks.set(input.sessionId, rows);
  }
  if (input.action === "add") {
    const pr = parseGithubPr({ url: input.url });
    if (!rows.some((row) => row.url === pr.url))
      rows.push({
        ...pr,
        id: `mock-${rows.length}`,
        sessionId: input.sessionId,
        firstSeenAt: 1,
        lastSeenAt: 1,
        associationSource: "explicit",
        removedAt: null,
      });
  } else if (input.action === "reorder") {
    input.ids.forEach((id, index) => {
      const row = rows.find((item) => item.id === id);
      if (row) row.priority = input.ids.length - index;
    });
  } else if (input.action !== "list") {
    const row = rows.find((item) => item.id === input.id);
    if (row) {
      if (input.action === "remove") {
        row.removedAt = 1;
        row.pinned = false;
      } else if (input.action === "restore") {
        row.removedAt = null;
        row.associationSource = "explicit";
      } else row.pinned = input.action === "pin";
    }
  }
  return structuredClone(
    [...rows].sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) ||
        (b.priority ?? 0) - (a.priority ?? 0),
    ),
  );
}
