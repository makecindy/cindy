/** 与数据库最新失败查询一致的快照顺序；已读状态不参与比较。 */
export interface FailedScheduleRunSnapshot {
  runId: string;
  firedAt: number;
}

export function compareFailedScheduleRuns(
  a: FailedScheduleRunSnapshot,
  b: FailedScheduleRunSnapshot,
): number {
  return a.firedAt - b.firedAt || (a.runId > b.runId ? 1 : a.runId < b.runId ? -1 : 0);
}

export function failedScheduleDismissalPrefix(ownerId: string, sessionId: string): string {
  return `scheduleFailureDismissal:${JSON.stringify([ownerId, sessionId])}:`;
}

function readRecords(prefix: string) {
  const records: Array<{ key: string; run: FailedScheduleRunSnapshot }> = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(prefix)) continue;
    try {
      const snapshot = JSON.parse(key.slice(prefix.length));
      if (
        Array.isArray(snapshot) &&
        snapshot.length === 2 &&
        typeof snapshot[1] === 'string' &&
        typeof snapshot[0] === 'number' &&
        Number.isFinite(snapshot[0])
      ) {
        records.push({ key, run: { firedAt: snapshot[0], runId: snapshot[1] } });
      }
    } catch {
      // 非本格式的数据不作为关闭凭据，也不删除。
    }
  }
  return records.sort((a, b) => compareFailedScheduleRuns(b.run, a.run));
}

export function readLatestDismissedScheduleFailure(
  prefix: string | null,
): FailedScheduleRunSnapshot | null {
  try {
    return prefix ? (readRecords(prefix)[0]?.run ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * 先写当前快照，再只回收较旧记录，静止后每个 owner/session 只剩一条。
 * 独立 key 避免旧窗口覆盖新窗口；清理只朝旧方向，交错扫描不会删除较新的关闭记录。
 * 写失败不回收，清理失败仍保留新记录，下次关闭时再顺带回收；不增加锁或后台任务。
 */
export function dismissScheduleFailure(prefix: string, run: FailedScheduleRunSnapshot): void {
  localStorage.setItem(`${prefix}${JSON.stringify([run.firedAt, run.runId])}`, '1');
  const records = readRecords(prefix);
  for (const record of records.slice(1)) localStorage.removeItem(record.key);
}
