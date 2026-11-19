import { describe, expect, it, vi } from 'vitest';

import {
  USAGE_LIMIT_ACCOUNT_SWITCH_DELAY_MS,
  USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES,
  USAGE_LIMIT_RESUME_BUFFER_MS,
  UsageLimitAutoResume,
  isAccountUsageLimitError,
  type UsageLimitAutoResumeDeps,
} from '../usageLimitAutoResume';
import { readTurnUsageResetAt } from '../../goal-host/usageLimit';
import { USAGE_LIMIT_RESET_AUTO_RESUME_REASON } from '../../../shared/agentInputQueue';
import type { ProviderView } from '@cindy/model-providers';
import { resolveSessionUsageReset, type SessionUsageRoute, type SessionUsageResetDeps } from '../sessionUsageReset';
import { createAutomaticContinueEligibility } from '../automaticContinueEligibility';

const NOW = 1_000_000;
const RESET_AT = NOW + 60 * 60 * 1000;
const LIMIT = { sdkError: 'rate_limit', message: "You've hit your session limit" };

function remoteResetHarness() {
  const provider = { id: 'remote-claude', auth: { method: 'oauth', native: 'claude' }, connected: true,
    agents: ['claude-code'], models: { 'claude-code': [{ id: 'claude-opus-5-5' }] }, routing: { 'claude-code': {} },
  } as ProviderView;
  const route: SessionUsageRoute = { agentKind: 'claude-code', providerId: null, modelId: 'claude-opus-5-5',
    agentDeviceId: 'target', remoteHostId: null, sdkSessionId: 'native-1' };
  let owner = 'owner';
  const deps = {
    now: () => NOW, scopeKey: () => owner, localFamilyOf: vi.fn<SessionUsageResetDeps['localFamilyOf']>(() => null),
    readRemoteProviders: vi.fn(async () => [provider]),
    readLocalLimit: vi.fn(async () => ({ limited: true, resetAtMs: RESET_AT + 9999 })),
    readRemoteLimit: vi.fn<SessionUsageResetDeps['readRemoteLimit']>(async () => ({ limited: true, resetAtMs: RESET_AT })),
    unavailable: vi.fn(),
  } satisfies SessionUsageResetDeps;
  return { provider, route, deps, changeOwner: () => { owner = 'new-owner'; } };
}

// Unit regression: real eligibility + quota timer. Existing tests stubbed eligibility,
// missing a remote companion's real Schedule run. Ordinary wakes have no quota owner.
describe('remote companion scheduled quota wait', () => {
  it.each(['resume', 'pause', 'takeover', 'shared', 'owner', 'local', 'no-run'] as const)('%s', async action => {
    let paused = false; let owns = action !== 'no-run'; let shared = false; let owner = 'a';
    const eligibility = createAutomaticContinueEligibility({
      ownerEpoch: () => owner, isPaused: () => paused,
      readSession: async () => ({ source: 'bot', status: 'active', agentDeviceId: action === 'local' ? null : 'remote' }),
      isShared: () => shared, goalOwnsRecovery: async () => false,
      readCompanion: async () => ({ role: 'canonical', profileStatus: 'active', hiddenAt: null, shadowed: false }),
      ownsCompanionInput: () => false, ownsScheduledQuotaInput: () => owns,
    });
    const h = harness({ isEligible: eligibility.usageLimit });
    expect(await h.guard.onTurnError('s', LIMIT)).toBe(action !== 'local' && action !== 'no-run');
    if (action === 'local' || action === 'no-run') { expect(h.timers).toHaveLength(0); return; }
    if (action === 'pause') paused = true;
    if (action === 'takeover') owns = false;
    if (action === 'shared') shared = true;
    if (action === 'owner') { owner = 'b'; owns = false; }
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledTimes(action === 'resume' ? 1 : 0);
    expect(await eligibility.providerGroup('s', { kind: 'before-send', clientId: 'retry', scheduled: true }))
      .toBe(action === 'resume');
  });
});

function harness(overrides: Partial<UsageLimitAutoResumeDeps> = {}) {
  const timers: Array<{ fn: () => void; delayMs: number; cleared: boolean }> = [];
  let tokenSeq = 0;
  const current = new Set<number>();
  // coordinator 在终态错误时下发候选令牌;测试里每次 onTurnError 用新令牌。
  const nextCandidate = () => ++tokenSeq;
  const deps: UsageLimitAutoResumeDeps = {
    now: () => NOW,
    random: () => 0,
    setTimer: (fn, delayMs) => {
      const timer = { fn, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    isEligible: vi.fn(async () => true),
    resolveResetAt: vi.fn(async () => RESET_AT),
    arm: vi.fn((_sessionId: string, token: number) => {
      current.add(token);
      return true;
    }),
    isCurrent: (_sessionId, token) => current.has(token),
    cancel: vi.fn((_sessionId: string, token: number) => {
      current.delete(token);
    }),
    continueSession: vi.fn(async () => 'resumed' as const),
    log: () => {},
    ...overrides,
  };
  const raw = new UsageLimitAutoResume(deps);
  // 测试里省掉候选令牌参数:每次报错自动取一个新令牌。
  const guard = Object.assign(raw, {
    onTurnError: (sessionId: string, signals: Parameters<UsageLimitAutoResume['onTurnError']>[1]) =>
      UsageLimitAutoResume.prototype.onTurnError.call(raw, sessionId, signals, nextCandidate()),
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fireLast = async () => {
    const timer = timers.at(-1)!;
    expect(timer.cleared).toBe(false);
    timer.fn();
    await flush();
  };
  return { guard, deps, timers, current, flush, fireLast };
}

describe('isAccountUsageLimitError', () => {
  it('accepts account limits and rejects overload or unrelated errors', () => {
    expect(isAccountUsageLimitError(LIMIT)).toBe(true);
    expect(isAccountUsageLimitError({ codexErrorInfo: 'usageLimitExceeded', message: 'x' })).toBe(true);
    expect(isAccountUsageLimitError({ errorStatus: 529, message: 'overloaded_error' })).toBe(false);
    expect(isAccountUsageLimitError({ sdkError: 'billing_error', message: 'credit balance too low' })).toBe(false);
    expect(isAccountUsageLimitError({ sdkError: 'billing_error', message: 'quota exceeded' })).toBe(false);
    expect(isAccountUsageLimitError({ errorStatus: 429, message: 'insufficient_quota' })).toBe(false);
    expect(isAccountUsageLimitError({ message: 'Connection closed mid-response' })).toBe(false);
  });
});

describe('UsageLimitAutoResume', () => {
  // #11088, unit: exercise the production reset resolver and timer together.
  // Old timer coverage injected a deadline, bypassing remote implicit identity.
  it('waits and resumes a remote implicit Claude route using its target account', async () => {
    const { route, provider, deps: resetDeps } = remoteResetHarness();
    const h = harness({ resolveResetAt: (_id, signals) => resolveSessionUsageReset(route, signals, resetDeps) });
    expect(await h.guard.onTurnError('remote-implicit', LIMIT)).toBe(true);
    expect(resetDeps.readRemoteLimit).toHaveBeenCalledWith({ ...route, providerId: provider.id }, 'claude');
    expect(resetDeps.readLocalLimit).not.toHaveBeenCalled();
    expect(h.deps.arm).toHaveBeenCalledWith('remote-implicit', 1, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it.each(['structured', 'zoned-text', 'bare-clock', 'unknown'] as const)(
    'uses only trustworthy remote reset hints: %s', async (kind) => {
      const { route, deps } = remoteResetHarness();
      deps.now = () => Date.parse('2026-11-17T10:00:00Z');
      const reset = Date.parse('2026-11-17T11:00:00Z');
      deps.readRemoteLimit.mockResolvedValue(null);
      const signals = kind === 'structured' ? { ...LIMIT, usageResetAt: reset }
        : { ...LIMIT, message: kind === 'zoned-text' ? "You've hit your limit · resets 7pm (Asia/Shanghai)"
          : kind === 'bare-clock' ? "You've hit your limit · resets 7pm" : LIMIT.message };
      expect(await resolveSessionUsageReset(route, signals, deps)).toBe(
        kind === 'structured' || kind === 'zoned-text' ? reset : null,
      );
      expect(deps.readLocalLimit).not.toHaveBeenCalled();
      if (kind === 'structured') expect(deps.readRemoteLimit).not.toHaveBeenCalled();
    },
  );

  it.each(['gateway', 'missing', 'unavailable', 'owner-changed', 'same-id-local-subscription'] as const)(
    'does not acquire local subscription semantics for a remote %s', async (kind) => {
      const h = remoteResetHarness();
      h.deps.localFamilyOf.mockReturnValue('claude');
      if (kind === 'gateway' || kind === 'same-id-local-subscription') h.provider.auth = { method: 'apiKey' };
      if (kind === 'same-id-local-subscription') h.route.providerId = h.provider.id;
      if (kind === 'missing') h.deps.readRemoteProviders.mockResolvedValue([]);
      if (kind === 'unavailable') h.deps.readRemoteProviders.mockRejectedValue(new Error('offline'));
      if (kind === 'owner-changed') h.deps.readRemoteProviders.mockImplementation(async () => { h.changeOwner(); return [h.provider]; });
      expect(await resolveSessionUsageReset(h.route, { ...LIMIT, usageResetAt: RESET_AT }, h.deps)).toBeNull();
      expect(h.deps.readLocalLimit).not.toHaveBeenCalled();
      expect(h.deps.readRemoteLimit).not.toHaveBeenCalled();
    },
  );

  it('retains explicit remote builtin hints offline and never queries local quota for SSH', async () => {
    const h = remoteResetHarness();
    h.route.providerId = 'anthropic';
    expect(await resolveSessionUsageReset(h.route, { ...LIMIT, usageResetAt: RESET_AT }, h.deps)).toBe(RESET_AT);
    expect(h.deps.readRemoteProviders).not.toHaveBeenCalled();
    h.route.remoteHostId = 'ssh';
    h.deps.localFamilyOf.mockReturnValue('claude');
    expect(await resolveSessionUsageReset(h.route, LIMIT, h.deps)).toBeNull();
    expect(h.deps.readLocalLimit).not.toHaveBeenCalled();
    expect(h.deps.readRemoteLimit).not.toHaveBeenCalled();
  });

  // Review #11092: auth.native can also describe an API-key route. Exercise the
  // real resolver + timer; a reset hint must not turn such a route into a subscription.
  it.each([
    { method: 'apiKey', access: 'api' },
    { method: 'apiKey', access: 'subscription' },
    { method: 'oauth', access: 'api' },
    { method: 'oauth', access: 'subscription' },
  ] as const)('checks auth and access before scheduling $method/$access native routes', async ({ method, access }) => {
    const reset = remoteResetHarness();
    reset.provider.auth = { method, native: 'codex' };
    reset.provider.access = access === 'subscription' ? { kind: access, product: 'ChatGPT' } : { kind: access };
    const h = harness({ resolveResetAt: (_id, signals) => resolveSessionUsageReset(reset.route, signals, reset.deps) });
    const subscription = method === 'oauth' && access === 'subscription';
    expect(await h.guard.onTurnError('remote-auth', { ...LIMIT, usageResetAt: RESET_AT })).toBe(subscription);
    expect(h.timers).toHaveLength(subscription ? 1 : 0);
    expect(reset.deps.readRemoteLimit).not.toHaveBeenCalled();
    expect(reset.deps.readLocalLimit).not.toHaveBeenCalled();
  });

  it.each(['stop', 'new-input'] as const)('discards remote directory results after %s', async (action) => {
    const reset = remoteResetHarness();
    let finish!: (views: ProviderView[]) => void;
    reset.deps.readRemoteProviders.mockReturnValue(new Promise(r => { finish = r; }));
    const h = harness({ resolveResetAt: (_id, signals) => resolveSessionUsageReset(reset.route, signals, reset.deps) });
    const pending = h.guard.onTurnError('remote-implicit', LIMIT);
    await Promise.resolve();
    if (action === 'stop') h.guard.noteSessionClosed('remote-implicit');
    else h.guard.noteUserAction('remote-implicit');
    finish([reset.provider]);
    await pending;
    expect(h.deps.arm).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
  });

  // Unit regression: real classifier + reset parser + timer. Earlier cases supplied
  // sdkError; text-only Claude limits never armed automatic continuation.
  it('schedules and continues a text-only five-hour limit at the stated reset time', async () => {
    const now = Date.parse('2026-11-11T10:00:00Z');
    const resumeAt = Date.parse('2026-11-11T13:30:00Z') + USAGE_LIMIT_RESUME_BUFFER_MS;
    const h = harness({ now: () => now, resolveResetAt: async (_id, signals) => readTurnUsageResetAt(signals, now) });
    expect(await h.guard.onTurnError('five-hour', {
      message: "You've hit your 5-hour limit · resets 2:30am (Pacific/Auckland)",
    })).toBe(true);
    expect(h.deps.arm).toHaveBeenCalledWith('five-hour', 1, resumeAt);
    expect(h.timers.at(-1)?.delayMs).toBe(resumeAt - now);
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  // Unit: real quota classifier + timer callback, using the Fable SDK envelope.
  // No wall-clock wait or model request; normal errors previously used generic text.
  it('waits for the structured Fable deadline and continues once when its timer fires', async () => {
    const h = harness({ resolveResetAt: async (_id, signals) => readTurnUsageResetAt(signals, NOW) });
    await h.guard.onTurnError('fable', {
      sdkError: 'rate_limit', usageResetAt: RESET_AT,
      message: "You've reached your Fable limit. Switch to another model to continue.",
    });
    expect(h.deps.arm).toHaveBeenCalledWith('fable', 1, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    expect(h.timers.at(-1)?.delayMs).toBe(RESET_AT - NOW + USAGE_LIMIT_RESUME_BUFFER_MS);
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it('restores the saved deadline and attempt budget; overdue startup waits buffer once', async () => {
    const h = harness();
    expect(h.guard.restore('restarted', 42, RESET_AT, 2)).toBe(true);
    expect(h.timers.at(-1)?.delayMs).toBe(RESET_AT - NOW);
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledWith('restarted', 42, expect.objectContaining({ attempt: 3 }));
    expect(h.guard.restore('overdue', 43, NOW - 1, 0)).toBe(true);
    expect(h.timers.at(-1)?.delayMs).toBe(USAGE_LIMIT_RESUME_BUFFER_MS);
    h.guard.suspend();
    expect(h.timers.at(-1)?.cleared).toBe(true);
    expect(h.guard.restore('capped', 44, RESET_AT, 3)).toBe(false);
  });

  it('does not arm a timer when persistence fails or cancellation wins the save', async () => {
    const failed = harness({ saveWait: async () => { throw new Error('disk full'); } });
    await failed.guard.onTurnError('s1', LIMIT);
    expect(failed.timers).toHaveLength(0);
    expect(failed.deps.cancel).toHaveBeenCalledWith('s1', 1);
    let release!: (saved: boolean) => void;
    const h = harness({ saveWait: () => new Promise(resolve => { release = resolve; }) });
    const scheduling = h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    h.current.clear(); h.guard.noteUserAction('s1'); release(true);
    await scheduling;
    expect(h.timers).toHaveLength(0);
  });

  it('waits for scheduler capacity without consuming quota retries or spinning on restored quota', async () => {
    let available = false;
    const h = harness({ continueSession: vi.fn(async () => available ? 'resumed' : 'capacity-wait') });
    h.guard.onTurnError('scheduled', LIMIT);
    await h.flush();
    await h.guard.resumeRestored(async () => true);
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
    expect(h.timers.at(-1)?.delayMs).toBe(USAGE_LIMIT_RESUME_BUFFER_MS);
    for (let index = 0; index < USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES; index++) await h.fireLast();
    available = true;
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenLastCalledWith('scheduled', 1, expect.objectContaining({ attempt: 1 }));
    expect(h.deps.cancel).not.toHaveBeenCalled();
  });

  it('reports unarmed waits so their scheduler run can settle', async () => {
    const h = harness({ resolveResetAt: async () => null });
    await expect(UsageLimitAutoResume.prototype.onTurnError.call(h.guard, 'scheduled', LIMIT, 42)).resolves.toBe(false);
    expect(h.deps.cancel).toHaveBeenCalledWith('scheduled', 42);
    expect(h.timers).toHaveLength(0);
  });

  // Unit regression: a failed disk write while capacity is full must not leave a dead countdown.
  it('cancels the wait if persisting a capacity deferral fails', async () => {
    const saveWait = vi.fn(async () => true);
    const h = harness({ saveWait, continueSession: vi.fn(async () => 'capacity-wait' as const) });
    await h.guard.onTurnError('scheduled', LIMIT);
    saveWait.mockRejectedValueOnce(new Error('disk full'));
    await h.fireLast();
    expect(h.deps.cancel).toHaveBeenCalledWith('scheduled', 1);
    expect(h.timers).toHaveLength(1);
    expect(h.current.size).toBe(0);
  });
  // Unit regression: a pending group switch can still have the previous local route saved.
  // Resetting that local account must not wake the group's wait or consume its retry budget.
  it('keeps a group quota wait until its timer even when the old account resets', async () => {
    const h = harness();
    h.guard.onTurnError('group', { usageLimit: true, providerGroupUsageLimit: { resetAtMs: RESET_AT } });
    await h.flush();
    const matches = vi.fn(async () => true);
    await h.guard.resumeRestored(matches);
    expect(matches).not.toHaveBeenCalled();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it('resumes only matching armed waits after a reset and respects user cancellation', async () => {
    const h = harness();
    h.guard.onTurnError('matching', LIMIT); h.guard.onTurnError('other', LIMIT);
    await h.flush();
    await h.guard.resumeRestored(async id => id === 'matching');
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
    expect(vi.mocked(h.deps.continueSession).mock.calls[0][0]).toBe('matching');
    h.current.clear();
    await h.guard.resumeRestored(async () => true);
    expect(h.deps.continueSession).toHaveBeenCalledOnce();
  });

  it('arms a wait after the reset plus buffer and continues the session when it fires', async () => {
    const h = harness();
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();

    expect(h.deps.arm).toHaveBeenCalledWith('s1', 1, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].delayMs).toBe(RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS - NOW);

    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledWith('s1', 1, {
      reason: USAGE_LIMIT_RESET_AUTO_RESUME_REASON,
      attempt: 1,
      maxAttempts: USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES,
      sessionTotal: 0,
    });
  });

  // Unit, 2026-11-11: another account of the same provider can take the task now (provider group
  // §6.1 switches at once). Minimal input: an account limit with a switchable pool; then a group-verified
  // limit, which already covers every member and keeps waiting for the reset.
  it('continues almost at once when another subscription account can take the task', async () => {
    const h = harness({ canSwitchAccount: vi.fn(async () => true) });
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    expect(h.deps.resolveResetAt).not.toHaveBeenCalled();
    expect(h.deps.arm).toHaveBeenCalledWith('s1', 1, NOW + USAGE_LIMIT_ACCOUNT_SWITCH_DELAY_MS);
    await h.fireLast();
    expect(h.deps.continueSession).toHaveBeenCalledTimes(1);

    const group = harness({ canSwitchAccount: vi.fn(async () => true) });
    group.guard.onTurnError('s1', { ...LIMIT, providerGroupUsageLimit: { resetAtMs: RESET_AT } });
    await group.flush();
    expect(group.deps.canSwitchAccount).not.toHaveBeenCalled();
    expect(group.deps.arm).toHaveBeenCalledWith('s1', 1, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);
  });

  it('does not wait without a usable reset time or for an ineligible session', async () => {
    const noReset = harness({ resolveResetAt: vi.fn(async () => null) });
    noReset.guard.onTurnError('s1', LIMIT);
    await noReset.flush();
    expect(noReset.deps.arm).not.toHaveBeenCalled();

    const tooFar = harness({ resolveResetAt: vi.fn(async () => NOW + 30 * 24 * 60 * 60 * 1000) });
    tooFar.guard.onTurnError('s1', LIMIT);
    await tooFar.flush();
    expect(tooFar.deps.arm).not.toHaveBeenCalled();

    const goal = harness({ isEligible: vi.fn(async () => false) });
    goal.guard.onTurnError('s1', LIMIT);
    await goal.flush();
    expect(goal.deps.resolveResetAt).not.toHaveBeenCalled();
    expect(goal.deps.arm).not.toHaveBeenCalled();

    const other = harness();
    other.guard.onTurnError('s1', { message: 'Connection closed mid-response' });
    await other.flush();
    expect(other.deps.isEligible).not.toHaveBeenCalled();
  });

  it('skips the continuation when the user already took over', async () => {
    const h = harness();
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    h.current.clear(); // coordinator 侧 recovery 已被用户动作替换
    await h.fireLast();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
  });

  it('re-checks eligibility when the timer fires (e.g. Goal started meanwhile)', async () => {
    const isEligible = vi.fn(async () => true);
    const h = harness({ isEligible });
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    isEligible.mockResolvedValue(false);
    await h.fireLast();
    expect(h.deps.continueSession).not.toHaveBeenCalled();
    // 放弃时撤掉横幅上的自动继续提示。
    expect(h.deps.cancel).toHaveBeenCalledWith('s1', 1);
  });

  it('withdraws the wait when the continuation does not start', async () => {
    for (const continueSession of [
      vi.fn(async () => 'no-progress' as const),
      vi.fn(async () => {
        throw new Error('db read failed');
      }),
    ]) {
      const h = harness({ continueSession });
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      await h.fireLast();
      expect(h.deps.cancel).toHaveBeenCalledWith('s1', 1);
    }
    const ok = harness();
    ok.guard.onTurnError('s1', LIMIT);
    await ok.flush();
    await ok.fireLast();
    expect(ok.deps.cancel).not.toHaveBeenCalled();
  });

  it('stops after the consecutive cap until progress or a human action resets it', async () => {
    const h = harness();
    for (let i = 0; i < USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES; i += 1) {
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      await h.fireLast();
    }
    expect(h.deps.continueSession).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES);

    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES);

    h.guard.noteProgress('s1');
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(USAGE_LIMIT_MAX_CONSECUTIVE_RESUMES + 1);
  });

  it('drops a stale resolution when a newer error arrives, and clears timers on user action', async () => {
    let release!: (value: number) => void;
    const first = new Promise<number>((resolve) => { release = resolve; });
    const resolveResetAt = vi
      .fn<UsageLimitAutoResumeDeps['resolveResetAt']>()
      .mockReturnValueOnce(first)
      .mockResolvedValue(RESET_AT);
    const h = harness({ resolveResetAt });
    h.guard.onTurnError('s1', LIMIT);
    h.guard.onTurnError('s1', LIMIT);
    await h.flush();
    release(RESET_AT + 999);
    await h.flush();
    expect(h.deps.arm).toHaveBeenCalledTimes(1);
    expect(h.deps.arm).toHaveBeenCalledWith('s1', 2, RESET_AT + USAGE_LIMIT_RESUME_BUFFER_MS);

    h.guard.noteUserAction('s1');
    expect(h.timers.at(-1)!.cleared).toBe(true);
  });

  it('drops an in-flight resolution once the user takes over or the task closes', async () => {
    for (const interrupt of ['noteUserAction', 'noteSessionClosed'] as const) {
      let release!: (value: number) => void;
      const pending = new Promise<number>((resolve) => { release = resolve; });
      const h = harness({ resolveResetAt: vi.fn(() => pending) });
      h.guard.onTurnError('s1', LIMIT);
      await h.flush();
      h.guard[interrupt]('s1');
      release(RESET_AT);
      await h.flush();
      expect(h.deps.arm).not.toHaveBeenCalled();
    }
  });
});
