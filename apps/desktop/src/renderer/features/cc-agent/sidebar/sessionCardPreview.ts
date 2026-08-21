/**
 * 侧栏任务预览正文：摘要只属于「置顶 + 卡片」。
 * 列表 / 文字模式、以及非置顶任务一律用最近消息 preview。
 */
export function resolveSessionCardBody(args: {
  variant: 'card' | 'list';
  pinned: boolean;
  summary?: string | null;
  preview?: string | null;
}): string | null {
  if (args.variant === 'card' && args.pinned) {
    const summary = args.summary?.trim();
    if (summary) return summary;
  }
  const preview = args.preview?.trim();
  return preview || null;
}

/** 本轮开始时的 preview 基线。运行中即使权威值先到,也不改这份基线。 */
export function nextTurnStartPreview(args: {
  previousSessionId: string;
  nextSessionId: string;
  previousLivePreview: string | null;
  previousTurnStartPreview: string | null;
  currentPreview: string | null;
}): string | null {
  if (args.previousSessionId === args.nextSessionId && args.previousLivePreview != null) {
    return args.previousTurnStartPreview;
  }
  return args.currentPreview;
}

/** 实时活动文案消失前,用最后一帧顶住列表预览,避免结束瞬间跳回上一轮。
 *  只在当前 preview 仍等于本轮开始前的缓存时才写:权威值已在运行中到达,
 *  或卡片换了任务,都不能把运行态盖上去。 */
export function shouldPromoteLivePreviewToSession(args: {
  previousSessionId: string;
  nextSessionId: string;
  previousLivePreview: string | null;
  nextLivePreview: string | null;
  currentPreview?: string | null;
  stalePreview?: string | null;
}): boolean {
  if (args.previousSessionId !== args.nextSessionId) return false;
  if (!args.previousLivePreview || args.nextLivePreview != null) return false;
  const current = args.currentPreview?.trim() ?? '';
  if (!current) return true;
  const stale = args.stalePreview?.trim() ?? '';
  return Boolean(stale) && current === stale && current !== args.previousLivePreview;
}
