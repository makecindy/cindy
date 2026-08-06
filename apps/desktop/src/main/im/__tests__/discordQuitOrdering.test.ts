import { describe, expect, it, vi } from 'vitest';

import { stopImBeforeDeviceLink } from '../discordQuitOrdering';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('stopImBeforeDeviceLink', () => {
  it('keeps Device Link presence until Discord transport disposal settles', async () => {
    const im = deferred();
    const order: string[] = [];
    const shutdown = stopImBeforeDeviceLink(
      async () => {
        order.push('im:start');
        await im.promise;
        order.push('im:done');
      },
      async () => {
        order.push('device-link:stop');
      },
    );

    await vi.waitFor(() => expect(order).toEqual(['im:start']));
    im.resolve();
    await shutdown;

    expect(order).toEqual(['im:start', 'im:done', 'device-link:stop']);
  });

  it('still tears down Device Link when IM shutdown rejects', async () => {
    const stopDeviceLink = vi.fn(async () => undefined);

    await expect(
      stopImBeforeDeviceLink(async () => {
        throw new Error('im shutdown failed');
      }, stopDeviceLink),
    ).rejects.toThrow('im shutdown failed');
    expect(stopDeviceLink).toHaveBeenCalledOnce();
  });
});
