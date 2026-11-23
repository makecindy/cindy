// Unit: the cloud providers page channel. Owner-gated, full catalog including hidden models,
// display-only routing, and every write delegated to the exact native Host channel.
import { describe, expect, it, vi } from 'vitest';
import {
  createProviderSettingsChannel,
  type ProviderSettingsChannelDeps,
} from '../providerSettingsChannel';

const OWNER = { dataOwnerId: 'owner-1', ownerGeneration: 7 };

function setup(overrides: Partial<ProviderSettingsChannelDeps> = {}) {
  let owner: typeof OWNER | null = OWNER;
  let isOwner = true;
  // The window's visibility choices as the provider list and Main mirror report them.
  const visibility = { revision: 'rev-1', overrides: { 'codex:xd:hidden': false } as Record<string, boolean> };
  const call = vi.fn<ProviderSettingsChannelDeps['call']>(async (channel) =>
    channel === 'maker:provider:list'
      ? {
          dataOwnerId: OWNER.dataOwnerId,
          ownerGeneration: OWNER.ownerGeneration,
          providerOrder: ['xd', 'openai'],
          modelVisibilityOverrides: { ...visibility.overrides },
          providers: [
            {
              id: 'xd',
              name: 'Cindy AI',
              connected: true,
              remoteInvocationEnabled: false,
              remoteModelIds: ['secret-share'],
              logoKind: 'forged',
              routing: {
                codex: {
                  upstream: 'https://internal.example.invalid',
                  authStrategy: 'bearer',
                  wireProtocol: 'openai-responses',
                },
              },
              models: {
                codex: [
                  { id: 'shown', name: 'Shown' },
                  { id: 'hidden', name: 'Hidden', defaultEnabled: false },
                  { id: 'paid', name: 'Paid', availability: 'requires_payment' },
                ],
              },
            },
          ],
        }
      : undefined,
  );
  const setVisibility = vi.fn<ProviderSettingsChannelDeps['setVisibility']>(async (providerId, targets, enabled) => {
    for (const target of targets) visibility.overrides[`${target.agent}:${providerId}:${target.modelId}`] = enabled!;
    visibility.revision = 'rev-2';
  });
  const deps: ProviderSettingsChannelDeps = {
    isInstanceOwner: () => isOwner,
    owner: () => owner,
    call,
    visibilityRevision: async () => visibility.revision,
    setVisibility,
    projectRouting: (routing) =>
      routing &&
      Object.fromEntries(
        Object.entries(routing as Record<string, { wireProtocol?: string }>).map(
          ([agent, route]) => [agent, { wireProtocol: route.wireProtocol }],
        ),
      ),
    resolveLogoKind: () => 'cindy',
    readEfforts: async () => ({ 'codex:*': { shown: 'high' } }),
    applyEffort: vi.fn(async () => {}),
    editModel: vi.fn(async () => {}),
    shareCommand: vi.fn(async (command) => ({ command })),
    ...overrides,
  };
  return {
    channel: createProviderSettingsChannel(deps),
    call,
    deps,
    setVisibility,
    setOwner: (next: typeof OWNER | null) => {
      owner = next;
    },
    setIsOwner: (next: boolean) => {
      isOwner = next;
    },
  };
}
const run = (h: ReturnType<typeof setup>, request: unknown) =>
  h.channel.handle('same-account-mac', request);

describe('cloud provider settings channel', () => {
  it('refuses a non-owner before reading or writing anything', async () => {
    const h = setup();
    h.setIsOwner(false);
    await expect(run(h, { op: 'list' })).rejects.toThrow('[PERMISSION_DENIED]');
    expect(h.call).not.toHaveBeenCalled();
  });

  it('lists the full catalog, including hidden and payment-locked models, with display-only routing', async () => {
    const h = setup();
    type Model = { id: string; availability?: string };
    type Provider = {
      models: { codex: Model[] };
      routing: unknown;
      logoKind: string;
      remoteInvocationEnabled: boolean;
    };
    const list = (await run(h, { op: 'list' })) as {
      providers: Provider[];
      supportedOps: string[];
    };
    expect(h.call).toHaveBeenCalledWith('maker:provider:list', [], expect.any(Object));
    expect(list).toMatchObject({
      version: 1,
      ownerGeneration: 7,
      providerOrder: ['xd', 'openai'],
      visibility: { status: 'ready', revision: 'rev-1', overrides: { 'codex:xd:hidden': false } },
    });
    expect(list.supportedOps).toContain('visibility-set');
    expect((list as unknown as { shareActions: string[] }).shareActions).toContain('insights');
    const xd = list.providers[0];
    expect(xd.models.codex.map((m) => m.id)).toEqual(['shown', 'hidden', 'paid']);
    expect(xd.models.codex[2].availability).toBe('requires_payment');
    expect(xd.routing).toEqual({ codex: { wireProtocol: 'openai-responses' } });
    expect(xd.logoKind).toBe('cindy');
    expect(xd.remoteInvocationEnabled).toBe(false);
    expect(xd).not.toHaveProperty('remoteModelIds');
    expect(JSON.stringify(list)).not.toContain('internal.example.invalid');
    expect(JSON.stringify(list)).not.toContain('bearer');
  });

  it('refuses a catalog over the transfer limit', async () => {
    const h = setup({
      call: async () => ({
        providers: [{ id: 'big', name: 'x'.repeat(2 * 1024 * 1024 + 1) }],
        providerOrder: [],
      }),
    });
    await expect(run(h, { op: 'list' })).rejects.toThrow('[TOO_LARGE]');
  });

  it('delegates each write to its native channel with the Host owner, never the caller’s', async () => {
    const cases: Array<[unknown, string, unknown]> = [
      [
        {
          op: 'model-disable',
          ownerGeneration: 7,
          providerId: 'xd',
          kind: 'model',
          disabled: true,
          modelIds: ['shown'],
        },
        'maker:model-disable:set',
        { providerId: 'xd', kind: 'model', disabled: true, modelIds: ['shown'] },
      ],
      [
        { op: 'order', ownerGeneration: 7, providerIds: ['openai', 'xd'] },
        'maker:provider:order:set',
        { dataOwnerId: 'owner-1', ownerGeneration: 7, providerIds: ['openai', 'xd'] },
      ],
      [
        {
          op: 'presentation',
          ownerGeneration: 7,
          providerId: 'openai',
          action: 'rename',
          name: 'Work',
        },
        'maker:provider:presentation:set',
        {
          dataOwnerId: 'owner-1',
          ownerGeneration: 7,
          providerId: 'openai',
          action: 'rename',
          name: 'Work',
        },
      ],
      [
        { op: 'remote-access', ownerGeneration: 7, providerId: 'xd', enabled: true },
        'maker:provider:remote-access:set',
        { providerId: 'xd', enabled: true },
      ],
      [
        { op: 'refresh', ownerGeneration: 7, providerId: 'openai' },
        'maker:provider:models-refresh',
        'openai',
      ],
      [
        { op: 'rediscover', ownerGeneration: 7, providerId: 'anthropic' },
        'maker:provider:models-rediscover',
        'anthropic',
      ],
    ];
    for (const [request, channel, arg] of cases) {
      const h = setup();
      await expect(run(h, request)).resolves.toEqual({
        ok: true,
        ownerGeneration: 7,
        catalogChanged: true,
      });
      expect(h.call).toHaveBeenCalledTimes(1);
      expect(h.call).toHaveBeenCalledWith(channel, [arg], expect.any(Object));
    }
  });

  it('rejects a stale owner generation without calling the Host', async () => {
    const h = setup();
    await expect(run(h, { op: 'order', ownerGeneration: 6, providerIds: ['xd'] })).rejects.toThrow(
      '[OWNER_CHANGED]',
    );
    expect(h.call).not.toHaveBeenCalled();
  });

  it('fails a write whose owner changes while the Host handler runs', async () => {
    const h = setup();
    h.call.mockImplementationOnce(async () => {
      h.setOwner({ dataOwnerId: 'owner-2', ownerGeneration: 8 });
      return undefined;
    });
    await expect(
      run(h, { op: 'remote-access', ownerGeneration: 7, providerId: 'xd', enabled: true }),
    ).rejects.toThrow('[OWNER_CHANGED]');
  });

  it('writes visibility with compare-and-swap and returns the new state', async () => {
    const h = setup();
    const targets = [{ agent: 'codex', modelId: 'hidden' }];
    await expect(
      run(h, {
        op: 'visibility-set',
        ownerGeneration: 7,
        revision: 'rev-0',
        providerId: 'xd',
        targets,
        enabled: true,
      }),
    ).rejects.toThrow('[REVISION_CONFLICT]');
    expect(h.setVisibility).not.toHaveBeenCalled();
    await expect(
      run(h, {
        op: 'visibility-set',
        ownerGeneration: 7,
        revision: 'rev-1',
        providerId: 'xd',
        targets,
        enabled: true,
      }),
    ).resolves.toEqual({
      ok: true,
      ownerGeneration: 7,
      catalogChanged: false,
      visibility: { status: 'ready', revision: 'rev-2', overrides: { 'codex:xd:hidden': true } },
    });
    expect(h.setVisibility).toHaveBeenCalledWith('xd', targets, true, expect.any(Function));
  });

  it('rejects malformed requests and unknown operations', async () => {
    const h = setup();
    for (const bad of [
      null,
      {},
      { op: 'delete-everything' },
      { op: 'order', ownerGeneration: 7, providerIds: [] },
      { op: 'list', extra: true },
      { op: 'refresh', ownerGeneration: 7, providerId: 'xd', channel: 'maker:auth:logout' },
    ])
      await expect(run(h, bad)).rejects.toThrow('[INVALID_PARAMS]');
    expect(h.call).not.toHaveBeenCalled();
  });

  it('serves model panel calls with the instance owner stamp and returns their views', async () => {
    const f = setup();
    f.call.mockImplementation(async (channel) => ({ channel }));
    const target = { providerId: 'xd', agent: 'codex', modelId: 'shown' };
    const forged = { dataOwnerId: 'controller', ownerGeneration: 1 };
    const send = (call: string, value?: unknown) =>
      f.channel.handle('controller', {
        op: 'model-call',
        ownerGeneration: 7,
        call,
        target,
        ...(value === undefined ? {} : { value }),
      });
    await expect(send('context-get')).resolves.toMatchObject({
      catalogChanged: false,
      value: { channel: 'maker:model-context-limit:get' },
    });
    await expect(send('context-set', 64_000)).resolves.toMatchObject({ catalogChanged: true });
    await send('compaction-set', null);
    await send('context-reset');
    const quote = { currency: 'USD', inputPerMtok: 1, outputPerMtok: 2 };
    await send('price-set', quote);
    expect(f.call.mock.calls.map(([channel, args]) => [channel, args])).toEqual([
      ['maker:model-context-limit:get', [target]],
      ['maker:model-context-limit:set', [target, 64_000, OWNER]],
      ['maker:model-compaction:set', [target, null, OWNER]],
      ['maker:model-context-limit:reset', [target, OWNER]],
      ['maker:model-price-override:set', [target, quote]],
    ]);
    expect(JSON.stringify(f.call.mock.calls)).not.toContain(forged.dataOwnerId);
    await expect(send('price-set', 3)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(send('context-set', quote)).rejects.toThrow('[INVALID_PARAMS]');
    await expect(
      f.channel.handle('controller', {
        op: 'model-call',
        ownerGeneration: 7,
        call: 'context-set',
        target: { ...target, owner: forged },
        value: 1,
      }),
    ).rejects.toThrow('[INVALID_PARAMS]');
  });

  it('applies reasoning effort on the instance and returns the new effort memory', async () => {
    const f = setup();
    await expect(
      f.channel.handle('controller', {
        op: 'effort',
        ownerGeneration: 7,
        agent: 'codex',
        providerId: 'xd',
        modelId: 'shown',
        effort: null,
      }),
    ).resolves.toEqual({
      ok: true,
      ownerGeneration: 7,
      catalogChanged: false,
      value: { 'codex:*': { shown: 'high' } },
    });
    expect(f.deps.applyEffort).toHaveBeenCalledWith({
      agent: 'codex',
      providerId: 'xd',
      modelId: 'shown',
      effort: null,
    });
    const list = (await f.channel.handle('controller', { op: 'list' })) as { efforts: unknown };
    expect(list.efforts).toEqual({ 'codex:*': { shown: 'high' } });
  });

  it('edits a custom model on the instance and scans the instance CLIs', async () => {
    const f = setup();
    const edit = { kind: 'capability', media: 'image', value: 'edit' } as const;
    await expect(
      f.channel.handle('controller', {
        op: 'model-edit',
        ownerGeneration: 7,
        providerId: 'web-1',
        agent: 'codex',
        modelId: 'm',
        edit,
      }),
    ).resolves.toMatchObject({ catalogChanged: true });
    expect(f.deps.editModel).toHaveBeenCalledWith(
      { providerId: 'web-1', agent: 'codex', modelId: 'm', edit },
      expect.objectContaining({ assertCurrent: expect.any(Function) }),
    );
    f.call.mockResolvedValueOnce({ detections: [] });
    await expect(
      f.channel.handle('controller', { op: 'cli-scan', ownerGeneration: 7 }),
    ).resolves.toMatchObject({ value: { detections: [] } });
    expect(f.call).toHaveBeenLastCalledWith('maker:provider:local-cli-scan', [], expect.anything());
  });

  it('runs only guest share actions on the instance', async () => {
    const f = setup();
    const share = (command: unknown) =>
      f.channel.handle('controller', { op: 'share', ownerGeneration: 7, command });
    await expect(
      share({ action: 'set-credential-consent', shareId: 's1', skip: true }),
    ).resolves.toMatchObject({
      value: { command: { action: 'set-credential-consent', shareId: 's1', skip: true } },
    });
    await share({ action: 'leave', memberId: 'm1' });
    expect(f.deps.shareCommand).toHaveBeenCalledTimes(2);
    // The share's quota and usage as this instance (the member) reads them.
    await expect(share({ action: 'insights', shareId: 's1', includeUsage: false })).resolves.toMatchObject({
      value: { command: { action: 'insights', shareId: 's1', includeUsage: false } },
    });
    expect(f.deps.shareCommand).toHaveBeenCalledTimes(3);
    for (const forbidden of [
      { action: 'create-link', providerId: 'xd' },
      { action: 'approve', requestId: 'r1' },
      { action: 'send-request', link: 'cindy://provider-share/join?x=1' },
      { action: 'insights', shareId: 's1' },
    ])
      await expect(share(forbidden)).rejects.toThrow('[INVALID_PARAMS]');
    expect(f.deps.shareCommand).toHaveBeenCalledTimes(3);
  });
});

describe('cloud provider setup over the channel', () => {
  const userProvider = {
    id: 'web-1',
    name: 'Gateway',
    source: 'user',
    routing: {
      codex: { upstream: 'https://gateway.example.test/v1', wireProtocol: 'openai-chat' },
    },
    models: { codex: [] },
  };
  function withSetup(native: (channel: string, args: unknown[]) => unknown = () => ({ ok: true })) {
    const stages = { stage: vi.fn(() => 'stage-1'), result: vi.fn(() => ({ status: 'pending' })) };
    const control = {
      status: vi.fn(() => ({ state: 'ok', source: 'server' })),
      retry: vi.fn(async () => ({ state: 'ok' })),
      rotate: vi.fn(async () => ({ state: 'ok', rotated: true })),
      byokStatus: vi.fn(() => ({ state: 'ready', providers: [] })),
      byokRetry: vi.fn(async () => ({ state: 'ready', providers: [] })),
    };
    const call = vi.fn(async (channel: string, args: unknown[]) =>
      channel === 'maker:provider:list'
        ? { providers: [userProvider], providerOrder: [] }
        : native(channel, args),
    );
    const h = setup({
      call,
      setup: {
        secretFree: (request: Record<string, unknown>) =>
          !request.apiKey && !(request.headers && Object.keys(request.headers).length),
        ...stages,
      } as never,
      modelAccess: () => control,
      xdKey: 'api_key',
    });
    return { h: Object.assign(h, { call }), stages, control };
  }
  const handle = (h: ReturnType<typeof setup>, request: Record<string, unknown>) =>
    h.channel.handle('controller', { ownerGeneration: 7, ...request });

  it('keeps the routing of the owner’s own connections and the projection for the rest', async () => {
    const { h } = withSetup();
    const list = (await run(h, { op: 'list' })) as { providers: Array<{ routing: unknown }> };
    expect(list.providers[0].routing).toEqual(userProvider.routing);
    const view = (await handle(h, { op: 'provider-view', providerId: 'web-1' })) as {
      value: { routing: unknown };
    };
    expect(view.value.routing).toEqual(userProvider.routing);
    await expect(handle(h, { op: 'provider-view', providerId: 'gone' })).rejects.toThrow(
      '[NOT_FOUND]',
    );
  });

  it('writes secret-free configurations and refuses inline credentials', async () => {
    const { h } = withSetup();
    const config = { id: 'web-2', name: 'G', runtimes: { codex: { baseUrl: 'https://g.test' } } };
    await handle(h, { op: 'custom-create', config });
    expect(h.call).toHaveBeenLastCalledWith(
      'maker:provider:custom:create',
      [config, {}, { source: 'manual-settings' }],
      expect.anything(),
    );
    await expect(
      handle(h, {
        op: 'custom-update',
        config: { ...config, runtimes: { codex: { baseUrl: 'x', headers: { A: 'secret' } } } },
      }),
    ).rejects.toThrow('[INVALID_PARAMS]');
    await expect(
      handle(h, { op: 'models-fetch', request: { baseUrl: 'https://g.test', apiKey: 'typed' } }),
    ).rejects.toThrow('[INVALID_PARAMS]');
    await expect(
      handle(h, {
        op: 'test-connection',
        request: { kind: 'adhoc', spec: { baseUrl: 'https://g.test', apiKey: 'typed' } },
      }),
    ).rejects.toThrow('[INVALID_PARAMS]');
    await handle(h, {
      op: 'test-connection',
      request: { kind: 'saved', providerId: 'web-1', agent: 'codex' },
    });
    expect(h.call).toHaveBeenLastCalledWith(
      'maker:provider:test-connection',
      [{ kind: 'saved', providerId: 'web-1', agent: 'codex' }],
      expect.anything(),
      { sender: true },
    );
  });

  it('stages setup steps and reads their results through the setup store', async () => {
    const { h, stages } = withSetup();
    await expect(
      handle(h, {
        op: 'setup-stage',
        kind: 'models-fetch',
        request: { baseUrl: 'https://g.test' },
      }),
    ).resolves.toMatchObject({ value: { stageId: 'stage-1' } });
    expect(stages.stage).toHaveBeenCalledWith('owner-1:7', 'models-fetch', {
      baseUrl: 'https://g.test',
    });
    await expect(
      handle(h, { op: 'setup-result', stageId: '00000000-0000-4000-8000-000000000000' }),
    ).resolves.toMatchObject({ value: { status: 'pending' } });
  });

  it('runs Cindy AI and organization actions with the instance’s own controls', async () => {
    const { h, control } = withSetup((channel) =>
      channel === 'safe-storage-remove' ? { success: true } : undefined,
    );
    await expect(handle(h, { op: 'xd', action: 'rotate' })).resolves.toMatchObject({
      value: { rotated: true },
      catalogChanged: true,
    });
    await handle(h, { op: 'xd', action: 'disconnect' });
    expect(h.call).toHaveBeenLastCalledWith('safe-storage-remove', ['api_key'], expect.anything());
    await handle(h, { op: 'byok', action: 'retry' });
    expect(control.byokRetry).toHaveBeenCalledTimes(1);
  });

  it('reads Codex limits, resets and account usage from the native handlers', async () => {
    const { h } = withSetup();
    await handle(h, { op: 'codex-limits', providerId: 'openai-1' });
    expect(h.call).toHaveBeenLastCalledWith(
      'maker:usage:codex-rate-limits',
      ['openai-1'],
      expect.anything(),
    );
    const key = '11111111-2222-4333-8444-555555555555';
    await handle(h, { op: 'codex-reset', idempotencyKey: key });
    expect(h.call).toHaveBeenLastCalledWith(
      'maker:usage:codex-rate-limit-reset',
      [key],
      expect.anything(),
    );
    await handle(h, { op: 'account-usage', providerId: 'web-1', forceRefresh: true });
    expect(h.call).toHaveBeenLastCalledWith(
      'maker:provider:account-usage',
      [{ providerId: 'web-1', forceRefresh: true }],
      expect.anything(),
    );
  });

  it('revokes the OpenAI image key when OpenAI is removed, as the local page does', async () => {
    const { h } = withSetup((channel) => (channel === 'builtin-api-key-has' ? true : undefined));
    await handle(h, { op: 'presentation', providerId: 'openai', action: 'remove' });
    const channels = h.call.mock.calls.map((call) => call[0]);
    expect(channels).toEqual([
      'builtin-api-key-has',
      'builtin-api-key-remove',
      'maker:provider:presentation:set',
    ]);
  });
});
