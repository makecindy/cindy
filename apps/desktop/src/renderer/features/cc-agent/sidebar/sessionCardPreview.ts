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

/** 实时活动文案消失前,用最后一帧顶住列表预览,避免结束瞬间跳回上一轮。
 *  sessionId 必须相同:卡片复用时不能把上一任务的运行文案写到当前任务上。
 *  已有 preview 若已是这一帧(或它的更完整版),说明落库权威值先到了,不要用截短的
 *  compactDetail 盖回去。 */
export function shouldPromoteLivePreviewToSession(args: {
  previousSessionId: string;
  nextSessionId: string;
  previousLivePreview: string | null;
  nextLivePreview: string | null;
  currentPreview?: string | null;
}): boolean {
  if (args.previousSessionId !== args.nextSessionId) return false;
  if (!args.previousLivePreview || args.nextLivePreview != null) return false;
  const current = args.currentPreview?.trim() ?? '';
  if (!current) return true;
  if (current === args.previousLivePreview) return false;
  return !(
    current.startsWith(args.previousLivePreview) || args.previousLivePreview.startsWith(current)
  );
}
