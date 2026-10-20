import {
  isPreviewGrant,
  remoteDesktopPreviewTabCapability,
  type PreviewTabsReply,
  type RemoteDesktopCapabilities,
  type RemoteDesktopRequest,
} from "@cindy/device-link";

/**
 * A preview tab the computer lists for a task. The listing also carries a
 * one-time grant; it is dropped here, because the view fetches its own right
 * before starting and a held grant would only expire.
 */
export interface PreviewTabListing {
  sessionId: string;
  pluginName: string;
  title: string;
}

/**
 * What the computer said about previews. It is asked once per poll run (page
 * shown, app foregrounded, computer reconnected) and polling only lists tabs.
 */
export interface PreviewCapsMemo {
  checked: boolean;
  supported: boolean;
}

/**
 * Asks the computer which plugin preview tabs a task has. Empty when previews
 * are unsupported, remote desktop is off, or the task has none; errors are the
 * caller's to back off from.
 */
export async function readPreviewTabs(
  invoke: (message: RemoteDesktopRequest) => Promise<unknown>,
  sessionId: string,
  memo: PreviewCapsMemo,
): Promise<PreviewTabListing[]> {
  if (!memo.checked) {
    const caps = (await invoke({ op: "capabilities" })) as
      | RemoteDesktopCapabilities
      | undefined;
    memo.supported =
      caps?.version === 1 &&
      caps.enabled === true &&
      remoteDesktopPreviewTabCapability(caps) !== null;
    memo.checked = true;
  }
  if (!memo.supported) return [];
  const reply = (await invoke({ op: "previewTabs", sessionId })) as
    | PreviewTabsReply
    | undefined;
  if (!Array.isArray(reply?.tabs)) return [];
  const listed: PreviewTabListing[] = [];
  for (const tab of reply.tabs) {
    if (
      isPreviewGrant(tab?.grant) &&
      tab.sessionId === sessionId &&
      typeof tab.pluginName === "string" &&
      typeof tab.title === "string"
    )
      listed.push({
        sessionId,
        pluginName: tab.pluginName,
        title: tab.title,
      });
  }
  return listed;
}

export function samePreviewListing(
  a: readonly PreviewTabListing[],
  b: readonly PreviewTabListing[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (tab, index) =>
        tab.pluginName === b[index].pluginName && tab.title === b[index].title,
    )
  );
}

export const PREVIEW_POLL_MS = 4000;
export const PREVIEW_POLL_MAX_MS = 30_000;

/** Delay before the next poll: steady while it works, doubling after failures. */
export function previewPollDelay(failures: number): number {
  return failures <= 0
    ? PREVIEW_POLL_MS
    : Math.min(PREVIEW_POLL_MAX_MS, PREVIEW_POLL_MS * 2 ** failures);
}
