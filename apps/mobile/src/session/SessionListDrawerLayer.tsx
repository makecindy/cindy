import type { ComponentProps } from 'react';
import { MessageHistoryOverlay } from './RecentMessageHistories';
import { SessionListDrawer } from './SessionListDrawer';

/** Keep presentation and native hosting in sync, including a modal's exit. */
export function SessionListDrawerLayer({ persistent, overlayMounted, open, width, sidebarWidth, ...props }:
  ComponentProps<typeof SessionListDrawer> & { overlayMounted: boolean; sidebarWidth: number }) {
  const inline = Boolean(persistent && !overlayMounted);
  return <MessageHistoryOverlay inline={inline}>
    <SessionListDrawer {...props} persistent={inline} open={inline || open} width={inline ? sidebarWidth : width} />
  </MessageHistoryOverlay>;
}
