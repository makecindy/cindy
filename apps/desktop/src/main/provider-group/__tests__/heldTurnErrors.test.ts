/**
 * 自动换电脑期间先不呈现的那次失败(provider-groups.md §6.1)：换成了不留痕迹，没换成补落并呈现，
 * 结算只认自己那次登记；补落的行在暂存那一刻就取好，换了账号不再写。
 */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '@cindy/maker-core';

import { createProviderGroupHeldRecovery, createProviderGroupHeldTurnErrors } from '../heldTurnErrors';
import { createProviderGroupHeldWorkerTerminals } from '../heldWorkerTerminals';
import { AutoResumeBookkeeping } from '../../maker-ipc/autoResumeBookkeeping';
import { createSessionBindingLifecycle } from '../../maker-ipc/sessionBindingLifecycle';
import { captureProductTurnFailureOwner, createDeferredProductTurnFailureGate } from '../../maker-ipc/productTurnFailureOwner';

interface Row {
  message: string;
  agentMeta: unknown;
  capturedAt: number;
}

function harness(live = true, settleFailure?: (sessionId: string) => void) {
  let clock = 1_000;
  let owner = 'owner-a';
  const deps = {
    // 暂存那一刻取好的行：记下当时的时刻与失败那一轮的身份。
    capture: vi.fn((_sessionId: string, data: unknown, agentMeta: unknown): Row | null => {
      const message = (data as { message?: unknown } | null)?.message;
      return typeof message === 'string' && message ? { message, agentMeta, capturedAt: clock } : null;
    }),
    persist: vi.fn(),
    surface: vi.fn(),
    settleFailure: vi.fn(settleFailure),
    releaseHold: vi.fn(() => live),
    ownerKey: () => owner,
    log: vi.fn(),
  };
  return {
    deps,
    held: createProviderGroupHeldTurnErrors<Row>(deps),
    advance: (ms: number) => { clock += ms; },
    switchOwner: (next: string) => { owner = next; },
  };
}

const DATA = { message: "You've hit your session limit", reason: 'usage_limit', sdkError: 'rate_limit', extra: 1 };
const DETAIL = { message: "You've hit your session limit", reason: 'usage_limit', sdkError: 'rate_limit' };
const META = { uuid: 'failed-turn' };
const ROW: Row = { message: DATA.message, agentMeta: META, capturedAt: 1_000 };

describe('provider group held turn errors', () => {
  it.each([false, true])('transfers the suppressed detail to recovery only within its account (account changed: %s)', changed => {
    const { held, deps, switchOwner } = harness();
    held.stash('s1', 1, DATA, META);
    if (changed) switchOwner('other-account');
    expect(held.takeForRecovery('s1', 1)).toEqual(changed ? null : DETAIL);
    expect(held.takeForRecovery('s1', 1)).toBeNull();
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.surface).not.toHaveBeenCalled();
    expect(deps.settleFailure).not.toHaveBeenCalled();
  });

  it('drops the error row when the task continued on another computer', () => {
    const { deps, held } = harness();
    expect(held.stash('s1', 1, DATA, META)).toBe(true);
    held.discard('s1', 1);
    expect(deps.releaseHold).toHaveBeenCalledWith('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    // 之后的结算(finally)什么都不做。
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.surface).not.toHaveBeenCalled();
    expect(deps.settleFailure).not.toHaveBeenCalled();
  });

  // #6671 / r4339380528, unit: queue acceptance discarded the error, but a
  // pre-vendor failure never settled its product receipt. Existing holder tests
  // stopped at queue acceptance. Drive the production continuation adapter with
  // real held stores/gate, including a product-only task with no Worker terminal.
  it.each([
    { dispatched: false, worker: false, takeover: 'none' },
    { dispatched: false, worker: true, takeover: 'none' },
    { dispatched: true, worker: true, takeover: 'none' },
    { dispatched: false, worker: false, takeover: 'stop' },
    { dispatched: false, worker: false, takeover: 'new-turn' },
    { dispatched: false, worker: false, takeover: 'account-change' },
  ] as const)('settles queued continuation receipts: %j', ({ dispatched, worker, takeover }) => {
    let generation = 3;
    const session = { id: 's1', instanceId: 'original', getTurnGeneration: () => generation } as Session;
    const owner = captureProductTurnFailureOwner(session, { type: 'error', source: 'codex', data: DATA });
    const gate = createDeferredProductTurnFailureGate();
    gate.defer(owner);
    const other = { ...owner, sessionId: 'unrelated' };
    gate.defer(other);
    const productFailed = vi.fn();
    const settleFailure = (sessionId: string) => gate.settle(
      sessionId,
      current => current.session === session && current.generation === generation,
      productFailed,
    );
    const h = harness(true, settleFailure);
    const delivered = vi.fn();
    const terminals = createProviderGroupHeldWorkerTerminals({ deliver: delivered, ownerKey: h.deps.ownerKey });
    const recovery = createProviderGroupHeldRecovery({ errors: h.held, terminals, settleFailure, ownerKey: h.deps.ownerKey });
    h.held.stash('s1', 1, DATA, META);
    if (worker) terminals.stash('s1', 1, 'original-terminal');

    recovery.discard('s1', 1);
    expect(recovery.hasPendingContinuation('s1')).toBe(true);
    recovery.release('s1', 1); // The failover hook's finally runs before dispatch.
    expect(productFailed).not.toHaveBeenCalled();
    expect(delivered).not.toHaveBeenCalled();
    expect(gate.pending('s1')).toBe(owner);
    if (dispatched || takeover === 'stop' || takeover === 'new-turn') gate.clearSession('s1');
    if (takeover === 'new-turn') generation++;
    if (takeover === 'account-change') h.switchOwner('other-account');
    expect(recovery.hasPendingContinuation('s1')).toBe(takeover !== 'account-change');

    recovery.settleContinuation('s1', dispatched);
    recovery.settleContinuation('s1', false);
    expect(recovery.hasPendingContinuation('s1')).toBe(false);
    recovery.release('s1', 1);
    if (!dispatched && takeover === 'none') {
      expect(productFailed).toHaveBeenCalledExactlyOnceWith(owner);
    } else expect(productFailed).not.toHaveBeenCalled();
    expect(gate.pending('s1')).toBe(takeover === 'account-change' ? owner : undefined);
    expect(gate.pending('unrelated')).toBe(other);
    expect(delivered.mock.calls).toEqual(worker && !dispatched ? [['s1', 'original-terminal']] : []);
    expect(h.deps.persist).not.toHaveBeenCalled();
  });

  // Unit regression for #6671 review: a capacity terminal before user-row
  // persistence leaves a deferred product receipt. Existing release tests only
  // checked the error row/Island, so the upstream/plugin caller could hang after
  // all alternate computers failed. Exercise real error transfer and release.
  it.each(['closed', 'replaced', 'new-dispatch'] as const)('settles the captured product receipt after handoff close, except a new dispatch: %s', outcome => {
    let closed!: () => void;
    const session = {
      id: 's1', instanceId: 'instance', getTurnGeneration: () => 3,
      setInteractionListener: vi.fn(),
      onStatusChange: (listener: (status: string) => void) => { closed = () => listener('closed'); return () => {}; },
    } as unknown as Session;
    const detail = { message: 'model at capacity', reason: 'upstream-overload' };
    const owner = captureProductTurnFailureOwner(session, {
      type: 'error', source: 'codex', data: detail,
    });
    const gate = createDeferredProductTurnFailureGate();
    const failed = vi.fn();
    // Real binding close -> gate teardown -> replacement bind, matching register.
    // The previous regression skipped close and could not expose lost ownership.
    const bindings = createSessionBindingLifecycle({
      log: { warn: vi.fn() }, restoreInteractionListener: vi.fn(), beforeReplace: vi.fn(),
      onBind: (runtime: Session) => gate.rebindSession(runtime.id, runtime),
      broadcastStatus: vi.fn(), captureCloseContext: () => null,
      cleanupClosedSession: vi.fn(), finalizeClosedSession: vi.fn(),
      beforeCloseTeardown: (runtime: Session) => gate.clearSession(runtime.id, runtime, { preserveRecovery: true }),
    });
    const registration = bindings.beginBinding(session)!;
    bindings.attachStatusListener(registration);
    const settleFailure = (sessionId: string) => {
      gate.settle(sessionId, current => {
        const bound = bindings.getSession(sessionId);
        return (!bound || bound === current.session) && current.instanceId === current.session.instanceId &&
          current.generation === current.session.getTurnGeneration();
      }, current => failed(current.originalExecution ?? current));
    };
    gate.defer(owner);
    const book = new AutoResumeBookkeeping({
      persistSuppressedError: vi.fn(),
      surfaceSuppressedError: settleFailure,
      markOutcome: vi.fn(),
      rollbackGuardPendingResume: vi.fn(),
      abandonTakeover: vi.fn(),
    });
    const deferredOwner = { generation: 3, clientId: 'capacity-turn' };
    book.stashSuppressedError('s1', detail, null, deferredOwner);
    const deferred = book.takeDeferredError('s1', deferredOwner)!;
    const h = harness(true, settleFailure);
    h.held.stash('s1', 1, deferred.detail);
    expect(failed).not.toHaveBeenCalled();

    closed();
    if (outcome !== 'closed') {
      const replacement = { ...session, instanceId: 'replacement', getTurnGeneration: () => 0 } as Session;
      bindings.beginBinding(replacement);
    }
    if (outcome === 'new-dispatch') gate.clearSession('s1');

    h.held.release('s1', 1);
    h.held.release('s1', 1);
    book.teardown('s1');
    if (outcome === 'new-dispatch') expect(failed).not.toHaveBeenCalled();
    else {
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'instance', generation: 3 }));
    }
    expect(gate.pending('s1')).toBeUndefined();
    expect(h.deps.persist).toHaveBeenCalledTimes(1);
  });

  it('writes the row captured when the error happened and surfaces it when the switch gives up', () => {
    const { deps, held, advance } = harness(true);
    held.stash('s1', 1, DATA, META);
    // 换电脑花了一阵子：补落写的仍是出错那一刻取好的那一行(失败那一轮的身份与时刻)。
    advance(90_000);
    held.release('s1', 1);
    expect(deps.capture).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenCalledWith('s1', ROW);
    expect(deps.surface).toHaveBeenCalledWith('s1', DETAIL);
    // 重复结算无副作用。
    held.release('s1', 1);
    expect(deps.persist).toHaveBeenCalledTimes(1);
  });

  it('only writes the row when the error is no longer current (the user took over)', () => {
    const { deps, held } = harness(false);
    held.stash('s1', 1, DATA, META);
    held.release('s1', 1);
    expect(deps.persist).toHaveBeenCalledWith('s1', ROW);
    expect(deps.surface).not.toHaveBeenCalled();
    expect(deps.settleFailure).not.toHaveBeenCalled();
  });

  it('does not write into another account after the user switched accounts', () => {
    const { deps, held, switchOwner } = harness(true);
    held.stash('s1', 1, DATA);
    switchOwner('owner-b');
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.surface).not.toHaveBeenCalled();
    expect(deps.settleFailure).not.toHaveBeenCalled();
  });

  it('keeps one row for a repeated terminal error and lets a different error through with its alert', () => {
    const { deps, held } = harness();
    expect(held.stash('s1', 1, DATA, META)).toBe(true);
    expect(held.stash('s1', 1, { ...DATA })).toBe(true);
    expect(deps.capture).toHaveBeenCalledTimes(1);
    // 同一次登记期间到达的另一条不同错误：不归这次暂存，调用方照常落库；换电脑期间被压下的 Agent Island 提醒
    // 在这里补上。暂存的那条不被覆盖。
    expect(held.stash('s1', 1, { message: 'Something else broke' })).toBe(false);
    expect(deps.surface).toHaveBeenCalledWith('s1', { message: 'Something else broke' });
    held.release('s1', 1);
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenCalledWith('s1', ROW);
  });

  it('writes nothing for an error without a message, but still holds and surfaces it', () => {
    const { deps, held } = harness();
    expect(held.stash('s1', 1, { reason: 'turn-failed' })).toBe(true);
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.surface).toHaveBeenCalledWith('s1', { reason: 'turn-failed' });
  });

  it('never lets a late settlement touch a newer failure', () => {
    const { deps, held } = harness();
    held.stash('s1', 1, DATA);
    held.release('s1', 1);
    held.stash('s1', 2, { message: 'second' });
    held.discard('s1', 1);
    held.release('s1', 1);
    expect(deps.persist).toHaveBeenCalledTimes(1);
    held.release('s1', 2);
    expect(deps.persist).toHaveBeenLastCalledWith('s1', expect.objectContaining({ message: 'second' }));
  });

  it('leaves an earlier failure to its own settlement when a new one arrives first', () => {
    // 换成了、续跑那一轮又很快失败：新的一次先暂存，上一次随后以「换成了」结算，不留错误卡。
    const { deps, held } = harness();
    held.stash('s1', 1, DATA);
    held.stash('s1', 2, { message: 'second' });
    expect(deps.persist).not.toHaveBeenCalled();
    held.discard('s1', 1);
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    // 新的这次没换成：照常补落。
    held.release('s1', 2);
    expect(deps.persist).toHaveBeenCalledTimes(1);
    expect(deps.persist).toHaveBeenCalledWith('s1', expect.objectContaining({ message: 'second' }));
  });
});
