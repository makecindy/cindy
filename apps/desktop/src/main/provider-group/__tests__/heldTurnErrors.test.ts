/**
 * 自动换电脑期间先不呈现的那次失败(provider-groups.md §6.1)：换成了不留痕迹，没换成补落并呈现，
 * 结算只认自己那次登记；补落的行在暂存那一刻就取好，换了账号不再写。
 */
import { describe, expect, it, vi } from 'vitest';

import { createProviderGroupHeldTurnErrors } from '../heldTurnErrors';

interface Row {
  message: string;
  agentMeta: unknown;
  capturedAt: number;
}

function harness(live = true) {
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
  });

  it('does not write into another account after the user switched accounts', () => {
    const { deps, held, switchOwner } = harness(true);
    held.stash('s1', 1, DATA);
    switchOwner('owner-b');
    held.release('s1', 1);
    expect(deps.persist).not.toHaveBeenCalled();
    expect(deps.surface).not.toHaveBeenCalled();
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
