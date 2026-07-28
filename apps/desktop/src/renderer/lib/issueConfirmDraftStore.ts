/**
 * In-memory drafts for the submit_github_issue confirmation card.
 *
 * This input state is intentionally separate from makerChatStore: title/body/
 * public-name changes happen on every keystroke and must not invalidate running-status
 * snapshots or notify session/global chat subscribers. Keys include both the
 * session and request so parallel sessions and consecutive requests cannot
 * share edits. Renderer restart intentionally drops all entries.
 */

export interface IssueConfirmDraft {
  title: string;
  body: string;
  type: 'bug' | 'feature';
  /** 平台代发时用户在确认卡片里编辑的公开署名。 */
  publicName?: string;
}

const draftsBySession = new Map<string, Map<string, IssueConfirmDraft>>();

export function getIssueConfirmDraft(
  sessionId: string,
  requestId: string,
): IssueConfirmDraft | undefined {
  return draftsBySession.get(sessionId)?.get(requestId);
}

export function saveIssueConfirmDraft(
  sessionId: string,
  requestId: string,
  draft: IssueConfirmDraft,
): void {
  let sessionDrafts = draftsBySession.get(sessionId);
  if (!sessionDrafts) {
    sessionDrafts = new Map();
    draftsBySession.set(sessionId, sessionDrafts);
  }
  sessionDrafts.set(requestId, draft);
}

export function clearIssueConfirmDraft(sessionId: string, requestId: string): void {
  const sessionDrafts = draftsBySession.get(sessionId);
  if (!sessionDrafts) return;
  sessionDrafts.delete(requestId);
  if (sessionDrafts.size === 0) draftsBySession.delete(sessionId);
}

export function clearIssueConfirmDraftsForSession(sessionId: string): void {
  draftsBySession.delete(sessionId);
}
