import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStartupCleanupPendingError, AgentStartupStoppedError, Maker } from '@cindy/maker-core';

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

  // Unit regression for merged legacy subscriptions: the existing startup tests
  // never exercised account preparation. A per-fire task has no durable row yet;
  // it must use the admitted source, while the saved schedule remains unchanged.
  // Retry is safe only once the failed runtime is proven stopped.
  it.each(['known-failure', 'learned-at-startup', 'healthy', 'cleanup-pending', 'unclassified', 'no-alternative', 'retry-exhausted'] as const)(
    'starts a fresh scheduled task using account admission (%s)', async mode => {
      const saved = { ...createOpts() as Record<string, unknown>, providerId: 'openai-old' };
      const options = { ...saved };
      const cause = Object.assign(new Error('limit'), { code: 'usage_limit' });
      const failure = mode === 'cleanup-pending'
        ? new AgentStartupCleanupPendingError('cleanup pending', { cause: new Error('limit'), whenStopped: Promise.resolve() })
        : mode === 'unclassified' ? new Error('unknown startup state') : new AgentStartupStoppedError(cause);
      let learned = mode === 'known-failure';
      const startedSources: unknown[] = [];
      const prepare = vi.fn(async (opts: Parameters<Starter>[0], assertCurrent: () => void) => {
        assertCurrent();
        if (!learned || opts.providerId === 'openai' || mode === 'no-alternative') return false;
        opts.providerId = 'openai';
        return true;
      });
      const rows = new Map();
      const maker = new Maker({ agents: { codex: {
        kind: 'codex', capabilities: {}, dispose: async () => {},
        startSession: async (opts: Parameters<Starter>[0]) => {
          startedSources.push(opts.providerId);
          expect(opts).not.toHaveProperty('preserveStartupStoppedError');
          if (mode !== 'healthy' && (opts.providerId === 'openai-old' || mode === 'retry-exhausted')) {
            learned = true;
            throw failure;
          }
          return { id: 'native-new', agentKind: 'codex', model: 'gpt-5', close: async () => {},
            events: async function* () {}, isTurnRunning: () => false,
            setInteractionResolver() {}, send: async () => {}, steer: async () => {}, abort: async () => {},
            getUsageSnapshot: () => ({}) };
        },
      } as never }, storage: {
        get: async (id: string) => rows.get(id) ?? null,
        create: async (row: { id: string }) => { rows.set(row.id, row); return row; },
        update: async (id: string, patch: object) => { const row = { ...rows.get(id), ...patch }; rows.set(id, row); return row; },
      } as never, logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never });
      const starter = vi.fn<Starter>(async opts => ({ session: await maker.createSession(opts) }));
      const bootstrap = createScheduledSessionBootstrap(starter, prepare);
      if (mode === 'no-alternative' || mode === 'retry-exhausted') {
        await expect(bootstrap(options as never)).rejects.toBe(cause);
        expect(startedSources).toEqual(mode === 'no-alternative' ? ['openai-old'] : ['openai-old', 'openai']);
        expect(prepare).toHaveBeenCalledTimes(2);
      } else if (mode === 'cleanup-pending' || mode === 'unclassified') {
        await expect(bootstrap(options as never)).rejects.toBe(failure);
        expect(startedSources).toEqual(['openai-old']);
        expect(prepare).toHaveBeenCalledOnce();
      } else {
        await expect(bootstrap(options as never)).resolves.toMatchObject({ id: 'session-1' });
        expect(startedSources).toEqual(mode === 'learned-at-startup' ? ['openai-old', 'openai']
          : [mode === 'healthy' ? 'openai-old' : 'openai']);
        expect(options.providerId).toBe(mode === 'healthy' ? 'openai-old' : 'openai');
      }
      expect(saved.providerId).toBe('openai-old');
      await maker.shutdown();
    });
});
