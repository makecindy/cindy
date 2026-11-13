/**
 * 测试价值
 * - 可观察结果：同一串账号与 `/models` 事件，桌面的模型目录同步（model-access/index.ts 的
 *   runModelsSync，桌面自己的代码）与 Host 的供应商目录（apps/host/src/agent/providers.mjs，按
 *   main.ts 的接法）在 active-catalog 里留下的 XD 快照相同：清单、权威标记、付费墓碑。六种情况：
 *   首轮进行中（从未成功）、成功、再次进行中（之前成功）、失败（之前成功）、换账号、失败（从未成功）。
 * - 规则依据：放行表第二节「XD 快照的权威标记」。只有本轮成功的快照才能把清单里的缺席当作拒绝；
 *   Codex 代理的 grok 线路判断和子代理模型准入都读这个标记。
 * - 最小失败输入：Host 刷新进行中仍是权威；失败后仍是权威；失败后丢掉付费墓碑。
 * - tier：unit（两边都在进程内；`/models` 请求由测试控制，不连网）。
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
  const state = {
    auth: { isAuthenticated: true, user: { id: 'user-a' } } as { isAuthenticated: boolean; user: { id: string } | null },
    authListeners: [] as Array<(auth: { isAuthenticated: boolean; user: { id: string } | null }) => void>,
    onStatusChange: null as null | ((status: { state: string }) => void),
    pending: [] as Pending[],
  };
  const next = () => new Promise((resolve, reject) => { state.pending.push({ resolve, reject }); });
  return { state, next };
});

vi.mock('electron', () => ({
  app: { on: () => {}, removeListener: () => {}, isPackaged: true, getPath: () => '/nonexistent' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {} },
}));
vi.mock('../../authManager.js', () => ({
  onAuthStateChange: (listener: (auth: typeof h.state.auth) => void) => { h.state.authListeners.push(listener); },
  getAuthState: () => h.state.auth,
  getActiveAuthRealm: () => 'global',
}));
vi.mock('../../serverApiClient.desktop.js', () => ({
  serverApiFetch: () => h.next(),
  ServerApiError: class ServerApiError extends Error {},
}));
vi.mock('../credentialsSync.js', () => ({
  createCredentialsSync: (deps: { onStatusChange: (status: { state: string }) => void }) => {
    h.state.onStatusChange = deps.onStatusChange;
    return {
      getStatus: () => ({ state: 'ok' }), sync: async () => ({ state: 'ok' }), retry: async () => ({ state: 'ok' }),
      rotate: async () => ({ state: 'ok' }), resyncAfterKeyRejection: async () => {}, handleAuthChange: () => {},
      handleProviderAccessChange: () => {},
    };
  },
}));
vi.mock('../../maker-host/index.js', () => ({
  scheduleCodexGatewayKeyRefresh: () => {}, prepareCodexForCustomProviderHostChange: async () => {},
  finalizeCodexAfterAuthModeChange: () => {}, cancelCodexAuthModeChange: () => {},
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  getProviderSecretStore: () => ({ get: () => null, set: () => true }), byokSnapshotSecretIo: {},
}));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'http://model-access.example.test' }));
vi.mock('../../usage/modelPricing.js', () => ({ replaceGatewayModelPricing: () => ({ xd: {} }), trackGatewayModelPricingSync: () => {} }));
vi.mock('../../usage/referenceModelPricing.js', () => ({ broadcastReferenceModelPricing: () => {} }));
vi.mock('../byokIpc.js', () => ({ registerByokIpc: () => {} }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: () => {} }));
vi.mock('../byokRuntime.js', () => ({ createByokRuntime: () => ({ setOwner: () => {}, sync: async () => {}, getStatus: () => ({}) }) }));
vi.mock('../byokCache.js', () => ({ createByokCache: () => ({}) }));
vi.mock('../credentialsStore.js', () => ({ getModelAccessCredentialsStore: () => ({}) }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../gatewayKeyRejection.js', () => ({ installCindyGatewayKeyRejectionReporter: () => {}, noteCindyGatewayKeyReplaced: () => {} }));
vi.mock('../../cindy-brain/ghostSetupChangeBus.js', () => ({ getGhostSetupChangeBus: () => ({ emitAll: () => {} }) }));
vi.mock('../mediaModels.js', () => ({ listExecutableMediaModels: async () => ({ unavailable: [] }), resetExecutableMediaModelCache: () => {} }));
vi.mock('../quotaCredentialState.js', () => ({ cloudQuotaOwnerKey: () => 'owner', noteQuotaCredentialStatus: () => {}, setQuotaCredentialStatusReader: () => {} }));
vi.mock('../../maker-host/model-disable-store.js', () => ({
  migrateLegacyNamespacedModelDisableOverrides: () => {}, onProviderDisableChange: () => () => {}, readModelDisableOverrides: () => ({}),
}));

import { initModelAccess, resetModelAccessForTest } from '../index.js';
import { parseModelsSyncPayload } from '../modelsSyncRefresh.js';
import { getXdGatewayModelAccessSnapshot, markXdGatewayModelAccessUnknown, setXdGatewayModels } from '../../maker-host/active-catalog.js';

// providers.mjs is JavaScript without declarations; the shape this test calls.
type HostProviders = { createProviderCatalog: (ports: Record<string, unknown>) =>
  (options: { gateway?: { endpoint: string; credential: string }; ownerId: string; force?: boolean }) => Promise<unknown> };
const hostModule = '../../../../../host/src/agent/providers.mjs';

const model = (id: string, availability: 'available' | 'requires_payment') => ({
  id, name: id, contextWindow: 200_000, currency: 'USD', agents: ['claude-code', 'codex'], mode: 'chat',
  icon: 'anthropic', modalities: { input: ['text'], output: ['text'] }, availability,
  perAgent: { 'claude-code': { wireProtocol: 'anthropic-messages' }, codex: { wireProtocol: 'openai-responses' } },
});
const payload = { schemaVersion: 5, accountTier: 'paid', models: [model('claude-sonnet-4-5', 'available'), model('claude-opus-4-1', 'requires_payment')] };

const snapshot = () => {
  const value = getXdGatewayModelAccessSnapshot();
  return { authoritative: value.authoritative, models: value.models.map(m => m.id), paid: [...value.paymentRequiredModelIds].sort() };
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const answer = (outcome: 'ok' | 'fail') => {
  const pending = h.state.pending.shift();
  if (!pending) throw new Error('no /models request is pending');
  if (outcome === 'ok') pending.resolve(payload); else pending.reject(new Error('fixture /models failure'));
};

const STATES = ['first round in flight', 'success', 'next round in flight', 'failure after a success', 'account change', 'failure, never succeeded'] as const;

describe('Host XD snapshot authority matches the desktop', () => {
  afterAll(() => { resetModelAccessForTest(); setXdGatewayModels([]); });

  it('leaves the same snapshot through success, refresh, failure and account changes', async () => {
    // Desktop: its own models sync, driven by auth and credential events.
    const desktop: Array<ReturnType<typeof snapshot>> = [];
    initModelAccess();
    h.state.onStatusChange!({ state: 'ok' });
    await settle(); desktop.push(snapshot());
    answer('ok'); await settle(); desktop.push(snapshot());
    h.state.onStatusChange!({ state: 'ok' });
    await settle(); desktop.push(snapshot());
    answer('fail'); await settle(); desktop.push(snapshot());
    h.state.auth = { isAuthenticated: true, user: { id: 'user-b' } };
    for (const listener of h.state.authListeners) listener(h.state.auth);
    await settle(); desktop.push(snapshot());
    h.state.onStatusChange!({ state: 'ok' });
    await settle(); answer('fail'); await settle(); desktop.push(snapshot());
    expect(h.state.pending).toEqual([]);
    resetModelAccessForTest();
    setXdGatewayModels([]);

    // Host: its own provider catalog with main.ts's ports.
    const { createProviderCatalog } = await import(hostModule) as HostProviders;
    const list = createProviderCatalog({
      readProviders: async () => [],
      applyModels: (models: never, options: never) => setXdGatewayModels(models, options),
      markModelsUnknown: () => markXdGatewayModelAccessUnknown(),
      fetchModels: async () => {
        const parsed = parseModelsSyncPayload(await h.next());
        if (!parsed.ok) throw new Error('HOST_MODEL_ACCESS_INVALID_RESPONSE');
        return parsed.models;
      },
    });
    const host: Array<ReturnType<typeof snapshot>> = [];
    const gateway = (credential: string) => ({ endpoint: 'http://gateway.example.test', credential });
    let call = list({ gateway: gateway('key-a'), ownerId: 'owner' });
    await settle(); host.push(snapshot());
    answer('ok'); await call; host.push(snapshot());
    call = list({ gateway: gateway('key-a'), ownerId: 'owner', force: true });
    await settle(); host.push(snapshot());
    answer('fail'); await call; host.push(snapshot());
    call = list({ gateway: gateway('key-b'), ownerId: 'owner' });
    await settle(); host.push(snapshot());
    answer('fail'); await call; host.push(snapshot());
    expect(h.state.pending).toEqual([]);

    expect(Object.fromEntries(STATES.map((state, i) => [state, host[i]])))
      .toEqual(Object.fromEntries(STATES.map((state, i) => [state, desktop[i]])));
    // What the five states are, so a change on both sides cannot pass unnoticed.
    expect(desktop).toEqual([
      { authoritative: false, models: [], paid: [] },
      { authoritative: true, models: ['claude-sonnet-4-5', 'claude-opus-4-1'], paid: ['claude-opus-4-1'] },
      { authoritative: false, models: ['claude-sonnet-4-5', 'claude-opus-4-1'], paid: ['claude-opus-4-1'] },
      { authoritative: false, models: ['claude-sonnet-4-5'], paid: ['claude-opus-4-1'] },
      { authoritative: false, models: [], paid: [] },
      { authoritative: false, models: [], paid: [] },
    ]);
  });
});

describe('the Host wiring the parity drives', () => {
  it('is main.ts: the catalog writes and the unknown mark go to the shared active catalog', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const main = fs.readFileSync(path.join(__dirname, '../../../../../host/src/main.ts'), 'utf8');
    expect(main).toContain('    setXdGatewayModels(models, options);\n');
    expect(main).toContain('  markModelsUnknown: () => markXdGatewayModelAccessUnknown(),\n');
    expect(main).toContain('const parsed = parseModelsSyncPayload(payload);');
  });
});
