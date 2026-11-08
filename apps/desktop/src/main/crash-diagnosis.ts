import { ipcMain } from 'electron';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import type { CrashDiagnosisEvidence, CrashDiagnosisSummary } from '../shared/crashDiagnosis';
import { getPreviousRunReports, type PreviousRunReport } from './startup-diagnostics';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { collectLogsFromDisk } from './log-upload/collectRuntime';
import type { CollectRequest } from './log-upload/collect';
import type { CollectResult } from './log-upload/types';
import { isFatalCrashReason } from './log-upload/crashTriggers';

/** Reuse the startup verdict; expected shutdowns and live sibling processes never prompt. */
export function createCrashDiagnosisService(deps: {
  reports(): readonly PreviousRunReport[];
  currentRunStartedAt: number;
  collect(request: CollectRequest): Promise<CollectResult>;
}) {
  let dismissed = false;
  let preparation: Promise<CrashDiagnosisEvidence | null> | null = null;
  function reports() {
    return deps.reports().filter((r) =>
      r.kind === 'abnormal' || r.kind === 'corrupt' ||
      ((r.kind === 'crash-exit' || r.kind === 'shutdown-incomplete') &&
        isFatalCrashReason(r.marker?.shutdownReason ?? '')),
    );
  }
  function summary(): CrashDiagnosisSummary | null {
    const rows = reports();
    if (dismissed || !rows.length) return null;
    return {
      count: rows.length,
      // Do not return marker paths, PIDs, or arbitrary additional marker fields.
      details: rows.slice(-10).map(({ kind, marker: m }) => redactSensitiveText(JSON.stringify({
        kind, version: m?.version, startedAt: m?.startedAt,
        lastHeartbeatAt: m?.heartbeatAt, shutdownAt: m?.shutdownAt,
        exitedAt: m?.exitedAt, reason: m?.shutdownReason, exitCode: m?.exitCode,
      }))).join('\n'),
    };
  }
  return {
    summary,
    dismiss() { dismissed = true; },
    prepare(): Promise<CrashDiagnosisEvidence | null> {
      if (preparation) return preparation;
      const info = summary();
      if (!info) return Promise.resolve(null);
      const anchors = reports().flatMap(({ marker: m }) => {
        const at = Date.parse(m?.exitedAt ?? m?.shutdownAt ?? m?.heartbeatAt ?? '');
        return Number.isFinite(at) ? [at] : [];
      });
      preparation = (async () => {
        // Unknown time: don't substitute unrelated recent logs for crash evidence.
        if (!anchors.length) return { ...info, logs: '', logsUnavailable: true };
        try {
          // Manual source allowlist: no agent stream or raw dumps, no upload side effect.
          const result = await deps.collect({ reason: 'manual', anchors });
          const distance = (ts: string) => Math.min(...anchors.map((at) => Math.abs(Date.parse(ts) - at)));
          const nearby = result.records.filter((r) =>
            Date.parse(r.ts) < deps.currentRunStartedAt && distance(r.ts) <= 5 * 60_000,
          ).sort((a, b) => distance(a.ts) - distance(b.ts));
          const lines: string[] = [];
          let size = 0;
          for (const record of nearby.slice(0, 100)) {
            const line = JSON.stringify(record);
            if (size + line.length + 1 > 16_000) break;
            lines.push(line);
            size += line.length + 1;
          }
          const logs = lines.join('\n');
          return { ...info, logs, logsUnavailable: !logs };
        } catch {
          return { ...info, logs: '', logsUnavailable: true };
        }
      })();
      return preparation;
    },
  };
}

export function initCrashDiagnosisService(): void {
  const service = createCrashDiagnosisService({
    reports: getPreviousRunReports,
    collect: collectLogsFromDisk,
    currentRunStartedAt: Date.now() - process.uptime() * 1000,
  });
  ipcMain.handle('crash-diagnosis:get', (event) => {
    assertTrustedAppRendererEvent(event);
    return service.summary();
  });
  ipcMain.handle('crash-diagnosis:prepare', (event) => {
    assertTrustedAppRendererEvent(event);
    return service.prepare();
  });
  ipcMain.handle('crash-diagnosis:dismiss', (event) => {
    assertTrustedAppRendererEvent(event);
    service.dismiss();
  });
}
