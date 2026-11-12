/**
 * 用量报告(usageReporter)的按账号接线：每个账号一个报告器，只读、只报告自己那份账本；
 * 换了账号之后旧账号那份停在原处，不在新账号的连接上发出去，换回来再接着报。
 */
import { getActiveAppSession } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { currentProviderPartyUsageStore, type ProviderPartyUsageStore } from '../usage/providerPartyUsageStore.js';
import { getProviderGroupRemoteClient } from './runtime.js';
import { createProviderGroupUsageReporter, type ProviderGroupUsageReporter } from './usageReporter.js';
import { readProviderGroupUsageSeq, writeProviderGroupUsageSeq } from './usageSeqStore.js';

const log = createLogger('providerGroupUsageReport');

/** 账号 → 报告器(按账号的账本对象区分账号，同一账号重新登录沿用)。 */
const reporters = new Map<ProviderPartyUsageStore, ProviderGroupUsageReporter>();

/** 当前账号的报告器(第一次取时把这个账号还没送到的整份报一次)；还没登录时为 null。 */
export function ensureProviderGroupUsageReporter(): ProviderGroupUsageReporter | null {
  if (!getActiveAppSession().dataOwnerId) return null;
  const store = currentProviderPartyUsageStore();
  const existing = reporters.get(store);
  if (existing) return existing;
  const reporter = createProviderGroupUsageReporter({
    owners: () => store.groupOwners(),
    rows: (owner, sinceDay) => store.groupReport(owner, sinceDay),
    send: async (owner, report) => {
      // 只在这个账号还是当前账号时发：别的账号的连接上不发这份，之后照常重试。
      await getProviderGroupRemoteClient().usage(owner, report, () => {
        // 大报告的每一批都重查，上一批在途时换账号不能在新账号的连接上继续发送旧账本。
        if (currentProviderPartyUsageStore() !== store) throw new Error('account is not active');
      });
    },
    now: () => Date.now(),
    log,
    loadLastSeq: () => readProviderGroupUsageSeq(),
    saveLastSeq: (seq) => writeProviderGroupUsageSeq(seq),
  });
  reporters.set(store, reporter);
  return reporter;
}

/** 刚给另一台电脑上的组记了用量：报告给它(防抖)。 */
export function notifyProviderGroupUsage(groupDeviceId: string, day: string): void {
  ensureProviderGroupUsageReporter()?.notify(groupDeviceId, day);
}

export function disposeProviderGroupUsageReporters(): void {
  for (const reporter of reporters.values()) reporter.dispose();
  reporters.clear();
}
