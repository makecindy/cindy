// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('resource usage subscription', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('引用计数只触发一次订阅，并处理 invoke rejection', async () => {
    const subscribe = vi.fn().mockRejectedValue(new Error('window closed'));
    const unsubscribe = vi.fn().mockRejectedValue(new Error('window closed'));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { processMonitor: { subscribe, unsubscribe } },
    });
    const { acquireProcessMonitorSubscription, releaseProcessMonitorSubscription } =
      await import('../subscription');

    acquireProcessMonitorSubscription();
    acquireProcessMonitorSubscription();
    await Promise.resolve();
    expect(subscribe).toHaveBeenCalledOnce();

    releaseProcessMonitorSubscription();
    expect(unsubscribe).not.toHaveBeenCalled();
    releaseProcessMonitorSubscription();
    await Promise.resolve();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
