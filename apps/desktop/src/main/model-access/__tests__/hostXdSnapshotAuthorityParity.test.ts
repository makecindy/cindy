/**
 * 测试价值
 * - 可观察结果：同一串账号与 `/models` 事件，桌面的模型目录同步（model-access/index.ts 的
 *   runModelsSync，桌面自己的代码）与 Host 的供应商目录（apps/host/src/agent/providers.mjs，按
 *   main.ts 的接法）在 active-catalog 里留下的 XD 快照相同：清单、权威标记、付费墓碑、XD 静态嵌入模型
 *   兜底是否还在。三串事件：成功、刷新、失败与换账号（六种情况）；冷启动首轮失败后再成功；同一账号换
 *   网关 key 后进行中、失败、再成功。
 * - 规则依据：放行表第二节「XD 快照的权威标记」。只有本轮成功的快照才能把清单里的缺席当作拒绝；
 *   Codex 代理的 grok 线路判断和子代理模型准入都读这个标记。换 owner、代次或端点才清空；只换 key
 *   保留上一份清单与付费墓碑、只撤销权威；冷启动在第一次成功之前保留嵌入模型兜底。
 * - 最小失败输入：Host 刷新进行中仍是权威；失败后仍是权威；失败后丢掉付费墓碑；第一次读取就关掉
 *   嵌入兜底；只换 key 就清空清单与墓碑。
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
import {
  getActiveCatalog, getXdGatewayModelAccessSnapshot, getXdGatewayModels, markXdGatewayModelAccessUnknown, setXdGatewayModels,
} from '../../maker-host/active-catalog.js';

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
  const xd = getActiveCatalog().providers.find(provider => provider.id === 'xd');
  return {
    authoritative: value.authoritative, models: value.models.map(m => m.id), paid: [...value.paymentRequiredModelIds].sort(),
    // The bundled XD embedding fallback: kept until the first authoritative round, off at an account boundary.
    embedding: (xd?.embeddingModels ?? []).length > 0,
  };
};
const settle = async () => { for (let i = 0; i < 25; i += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const answer = (outcome: 'ok' | 'fail') => {
  const pending = h.state.pending.shift();
  if (!pending) throw new Error('no /models request is pending');
  if (outcome === 'ok') pending.resolve(payload); else pending.reject(new Error('fixture /models failure'));
};

// Desktop: its own models sync, driven by auth and credential events, from a fresh process.
type Snapshot = ReturnType<typeof snapshot>;
const desktopRun = async (steps: (record: () => void) => Promise<void>): Promise<Snapshot[]> => {
  const out: Snapshot[] = [];
  h.state.auth = { isAuthenticated: true, user: { id: 'user-a' } };
  h.state.authListeners = [];
  initModelAccess();
  await steps(() => { out.push(snapshot()); });
  expect(h.state.pending).toEqual([]);
  resetModelAccessForTest();
  return out;
};
const credentialsReady = async () => { h.state.onStatusChange!({ state: 'ok' }); await settle(); };
const switchAccount = async (id: string) => {
  h.state.auth = { isAuthenticated: true, user: { id } };
  for (const listener of h.state.authListeners) listener(h.state.auth);
  await settle();
};

// Host: its own provider catalog with main.ts's ports, from a fresh process.
const hostRun = async (steps: (list: (options: { credential: string; ownerId: string; force?: boolean }) => Promise<unknown>, record: () => void) => Promise<void>): Promise<Snapshot[]> => {
  const out: Snapshot[] = [];
  const { createProviderCatalog } = await import(hostModule) as HostProviders;
  const list = createProviderCatalog({
    readProviders: async () => [],
    applyModels: (models: never, options: never) => setXdGatewayModels(models, options),
    readModels: () => getXdGatewayModels(),
    markModelsUnknown: () => markXdGatewayModelAccessUnknown(),
    fetchModels: async () => {
      const parsed = parseModelsSyncPayload(await h.next());
      if (!parsed.ok) throw new Error('HOST_MODEL_ACCESS_INVALID_RESPONSE');
      return parsed.models;
    },
  });
  await steps(({ credential, ownerId, force }) => list({ gateway: { endpoint: 'http://gateway.example.test', credential }, ownerId, force }), () => { out.push(snapshot()); });
  expect(h.state.pending).toEqual([]);
  resetModelAccessForTest();
  return out;
};
const inFlight = async (record: () => void) => { await settle(); record(); };

const both = ['claude-sonnet-4-5', 'claude-opus-4-1'];
const paid = ['claude-opus-4-1'];

describe('Host XD snapshot authority matches the desktop', () => {
  afterAll(() => { resetModelAccessForTest(); });

  it('leaves the same snapshot through success, refresh, failure and account changes', async () => {
    const STATES = ['first round in flight', 'success', 'next round in flight', 'failure after a success', 'account change', 'failure, never succeeded'] as const;
    const desktop = await desktopRun(async (record) => {
      await credentialsReady(); record();
      answer('ok'); await settle(); record();
      await credentialsReady(); record();
      answer('fail'); await settle(); record();
      await switchAccount('user-b'); record();
      await credentialsReady(); answer('fail'); await settle(); record();
    });
    const host = await hostRun(async (list, record) => {
      let call = list({ credential: 'key-a', ownerId: 'owner-a' });
      await inFlight(record); answer('ok'); await call; record();
      call = list({ credential: 'key-a', ownerId: 'owner-a', force: true });
      await inFlight(record); answer('fail'); await call; record();
      call = list({ credential: 'key-b', ownerId: 'owner-b' });
      await inFlight(record); answer('fail'); await call; record();
    });
    expect(Object.fromEntries(STATES.map((state, i) => [state, host[i]])))
      .toEqual(Object.fromEntries(STATES.map((state, i) => [state, desktop[i]])));
    // What the states are, so a change on both sides cannot pass unnoticed.
    expect(desktop).toEqual([
      { authoritative: false, models: [], paid: [], embedding: true },
      { authoritative: true, models: both, paid, embedding: false },
      { authoritative: false, models: both, paid, embedding: false },
      { authoritative: false, models: ['claude-sonnet-4-5'], paid, embedding: false },
      { authoritative: false, models: [], paid: [], embedding: false },
      { authoritative: false, models: [], paid: [], embedding: false },
    ]);
  });

  it('keeps the bundled embedding fallback through a failed first round after a cold start', async () => {
    const STATES = ['first round in flight', 'first round failed', 'second round in flight', 'first success'] as const;
    const desktop = await desktopRun(async (record) => {
      await credentialsReady(); record();
      answer('fail'); await settle(); record();
      await credentialsReady(); record();
      answer('ok'); await settle(); record();
    });
    const host = await hostRun(async (list, record) => {
      let call = list({ credential: 'key-a', ownerId: 'owner-a' });
      await inFlight(record); answer('fail'); await call; record();
      call = list({ credential: 'key-a', ownerId: 'owner-a' });
      await inFlight(record); answer('ok'); await call; record();
    });
    expect(Object.fromEntries(STATES.map((state, i) => [state, host[i]])))
      .toEqual(Object.fromEntries(STATES.map((state, i) => [state, desktop[i]])));
    expect(desktop).toEqual([
      { authoritative: false, models: [], paid: [], embedding: true },
      { authoritative: false, models: [], paid: [], embedding: true },
      { authoritative: false, models: [], paid: [], embedding: true },
      { authoritative: true, models: both, paid, embedding: false },
    ]);
  });

  it('keeps the last list and payment refusals, non-authoritative, when the same account rotates its key', async () => {
    const STATES = ['success', 'rotated key in flight', 'failure after the rotation', 'success with the rotated key'] as const;
    const desktop = await desktopRun(async (record) => {
      await credentialsReady(); answer('ok'); await settle(); record();
      await credentialsReady(); record();
      answer('fail'); await settle(); record();
      await credentialsReady(); answer('ok'); await settle(); record();
    });
    const host = await hostRun(async (list, record) => {
      let call = list({ credential: 'key-a', ownerId: 'owner-a' });
      await settle(); answer('ok'); await call; record();
      call = list({ credential: 'key-b', ownerId: 'owner-a' });
      await inFlight(record); answer('fail'); await call; record();
      call = list({ credential: 'key-b', ownerId: 'owner-a' });
      await settle(); answer('ok'); await call; record();
    });
    expect(Object.fromEntries(STATES.map((state, i) => [state, host[i]])))
      .toEqual(Object.fromEntries(STATES.map((state, i) => [state, desktop[i]])));
    expect(desktop).toEqual([
      { authoritative: true, models: both, paid, embedding: false },
      { authoritative: false, models: both, paid, embedding: false },
      { authoritative: false, models: ['claude-sonnet-4-5'], paid, embedding: false },
      { authoritative: true, models: both, paid, embedding: false },
    ]);
  });
});

