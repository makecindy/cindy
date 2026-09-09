import { advanceSessionRewindGeneration, withSendToSessionLock } from '../sendToSessionLock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GhostSetupAssessment } from '../../../shared/ghost';
import type { BotAuthorizationCard } from '../../../shared/botAuthorization';
import type { initBotAuthorizationService } from '../botAuthorizationService';

const state = vi.hoisted(() => ({
  assessment: vi.fn<() => GhostSetupAssessment>(),
  subscribe: vi.fn((_id: string, _listener: (event: { source: string; ref?: string }) => void) => () => {}),
  save: vi.fn(),
  profileStatus: 'active',
  login: vi.fn(async () => ({ ok: true })),
  continued: vi.fn(),
  policy: JSON.stringify({ toolsets: ['art'] }) as string | undefined,
  deps: null as unknown as Parameters<typeof initBotAuthorizationService>[0],
  execute: vi.fn(async () => ({ ok: true })),
}));
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }));
vi.mock('../../i18n.js', () => ({ t: (key: string) => key }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../botAuthorizationService.js', () => ({
  initBotAuthorizationService: (deps: typeof state.deps) => { state.deps = deps; },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ drizzle: { select: (fields: Record<string, unknown>) => {
    const query = {
      from: () => query, innerJoin: () => query, where: () => query, orderBy: () => query,
      limit: async () => 'resolvedJson' in fields
        ? (state.policy === undefined ? [] : [{ resolvedJson: state.policy }])
        : [{ id: 'bot', workingDir: '/bot', status: state.profileStatus }],
    };
    return query;
  } } }),
}));
vi.mock('../../localDb/ipc/messages.js', () => ({
  createMessage: state.save, patchMessageAgentMeta: vi.fn(),
  broadcastMessageAgentMetaUpdate: vi.fn(), updateMessageContent: vi.fn(),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}), isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => [] }),
  getGhostSetupAssessment: state.assessment,
  executeGhostSetupAction: state.execute, executeGhostSetupInlineAction: state.execute,
  isGhostAvailableForActiveSession: () => true,
  acquireGhostMutationLeaseForMcp: () => () => {}, captureGhostMutationOwnerForMcp: () => ({}),
}));
vi.mock('../../cindy-brain/ghostVisibility.js', () => ({
  classifyGhostVisibility: () => ({ ok: true, ghost: { manifest: { id: 'art', name: 'Art' } } }),
}));
vi.mock('../../cindy-brain/ghostWorkdirPrefs.js', () => ({ isGhostDisabledForWorkdir: () => false }));
vi.mock('../../cindy-brain/ghostSetupChangeBus.js', () => ({
  getGhostSetupChangeBus: () => ({ subscribe: state.subscribe, currentRevision: () => 1 }),
}));
vi.mock('../../maker-host/grok-oauth-login.js', () => ({
  getGrokAccessToken: vi.fn(), hasGrokOAuthLogin: () => false, runGrokOAuthLogin: state.login,
  getGrokOAuthCredentialGeneration: () => 0, cancelGrokOAuthLogin: vi.fn(),
}));
import { initializeBotAuthorizationHost } from '../botAuthorizationHost';

const target = { kind: 'plugin' as const, id: 'art' };
describe('authorization Host frozen plugin policy', () => {
  beforeEach(() => {
    state.assessment.mockReturnValue({ state: 'ready', revision: 1, groups: [] });
    state.subscribe.mockClear();
    state.policy = JSON.stringify({ toolsets: ['art'] });
    state.save.mockClear();
    state.profileStatus = 'active';
    state.login.mockClear();
    state.continued.mockClear();
    state.execute.mockClear();
    initializeBotAuthorizationHost(async (_card, validate) => {
      await validate();
      state.continued();
    });
  });

  it.each(['oauth_connect', 'inline_form'] as const)('checks the action generation after asynchronous Host validation for %s', async (kind) => {
    const adapter = await state.deps.adapter('session', target);
    let current = true;
    const executing = adapter.execute({ id: 'connect', kind } as never, undefined,
      kind === 'inline_form' ? 'fake-secret' : undefined, undefined,
      () => { if (!current) throw new Error('card cleared or rewound'); });
    current = false;
    await expect(executing).rejects.toThrow('card cleared or rewound');
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rejects a card prepared before a clear even when its timestamp is newer', async () => {
    let generation = 0;
    initializeBotAuthorizationHost(async () => {}, () => {
      const captured = generation;
      return () => { if (generation !== captured) throw new Error('cleared'); };
    });
    const assertCurrent = state.deps.captureRequestGuard!('session');
    await state.deps.adapter('session', target);
    generation++;
    await expect(state.deps.save({ v: 1, sessionId: 'session', target, createdAt: Date.now(),
      snapshot: { kind: 'plugin_setup', requestId: 'pre-clear', revision: 1,
        ghost: { id: 'art', name: 'Art' }, steps: [] } }, assertCurrent)).rejects.toThrow('cleared');
    expect(state.save).not.toHaveBeenCalled();
  });

  it('rejects a prepared card when rewind wins the shared write boundary', async () => {
    await state.deps.adapter('session', target);
    const assertCurrent = state.deps.captureRequestGuard!('session');
    let release!: () => void;
    const rewind = withSendToSessionLock('session', async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      advanceSessionRewindGeneration('session');
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const saving = state.deps.save({ v: 1, sessionId: 'session', target, createdAt: 1,
      snapshot: { kind: 'plugin_setup', requestId: 'stale', revision: 1,
        ghost: { id: 'art', name: 'Art' }, steps: [] } }, assertCurrent);
    const rejected = expect(saving).rejects.toThrow('Authorization request was rewound');
    release();
    await rewind;
    await rejected;
    expect(state.save).not.toHaveBeenCalled();
  });

  it('keeps credential A pending after credential B completes until A reauth is resolved', async () => {
    const ready: GhostSetupAssessment = { state: 'ready', revision: 1, groups: [] };
    state.assessment.mockReturnValue({ ...ready, reauthSuggest: {
      ghostId: 'art', secretKey: 'A', missingScopes: ['write'], missingScopeCount: 1,
      requirement: { ref: 'oauth:A', kind: 'oauth', label: 'Account A', action: { id: 'connect:A', kind: 'oauth_connect' } },
    } });
    const adapter = await state.deps.adapter('session', { ...target, reauthorize: true });
    adapter.subscribe(vi.fn());
    const callback = state.subscribe.mock.calls[0][1];
    callback({ source: 'oauth', ref: 'B' });
    await expect(adapter.assess()).resolves.toMatchObject({ state: 'required', groups: [{ id: 'reauth:A' }] });
    // Even an action success is insufficient while the scope suggestion remains.
    await adapter.execute({ id: 'connect:A', kind: 'oauth_connect' }, undefined);
    await expect(adapter.assess()).resolves.toMatchObject({ state: 'required', groups: [{ id: 'reauth:A' }] });
    state.assessment.mockReturnValue(ready);
    await expect(adapter.assess()).resolves.toMatchObject({ state: 'ready' });
  });

  it('persists the validated credential-page link for the Desktop card', async () => {
    await state.deps.adapter('session', target);
    const card: BotAuthorizationCard = { v: 1, sessionId: 'session', target, createdAt: 1,
      snapshot: { kind: 'plugin_setup', requestId: 'r', revision: 1, ghost: { id: 'art', name: 'Art' },
        steps: [{ id: 'step', groupId: 'group', groupMode: 'any_of', title: 'Key', description: '', phase: 'pending',
          action: { id: 'inline', kind: 'inline_form', form: { fields: [{ id: 'value', type: 'secret', label: 'Key',
            required: true, maxLength: 4096, externalLink: { url: 'https://example.com/keys' } }] } } }] } };
    await state.deps.save(card);
    expect(state.save.mock.calls[0][1].agentMeta.botAuthorization.snapshot.steps[0].action.form.fields[0].externalLink)
      .toEqual({ url: 'https://example.com/keys' });
  });

  it.each(['paused', 'archived', 'deleting', 'error'])('rejects old plugin and Host cards when the Profile is %s', async (status) => {
    const plugin = await state.deps.adapter('session', target);
    const hostTarget = { kind: 'host' as const, id: 'grok' as const };
    const host = await state.deps.adapter('session', hostTarget);
    state.profileStatus = status; // canonical Session remains active
    for (const [adapter, cardTarget] of [[plugin, target], [host, hostTarget]] as const) {
      await expect(state.deps.adapter('session', cardTarget)).rejects.toThrow('teammate is unavailable');
      await expect(adapter.assess()).rejects.toThrow('teammate is unavailable');
      await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).rejects.toThrow('teammate is unavailable');
      await expect(state.deps.resume({ sessionId: 'session', target: cardTarget } as BotAuthorizationCard, () => {})).rejects.toThrow('teammate is unavailable');
    }
    expect(state.execute).not.toHaveBeenCalled();
    expect(state.login).not.toHaveBeenCalled();
    expect(state.continued).not.toHaveBeenCalled();
  });

  it.each([undefined, '{', '{}', '{"toolsets":[]}'])('rejects restored cards without an applied grant: %s', async (policy) => {
    state.policy = policy;
    await expect(state.deps.adapter('session', target)).rejects.toThrow('disabled in teammate profile');
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('rechecks the durable policy before assessment, credential mutation and continuation', async () => {
    const adapter = await state.deps.adapter('session', target);
    await expect(adapter.assess()).resolves.toMatchObject({ state: 'ready' });
    state.policy = JSON.stringify({ toolsets: [] });
    await expect(adapter.assess()).rejects.toThrow('disabled in teammate profile');
    await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).rejects.toThrow('disabled in teammate profile');
    await expect(state.deps.resume({ sessionId: 'session', target } as BotAuthorizationCard, () => {})).rejects.toThrow('disabled in teammate profile');
    expect(state.execute).not.toHaveBeenCalled();
  });

  it('permits configured plugin actions and does not apply plugin policy to Host login', async () => {
    const adapter = await state.deps.adapter('session', target);
    await expect(adapter.execute({ id: 'connect', kind: 'oauth_connect' }, undefined)).resolves.toMatchObject({ ok: true });
    expect(state.execute).toHaveBeenCalledTimes(1);
    state.policy = undefined;
    await expect(state.deps.adapter('session', { kind: 'host', id: 'grok' })).resolves.toMatchObject({ identity: { id: 'grok' } });
  });
});
