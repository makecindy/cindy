import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  DesktopHeartbeatHistory,
  desktopDiagnosticCode,
  desktopDiagnosticId,
} from '../remoteDesktopDiagnostics';

it('correlates renderer diagnostics with Main using a hash instead of the lease', async () => {
  const lease = '8108db5e-7b62-4cf6-9893-a2a477fce6c7';
  expect(await desktopDiagnosticId(lease)).toBe(
    createHash('sha256').update(lease).digest('hex').slice(0, 16),
  );
});

it('keeps snapshots immutable when an in-flight heartbeat settles after disconnect', () => {
  const history = new DesktopHeartbeatHistory();
  const pending = history.add({ requestedAt: 10 });
  const snapshot = history.snapshot();
  pending.settledAt = 20;
  pending.result = 'INVOKE_TIMEOUT';
  expect(snapshot).toEqual([{ requestedAt: 10 }]);
  for (let i = 0; i < 12; i++) history.add({ requestedAt: 30 + i });
  expect(history.snapshot()).toHaveLength(8);
  expect(history.snapshot()[0].requestedAt).toBe(34);
});

it('drops unknown or decorated error text rather than logging user data', () => {
  expect(desktopDiagnosticCode(new Error('DESKTOP_LEASE_EXPIRED'))).toBe('DESKTOP_LEASE_EXPIRED');
  for (const value of [
    'DESKTOP_LEASE_EXPIRED private-text',
    'SECRET_CONTENT',
    new Error('/private/file'),
    { code: 'INVOKE_TIMEOUT' },
  ])
    expect(desktopDiagnosticCode(value)).toBe('UNKNOWN_ERROR');
});
