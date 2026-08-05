import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const registerSource = readFileSync(resolve(__dirname, '..', 'register.ts'), 'utf8').replace(
  /\r\n?/g,
  '\n',
);

function sourceBetween(startNeedle: string, endNeedle: string): string {
  const start = registerSource.indexOf(startNeedle);
  const end = registerSource.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return registerSource.slice(start, end);
}

describe('Pi session-tree lazy resume provider route', () => {
  it('preserves the persisted providerId null/undefined distinction', () => {
    const lazyResume = sourceBetween(
      'async function getOrResumeSessionTreeSession',
      'ipcMain.handle(MAKER_INVOKE.GET_SESSION_TREE',
    );

    expect(lazyResume).toContain('providerId: row.providerId,');
    expect(lazyResume).not.toContain('providerId: row.providerId ?? undefined');
  });

  it('keeps the same three-state route contract across every persisted-session bootstrap', () => {
    const preHydrate = sourceBetween(
      'async function hydrateProviderIdBeforeSessionStart',
      'async function markOrcaRoleIfNeeded',
    );
    const reconcile = sourceBetween(
      'async function reconcileCreateOptsAgainstDb',
      'const agentSwitchDeps:',
    );
    const queued = sourceBetween(
      'async function buildCreateOptsForQueuedSession',
      'async function enqueueSendToSessionMessage',
    );

    expect(preHydrate).toContain('o.providerId = row.providerId?.trim() || null;');
    expect(reconcile).toContain('co.providerId = row.providerId;');
    expect(queued).toContain('providerId: row.providerId,');
    expect(registerSource).toContain('providerId: row?.providerId,');
    expect(registerSource).toContain('providerId: inherited.providerId,');
    expect(registerSource).not.toContain('co.providerId = row.providerId ?? undefined;');
    expect(registerSource).not.toContain('providerId: row.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: row?.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: inherited.providerId ?? undefined,');
  });
});
