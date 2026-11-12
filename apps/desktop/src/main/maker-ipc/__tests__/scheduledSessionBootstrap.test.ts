import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: (name: string) => `/tmp/cindy-scheduled-bootstrap-${name}` },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../maker-host/override-settings-file.js', () => ({
  createOverrideSettingsFile: () => ({
    read: () => ({ activeMode: 'signed-out' }),
    writePatch: vi.fn(),
  }),
}));

import { commitActiveAppSession } from '../../appSessionState.js';
import { captureScheduledOwnerGuard, createScheduledSessionBootstrap } from '../scheduledSessionBootstrap.js';

type Starter = Parameters<typeof createScheduledSessionBootstrap>[0];

function createOpts() {
  return { id: 'session-1', agentKind: 'codex', workingDir: '/tmp/work' } as never;
}

/** Mirrors a launch where the account restore commits after handler registration. */
function starterOk() {
  return vi.fn<Starter>(async options => ({
    session: { id: options.id } as never,
  }));
}

describe('createScheduledSessionBootstrap', () => {
  beforeEach(() => {
    // No public reset for the module state: committing signed-out returns the
    // process to the same pre-login owner the app boots with.
    commitActiveAppSession('signed-out');
  });

  it('bootstraps with the owner active at fire time, not the one seen at registration', async () => {
    const starter = starterOk();
    // Registration happens before the app session commit restores the account.
    const bootstrap = createScheduledSessionBootstrap(starter);
    commitActiveAppSession('cloud', 'owner-a');

    await expect(bootstrap(createOpts())).resolves.toEqual({ id: 'session-1' });

    // The snapshot is per fire, so the same holder keeps working after the account
    // commits again: a holder that cached the first snapshot would fail here.
    commitActiveAppSession('cloud', 'owner-b');
    await expect(bootstrap(createOpts())).resolves.toEqual({ id: 'session-1' });
    expect(starter).toHaveBeenCalledTimes(2);
  });

  it('rejects an owner change between fire entry and session startup', async () => {
    const starter = starterOk();
    const bootstrap = createScheduledSessionBootstrap(starter);
    commitActiveAppSession('cloud', 'owner-a');
    const assertOwner = captureScheduledOwnerGuard();
    commitActiveAppSession('cloud', 'owner-b');

    await expect(bootstrap(createOpts(), undefined, assertOwner)).rejects.toThrow('Scheduled session owner changed');
    expect(starter).not.toHaveBeenCalled();
  });

  it('fails closed when the owner switches while the bootstrap is in flight', async () => {
    const bootstrap = createScheduledSessionBootstrap(async (options, assertAccess) => {
      // An account switch lands between the funnels's awaits.
      commitActiveAppSession('cloud', 'owner-b');
      assertAccess?.();
      return { session: { id: options.id } as never };
    });
    commitActiveAppSession('local');

    await expect(bootstrap(createOpts())).rejects.toThrow('Scheduled session owner changed');
  });

  it('does not start a session when the fire was already aborted', async () => {
    const starter = starterOk();
    const bootstrap = createScheduledSessionBootstrap(starter);
    const controller = new AbortController();
    controller.abort(new Error('fire stopped'));

    await expect(bootstrap(createOpts(), controller.signal)).rejects.toThrow('fire stopped');
    expect(starter).not.toHaveBeenCalled();
  });

  it('keeps the caller routing metadata aligned with the funnel decision', async () => {
    const bootstrap = createScheduledSessionBootstrap(async options => {
      options.agentDeviceId = 'device-from-group';
      options.providerId = 'provider-from-group';
      return { session: { id: options.id } as never };
    });
    const opts = createOpts() as Record<string, unknown>;

    await bootstrap(opts as never);

    expect(opts.agentDeviceId).toBe('device-from-group');
    expect(opts.providerId).toBe('provider-from-group');
  });
});
