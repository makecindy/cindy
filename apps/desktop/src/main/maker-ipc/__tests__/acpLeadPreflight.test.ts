/**
 * Test value
 * - Production entry and observable result: dormantAcpLeadRefusal, the decision assertLeadCollabProjectEnabled
 *   takes (before any team or Worker exists) for a plugin-engine task with no live session.
 * - Basis: docs/plans/acp-plugin-bridge.md (a plugin engine task can lead only when it can use the cindy_orca
 *   tools; reopening a task needs session resume or load) and the live-session rule in makerSendTransaction
 *   (an engine that cannot resume is refused as a Lead).
 * - Existing gap: the preflight only asked for HTTP MCP, so a task with a stored native session on an engine that
 *   cannot reopen it got a team and a Worker, then failed on its first message as a Lead it could not wake.
 * - Minimal failing input: HTTP MCP supported, no resume or load, task with a stored session id.
 * - Tier: unit (pure decision).
 */
import type { AcpLeadSupport } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';
import { createDormantAcpLeadPreflight, dormantAcpLeadRefusal, revokeAcpLeadIfTeamEnded } from '../acpLeadPreflight.js';

describe('dormantAcpLeadRefusal', () => {
  it.each([
    { name: 'can reopen its stored session', support: { httpMcp: true, resume: true }, stored: true },
    { name: 'cannot reopen a session but the task has none yet', support: { httpMcp: true, resume: false }, stored: false },
    { name: 'can reopen a session and the task has none yet', support: { httpMcp: true, resume: true }, stored: false },
  ])('accepts an engine that $name', ({ support, stored }) => {
    expect(dormantAcpLeadRefusal(support, stored)).toBeNull();
  });

  it('refuses an engine without HTTP MCP, whatever its session support', () => {
    for (const stored of [false, true]) {
      expect(dormantAcpLeadRefusal({ httpMcp: false, resume: true }, stored)).toMatchObject({
        code: 'UNSUPPORTED_CAPABILITY',
        message: expect.stringContaining('[PLUGIN_ENGINE_LEAD_TOOLS_UNSUPPORTED]'),
      });
    }
  });

  it('refuses a task with a stored session on an engine that cannot reopen it', () => {
    expect(dormantAcpLeadRefusal({ httpMcp: true, resume: false }, true)).toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringMatching(/\[PLUGIN_ENGINE_LEAD_TOOLS_UNSUPPORTED\].*cannot reopen this task/),
    });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const ENGINE = 'acme:agent';
const CAN_LEAD: AcpLeadSupport = { httpMcp: true, resume: true };

// Production entry: createDormantAcpLeadPreflight, the preflight assertLeadCollabProjectEnabled runs on a dormant
// plugin-engine task before any team or Worker exists (register.ts wires it to the plugin registry and the ACP probe).
// Basis: docs/plans/acp-plugin-bridge.md (a dormant task is probed before a team is built; a probe that cannot be
// confirmed stopped is a failure) and the registry rule that an engine published unavailable cannot be started.
// Gap: this wiring had no test. An engine published unavailable while its probe process was stopping still got a team
// (its Lead could never wake), and an answer kept from an earlier call outlived the plugin it came from.
// Minimal failing input: unavailable published before the probe settles; two calls around a plugin replacement.
// Tier: unit (fake registry state and probe).
describe('createDormantAcpLeadPreflight', () => {
  const setup = (probe: (harnessKey: string) => Promise<AcpLeadSupport>) => {
    const states = new Map<string, 'available' | 'unavailable' | 'unknown'>([[ENGINE, 'available']]);
    const probeSpy = vi.fn(probe);
    const onProbeFailed = vi.fn();
    const preflight = createDormantAcpLeadPreflight({
      engineState: (harnessKey) => states.get(harnessKey),
      probe: probeSpy,
      onProbeFailed,
    });
    return { states, probe: probeSpy, onProbeFailed, preflight };
  };

  it.each([
    { name: 'an engine that is not listed', key: 'gone:agent', state: undefined },
    { name: 'an engine published unavailable', key: ENGINE, state: 'unavailable' as const },
    { name: 'a task with no engine', key: null, state: undefined },
  ])('refuses $name without starting a probe', async ({ key, state }) => {
    const t = setup(async () => CAN_LEAD);
    if (state) t.states.set(ENGINE, state);
    await expect(t.preflight(key, false)).resolves.toMatchObject({ code: 'PROVIDER_ROUTE_UNAVAILABLE' });
    expect(t.probe).not.toHaveBeenCalled();
  });

  it('accepts an engine whose availability is not known yet when it can lead', async () => {
    const t = setup(async () => CAN_LEAD);
    t.states.set(ENGINE, 'unknown');
    await expect(t.preflight(ENGINE, true)).resolves.toBeNull();
  });

  it('refuses an engine that is published unavailable while its probe process is being stopped', async () => {
    const stopping = deferred<AcpLeadSupport>();
    const t = setup(() => stopping.promise);
    const result = t.preflight(ENGINE, true);
    await vi.waitFor(() => expect(t.probe).toHaveBeenCalledOnce());
    t.states.set(ENGINE, 'unavailable');
    stopping.resolve(CAN_LEAD);
    await expect(result).resolves.toMatchObject({ code: 'PROVIDER_ROUTE_UNAVAILABLE' });
  });

  it('tells a failed probe of an available engine from one of an engine that went away', async () => {
    const t = setup(async () => { throw new Error('endpoint still running'); });
    await expect(t.preflight(ENGINE, false)).resolves.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('could not verify'),
    });
    expect(t.onProbeFailed).toHaveBeenCalledWith(ENGINE, expect.objectContaining({ message: 'endpoint still running' }));
    const gone = deferred<AcpLeadSupport>();
    const t2 = setup(() => gone.promise);
    const result = t2.preflight(ENGINE, false);
    await vi.waitFor(() => expect(t2.probe).toHaveBeenCalledOnce());
    t2.states.set(ENGINE, 'unavailable');
    gone.reject(new Error('Task engine is unavailable'));
    await expect(result).resolves.toMatchObject({ code: 'PROVIDER_ROUTE_UNAVAILABLE' });
  });

  it('asks the plugin again on every call, so a replaced plugin is judged by what it offers now', async () => {
    let offers: AcpLeadSupport = CAN_LEAD;
    const t = setup(async () => offers);
    await expect(t.preflight(ENGINE, true)).resolves.toBeNull();
    offers = { httpMcp: true, resume: false };
    await expect(t.preflight(ENGINE, true)).resolves.toMatchObject({
      code: 'UNSUPPORTED_CAPABILITY',
      message: expect.stringContaining('cannot reopen this task'),
    });
    expect(t.probe).toHaveBeenCalledTimes(2);
  });
});

// Production entry: revokeAcpLeadIfTeamEnded, the check bootstrapSession (register.ts) runs once a plugin-engine Lead's
// engine is open, before the runtime is wired and marked as hydrated.
// Basis: docs/plans/acp-plugin-bridge.md (a Lead is briefed for its team; ending the team takes its role and briefing out
// of the runtime). disableOrca clears a runtime only once it is published, and the runtime is published after the open.
// Gap: the check on the team covered the database role, not the runtime: a team that ended while the engine opened left
// the runtime holding the closed team's Lead role and briefing for the first ordinary message.
// Minimal failing input: briefed for team A; the Lead has no active team when the open completes.
// Tier: unit (fake team read and revoke).
describe('revokeAcpLeadIfTeamEnded', () => {
  it.each([
    { name: 'keeps the role while the Lead has an active team', hasActiveTeam: true, revoked: false },
    { name: 'takes the role out when the team ended while the engine opened', hasActiveTeam: false, revoked: true },
  ])('$name', async ({ hasActiveTeam, revoked }) => {
    const revokeRole = vi.fn(async () => {});
    await expect(revokeAcpLeadIfTeamEnded({ hasActiveTeam: async () => hasActiveTeam, revokeRole })).resolves.toBe(revoked);
    expect(revokeRole).toHaveBeenCalledTimes(revoked ? 1 : 0);
  });
});
