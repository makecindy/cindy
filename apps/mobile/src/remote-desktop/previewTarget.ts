import { isPreviewTabRef, type PreviewTabSummary } from "@cindy/device-link";

/**
 * Which plugin preview tab a phone wants to watch. It names the task and, when
 * known, the plugin and the title the entry showed; it never carries a grant:
 * the one-time token is fetched right before the view starts and is not kept.
 */
export interface PreviewTarget {
  sessionId: string;
  pluginName?: string;
  title?: string;
  /** The listed tab's stable reference; absent for computers that predate it. */
  ref?: string;
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : undefined;

/** Reads route params; null when they do not name a task. */
export function parsePreviewTarget(params: {
  previewSession?: unknown;
  previewPlugin?: unknown;
  previewTitle?: unknown;
  previewRef?: unknown;
}): PreviewTarget | undefined {
  const sessionId = text(params.previewSession, 128);
  if (!sessionId) return undefined;
  const pluginName = text(params.previewPlugin, 200);
  const title = text(params.previewTitle, 200);
  const ref = isPreviewTabRef(params.previewRef) ? params.previewRef : undefined;
  return {
    sessionId,
    ...(pluginName ? { pluginName } : {}),
    ...(title ? { title } : {}),
    ...(ref ? { ref } : {}),
  };
}

/**
 * The listed tab to start. With a `ref` only that tab will do: it is the host's
 * stable identity of the binding, so a missing one means the tab was closed or
 * rebuilt, and another tab of the same plugin is never taken in its place.
 * Without one (a computer that predates it) titles change while a page loads,
 * so an exact match is preferred but not required: the only tab of the task is
 * taken as it is, and among several the plugin decides. Anything else means
 * the tab is gone.
 */
export function pickPreviewTab(
  tabs: readonly PreviewTabSummary[],
  target: PreviewTarget,
): PreviewTabSummary | undefined {
  // A tab with a ref that is not one is malformed, not "a computer without refs".
  const own = tabs.filter(
    (tab) =>
      tab.sessionId === target.sessionId &&
      (tab.ref === undefined || isPreviewTabRef(tab.ref)),
  );
  if (target.ref !== undefined) return own.find((tab) => tab.ref === target.ref);
  const exact = own.find(
    (tab) =>
      tab.pluginName === target.pluginName && tab.title === target.title,
  );
  if (exact) return exact;
  if (own.length === 1) return own[0];
  return own.find((tab) => tab.pluginName === target.pluginName);
}

/** How long a view that lost its source waits for the plugin's replacement preview. */
export const PREVIEW_FOLLOW_WINDOW_MS = 8000;
/** Pause between looks for it (in practice the 3 s reconnect tick paces them). */
export const PREVIEW_FOLLOW_RETRY_MS = 1000;

/**
 * Whether a view whose source the computer reported ended is still looking for
 * the preview that replaced it. `until` is 0 for a view that never lost its
 * source; `known` are the refs of the task's tabs and `title` the one of the
 * tab being watched, both as of when the view last started.
 */
export interface PreviewFollow {
  until: number;
  known: readonly string[];
  title?: string;
}

export const newPreviewFollow = (): PreviewFollow => ({ until: 0, known: [] });

/**
 * The computer said the source ended. Opens the look-for-a-replacement window
 * when the view had been live, and says whether it is still open. A view that
 * never showed the preview (stale entry) gets no window.
 */
export function previewFollowOpen(
  follow: PreviewFollow,
  now: number,
  wasLive: boolean,
): boolean {
  if (follow.until === 0 && wasLive) follow.until = now + PREVIEW_FOLLOW_WINDOW_MS;
  return now < follow.until;
}

/**
 * The preview that replaced the one being watched: a tab of the same task and
 * plugin with the same title that was not there when the view started. Only a
 * single such tab is taken; none or several mean there is nothing to say it
 * replaced ours, and the view reports the end as before. Needs refs, so a
 * computer that predates them never lands here (see `pickPreviewTab`).
 */
export function pickSupersedingTab(
  tabs: readonly PreviewTabSummary[],
  target: PreviewTarget,
  follow: Pick<PreviewFollow, "known" | "title">,
): PreviewTabSummary | undefined {
  const title = follow.title ?? target.title;
  if (target.pluginName === undefined || title === undefined) return undefined;
  const candidates = tabs.filter(
    (tab) =>
      tab.sessionId === target.sessionId &&
      tab.pluginName === target.pluginName &&
      tab.title === title &&
      isPreviewTabRef(tab.ref) &&
      tab.ref !== target.ref &&
      !follow.known.includes(tab.ref),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
