import { describe, expect, it, vi } from 'vitest';

import {
  closeLocalDbAfterDiscordShutdown,
  stopImBeforeFinishingSchedulerDrain,
  stopImAndDeviceLinkBeforeDbClient,
  stopImBeforeDeviceLink,
} from '../discordQuitOrdering';

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

describe('stopImAndDeviceLinkBeforeDbClient', () => {
  it('keeps DbClient available until ownership release finishes', async () => {
    const im = deferred();
    const deviceLink = deferred();
    const order: string[] = [];
    const shutdown = stopImAndDeviceLinkBeforeDbClient(
      async () => {
        order.push('im:start');
        await im.promise;
        order.push('im:done');
      },
      async () => {
        order.push('device-link:start');
        await deviceLink.promise;
        order.push('device-link:done');
      },
      async () => {
        order.push('db-client:stop');
      },
    );

    await vi.waitFor(() => expect(order).toEqual(['im:start']));
    im.resolve();
    await vi.waitFor(() =>
      expect(order).toEqual(['im:start', 'im:done', 'device-link:start']),
    );
    deviceLink.resolve();
    await shutdown;

    expect(order).toEqual([
      'im:start',
      'im:done',
      'device-link:start',
      'device-link:done',
      'db-client:stop',
    ]);
  });

  it('still disposes DbClient after an ownership release failure', async () => {
    const stopDbClient = vi.fn(async () => undefined);

    await expect(
      stopImAndDeviceLinkBeforeDbClient(
        async () => undefined,
        async () => {
          throw new Error('ownership release failed');
        },
        stopDbClient,
      ),
    ).rejects.toThrow('ownership release failed');
    expect(stopDbClient).toHaveBeenCalledOnce();
  });
});

describe('closeLocalDbAfterDiscordShutdown', () => {
  it('does not close the local DB while ownership release is still pending', async () => {
    const shutdown = deferred();
    const closeLocalDb = vi.fn();
    const close = closeLocalDbAfterDiscordShutdown(shutdown.promise, closeLocalDb);

    await Promise.resolve();
    expect(closeLocalDb).not.toHaveBeenCalled();

    shutdown.resolve();
    await close;
    expect(closeLocalDb).toHaveBeenCalledOnce();
  });

  it('still closes the local DB after a failed shutdown attempt settles', async () => {
    const closeLocalDb = vi.fn();

    await closeLocalDbAfterDiscordShutdown(
      Promise.reject(new Error('ownership release failed')),
      closeLocalDb,
    );

    expect(closeLocalDb).toHaveBeenCalledOnce();
  });
});

describe('stopImBeforeFinishingSchedulerDrain', () => {
  it('cancels orchestrator sessions before waiting for a scheduler handoff drain', async () => {
    const drain = deferred();
    const order: string[] = [];

    await stopImBeforeFinishingSchedulerDrain(
      async () => {
        order.push('scheduler:prepare');
      },
      async () => {
        order.push('transport:dispose');
      },
      async () => {
        order.push('sessions:dispose');
        drain.resolve();
      },
      async () => {
        order.push('scheduler:finish:start');
        await drain.promise;
        order.push('scheduler:finish:done');
      },
    );

    expect(order).toEqual([
      'scheduler:prepare',
      'transport:dispose',
      'sessions:dispose',
      'scheduler:finish:start',
      'scheduler:finish:done',
    ]);
  });

  it('still cancels sessions and finishes the scheduler when transport disposal fails', async () => {
    const disposeSessions = vi.fn(async () => undefined);
    const finishScheduler = vi.fn(async () => undefined);

    await expect(
      stopImBeforeFinishingSchedulerDrain(
        async () => undefined,
        async () => {
          throw new Error('transport dispose failed');
        },
        disposeSessions,
        finishScheduler,
      ),
    ).rejects.toThrow('transport dispose failed');

    expect(disposeSessions).toHaveBeenCalledOnce();
    expect(finishScheduler).toHaveBeenCalledOnce();
  });
});
