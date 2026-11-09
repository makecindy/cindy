import { describe, expect, it } from 'vitest';

import {
  decideModelExecution,
  isWithinProject,
  normalizeApproval,
  parseModelExecutionPolicy,
  type ModelExecutionPolicySnapshot,
} from '../model-execution-policy.js';

const NOW = 1_700_000_000_000;

function snapshot(overrides: Partial<ModelExecutionPolicySnapshot> = {}): ModelExecutionPolicySnapshot {
  return {
    version: 1,
    sessionId: 'sess-parent',
    mode: 'development',
    allowedRoutes: [
      { provider: 'omlx', model: 'Qwen', tier: 'local' },
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha', tier: 'paid' },
      { provider: 'openrouter-a3fe858b', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', tier: 'free' },
    ],
    approvals: [],
    issuedAt: NOW,
    ...overrides,
  };
}

describe('parseModelExecutionPolicy', () => {
  it('rejects non-objects and wrong versions (fail-closed)', () => {
    expect(parseModelExecutionPolicy(null)).toBeNull();
    expect(parseModelExecutionPolicy('x')).toBeNull();
    expect(parseModelExecutionPolicy({ ...snapshot(), version: 99 })).toBeNull();
  });

  it('rejects a snapshot with any malformed route or approval', () => {
    expect(parseModelExecutionPolicy({
      ...snapshot(),
      allowedRoutes: [{ provider: 'x', model: 'y', tier: 'expensive' }],
    })).toBeNull();
    expect(parseModelExecutionPolicy({
      ...snapshot(),
      approvals: [{ id: 'a', provider: 'p', model: 'm', scope: 'session', sessionId: 's', grantedBy: 'agent', grantedAt: 1, expiresAt: 2 }],
    })).toBeNull();
  });

  it('round-trips a valid snapshot', () => {
    const parsed = parseModelExecutionPolicy(snapshot());
    expect(parsed?.allowedRoutes).toHaveLength(3);
    expect(parsed?.sessionId).toBe('sess-parent');
  });
});

describe('decideModelExecution', () => {
  it('denies when the snapshot is missing (fail-closed)', () => {
    const decision = decideModelExecution(null, { provider: 'omlx', model: 'Qwen' }, NOW);
    expect(decision.allowed).toBe(false);
  });

  it('allows the parent local route in local-only mode', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'local-only' }),
      { provider: 'omlx', model: 'Qwen' },
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies a free cloud route in local-only mode: free is not authorization', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'local-only' }),
      { provider: 'openrouter-a3fe858b', model: 'nvidia/nemotron-3-ultra-550b-a55b:free' },
      NOW,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('free is not authorization');
  });

  it('denies a non-allow-listed paid route even in development mode', () => {
    const decision = decideModelExecution(
      snapshot(),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
    );
    expect(decision.allowed).toBe(false);
  });

  it('denies an allow-listed paid route outside approved-paid mode', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'development' }),
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' },
      NOW,
    );
    expect(decision.allowed).toBe(false);
  });

  it('allows an allow-listed paid route in approved-paid mode', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'approved-paid' }),
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' },
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });

  it('approves a route covered by an unexpired session-scoped approval', () => {
    const decision = decideModelExecution(
      snapshot({
        approvals: [{
          id: 'appr-1',
          provider: 'openrouter-a3fe858b',
          model: 'deepseek/deepseek-v4-flash',
          scope: 'session',
          sessionId: 'sess-parent',
          grantedBy: 'user',
          grantedAt: NOW - 1000,
          expiresAt: NOW + 60_000,
        }],
      }),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.approvalId).toBe('appr-1');
  });

  it('denies an expired approval and a wrong-session approval', () => {
    const expired = snapshot({
      approvals: [{
        id: 'appr-expired', provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
        scope: 'session', sessionId: 'sess-parent', grantedBy: 'user', grantedAt: NOW - 10_000, expiresAt: NOW - 1,
      }],
    });
    expect(decideModelExecution(expired, { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' }, NOW).allowed).toBe(false);
    const wrongSession = snapshot({
      approvals: [{
        id: 'appr-other', provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
        scope: 'session', sessionId: 'sess-other', grantedBy: 'user', grantedAt: NOW - 1000, expiresAt: NOW + 60_000,
      }],
    });
    expect(decideModelExecution(wrongSession, { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' }, NOW).allowed).toBe(false);
  });

  it('approves a project-scoped approval only inside the project subtree', () => {
    const approval = {
      id: 'appr-proj', provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
      scope: 'project' as const, projectRoot: '/work/proj', grantedBy: 'user' as const,
      grantedAt: NOW - 1000, expiresAt: NOW + 60_000,
    };
    const inside = decideModelExecution(
      snapshot({ projectRoot: '/work/proj/sub', approvals: [approval] }),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
    );
    expect(inside.allowed).toBe(true);
    const outside = decideModelExecution(
      snapshot({ projectRoot: '/work/other', approvals: [approval] }),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
    );
    expect(outside.allowed).toBe(false);
  });

  it('normalizes approvals: agent-granted approvals are invalid', () => {
    expect(normalizeApproval({
      id: 'x', provider: 'p', model: 'm', scope: 'session', sessionId: 's',
      grantedBy: 'agent', grantedAt: 1, expiresAt: 2,
    })).toBeNull();
  });
});

describe('isWithinProject', () => {
  it('matches equal and child roots and rejects prefix-siblings', () => {
    expect(isWithinProject('/a/b', '/a/b')).toBe(true);
    expect(isWithinProject('/a/b/c', '/a/b')).toBe(true);
    expect(isWithinProject('/a/bc', '/a/b')).toBe(false);
  });
});

describe('regression: 2026-11-07 unauthorized DeepSeek incident', () => {
  const incidentSnapshot = snapshot({
    allowedRoutes: [
      { provider: 'omlx', model: 'Qwen', tier: 'local' },
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha', tier: 'paid' },
      { provider: 'openrouter-a3fe858b', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', tier: 'free' },
    ],
  });

  it('blocks a paid non-allow-listed model even though its provider is connected and the model is listed', () => {
    const decision = decideModelExecution(incidentSnapshot, {
      provider: 'openrouter-a3fe858b',
      model: 'deepseek/deepseek-v4-flash',
    }, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('not in this session');
  });

  it('keeps an allow-listed paid route denied outside approved-paid mode', () => {
    expect(decideModelExecution(incidentSnapshot, {
      provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha',
    }, NOW).allowed).toBe(false);
  });

  it('denies the same model id when claimed through a different source provider id', () => {
    const withXd = snapshot({
      allowedRoutes: [{ provider: 'xd', model: 'deepseek/deepseek-v4-flash', tier: 'paid' }],
    });
    const result = decideModelExecution(withXd, {
      provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
    }, NOW);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('not in this session');
  });

  it('a vague user statement (use other models) never becomes an approval by itself', () => {
    expect(incidentSnapshot.approvals).toEqual([]);
    const decision = decideModelExecution(incidentSnapshot, {
      provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
    }, NOW);
    expect(decision.allowed).toBe(false);
    expect(decision.approvalId).toBeUndefined();
  });

  it('local Qwen route does not authorize reaching OpenRouter for the same task', () => {
    const decision = decideModelExecution(snapshot({
      mode: 'local-only',
      allowedRoutes: [{ provider: 'omlx', model: 'Qwen', tier: 'local' }],
    }), { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' }, NOW);
    expect(decision.allowed).toBe(false);
  });
});
