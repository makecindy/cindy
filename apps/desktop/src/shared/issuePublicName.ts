/**
 * 平台代发 GitHub Issue 时公开署名的跨进程契约。
 *
 * github-server 会把 userName 原样写进 Markdown 正文，因此这里同时限制长度与
 * 单行纯文本形状。Renderer 用它控制提交状态，Main 在 IPC 边界再次校验。
 */
export const ISSUE_PUBLIC_NAME_MAX = 100;

export function normalizeIssuePublicName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ISSUE_PUBLIC_NAME_MAX) {
    return null;
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      return null;
    }
  }
  return value;
}
