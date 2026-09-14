import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createPendingAgentSwitchRegistry } from '../maker-ipc/sessionAgentSwitchHandler';

const source = readFileSync(new URL('../maker-ipc/register.ts', import.meta.url), 'utf8');
const guard = source.slice(
  source.indexOf('  const canApplyAutomaticRuntimeSelection ='),
  source.indexOf('  cancelPendingAgentSwitchHolder ='),
);
const fallback = source.slice(
  source.indexOf('  const maybeApplySessionRuntimeFallback = async ('),
  source.indexOf('  const sessionControlService = createSessionControlService({'),
);

function harness() {
  const pending = createPendingAgentSwitchRegistry();
  let generation = 0;
  const current = { agentKind: 'codex', model: 'current', providerId: 'openai', effort: 'high', fastMode: false };
  const candidate = { ...current, agentKind: 'claude-code', model: 'fallback' };
  const readCandidate = vi.fn(async () => ({ isBot: true, candidate }));
  const switchAgent = vi.fn(async () => ({ switched: true }));
  const accept = vi.fn();
  const withLock = vi.fn(async (_id: string, task: () => Promise<unknown>) => task());
  const deps = {
    agentSwitchPending: pending,
    sessionRuntimeGenerationMatches: (_id: string, expected?: number) => expected === undefined || expected === generation,
    captureSessionRuntimeControlOwnerEpoch: () => 'owner',
    sessionRuntimeControlOwnerEpochMatches: () => true,
    readSessionRuntimeProfiles: async () => ({ effective: current, control: { generation, pending: null } }),
    readBotFallbackCandidate: readCandidate,
    maker: { getSession: () => current },
    pendingSessionRuntimeFallbackRebuilds: new WeakMap(),
    withSendToSessionLock: withLock,
    performSessionAgentSwitch: switchAgent,
    agentSwitchDeps: {},
    acceptSessionRuntimeMutation: accept,
    log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  };
  const js = transpileModule(`${guard}\n${fallback}\nreturn { run: maybeApplySessionRuntimeFallback, allowed: canApplyAutomaticRuntimeSelection };`, {
    compilerOptions: { target: ScriptTarget.ES2022 },
  }).outputText;
  const runtime = new Function(...Object.keys(deps), js)(...Object.values(deps));
  const pick = () => {
    pending.set('session', { sameAgentSelection: true, targetAgentKind: 'codex', model: 'chosen', providerId: 'xd' });
    generation += 1;
  };
  return { ...runtime, pending, pick, readCandidate, switchAgent, accept, withLock, generation: () => generation };
}

describe('automatic runtime selection respects the user send boundary', () => {
  it('rejects a new automatic request even when it read the generation after the user selected', async () => {
    const h = harness();
    h.pick();
    expect(h.allowed('session', h.generation())).toBe(false);
    await h.run('session', 2, 1);
    expect(h.readCandidate).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('rechecks a user selection that arrived while fallback waited for the route lock', async () => {
    const h = harness();
    h.withLock.mockImplementationOnce(async (_id: string, task: () => Promise<unknown>) => {
      h.pick();
      return task();
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('rejects stale work after the user selection has been cleared', () => {
    const h = harness();
    const observed = h.generation();
    h.pick();
    h.pending.clear('session');
    expect(h.allowed('session', observed)).toBe(false);
    expect(h.allowed('session', h.generation())).toBe(true);
  });

  it('retains a selection accepted before candidate lookup fails', async () => {
    const h = harness();
    h.readCandidate.mockImplementationOnce(async () => {
      h.pick();
      throw new Error('candidate lookup failed');
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).not.toHaveBeenCalled();
    expect(h.accept).not.toHaveBeenCalled();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('commits an uncontested fallback inside the existing route lock', async () => {
    const h = harness();
    h.withLock.mockImplementationOnce(async (_id: string, task: () => Promise<unknown>) => {
      const result = await task();
      expect(h.accept).toHaveBeenCalledTimes(1);
      return result;
    });
    await h.run('session', 2, 1);
    expect(h.switchAgent).toHaveBeenCalledTimes(1);
    h.pick();
    expect(h.pending.get('session')?.model).toBe('chosen');
  });

  it('uses the same guard before every automatic same-engine mutation can write or reconcile', () => {
    const start = source.indexOf('  const handleSetModel = async (');
    const body = source.slice(start, source.indexOf('      const routeExplicit =', start));
    expect(body).toMatch(/internalOptions.source !== 'user' &&\s*!canApplyAutomaticRuntimeSelection\(sessionId, internalOptions.expectedGeneration\)/);
    expect(body).toContain('return { deferred: false, superseded: true };');
  });
});
