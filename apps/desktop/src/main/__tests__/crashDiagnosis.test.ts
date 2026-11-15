/** Unit: restart diagnosis must not prompt on expected exits, disclose marker paths,
 * collect before consent, or lose the exit summary when logs are unavailable. */
import { describe, expect, it, vi } from 'vitest';
import type { PreviousRunReport } from '../startup-diagnostics';
const mocks = vi.hoisted(() => ({ handle: vi.fn(), trust: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }));
vi.mock('../startup-diagnostics', () => ({ getPreviousRunReports: () => [] }));
vi.mock('../log-upload/collectRuntime', () => ({ collectLogsFromDisk: vi.fn() }));
vi.mock('../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: mocks.trust }));
import { createCrashDiagnosisService, initCrashDiagnosisService } from '../crash-diagnosis';

const at = '2026-11-07T01:00:00.000Z';
function report(kind: PreviousRunReport['kind'], reason?: string): PreviousRunReport {
  return { kind, file: '/private/run-10.json', marker: {
    pid: 10, version: '1.2.3', startedAt: at, heartbeatAt: at,
    heartbeatIntervalMs: 30000, state: 'running', shutdownReason: reason,
  } };
}

describe('restart diagnosis', () => {
  it('groups unexpected exits, excludes expected exits and live instances, and only collects on prepare', async () => {
    const collect = vi.fn().mockResolvedValue({ records: [
      { ts: at, level: 'error', src: 'main', scope: 'process', msg: 'crashed' },
      { ts: '2026-11-06T01:00:00.000Z', msg: 'unrelated' },
      { ts: '2026-11-07T01:00:02.000Z', msg: 'new startup, not crash evidence' },
    ] });
    const service = createCrashDiagnosisService({ collect, currentRunStartedAt: Date.parse(at) + 1000, reports: () => [
      report('clean'), report('still-running'), report('crash-exit', 'signal:SIGTERM'),
      report('shutdown-incomplete', 'update-relaunch'), report('shutdown-incomplete', 'session-end'), report('ended-asleep'), report('abnormal'),
      report('crash-exit', 'uncaughtException'), report('shutdown-incomplete', 'render-process-gone:crashed'),
    ] });
    expect(service.summary()?.count).toBe(3);
    expect(service.summary()?.details).not.toContain('/private');
    expect(collect).not.toHaveBeenCalled();
    const evidence = await service.prepare();
    expect(evidence?.logs).toContain('crashed');
    expect(evidence?.logs).not.toContain('unrelated');
    expect(evidence?.logs).not.toContain('new startup');
    expect(collect).toHaveBeenCalledWith({ reason: 'manual', anchors: expect.any(Array) });
    expect(await service.prepare()).toEqual(evidence);
    expect(collect).toHaveBeenCalledTimes(1);
    service.dismiss();
    expect(service.summary()).toBeNull();
  });

  it('keeps diagnosis usable without logs, and never reads arbitrary recent logs for a corrupt marker', async () => {
    const collect = vi.fn().mockRejectedValue(new Error('unreadable'));
    const service = createCrashDiagnosisService({ collect, currentRunStartedAt: Date.parse(at) + 1000, reports: () => [report('abnormal')] });
    expect(await service.prepare()).toMatchObject({ count: 1, logs: '', logsUnavailable: true });
    collect.mockClear();
    const corrupt = createCrashDiagnosisService({ collect, currentRunStartedAt: Date.parse(at) + 1000, reports: () => [{ kind: 'corrupt', file: '/private' }] });
    expect(await corrupt.prepare()).toMatchObject({ count: 1, logsUnavailable: true });
    expect(collect).not.toHaveBeenCalled();
    corrupt.dismiss();
    expect(corrupt.summary()).toBeNull();
  });

  it('all local IPC handlers reject an untrusted sender before reading or dismissing', () => {
    initCrashDiagnosisService();
    const denied = new Error('untrusted');
    mocks.trust.mockImplementation(() => { throw denied; });
    expect(mocks.handle.mock.calls).toHaveLength(3);
    for (const [, handler] of mocks.handle.mock.calls) {
      expect(() => handler({})).toThrow(denied);
    }
  });
});
