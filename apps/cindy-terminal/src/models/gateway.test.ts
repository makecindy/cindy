import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import { TerminalSecretStore } from '../secrets.js';
import { TerminalModelConfig, closeModelFixtureDatabases } from '../testing/model-config.js';
import { TerminalGateway } from './gateway.js';
import { createTerminalPricing } from './pricing.js';
import { createProviderProxy } from './proxy.js';
import {connectedModels} from '../client-operations.js';
import type {TerminalClient} from '../contracts.js';

const cleanup: Array<() => Promise<unknown>> = [];
const roots: string[] = [];
const pricingFor = (root: string, models: TerminalModelConfig, assertCurrent: () => void) => createTerminalPricing({
  profileDir: root, models, region: 'global', getOwnerId: () => 'database-owner-hash', assertCurrent,
  logger: { debug() {}, info() {}, warn() {}, error() {} }, emit() {},
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeModelFixtureDatabases();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Integration: terminal login previously never loaded account model grants.
// Exercise the real catalog, encrypted vault and outbound proxy; only HTTP is a fixture.
it('loads an account catalog, uses its credentials and keeps payment denial across a failed refresh', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-gateway-'));
  roots.push(root);
  const secrets = new TerminalSecretStore(root);
  await secrets.initialize('machine');
  let base = '',
    upstreamStatus = 200,
    modelFailure = false,
    apiKey = 'gateway-fixture-first',
    credentialCalls = 0;
  const messages: Array<{ path: string; credential: string }> = [],
    visible: unknown[] = [];
  const api = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.startsWith('/api/model-catalog/catalog')) {
      res.end(JSON.stringify(BUNDLED_CATALOG));
      return;
    }
    if (
      [
        '/upstream/v1/messages',
        '/upstream/v1/responses',
        '/upstream/v1/chat/completions',
      ].includes(req.url ?? '')
    ) {
      messages.push({
        path: req.url!,
        credential: String(
          req.headers.authorization ?? req.headers['x-api-key'],
        ),
      });
      res.writeHead(upstreamStatus).end(JSON.stringify(upstreamStatus === 401 ? { error: { message: 'Fixture credential expired' } } : { output_text: 'GATEWAY_OK' }));
      return;
    }
    if (req.headers.authorization !== 'Bearer account-fixture') {
      res.writeHead(401).end('{}');
      return;
    }
    if (req.url?.startsWith('/api/model-access/credentials')) {
      credentialCalls++;
      res.end(JSON.stringify({ endpoint: base + '/upstream', apiKey }));
      return;
    }
    if (req.url?.startsWith('/api/model-access/models')) {
      if (modelFailure) {
        res.writeHead(503).end('{}');
        return;
      }
      expect(req.headers['x-cindy-model-capabilities']).toBe(
        'audio_speech,display_pricing',
      );
      const model = {
        id: 'terminal-fixture',
        name: 'Terminal fixture',
        contextWindow: 128000,
        currency: 'CNY', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015,
        agents: ['claude-code', 'codex', 'pi'],
        mode: 'chat',
        modalities: { input: ['text'], output: ['text'] },
        availability: 'available',
        perAgent: {
          'claude-code': { wireProtocol: 'anthropic-messages' },
          codex: { wireProtocol: 'openai-responses' },
          pi: { wireProtocol: 'openai-completions' },
        },
      };
      res.end(
        JSON.stringify({
          schemaVersion: 5,
          accountTier: 'free',
          models: [
            model,
            { ...model, id: 'paid-fixture', availability: 'requires_payment' },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        api.closeAllConnections();
        api.close(() => resolve());
      }),
  );
  const models = new TerminalModelConfig(root, secrets, async () => ({
    authenticated: false,
  }));
  await models.open();
  let active = true;
  const pricing = pricingFor(root, models, () => { if (!active) throw new Error('OWNER_CHANGED'); });
  const gateway = new TerminalGateway({
    root,
    models,
    pricing,
    secrets,
    endpoint: () => base,
    fallbackEndpoint: () => base,
    identity: () => ({ userId: 'owner-a', realm: 'global' }),
    token: () => 'account-fixture',
    refreshToken: async () => {},
    assertCurrent: () => {
      if (!active) throw new Error('OWNER_CHANGED');
    },
    changed: (status) => visible.push(status),
  });
  cleanup.push(() => gateway.close());
  await gateway.start();
  expect(gateway.status()).toMatchObject({ state: 'ok', accountTier: 'free' });
  // The authenticated account owns prices even when its physical SQLite owner
  // ID is hashed; a Global build still retains this account's declared CNY.
  expect(pricing.currentLedgerCurrency()).toBe('CNY');
  expect(await pricing.getGatewayAccountCurrency()).toBe('CNY');
  expect(await pricing.getGatewayModelPricingForModel()).toMatchObject({ xd: {
    'terminal-fixture': { currency: 'CNY', inputPerMtok: 3, outputPerMtok: 15 },
  } });
  for (const agentKind of ['claude-code', 'codex', 'pi'] as const) {
    const chosen = await models.select({
      providerId: 'xd',
      model: 'terminal-fixture',
      agentKind,
    });
    expect(chosen.route.routing.upstream).toBe(base + '/upstream');
  }
  // Actual SDK URL conventions differ; a fixture accepting every path hid the
  // missing /v1 bug caught by the first real Pi account-model request.
  for (const [agentKind, resource] of [
    ['claude-code', '/v1/messages'],
    ['codex', '/responses'],
    ['pi', '/chat/completions'],
  ] as const) {
    const chosen = await models.select({
      providerId: 'xd',
      model: 'terminal-fixture',
      agentKind,
    });
    const proxy = await createProviderProxy(
      chosen.route,
      agentKind,
      await models.credential('xd', agentKind),
      {},
    );
    try {
      const response = await fetch(proxy.url + resource, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${proxy.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'terminal-fixture',
          input: 'check gateway routing',
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        output_text: 'GATEWAY_OK',
      });
    } finally {
      await proxy.close();
    }
  }
  expect(messages).toEqual([
    { path: '/upstream/v1/messages', credential: 'gateway-fixture-first' },
    {
      path: '/upstream/v1/responses',
      credential: 'Bearer gateway-fixture-first',
    },
    {
      path: '/upstream/v1/chat/completions',
      credential: 'Bearer gateway-fixture-first',
    },
  ]);
  // A normal task request must report the exact rejected credential, rather
  // than leaving account-model availability silently connected after a 401.
  upstreamStatus = 401;
  const rejected: Array<string | null> = [];
  const chosen = await models.select({ providerId: 'xd', model: 'terminal-fixture', agentKind: 'codex' });
  const rejectedProxy = await createProviderProxy(chosen.route, 'codex', await models.credential('xd', 'codex'), {}, undefined, key => { rejected.push(key); });
  try {
    const response = await fetch(rejectedProxy.url + '/responses', {
      method: 'POST', headers: { authorization: `Bearer ${rejectedProxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'terminal-fixture', input: 'check expired credential' }),
    });
    expect(response.status).toBe(401);
    await response.text();
    expect(rejected).toEqual(['gateway-fixture-first']);
  } finally { await rejectedProxy.close(); }
  upstreamStatus = 200;
  modelFailure = true;
  await expect(gateway.refresh()).rejects.toThrow(
    'MODEL_ACCESS_REQUEST_FAILED',
  );
  expect(credentialCalls).toBe(1);
  await expect(
    models.select({
      providerId: 'xd',
      model: 'paid-fixture',
      agentKind: 'codex',
    }),
  ).rejects.toThrow();
  expect(
    (
      await models.select({
        providerId: 'xd',
        model: 'terminal-fixture',
        agentKind: 'codex',
      })
    ).selection.model,
  ).toBe('terminal-fixture');
  apiKey = 'gateway-fixture-rotated';
  await gateway.rotate();
  expect(await models.credential('xd', 'codex')).toBe(apiKey);
  const disk = await readFile(path.join(root, 'secrets.enc'), 'utf8');
  expect(disk).not.toContain(apiKey);
  expect(JSON.stringify(visible)).not.toContain(apiKey);
  const savedCredentials = await secrets.get('terminal:gateway');
  apiKey = 'gateway-fixture-write-failed';
  const failedWrite = vi.spyOn(secrets, 'set').mockRejectedValueOnce(new Error('EIO'));
  expect(await gateway.rotate()).toMatchObject({ state: 'failed', errorCode: 'SAFE_STORAGE_UNAVAILABLE' });
  failedWrite.mockRestore();
  expect(await secrets.get('terminal:gateway')).toBe(savedCredentials);
  expect(gateway.credentials()?.apiKey).toBe('gateway-fixture-rotated');
  const other = new TerminalModelConfig(
    path.join(root, 'other'),
    secrets,
    async () => ({ authenticated: false }),
  );
  await other.open();
  expect(
    (await other.views()).find((provider) => provider.id === 'xd')?.connected,
  ).toBe(false);
  expect(other.catalogRuntime.getXdGatewayModels()).toEqual([]);
  active = false;
  expect(gateway.credentials()).toBeNull();
  await expect(gateway.refresh()).rejects.toThrow('OWNER_CHANGED');
});

// Integration: a credential response racing an account switch must never
// establish a key for that owner's replacement or write the old key to disk.
it('discards a late credential response after the owner lease is revoked', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-gateway-owner-'));
  roots.push(root);
  const secrets = new TerminalSecretStore(root); await secrets.initialize('machine');
  const models = new TerminalModelConfig(root, secrets, async () => ({ authenticated: false })); await models.open();
  let active = true, release!: (response: Response) => void, started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const fetchFixture: typeof fetch = async url => {
    if (String(url).includes('/api/model-access/credentials')) { started(); return new Promise<Response>(resolve => { release = resolve; }); }
    return Response.json(BUNDLED_CATALOG);
  };
  const gateway = new TerminalGateway({ root, models, pricing: pricingFor(root, models, () => { if (!active) throw new Error('OWNER_CHANGED'); }), secrets, endpoint: () => 'https://account.example.invalid', fallbackEndpoint: () => 'https://catalog.example.invalid',
    identity: () => ({ userId: 'owner-a', realm: 'global' }), token: () => 'fixture-account-token', refreshToken: async () => {},
    assertCurrent: () => { if (!active) throw new Error('OWNER_CHANGED'); }, changed() {}, fetch: fetchFixture,
  }); cleanup.push(() => gateway.close());
  const pending = gateway.start();
  const rejected = expect(pending).rejects.toThrow('OWNER_CHANGED');
  await entered; active = false;
  release(Response.json({ endpoint: 'https://gateway.example.invalid', apiKey: 'old-owner-key' }));
  await rejected;
  expect(await secrets.get('terminal:gateway')).toBeNull();
  expect(gateway.credentials()).toBeNull();
  expect(models.catalogRuntime.getXdGatewayModels()).toEqual([]);
});

// Integration: provider:list over device-link must not start native status or
// authenticated discovery. Existing gateway tests only exercised owner reads.
// Minimal regression: a connected native account, then a snapshot read before
// and after the owner explicitly loads its models. Only native I/O is replaced.
it('keeps remote provider snapshots read-only while owner reads discover native models', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-provider-snapshot-'));
  roots.push(root);
  const secrets = new TerminalSecretStore(root); await secrets.initialize('machine');
  const nativeStatus = vi.fn(async () => ({authenticated:true}));
  const discover = vi.fn(async () => [{id:'snapshot-fixture',name:'Snapshot fixture',contextWindow:200000,efforts:[],defaultEffort:null}]);
  const models = new TerminalModelConfig(root, secrets, nativeStatus, BUNDLED_CATALOG, discover);
  await models.open();
  await models.views({allowSideEffects:false, snapshotOnly:true});
  expect(nativeStatus).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
  await models.views({allowSideEffects:true, waitForDiscovery:true});
  expect(discover).toHaveBeenCalled();
  nativeStatus.mockClear(); discover.mockClear();
  const snapshot = await models.views({allowSideEffects:false, snapshotOnly:true});
  expect(snapshot.find(provider => provider.id === 'anthropic')).toMatchObject({connected:true});
  expect(snapshot.find(provider => provider.id === 'anthropic')?.models['claude-code']).toEqual(expect.arrayContaining([expect.objectContaining({id:'snapshot-fixture'})]));
  expect(nativeStatus).not.toHaveBeenCalled();
  expect(discover).not.toHaveBeenCalled();
});

// Integration: the headless host used to omit model visibility and GUI owner
// stamps. Exercise the same preference service through real Node DB/storage,
// reopen it, then project the ordinary provider:list payload. Native I/O alone
// is replaced. A hidden model remains executable when explicitly selected.
it('persists original model visibility without a renderer and scopes remote snapshots to the owner', async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),'cindy-model-visibility-'));
  roots.push(root);
  const secrets=new TerminalSecretStore(root);await secrets.initialize('machine');
  const native=async()=>({authenticated:true});
  const discover=async()=>[{id:'visibility-fixture',name:'Visibility fixture',contextWindow:200000,efforts:[],defaultEffort:null}];
  const models=new TerminalModelConfig(root,secrets,native,BUNDLED_CATALOG,discover);await models.open();
  await models.views({allowSideEffects:true,waitForDiscovery:true});
  cleanup.push(()=>models.close());
  const providers=await models.views({allowSideEffects:false});
  const anthropic=providers.find(provider=>provider.id==='anthropic')!;
  const model=anthropic.models['claude-code']![0]!;
  await models.setVisibility('claude-code',anthropic.id,[model.id],false);
  const restarted=new TerminalModelConfig(root,secrets,native,BUNDLED_CATALOG,discover);await restarted.open();
  await restarted.views({allowSideEffects:true,waitForDiscovery:true});
  cleanup.push(()=>restarted.close());
  const owner={dataOwnerId:'fixture-owner',generation:7};
  const snapshot=await restarted.providerListSnapshot(await restarted.views({allowSideEffects:false}),owner);
  expect(snapshot).toMatchObject({dataOwnerId:'fixture-owner',ownerGeneration:7,
    modelVisibilityOverrides:{[`claude-code:anthropic:${model.id}`]:false}});
  expect(snapshot.providers.find(provider=>provider.id==='anthropic')?.models['claude-code']?.find(item=>item.id===model.id)?.disabled).not.toBe(true);
  const client={invoke:async(channel:string)=>channel==='maker:provider:list'?snapshot:restarted.snapshot()} as TerminalClient;
  expect(await connectedModels(client)).not.toEqual(expect.arrayContaining([expect.objectContaining({providerId:'anthropic',agentKind:'claude-code',model:model.id})]));
  await expect(restarted.select({agentKind:'claude-code',providerId:'anthropic',model:model.id})).resolves.toMatchObject({selection:{model:model.id}});
  const other=new TerminalModelConfig(path.join(root,'other'),secrets,native);await other.open();
  cleanup.push(()=>other.close());
  const isolated=await other.providerListSnapshot(await other.views({allowSideEffects:false}),{dataOwnerId:'other-owner',generation:8});
  expect(isolated.modelVisibilityOverrides[`claude-code:anthropic:${model.id}`]).not.toBe(false);
});
