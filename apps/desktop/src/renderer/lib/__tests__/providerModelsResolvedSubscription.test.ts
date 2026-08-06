import { describe, expect, it, vi } from 'vitest';

import { subscribeToProviderModelsResolved } from '../providerModelsResolvedSubscription';

interface Payload {
  requestId: string;
  models: string[];
}

describe('subscribeToProviderModelsResolved', () => {
  it('ignores other requests and unsubscribes after the matching response', () => {
    vi.useFakeTimers();
    let listener: ((payload: Payload) => void) | undefined;
    const unsubscribe = vi.fn();
    const onResolved = vi.fn();

    subscribeToProviderModelsResolved<Payload>({
      requestId: 'wanted',
      timeoutMs: 30_000,
      subscribe: (next) => {
        listener = next;
        return unsubscribe;
      },
      onResolved,
    });

    listener?.({ requestId: 'other', models: [] });
    expect(onResolved).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();

    const payload = { requestId: 'wanted', models: ['model-a'] };
    listener?.(payload);
    expect(onResolved).toHaveBeenCalledWith(payload);
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(30_000);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('unsubscribes on timeout and makes explicit cleanup idempotent', () => {
    vi.useFakeTimers();
    const unsubscribe = vi.fn();
    const stop = subscribeToProviderModelsResolved<Payload>({
      requestId: 'wanted',
      timeoutMs: 30_000,
      subscribe: () => unsubscribe,
      onResolved: vi.fn(),
    });

    vi.advanceTimersByTime(30_000);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('explicit cleanup prevents a late response from reaching an unmounted caller', () => {
    vi.useFakeTimers();
    let listener: ((payload: Payload) => void) | undefined;
    let active = true;
    const onResolved = vi.fn();
    const stop = subscribeToProviderModelsResolved<Payload>({
      requestId: 'wanted',
      timeoutMs: 30_000,
      subscribe: (next) => {
        listener = next;
        return () => {
          active = false;
        };
      },
      onResolved,
    });

    stop();
    if (active) listener?.({ requestId: 'wanted', models: ['late-model'] });
    expect(onResolved).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
