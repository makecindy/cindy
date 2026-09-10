import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelMemoryResetRequests } from '../model-memory-reset.js';

describe('persisted model memory reset acknowledgement', () => {
  afterEach(() => vi.useRealTimers());
  it('correlates independent requests and rejects an unconfirmed write', async () => {
    vi.useFakeTimers();
    const requests = new ModelMemoryResetRequests();
    const ids: string[] = [];
    const first = requests.request((id) => ids.push(id));
    const second = requests.request((id) => ids.push(id));
    const rejected = expect(second).rejects.toThrow('MODEL_MEMORY_RESET_NOT_CONFIRMED');
    requests.acknowledge('unrelated');
    requests.acknowledge(ids[0]);
    await expect(first).resolves.toEqual({ resetApplied: true });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    requests.acknowledge(ids[1]);
  });
});


it('rejects a stale acknowledgement after the account boundary changes', async () => {
  const requests = new ModelMemoryResetRequests();
  let owner = 'a'; let requestId = '';
  const pending = requests.request((id) => { requestId = id; }, () => owner === 'a');
  owner = 'b';
  const failure = expect(pending).rejects.toThrow('OWNER_CHANGED');
  expect(requests.acknowledge(requestId)).toBe(false);
  await failure;
});
