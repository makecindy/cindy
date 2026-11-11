import { createSessionOptionsReconciler } from '../sessionOptionsReconciler.js';
import type { MakerSessionCreateOpts } from '../sessionRequest.js';
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
  it('refreshes shared global skills before Pi discovery', () => {
    const listSkills = sourceBetween(
      'MAKER_INVOKE.LIST_AGENT_SKILLS',
      'MAKER_INVOKE.SCAN_AT_RESOURCES',
    );
    const listCustomizations = sourceBetween(
      'MAKER_INVOKE.LIST_CUSTOMIZATIONS',
      '// ── Session 生命周期',
    );

    expect(listSkills).toContain('const kind = requireAgentKind(agentKind);');
    expect(listSkills).toContain('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();');
    // Guard discovery order independently of optional host verification arguments.
    const skillsDiscoveryIdx = listSkills.indexOf('maker.listAgentSkills(');
    expect(skillsDiscoveryIdx).toBeGreaterThanOrEqual(0);
    expect(
      listSkills.indexOf('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();'),
    ).toBeLessThan(skillsDiscoveryIdx);

    expect(listCustomizations).toContain("else if (agentKind === 'pi') {");
    expect(listCustomizations).toContain(
      'await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();',
    );
    expect(
      listCustomizations.indexOf('await desktopClaudeAuthAdapter.ensureSharedGlobalSkills();'),
    ).toBeLessThan(listCustomizations.indexOf('maker.listCustomizations(opts)'));
  });

  // Cross-file routing guard: the factory controls eligibility, while register
  // must carry persisted provider/host authority into the native bootstrap.
  it('preserves route identity and requires native history for cold actions', () => {
    const lazyResume = sourceBetween(
      'const getOrResumeSessionForHistory = createSessionActionRuntime',
      'ipcMain.handle(MAKER_INVOKE.GET_SESSION_TREE',
    );
    expect(lazyResume).toContain('providerId: row.providerId,');
    expect(lazyResume).toContain('remoteHostId: row.remoteHostId ?? undefined,');
    expect(lazyResume).toContain('agentDeviceId: row.agentDeviceId ?? undefined,');
    expect(lazyResume).toContain('bootstrapSession(createOpts, assertCurrent, true)');
  });

  it('keeps the same three-state route contract across every persisted-session bootstrap', async () => {
    const preHydrate = sourceBetween(
      'async function hydrateProviderIdBeforeSessionStart',
      'async function markOrcaRoleIfNeeded',
    );
    const queued = sourceBetween(
      'async function buildCreateOptsForQueuedSession',
      'async function enqueueSendToSessionMessage',
    );

    expect(preHydrate).toContain('o.providerId = row.providerId?.trim() || null;');
    for (const providerId of [null, undefined, 'selected-provider']) {
      const co = { agentKind: 'pi', providerId: 'stale' } as MakerSessionCreateOpts;
      await createSessionOptionsReconciler({ log: { warn() {} },
        readSession: async () => ({ model: 'm', agentKind: 'pi', providerId }) })('task', co);
      expect(co.providerId).toBe(providerId);
    }
    expect(queued).toContain('providerId: row.providerId,');
    expect(registerSource).toContain('providerId: row?.providerId,');
    expect(registerSource).toContain('providerId: inherited.providerId,');
    expect(registerSource).not.toContain('co.providerId = row.providerId ?? undefined;');
    expect(registerSource).not.toContain('providerId: row.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: row?.providerId ?? undefined,');
    expect(registerSource).not.toContain('providerId: inherited.providerId ?? undefined,');
  });
});
