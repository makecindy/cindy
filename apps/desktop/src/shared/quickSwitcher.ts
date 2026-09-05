import type { ConversationSearchSessionSummary } from './conversationSearch';

/** Title/directory metadata only; never includes messages or runtime configuration. */
export interface QuickSwitcherSession extends ConversationSearchSessionSummary {
  remoteHostId: string | null;
  pinnedAt: string | null;
}

export interface QuickSwitcherCatalogPage {
  version: 1;
  sessions: QuickSwitcherSession[];
  nextCursor: string | null;
}

export const QUICK_SWITCHER_PAGE_SIZE = 128;
