import type { PreviewTabSummary } from "@cindy/device-link";

/**
 * Which plugin preview tab a phone wants to watch. It names the task and, when
 * known, the plugin and the title the entry showed; it never carries a grant:
 * the one-time token is fetched right before the view starts and is not kept.
 */
export interface PreviewTarget {
  sessionId: string;
  pluginName?: string;
  title?: string;
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
}): PreviewTarget | undefined {
  const sessionId = text(params.previewSession, 128);
  if (!sessionId) return undefined;
  const pluginName = text(params.previewPlugin, 200);
  const title = text(params.previewTitle, 200);
  return {
    sessionId,
    ...(pluginName ? { pluginName } : {}),
    ...(title ? { title } : {}),
  };
}

/**
 * The listed tab to start. Titles change while a page loads, so an exact match
 * is preferred but not required: the only tab of the task is taken as it is,
 * and among several the plugin decides. Anything else means the tab is gone.
 */
export function pickPreviewTab(
  tabs: readonly PreviewTabSummary[],
  target: PreviewTarget,
): PreviewTabSummary | undefined {
  const own = tabs.filter((tab) => tab.sessionId === target.sessionId);
  const exact = own.find(
    (tab) =>
      tab.pluginName === target.pluginName && tab.title === target.title,
  );
  if (exact) return exact;
  if (own.length === 1) return own[0];
  return own.find((tab) => tab.pluginName === target.pluginName);
}
