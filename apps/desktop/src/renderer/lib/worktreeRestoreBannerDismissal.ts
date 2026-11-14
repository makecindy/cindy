/**
 * 「worktree 已被回收 / 有未应用快照」横幅的关闭记录(本机 localStorage)。
 *
 * 用户点 X 之后,同一条提示在重开任务、重启应用后都不再弹出。记录按
 * 「任务 + 提示内容(哪种状态、哪个 worktree 目录)」保存:内容变了(例如从
 * 「目录不存在」变成「有未应用快照」)算一条新提示,照常展示;worktree 恢复后
 * 由横幅清掉记录,之后再次被回收也照常展示。
 *
 * 只是本机的界面偏好,不进数据库、不跨设备同步:横幅本身只对本机任务出现,
 * 丢了记录的后果只是提示再出现一次。
 */

const STORAGE_KEY = 'worktreeRestoreBanner.dismissed.v1';
/** 只保留最近关闭的若干条,防止长期使用后无限增长。 */
const MAX_ENTRIES = 200;

/** [sessionId, signature],按关闭先后排列,最新的在末尾。 */
type DismissalEntry = [string, string];

function readEntries(): DismissalEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is DismissalEntry =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    );
  } catch {
    return [];
  }
}

function writeEntries(entries: DismissalEntry[]): void {
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // 存储不可用时退回旧行为:本次视图内隐藏,下次打开再提示。
  }
}

/** 一条提示的身份:状态种类 + worktree 目录。 */
export function worktreeRestoreBannerSignature(
  variant: 'missing' | 'pending',
  worktreePath: string,
): string {
  return `${variant}\n${worktreePath}`;
}

export function isWorktreeRestoreBannerDismissed(sessionId: string, signature: string): boolean {
  return readEntries().some(([id, value]) => id === sessionId && value === signature);
}

export function dismissWorktreeRestoreBanner(sessionId: string, signature: string): void {
  const entries = readEntries().filter(([id]) => id !== sessionId);
  entries.push([sessionId, signature]);
  writeEntries(entries);
}

export function clearWorktreeRestoreBannerDismissal(sessionId: string): void {
  const entries = readEntries();
  const remaining = entries.filter(([id]) => id !== sessionId);
  if (remaining.length !== entries.length) writeEntries(remaining);
}
