/**
 * 协同开关的「外部触发」边沿判定(CCAgentSessionView 的 F-COLLAB effect 用)。
 *
 * 边沿只在同一个任务内成立：切换任务时同一个视图实例会复用，上一个任务的值不能当成
 * 这个任务的「上一次」；任务数据未就绪(未知)时既不触发也不当基线，否则「未加载 →
 * 加载完是 Lead」会被误判成刚开启协同。
 */

export interface CollabEnabledBaseline {
  sessionId: string;
  collabEnabled: boolean;
}

export type CollabEnabledEdge = 'enabled' | 'disabled' | null;

/**
 * @param collabEnabled 当前任务是否为 Lead；null = 任务数据未就绪，未知。
 */
export function nextCollabEnabledEdge(
  baseline: CollabEnabledBaseline | null,
  sessionId: string | null | undefined,
  collabEnabled: boolean | null,
): { baseline: CollabEnabledBaseline | null; edge: CollabEnabledEdge } {
  if (!sessionId) return { baseline: null, edge: null };
  const sameSession = baseline?.sessionId === sessionId;
  if (collabEnabled === null) {
    // 同一任务暂时读不到数据时保留旧基线；换了任务则等数据就绪后重新记基线。
    return { baseline: sameSession ? baseline : null, edge: null };
  }
  const next = { sessionId, collabEnabled };
  if (!baseline || !sameSession) return { baseline: next, edge: null };
  if (!baseline.collabEnabled && collabEnabled) return { baseline: next, edge: 'enabled' };
  if (baseline.collabEnabled && !collabEnabled) return { baseline: next, edge: 'disabled' };
  return { baseline: next, edge: null };
}
