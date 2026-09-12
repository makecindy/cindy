import type { MobileHomePresentation } from "./mobileHome";
import type { RemoteSessionListItem } from "./sessionList";

export const REMOTE_TASK_SUGGESTION_BATCHES = [
  ["findFile", "computerStatus", "projectProgress"],
  ["downloads", "summarizeDocument", "storageUsage"],
] as const;
export type RemoteTaskSuggestionId =
  (typeof REMOTE_TASK_SUGGESTION_BATCHES)[number][number];
export type RemoteTaskSuggestionsMode = "empty" | "footer" | null;

export function isRemoteTaskSuggestionId(
  value: unknown,
): value is RemoteTaskSuggestionId {
  return REMOTE_TASK_SUGGESTION_BATCHES.some((batch) =>
    batch.some((id) => id === value),
  );
}

/** Count sessions before project, pinned and automation rows are collapsed. */
export function countHomeSuggestionSessions(
  home: Pick<MobileHomePresentation, "pinned" | "chats" | "projects">,
  searchResults?: readonly RemoteSessionListItem[],
): number {
  const countItems = (items: readonly RemoteSessionListItem[]) =>
    items.reduce(
      (count, item) => count + (item.automationGroup?.sessionCount ?? 1),
      0,
    );
  if (searchResults) return countItems(searchResults);
  return (
    countItems(home.pinned) +
    countItems(home.chats) +
    home.projects.reduce((count, project) => count + project.sessionCount, 0)
  );
}

export function remoteTaskSuggestionsMode({
  sessionCount,
  totalSessionCount,
  ready,
  hasSearchOrFilter,
}: {
  sessionCount: number;
  totalSessionCount: number;
  ready: boolean;
  hasSearchOrFilter: boolean;
}): RemoteTaskSuggestionsMode {
  if (!ready || sessionCount > 3) return null;
  if (sessionCount > 0) return "footer";
  return totalSessionCount === 0 && !hasSearchOrFilter ? "empty" : null;
}
