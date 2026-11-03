/**
 * 用量报告序号(usageReporter 的 nextSeq)按账号存在本机(`provider-group-usage-seq.json`)：
 * 校时或自动校时让系统时间倒退、或发送方重启时，新序号仍必须大于上次已发出的那个，否则组所在
 * 电脑那份按序号去重的记忆会直接丢弹这次报告(greptile-apps P2, PR #5792 review)。
 * 只存目前为止用过的最大序号；写不下去只记日志，本次运行退回到纯内存计数(进程内仍单调递增)。
 */
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';

interface SeqFile {
  seq: number;
}

function normalize(raw: unknown): SeqFile {
  const value = (raw as Partial<SeqFile> | null)?.seq;
  return { seq: typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0 };
}

const log = desktopMakerLogger.child('provider-group');
const store = createOverrideSettingsFile<SeqFile>({
  filePath: () => ownerScopedUserDataPath('provider-group-usage-seq.json'),
  scopeKey: activeOwnerScopeKey,
  defaults: { seq: 0 },
  normalize,
  log,
  label: 'provider-group-usage-seq',
  maxBytes: 4 * 1024,
});

/** 这个账号目前为止用过的最大序号；读不到按 0(从头计数，仍不影响去重语义——0 比任何正序号都小)。 */
export function readProviderGroupUsageSeq(): number {
  store.invalidateIfChanged();
  return store.read().seq;
}

/** 落盘这次用过的序号；只在比当前记录的更大时才真正写(调用方应已保证单调，这里再兜底一次)。 */
export function writeProviderGroupUsageSeq(seq: number): void {
  void store.updateAtomic((current) => ({ seq: Math.max(current.value.seq, seq) })).catch((error: unknown) => {
    log.warn('provider group: saving usage report sequence failed', { error: error instanceof Error ? error.message : String(error) });
  });
}

export const __testing = { normalize };
