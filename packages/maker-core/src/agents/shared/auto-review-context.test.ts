import { describe, it, expect, vi } from "vitest";
import {
  withAutoReviewContext,
  resolveAutoReviewDecision,
  type AutoReviewDelegate,
  type AutoReviewRequest,
  type AutoReviewDecision,
  type PersonalRequirements,
} from "./auto-review-decision.js";
import { normalizeRuleGroup } from './approval-rules/normalize.js';
const request: AutoReviewRequest = {
  sessionId: "s",
  agentKind: "pi",
  model: "m",
  userIntent: "",
  workspaceRoots: ["/answer"],
  platform: "linux",
  action: { kind: "exec", command: "npm test", cwd: "/answer" },
};
// Unit: exercise the production wrapper around local shortcuts and cached
// reviewer results. Delegation tests cannot express managed publication.
describe('managed rules across ordinary review caches', () => {
  const allowData = (fingerprint = 'allow-1'): PersonalRequirements => ({ fingerprint,
    scope: { ownerId: 'o', executionHostId: 'h', harnesses: ['pi'] },
    groups: [normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'exact-bash:test',
      locator: 'cindy://test', dialectVersion: '1', decisionDomain: 'personal-approval' },
    { ownerId: 'o', executionHostId: 'h', harnesses: ['pi'] }, [{ id: 'a', decision: 'allow', original: 'Bash(npm test)',
      matcher: { kind: 'cc-command', mode: 'exact', pattern: 'npm test' } }])] });
  it('adds managed allow data to review and cache input without changing authorization or user intent', async () => {
    let version = '1';
    const delegate: AutoReviewDelegate = async () => null;
    delegate.prepareRequest = async r => ({ ...r, authorizationContext: { requesterAuthority: 'owner', source: 'direct' } });
    delegate.precheckManagedAction = async () => ({ kind: 'clear', contextKey: 'root', isCurrent: () => true,
      personalRequirements: allowData(version) });
    const evaluate = vi.fn(async (_prepared: AutoReviewRequest): Promise<AutoReviewDecision> => ({ verdict: 'block', reason: 'ordinary block' }));
    expect(await withAutoReviewContext(request, delegate, evaluate)).toMatchObject({ verdict: 'block', reason: 'ordinary block' });
    version = '2';
    await withAutoReviewContext(request, delegate, evaluate);
    const first = evaluate.mock.calls[0]!;
    const second = evaluate.mock.calls[1]!;
    expect(first[0]).toMatchObject({ userIntent: request.userIntent, personalRequirements: { fingerprint: '1' } });
    expect(second[0].personalRequirements?.fingerprint).toBe('2');
  });
  it.each(['remove', 'retire', 'block'] as const)('withdraws managed allow review data on %s without consuming its old authorization hint', async scenario => {
    let qualified = true; let active = true;
    const delegate: AutoReviewDelegate = async () => null;
    delegate.precheckManagedAction = async () => ({ kind: 'clear', contextKey: 'root', isCurrent: () => true,
      personalRequirements: active ? allowData() : undefined });
    const seen: AutoReviewRequest[] = [];
    const evaluate = vi.fn(async (prepared: AutoReviewRequest): Promise<AutoReviewDecision> => {
      seen.push(prepared);
      if (scenario === 'retire') qualified = false; else active = false;
      return { verdict: scenario === 'block' || !prepared.personalRequirements ? 'block' : 'allow', reason: 'ordinary review' };
    });
    expect(await withAutoReviewContext(request, delegate, evaluate, undefined, undefined,
      { isCurrent: () => qualified, captureFallback: () => {} })).toMatchObject({ verdict: 'block' });
    expect(seen[0]?.personalRequirements).toBeDefined();
    if (scenario === 'block') expect(evaluate).toHaveBeenCalledOnce();
    else { expect(evaluate).toHaveBeenCalledTimes(2); expect(seen[1]?.personalRequirements).toBeUndefined(); }
  });
  it('bounds repeat rule changes without releasing a stale allow or replaying review indefinitely', async () => {
    let version = 0;
    const delegate: AutoReviewDelegate = async () => null;
    delegate.precheckManagedAction = async () => ({ kind: 'clear', contextKey: 'root', isCurrent: () => true,
      personalRequirements: allowData(String(version)) });
    const evaluate = vi.fn(async (): Promise<AutoReviewDecision> => { version++; return { verdict: 'allow' }; });
    expect(await withAutoReviewContext(request, delegate, evaluate)).toMatchObject({ verdict: 'block', reason: expect.stringContaining('changed repeatedly') });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it('checks new deny before cached allow and does not cache a removed deny', async () => {
    let denied = false;
    const delegate = Object.assign(async () => null, {
      precheckManagedAction: async () => ({ kind: denied ? 'deny' as const : 'clear' as const,
        contextKey: 'owner-instance', revision: 1, ruleId: 'rule', reason: 'published exact deny', isCurrent: () => true }),
    });
    const cached = vi.fn(async () => resolveAutoReviewDecision(request, delegate, true));
    expect((await withAutoReviewContext(request, delegate, cached)).verdict).toBe('allow');
    denied = true;
    expect(await withAutoReviewContext(request, delegate, cached))
      .toMatchObject({ verdict: 'block', reason: 'published exact deny' });
    expect(cached).toHaveBeenCalledTimes(1);
    denied = false;
    expect((await withAutoReviewContext(request, delegate, cached)).verdict).toBe('allow');
  });
  it('checks publication again after pending reviewer allow', async () => {
    let denied = false;
    const delegate = Object.assign(async () => null, {
      precheckManagedAction: async () => ({ kind: denied ? 'deny' as const : 'clear' as const,
        contextKey: 'owner-instance', revision: 2, ruleId: 'rule', reason: 'new published deny', isCurrent: () => true }),
    });
    expect(await withAutoReviewContext(request, delegate, async () => {
      denied = true; return { verdict: 'allow' };
    })).toMatchObject({ verdict: 'block', reason: 'new published deny' });
  });
  it('discards an old allow after owner or instance changes', async () => {
    let contextKey = 'owner-instance-1';
    const delegate = Object.assign(async () => null, {
      precheckManagedAction: async () => ({ kind: 'clear' as const, contextKey, isCurrent: () => true }),
    });
    expect(await withAutoReviewContext(request, delegate, async () => {
      contextKey = 'owner-instance-2'; return { verdict: 'allow' };
    })).toMatchObject({ verdict: 'ask', unavailable: true });
  });
});
// Unit: builtin proof retirement is not an authority reset. Exercise the
// exported review wrapper with real context/finalization and a retained verdict.
describe('retired builtin contribution', () => {
  it.each(['owner', 'task-row', 'input', 'directory'] as const)(
    'preserves the %s fence when builtin proof retires alongside it', async boundary => {
    let current = true;
    const delegate: AutoReviewDelegate = async () => ({ verdict: 'allow' });
    delegate.prepareRequest = async r => ({ ...r, userIntent: boundary === 'input' && !current ? 'new instruction' : '' });
    delegate.precheckManagedAction = async () => !current && boundary === 'task-row'
      ? { kind: 'unavailable', reason: 'managed-task-changed' }
      : { kind: 'clear', contextKey: 'root', isCurrent: () => true,
          isExecutionCurrent: () => boundary !== 'owner' || current };
    const evaluate = vi.fn(async (): Promise<AutoReviewDecision> => { current = false; return { verdict: 'allow' }; });
    const result = await withAutoReviewContext(request, delegate, evaluate,
      decision => boundary === 'directory' && !current ? { verdict: 'block', reason: 'Directory permissions changed' } : decision,
      undefined, { isCurrent: () => current, captureFallback: () => {} });
    expect(result.verdict).toBe(boundary === 'input' || boundary === 'directory' ? 'block' : 'ask');
    expect(evaluate).toHaveBeenCalledOnce();
  });

  it('uses the original reviewer once when proof retires after returning a managed deny', async () => {
    let qualified = true;
    let fallback!: () => Promise<AutoReviewDecision>;
    const delegate: AutoReviewDelegate = async () => null;
    delegate.precheckManagedAction = async () => ({ kind: 'deny', contextKey: 'root',
      revision: 1, ruleId: 'rule', reason: 'builtin-only deny', isCurrent: () => true, isExecutionCurrent: () => true });
    const evaluate = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'block', reason: 'ordinary reviewer block' }));
    expect(await withAutoReviewContext(request, delegate, evaluate, undefined, undefined,
      { isCurrent: () => qualified, captureFallback: captured => { fallback = captured; } }))
      .toMatchObject({ verdict: 'block', reason: 'builtin-only deny' });
    expect(evaluate).not.toHaveBeenCalled();
    qualified = false;
    expect(await fallback()).toEqual({ verdict: 'block', reason: 'ordinary reviewer block' });
    expect(await fallback()).toEqual({ verdict: 'block', reason: 'ordinary reviewer block' });
    expect(evaluate).toHaveBeenCalledOnce();
  });
});
describe("live review context across decision caches", () => {
  it("rechecks revocation even when an allow decision is already cached", async () => {
    let active = true;
    const delegate: AutoReviewDelegate = async () => ({ verdict: "allow" });
    delegate.prepareRequest = async (r) =>
      active
        ? {
            ...r,
            delegatedTask: {
              source: "approved-plugin",
              pluginId: "p",
              role: "worker",
              task: "Run tests",
              workingDir: "/answer",
              authorizationRevision: "v1",
            },
          }
        : { ...r, authorizationError: "revoked" };
    const evaluate = vi.fn(async (): Promise<AutoReviewDecision> => ({
      verdict: "allow",
    }));
    expect(
      (await withAutoReviewContext(request, delegate, evaluate)).verdict,
    ).toBe("allow");
    active = false;
    expect(
      (await withAutoReviewContext(request, delegate, evaluate)).verdict,
    ).toBe("block");
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  it("rejects a stale allow after user restriction or owner epoch changes during review", async () => {
    let revision = "1";
    const delegate: AutoReviewDelegate = async () => ({ verdict: "allow" });
    delegate.prepareRequest = async (r) => ({
      ...r,
      delegatedTask: {
        source: "approved-plugin",
        pluginId: "p",
        role: "worker",
        task: "Run tests",
        workingDir: "/answer",
        authorizationRevision: revision,
      },
    });
    expect(
      (
        await withAutoReviewContext(request, delegate, async () => {
          revision = "2";
          return { verdict: "allow" };
        })
      ).verdict,
    ).toBe("block");
  });
  it("asks on infrastructure failure without evaluating or using cached authorization", async () => {
    const delegate: AutoReviewDelegate = async () => null;
    delegate.prepareRequest = async () => {
      throw Error("DB changed");
    };
    const evaluate = vi.fn();
    expect(
      await withAutoReviewContext(request, delegate, evaluate),
    ).toMatchObject({ verdict: "ask", unavailable: true });
    expect(evaluate).not.toHaveBeenCalled();
  });
});

it('delegated local edits still review user restrictions instead of using the workspace fast path', async () => {
 const delegate = vi.fn(async ():Promise<AutoReviewDecision> => ({verdict:'block'}));
 const scoped:AutoReviewRequest={...request,userIntent:'Only read; do not modify files',
 delegatedTask:{source:'approved-plugin',pluginId:'eval',role:'worker',task:'Fix project',workingDir:'/answer',authorizationRevision:'1'},
 action:{kind:'file-write',path:'/answer/src/a.ts'}};
 expect((await resolveAutoReviewDecision(scoped,delegate)).verdict).toBe('block');
 expect(delegate).toHaveBeenCalledOnce();
});

it('reviews task-level read restrictions even without separate user text', async () => {
  const delegate = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'block' }));
  const scoped: AutoReviewRequest = { ...request, userIntent: '',
    delegatedTask: { source: 'approved-plugin', pluginId: 'eval', role: 'worker',
      task: 'Inspect src only. Do not read fixtures/private.txt.', workingDir: '/answer', authorizationRevision: '1' },
    action: { kind: 'read', path: '/answer/fixtures/private.txt' } };
  expect((await resolveAutoReviewDecision(scoped, delegate)).verdict).toBe('block');
  expect(delegate).toHaveBeenCalledOnce();
});

it('does not execute a stale allow when the final authority lookup fails', async () => {
  let calls = 0;
  const delegate: AutoReviewDelegate = async () => null;
  delegate.prepareRequest = async r => { if (++calls === 2) throw Error('storage offline'); return r; };
  expect(await withAutoReviewContext(request, delegate, async () => ({verdict: 'allow'})))
    .toMatchObject({verdict: 'ask', unavailable: true});
});

it.each([false, true])('non-Auto Host shortcut never invokes a model (delegated=%s)', async delegated => {
  const delegate = vi.fn(async (): Promise<AutoReviewDecision> => ({ verdict: 'allow' }));
  const prepared: AutoReviewRequest = delegated ? { ...request, delegatedTask: {
    source: 'approved-plugin', pluginId: 'eval', role: 'worker', task: 'Run tests',
    workingDir: '/answer', authorizationRevision: '1',
  } } : request;
  expect((await resolveAutoReviewDecision(prepared, delegate, true, true)).verdict)
    .toBe(delegated ? 'ask' : 'allow');
  expect(delegate).not.toHaveBeenCalled();
});
