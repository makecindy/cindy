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
