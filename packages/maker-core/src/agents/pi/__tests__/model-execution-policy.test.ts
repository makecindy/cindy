import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  approvalSpendKey,
  decideModelExecution,
  isWithinProject,
  normalizeApproval,
  parseAndVerifyExecutionPolicy,
  parseModelExecutionPolicy,
  signExecutionPolicySnapshot,
  type ModelExecutionPolicySnapshot,
} from '../model-execution-policy.js';

const NOW = 1_700_000_000_000;
const KEY = Buffer.alloc(32, 7);

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

  it('rejects a malformed signature', () => {
    expect(parseModelExecutionPolicy({ ...snapshot(), signature: 'xyz' })).toBeNull();
  });

  it('rejects a snapshot with non-positive issuedAt', () => {
    expect(parseModelExecutionPolicy({ ...snapshot(), issuedAt: 0 })).toBeNull();
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

describe('approval fallthrough for allow-listed paid routes (P1-4)', () => {
  const approval = {
    id: 'appr-paid', provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha',
    scope: 'session' as const, sessionId: 'sess-parent', grantedBy: 'user' as const,
    grantedAt: NOW - 1000, expiresAt: NOW + 60_000,
  };

  it('lets a live approval run an allow-listed paid route in development mode', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'development', approvals: [approval] }),
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' },
      NOW,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.allowed && decision.approvalId).toBe('appr-paid');
  });

  it('still denies the same route in local-only mode without an approval', () => {
    const decision = decideModelExecution(
      snapshot({ mode: 'local-only' }),
      { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' },
      NOW,
    );
    expect(decision.allowed).toBe(false);
  });
});

describe('approval spend cap (P1-7)', () => {
  const approval = {
    id: 'appr-capped', provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash',
    scope: 'session' as const, sessionId: 'sess-parent', grantedBy: 'user' as const,
    grantedAt: NOW - 1000, expiresAt: NOW + 60_000, maxCostUsd: 5,
  };

  it('allows while accumulated spend is under the cap', () => {
    const decision = decideModelExecution(
      snapshot({ approvals: [approval] }),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
      () => 4.99,
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies once accumulated spend reaches the cap', () => {
    const decision = decideModelExecution(
      snapshot({ approvals: [approval] }),
      { provider: 'openrouter-a3fe858b', model: 'deepseek/deepseek-v4-flash' },
      NOW,
      () => 5,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('spend cap');
  });

  it('approvalSpendKey is stable across Host accumulation and checker lookup', () => {
    const snap = snapshot({ approvals: [approval] });
    expect(approvalSpendKey(approval, snap)).toBe('session:sess-parent');
    const projectApproval = {
      ...approval, scope: 'project' as const, sessionId: undefined, projectRoot: '/work/proj',
    };
    expect(approvalSpendKey(projectApproval, snap)).toBe('project:/work/proj');
  });
});

describe('source attribution matching (P1-5)', () => {
  it('requires both sides to agree on the source when the entry declares one', () => {
    const snap = snapshot({
      mode: 'approved-paid',
      allowedRoutes: [{ provider: 'openai-codex', model: 'gpt-5.4', sourceProviderId: 'openai', tier: 'paid' }],
    });
    expect(decideModelExecution(snap, {
      provider: 'openai-codex', model: 'gpt-5.4', sourceProviderId: 'openai',
    }, NOW).allowed).toBe(true);
    // 来源不匹配(网关伪造/自称其它供应商)一律拒绝。
    expect(decideModelExecution(snap, {
      provider: 'openai-codex', model: 'gpt-5.4', sourceProviderId: 'other',
    }, NOW).allowed).toBe(false);
  });

  it('treats a missing requested source as the provider itself (no wildcard pass)', () => {
    const snap = snapshot({
      mode: 'approved-paid',
      allowedRoutes: [{ provider: 'openai-codex', model: 'gpt-5.4', sourceProviderId: 'openai', tier: 'paid' }],
    });
    expect(decideModelExecution(snap, {
      provider: 'openai-codex', model: 'gpt-5.4',
    }, NOW).allowed).toBe(false);
  });

  it('matches when both sides omit the source (defaults to the provider id)', () => {
    const snap = snapshot({
      allowedRoutes: [{ provider: 'omlx', model: 'Qwen', tier: 'local' }],
    });
    expect(decideModelExecution(snap, { provider: 'omlx', model: 'Qwen' }, NOW).allowed).toBe(true);
  });
});

describe('isWithinProject', () => {
  it('matches equal and child roots and rejects prefix-siblings', () => {
    expect(isWithinProject('/a/b', '/a/b')).toBe(true);
    expect(isWithinProject('/a/b/c', '/a/b')).toBe(true);
    expect(isWithinProject('/a/bc', '/a/b')).toBe(false);
  });
});

describe('snapshot signature (P1-8)', () => {
  function signed(overrides: Partial<ModelExecutionPolicySnapshot> = {}) {
    const snap = snapshot(overrides);
    return { ...snap, signature: signExecutionPolicySnapshot(snap, KEY) };
  }

  it('round-trips: signed snapshot verifies for the bound session', () => {
    expect(parseAndVerifyExecutionPolicy(signed(), KEY, 'sess-parent', NOW)?.sessionId).toBe('sess-parent');
  });

  it('rejects a tampered snapshot even with a syntactically valid signature', () => {
    const tampered = { ...signed(), mode: 'approved-paid' as const };
    expect(parseAndVerifyExecutionPolicy(tampered, KEY, 'sess-parent', NOW)).toBeNull();
  });

  it('rejects an unsigned snapshot', () => {
    expect(parseAndVerifyExecutionPolicy(snapshot(), KEY, 'sess-parent', NOW)).toBeNull();
  });

  it('rejects a snapshot replayed into a different session', () => {
    expect(parseAndVerifyExecutionPolicy(signed(), KEY, 'sess-other', NOW)).toBeNull();
  });

  it('rejects a stale snapshot beyond 24h', () => {
    const stale = signed({ issuedAt: NOW - 25 * 60 * 60 * 1000 });
    expect(parseAndVerifyExecutionPolicy(stale, KEY, 'sess-parent', NOW)).toBeNull();
  });

  it('rejects verification with a different key', () => {
    expect(parseAndVerifyExecutionPolicy(signed(), Buffer.alloc(32, 9), 'sess-parent', NOW)).toBeNull();
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

  it('free provider-declared Crouton Alpha executes in development (P0-1 regression)', () => {
    // P0-1:旧 classifyTier 只认 :free 后缀,把免费 Crouton Alpha 误判 paid。
    // Host 现在按 provider 声明的零价格分级(tier=free),免费 Crouton 在开发模式下
    // 合法执行;local-only 下仍拒绝(免费≠授权)。
    const croutonFree = snapshot({
      allowedRoutes: [{ provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha', tier: 'free' }],
    });
    expect(decideModelExecution(croutonFree, {
      provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha',
    }, NOW).allowed).toBe(true);
    expect(decideModelExecution(snapshot({
      mode: 'local-only',
      allowedRoutes: [{ provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha', tier: 'free' }],
    }), {
      provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha',
    }, NOW).allowed).toBe(false);
  });

  it('lan local Qwen executes in local-only mode (P0-2 regression)', () => {
    // P0-2:oMLX 在本机网卡地址上运行,Host 判定为 local(经验证的本地端点)。
    const snapshotLocal = snapshot({
      mode: 'local-only',
      allowedRoutes: [{ provider: 'omlx', model: 'Qwen', tier: 'local' }],
    });
    expect(decideModelExecution(snapshotLocal, { provider: 'omlx', model: 'Qwen' }, NOW).allowed).toBe(true);
  });

  it('local Qwen route does not authorize reaching OpenRouter for the same task', () => {
    const decision = decideModelExecution(snapshot({
      mode: 'local-only',
      allowedRoutes: [{ provider: 'omlx', model: 'Qwen', tier: 'local' }],
    }), { provider: 'openrouter-a3fe858b', model: 'stealth/crouton-alpha' }, NOW);
    expect(decision.allowed).toBe(false);
  });
});
