import { describe, expect, it, vi } from 'vitest';
import { createRecoveryDiagnostics, settleMeasuredSnapshot } from '../device-link/recoveryDiagnostics';

describe('mobile recovery diagnostics', () => {
  it('correlates peer phases from foreground without emitting device IDs or content', () => {
    let now = 100;
    const emit = vi.fn();
    const diagnostics = createRecoveryDiagnostics(emit, () => 7, () => now);
    diagnostics.foreground();
    now = 200;
    const a = diagnostics.capture('private-device-a', 7);
    const b = diagnostics.capture('private-device-b', 7);
    now = 600;
    a('subscription', 'applied', 2);
    now = 900;
    b('history', 'failed');
    expect(emit.mock.calls.map(([event]) => event)).toEqual([
      { generation: 1, connection: 7, peer: 1, operation: 1, phase: 'subscription', outcome: 'applied', count: 2, elapsedMs: 400, foregroundElapsedMs: 500 },
      { generation: 1, connection: 7, peer: 2, operation: 2, phase: 'history', outcome: 'failed', elapsedMs: 700, foregroundElapsedMs: 800 },
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain('private');
  });

  it('drops late observations from background, replaced connections and old foreground generations', () => {
    let epoch = 1;
    const emit = vi.fn();
    const diagnostics = createRecoveryDiagnostics(emit, () => epoch, () => 0);
    diagnostics.foreground();
    const old = diagnostics.capture('device', 1);
    diagnostics.background();
    old('history', 'applied');
    diagnostics.foreground();
    old('history', 'applied');
    const disconnected = diagnostics.capture('device', 1);
    epoch++;
    disconnected('history', 'applied');
    expect(emit).not.toHaveBeenCalled();
  });

  it('reports success only after a snapshot is accepted by the store', async () => {
    const report = vi.fn();
    await settleMeasuredSnapshot(Promise.resolve('content'), () => false, report);
    expect(report).toHaveBeenLastCalledWith('superseded');
    await settleMeasuredSnapshot(Promise.resolve('content'), () => true, report);
    expect(report).toHaveBeenLastCalledWith('applied');
    const error = new Error('private server response');
    expect(await settleMeasuredSnapshot(Promise.reject(error), () => true, report))
      .toEqual({ status: 'rejected', reason: error });
    expect(report).toHaveBeenLastCalledWith('failed');
    expect(JSON.stringify(report.mock.calls)).not.toContain('private');
  });
});
