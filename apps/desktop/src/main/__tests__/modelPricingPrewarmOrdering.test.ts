/**
 * Source contract for model pricing prewarm startup timing.
 *
 * Pricing may read provider secrets and caches by current localDb user scope.
 * Prewarm must wait until ensureLifecycleDbClient(userId) succeeds, otherwise
 * cold start can use a previous account key and populate the anonymous scope.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '..', 'bootstrap-electron.ts'), 'utf8').replace(/\r\n?/g, '\n');

describe('model pricing prewarm ordering', () => {
  it('only prewarms model pricing once', () => {
    const calls = source.match(/void prewarmModelPricing\(\);/g) ?? [];
    expect(calls).toHaveLength(1);
  });

  it('prewarms after localDb user takeover succeeds', () => {
    const localDbReady = source.indexOf('const dbClientTakeover = await ensureLifecycleDbClient(userId);');
    const failedGuard = source.indexOf("dbClientTakeover.mode === 'failed'");
    const unchangedGuard = source.indexOf("dbClientTakeover.mode === 'unchanged'");
    const attachmentSweep = source.indexOf('sweepStagedChatAttachmentsOnStartup({');
    const lifecycleStartupBlock = source.slice(localDbReady, attachmentSweep);
    const earlyUsageIpc = source.indexOf('registerMakerUsageIpc(ipcMaker);');
    const prewarm = source.indexOf('void prewarmModelPricing();');
    const refreshCatalog = source.indexOf('await refreshCustomProvidersIntoCatalog(');

    expect(localDbReady).toBeGreaterThanOrEqual(0);
    expect(failedGuard).toBeGreaterThan(localDbReady);
    expect(unchangedGuard).toBeGreaterThan(failedGuard);
    expect(attachmentSweep).toBeGreaterThan(unchangedGuard);
    expect(lifecycleStartupBlock).not.toContain(
      'BrowserWindow.getAllWindows().some(isSecondaryAppWindow)',
    );
    expect(earlyUsageIpc).toBeGreaterThanOrEqual(0);
    expect(prewarm).toBeGreaterThan(failedGuard);
    expect(prewarm).toBeGreaterThan(earlyUsageIpc);
    expect(refreshCatalog).toBeGreaterThan(prewarm);
  });

  it('does not prewarm in the early IPC registration block', () => {
    const earlyUsageIpc = source.indexOf('registerMakerUsageIpc(ipcMaker);');
    const nextIpc = source.indexOf('registerMakerBinaryVersionIpc();', earlyUsageIpc);
    expect(earlyUsageIpc).toBeGreaterThanOrEqual(0);
    expect(nextIpc).toBeGreaterThan(earlyUsageIpc);
    expect(source.slice(earlyUsageIpc, nextIpc)).not.toContain('prewarmModelPricing');
  });
});
