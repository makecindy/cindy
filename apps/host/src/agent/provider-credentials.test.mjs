import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderRouteResolver } from './provider-credentials.mjs';
import { dataOwnerStorageKey } from '../../../desktop/src/main/dataOwnerPath.ts';
import { createProviderCatalog } from './providers.mjs';
import { fetchGatewayCredentials } from './gateway.mjs';

// Fresh-profile regression: no copied desktop vault is needed after login.
// Unit: the production provisioning adapter must validate the response and
// preserve HTTP failures without returning keys in its error messages.
test('fresh Host login provisions a validated gateway connection', async () => {
  const connection = await fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async (url, options) => {
    assert.ok(url.endsWith('/api/model-access/credentials'));
    assert.equal(options.headers.authorization, 'Bearer test-session');
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ apiKey: 'test-key', endpoint: 'https://gateway.example/' }) };
  } });
  assert.deepEqual(connection, { credential: 'test-key', endpoint: 'https://gateway.example' });
  assert.equal(await fetchGatewayCredentials({ sessionToken: null, region: 'global', request: () => { throw Error('must not request'); } }), null);
  await assert.rejects(fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async () => ({ ok: false, status: 403 }) }), /HOST_MODEL_ACCESS_HTTP_403/);
  await assert.rejects(fetchGatewayCredentials({ sessionToken: 'test-session', region: 'global', request: async () => ({ ok: true, json: async () => ({ apiKey: 'test-key', endpoint: 'file:///tmp' }) }) }), /HOST_MODEL_ACCESS_INVALID_RESPONSE/);
});

test('custom providers resolve only their own runtime credential and never reuse a gateway key', async () => {
  const reads = [];
  const resolve = createProviderRouteResolver({ ownerId: 'owner', catalog: async () => ({ providers: [{
    id: 'vendor', auth: { method: 'apiKey' }, routing: {
      'claude-code': { upstream: 'https://vendor.example/v1' },
      codex: { upstream: 'https://codex.example/v1' },
    },
  }] }), store: { read: key => { reads.push(key); return key.endsWith('_codex') ? 'codex-secret' : null; } } });
  await assert.rejects(resolve('vendor', 'claude-code'), /Connect this provider/);
  assert.equal((await resolve('vendor', 'codex')).apiKey, 'codex-secret');
  assert.deepEqual(reads, ['claude-code', 'codex'].map(agent => `owner_${dataOwnerStorageKey('owner')}_provider_key_vendor_${agent}`));
  await assert.rejects(resolve('unknown', 'codex'), /not configured/);
  assert.equal(await resolve('xd', 'codex'), null);
});

// A fake of the active-catalog XD snapshot with the setter semantics the catalog relies on: the list,
// the authority mark and the payment refusals (kept only when the caller asks to preserve them).
const fakeSnapshot = () => {
  const state = { models: [], authoritative: false, paid: [] };
  return {
    state,
    applyModels: (models, options) => {
      state.models = models;
      state.authoritative = options.authoritative;
      if (!options.preservePaymentRequiredRoutes) state.paid = models.filter(m => m.availability === 'requires_payment').map(m => m.id);
    },
    readModels: () => state.models,
    markModelsUnknown: () => { state.authoritative = false; },
  };
};

test('after an owner, generation or endpoint change, a failed refresh does not expose the old list', async () => {
  for (const change of ['owner', 'generation', 'endpoint']) {
    const snapshot = fakeSnapshot();
    let fail = false;
    const list = createProviderCatalog({ ...snapshot,
      readProviders: async () => snapshot.state.models.length ? [{ id: 'xd', models: snapshot.state.models }] : [],
      fetchModels: async () => {
        if (fail) throw new Error('denied');
        return [{ id: 'private-model' }, { id: 'paid-model', availability: 'requires_payment' }];
      } });
    const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
    assert.equal((await list({ gateway, ownerId: 'a', ownerGeneration: 1 })).providers.length, 1, change);
    fail = true;
    const next = change === 'owner' ? { gateway, ownerId: 'b', ownerGeneration: 1 }
      : change === 'generation' ? { gateway, ownerId: 'a', ownerGeneration: 2 }
        : { gateway: { ...gateway, endpoint: 'https://other-gateway.example' }, ownerId: 'a', ownerGeneration: 1 };
    const result = await list(next);
    assert.ok(result.error, change);
    assert.equal(result.providers.length, 0, change);
    assert.deepEqual(snapshot.state, { models: [], authoritative: false, paid: [] }, change);
  }
});

test('after a key-only change, a failed refresh keeps the old list and payment refusals, non-authoritative', async () => {
  const snapshot = fakeSnapshot();
  const credentials = [];
  const list = createProviderCatalog({ ...snapshot,
    readProviders: async () => [{ id: 'xd', models: snapshot.state.models }],
    fetchModels: async ({ credential }) => {
      credentials.push(credential);
      if (credential !== 'account-a-key') throw new Error('denied');
      return [{ id: 'private-model' }, { id: 'paid-model', availability: 'requires_payment' }];
    } });
  const gateway = { endpoint: 'https://gateway.example', credential: 'account-a-key' };
  await list({ gateway, ownerId: 'a' });
  assert.deepEqual(snapshot.state.paid, ['paid-model']);
  assert.equal(snapshot.state.authoritative, true);
  // The rotated key is refetched at once, without waiting for the five-minute cache.
  const result = await list({ gateway: { ...gateway, credential: 'rotated-key' }, ownerId: 'a' });
  assert.deepEqual(credentials, ['account-a-key', 'rotated-key']);
  assert.ok(result.error);
  assert.deepEqual(result.providers[0].models, [{ id: 'private-model' }]);
  assert.deepEqual(snapshot.state, { models: [{ id: 'private-model' }], authoritative: false, paid: ['paid-model'] });
});

// Port contract: a failed refresh keeps the list currently in the shared snapshot (main.ts reads it
// with getXdGatewayModels), as the desktop's runModelsSync does, not a private copy of the last
// success. Inside the Host only this catalog writes that snapshot, so the two agree today.
test('a failed refresh keeps the current snapshot list, read through the port', async () => {
  const snapshot = fakeSnapshot();
  let fail = false;
  const list = createProviderCatalog({ ...snapshot, readProviders: async () => [],
    fetchModels: async () => {
      if (fail) throw new Error('denied');
      return [{ id: 'allowed' }];
    } });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  snapshot.state.models = [{ id: 'current' }, { id: 'upsell', availability: 'requires_payment' }];
  fail = true;
  await list({ ...options, force: true });
  assert.deepEqual(snapshot.state.models, [{ id: 'current' }]);
});

// Unit regression: a forced refresh that failed left the last success fresh, so the next read inside
// the cache window restored its authority (and dropped the payment refusals' preservation) without a
// successful round. The desktop stays non-authoritative until a round succeeds.
test('a failed refresh is not followed by a cached read that restores authority', async () => {
  const snapshot = fakeSnapshot();
  let fail = false;
  let calls = 0;
  const list = createProviderCatalog({ ...snapshot, readProviders: async () => [],
    fetchModels: async () => {
      calls++;
      if (fail) throw new Error('denied');
      return [{ id: 'allowed' }];
    } });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  fail = true;
  await list({ ...options, force: true });
  assert.equal(snapshot.state.authoritative, false);
  await list(options);
  assert.equal(calls, 3);
  assert.equal(snapshot.state.authoritative, false);
  fail = false;
  await list(options);
  assert.equal(snapshot.state.authoritative, true);
});

// Unit regression: a retained catalog read used to return a hardcoded owner
// generation after an async refresh crossed sign-out. No real network is used.
test('catalog rejects an in-flight response after its owner generation changes', async () => {
  let owner = { dataOwnerId: 'a', generation: 7, pending: false };
  let resume;
  const list = createProviderCatalog({ readOwner: () => owner, applyModels() {}, readModels: () => [], fetchModels: async () => [],
    readProviders: () => new Promise(resolve => { resume = resolve; }) });
  const result = list({ ownerId: 'a', gateway: null });
  owner = { ...owner, generation: 8 };
  resume([]);
  await assert.rejects(result, /PROVIDER_OWNER_CHANGED/);
});

// Race regression: an old credential fetch must never overwrite a newer one,
// even when the account generation itself has not changed.
test('model refresh is single-flight and rejects a stale credential response', async () => {
  let applied = [];
  let resume;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const list = createProviderCatalog({
    readProviders: async () => [{ id: 'xd', models: applied }],
    applyModels: models => { applied = models; },
    readModels: () => applied,
    fetchModels: async ({ credential }) => {
      calls++;
      if (credential === 'old') { started(); return new Promise(resolve => { resume = resolve; }); }
      return [{ id: 'current', contextWindow: 12345, agents: ['pi'] }];
    },
  });
  const gateway = { endpoint: 'https://gateway.example', credential: 'old' };
  const first = list({ ownerId: 'a', gateway });
  const joined = list({ ownerId: 'a', gateway });
  const stale = Promise.all([assert.rejects(first, /PROVIDER_CONNECTION_CHANGED/), assert.rejects(joined, /PROVIDER_CONNECTION_CHANGED/)]);
  await entered;
  assert.equal(calls, 1);
  const current = await list({ ownerId: 'a', gateway: { ...gateway, credential: 'new' } });
  assert.equal(current.providers[0].models[0].contextWindow, 12345);
  assert.deepEqual(current.providers[0].models[0].agents, ['pi']);
  resume([{ id: 'stale' }]);
  await stale;
  assert.equal(applied[0].id, 'current');
});

test('failed refresh preserves executable models but drops stale payment advertising', async () => {
  let applied = [];
  let fail = false;
  const list = createProviderCatalog({
    readProviders: async () => [{ id: 'xd', models: applied }],
    applyModels: models => { applied = models; },
    readModels: () => applied,
    fetchModels: async () => {
      if (fail) throw Error('sensitive synthetic upstream failure');
      return [{ id: 'allowed' }, { id: 'upgrade', availability: 'requires_payment' }];
    },
  });
  const options = { ownerId: 'a', gateway: { endpoint: 'https://gateway.example', credential: 'fixture' } };
  await list(options);
  fail = true;
  const result = await list({ ...options, force: true });
  assert.deepEqual(result.providers[0].models, [{ id: 'allowed' }]);
  assert.ok(result.error);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

// ── Credential status and the XD model list (release table section 2, model list on credential status) ──
// 测试价值
// - 生产入口：model-access.ts 的 createHostModelAccess（桌面 credentialsSync 的 Host 实例）把状态交给
//   providers.mjs 的 noteCredentialStatus，接法照 main.ts；模型写进本进程真实的 active-catalog
//   （setXdGatewayModels，main.ts 的 applyModels 就是它），路由守卫用 Host 也用的 tombstoneGuardOptions。
// - 规则：桌面 model-access/index.ts onStatusChange（433–441）：failed 清掉模型、保留最近一次付费拒绝
//   （已有任务不能借此绕过路由守卫）；disabled / unsupported / idle 清掉模型与拒绝、不回退内置嵌入模型；
//   这些状态下不发 /models，ok 之后的下一轮才把模型带回（桌面只在 ok 时发起，432）。
// - 现有覆盖缺口：上面的用例用的是假快照，只测刷新失败与账号边界；之前 Host 不听凭据状态，模型和拒绝照旧，
//   disabled 之后还用旧 Key 拉 /models。
// - 最小失败输入：一次带付费拒绝的成功轮，再一次 failed（新 Key 存不下）或 disabled（503），再恢复到 ok。
//   tier：unit（临时 profile，无网络）。
const { setXdGatewayModels, getXdGatewayModels, markXdGatewayModelAccessUnknown, getXdGatewayModelAccessSnapshot, getActiveCatalog } =
  await import('../../../desktop/src/main/maker-host/active-catalog.ts');
const { tombstoneGuardOptions } = await import('../../../desktop/src/main/maker-host/model-route-guard-catalog.ts');
const { createHostModelAccess } = await import('./model-access.ts');
const { configureHostOwner } = await import('./claude-auth.mjs');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

const ROUND = [{ id: 'open-model', agents: ['claude-code'] }, { id: 'paid-model', agents: ['claude-code'], availability: 'requires_payment' }];
const refusedByGuard = () => tombstoneGuardOptions(getActiveCatalog()).isPaymentRequiredTombstone('xd', 'paid-model', 'claude-code');

async function heldCatalog(t, ownerId) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-model-hold-'));
  configureHostOwner({ userDataDir: profile, ownerId });
  t.after(() => { setXdGatewayModels([]); configureHostOwner({ userDataDir: profile, ownerId: null }); fs.rmSync(profile, { recursive: true, force: true }); });
  const rounds = [];
  const fetched = [];
  const priced = [];
  const catalog = createProviderCatalog({
    // The price projection's input (main.ts applyPricedModels): the models of each list it is fed.
    applyPricedModels: models => priced.push(models.map(model => model.id)),
    readProviders: async () => [],
    // As main.ts: the shared active catalog of this process.
    applyModels: (models, options) => setXdGatewayModels(models, options),
    markModelsUnknown: () => markXdGatewayModelAccessUnknown(),
    readModels: () => getXdGatewayModels(),
    fetchModels: async gateway => { fetched.push(gateway.credential); const next = rounds.shift(); if (!next) throw new Error('no round'); return next; },
  });
  const endpoint = 'https://gateway.example.test';
  let key = 'fixture-key-a';
  let writable = true;
  let respond = () => ({ endpoint, apiKey: key });
  const access = createHostModelAccess({ ownerId, region: 'global',
    readKey: () => key, writeKey: value => { if (!writable) return false; key = value; return true; },
    request: async () => respond(),
    publish: status => catalog.noteCredentialStatus(status),
    onKeyChanged: () => {},
  });
  t.after(() => access.close());
  assert.equal((await access.start()).state, 'ok');
  const read = (force = false) => catalog({ gateway: { endpoint, credential: key }, ownerId, force });
  rounds.push(ROUND);
  await read();
  assert.deepEqual(getXdGatewayModels().map(model => model.id), ['open-model', 'paid-model']);
  assert.equal(refusedByGuard(), true, 'the paid route is refused before');
  return {
    access, rounds, fetched, priced, read,
    fail: () => { writable = false; respond = () => ({ endpoint, apiKey: 'fixture-key-b' }); },
    disable: () => { respond = () => { throw Object.assign(new Error('model access disabled'), { code: 'MODEL_ACCESS_DISABLED', statusCode: 503 }); }; },
    recover: () => { writable = true; respond = () => ({ endpoint, apiKey: key }); },
  };
}

test('credentials failed: the models go, the paid route stays refused, no /models round until ok', async t => {
  const h = await heldCatalog(t, 'model-hold-failed');
  h.fail();
  assert.equal((await h.access.sync.retry()).state, 'failed');
  assert.deepEqual(getXdGatewayModels(), []);
  assert.equal(getXdGatewayModelAccessSnapshot().authoritative, false);
  assert.equal(refusedByGuard(), true, 'a task refused before cannot pass the route guard through the failure');
  h.rounds.push(ROUND);
  await h.read(true);
  assert.equal(h.fetched.length, 1, 'no /models round while failed, not even forced');
  assert.deepEqual(getXdGatewayModels(), []);
  assert.equal(refusedByGuard(), true);

  h.recover();
  assert.equal((await h.access.sync.retry()).state, 'ok');
  await h.read();
  assert.equal(h.fetched.length, 2, 'the read after ok runs the round');
  assert.deepEqual(getXdGatewayModels().map(model => model.id), ['open-model', 'paid-model']);
  assert.equal(getXdGatewayModelAccessSnapshot().authoritative, true);
});

test('credentials disabled: the models and refusals go, no embedding fallback, no /models with the old key', async t => {
  const h = await heldCatalog(t, 'model-hold-disabled');
  // Let the bundled embedding fallback show again before the status, so its suppression is the status's.
  setXdGatewayModels([], { authoritative: false });
  h.disable();
  assert.equal((await h.access.sync.retry()).state, 'disabled');
  assert.deepEqual(getXdGatewayModels(), []);
  assert.equal(refusedByGuard(), false, 'the refusals are cleared with the models');
  assert.equal(getActiveCatalog().providers.find(provider => provider.id === 'xd')?.embeddingModels, undefined,
    'no fallback to the bundled embedding models');
  h.rounds.push(ROUND);
  await h.read(true);
  await h.read();
  assert.equal(h.fetched.length, 1, 'the old key is not used for /models after disabled');
  assert.deepEqual(getXdGatewayModels(), []);
});

test('a /models round in flight when the credentials fail is dropped: it writes neither the list nor the prices', async t => {
  const h = await heldCatalog(t, 'model-hold-in-flight');
  let land;
  h.rounds.push(new Promise(resolve => { land = resolve; }));
  const inFlight = h.read(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.fetched.length, 2, 'the forced round is in flight');
  h.fail();
  assert.equal((await h.access.sync.retry()).state, 'failed');
  const pricedBefore = h.priced.length;
  land(ROUND);
  await inFlight;
  assert.deepEqual(getXdGatewayModels(), [], 'the late round shows no models');
  assert.deepEqual(h.priced.slice(pricedBefore), [], 'and feeds no prices');
  // Not cached either: after ok the next read runs its own round instead of serving the dropped one.
  h.recover();
  assert.equal((await h.access.sync.retry()).state, 'ok');
  h.rounds.push(ROUND);
  await h.read();
  assert.equal(h.fetched.length, 3);
  assert.deepEqual(getXdGatewayModels().map(model => model.id), ['open-model', 'paid-model']);
});
