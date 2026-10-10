/**
 * 协同 Worker 换电脑期间先不回报给 Lead 的那次终态(provider-groups.md §6.1「协同任务」)：换成了丢掉，
 * 没换成恰好回报一次；结算只认自己那次登记，换了账号不再回报。
 */
import { describe, expect, it, vi } from 'vitest';

import { createProviderGroupHeldWorkerTerminals } from '../heldWorkerTerminals';

interface Terminal {
  status: 'error' | 'done';
  diagnostic?: string;
}

function harness() {
  let owner = 'owner-a';
  const deps = {
    deliver: vi.fn<(sessionId: string, terminal: Terminal) => void>(),
    ownerKey: () => owner,
    log: vi.fn(),
  };
  return {
    deps,
    held: createProviderGroupHeldWorkerTerminals<Terminal>(deps),
    switchOwner: (next: string) => { owner = next; },
  };
}

const LIMIT: Terminal = { status: 'error', diagnostic: "You've hit your session limit" };

describe('provider group held Worker terminals', () => {
  it('does not report to the Lead when the Worker continued on another computer', () => {
    const { deps, held } = harness();
    held.stash('w1', 1, LIMIT);
    held.discard('w1', 1);
    held.release('w1', 1);
    expect(deps.deliver).not.toHaveBeenCalled();
  });

  it('reports the abnormal termination exactly once when no computer could take over', () => {
    const { deps, held } = harness();
    held.stash('w1', 1, LIMIT);
    held.release('w1', 1);
    held.release('w1', 1);
    expect(deps.deliver).toHaveBeenCalledTimes(1);
    expect(deps.deliver).toHaveBeenCalledWith('w1', LIMIT);
  });

  it('keeps the first terminal of a hold (the error, not its done echo)', () => {
    const { deps, held } = harness();
    held.stash('w1', 1, LIMIT);
    held.stash('w1', 1, { status: 'done' });
    held.release('w1', 1);
    expect(deps.deliver).toHaveBeenCalledWith('w1', LIMIT);
  });

  it('settles only its own hold: a late settlement cannot touch the next failure', () => {
    const { deps, held } = harness();
    held.stash('w1', 1, LIMIT);
    held.discard('w1', 1);
    const next: Terminal = { status: 'error', diagnostic: 'second failure' };
    held.stash('w1', 2, next);
    // 上一趟迟到的结算。
    held.release('w1', 1);
    held.discard('w1', 1);
    expect(deps.deliver).not.toHaveBeenCalled();
    held.release('w1', 2);
    expect(deps.deliver).toHaveBeenCalledWith('w1', next);
  });

  it('drops the held report after the account changed', () => {
    const { deps, held, switchOwner } = harness();
    held.stash('w1', 1, LIMIT);
    switchOwner('owner-b');
    held.release('w1', 1);
    expect(deps.deliver).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalled();
  });

  it('settling without anything held is a no-op', () => {
    const { deps, held } = harness();
    held.release('w1', 7);
    held.discard('w1', 7);
    expect(deps.deliver).not.toHaveBeenCalled();
  });
});
