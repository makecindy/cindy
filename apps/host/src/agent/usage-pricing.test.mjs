/*
 * 测试价值
 * - 生产入口：providers.mjs 的 createProviderCatalog（Host 唯一的 /models 轮次）加
 *   usage-pricing.ts 的 createHostUsagePricing（桌面 modelPricingCore 的 Host 实例），接法与
 *   main.ts 相同：applyPricedModels → replaceGatewayModelPricing，trackModelsSync →
 *   trackGatewayModelPricingSync。
 * - 规则：放行表第 13 行 3a。桌面只在一次 /models 成功和账号边界替换 XD 报价
 *   （model-access/index.ts applyGatewayModels）；Host 的 applyModels 在两轮之间的每次读取和
 *   失败轮也会调用，若把价格挂在那里，会每次重写缓存、失败时用旧列表重算。Host 原来
 *   /api/usage/model-pricing 恒为 null。
 * - 覆盖缺口：桌面 modelPricing.test.ts 只测桌面壳与 mock 端口；Host 没有任何定价测试。
 * - 最小输入：一个带价格的 XD 模型、一次失败轮、一次账号代际变化、一次 Key 文件替换。
 *   tier：unit，无网络、无子进程、无真实等待。
 *
 * 凭据状态（最后两条用例，审核方 2026-11-17 定对齐桌面）：
 * - 生产入口：model-access.ts 的 createHostModelAccess（桌面 credentialsSync 的 Host 实例），它的
 *   publish 照 main.ts 交给 listProviders.noteCredentialStatus。
 * - 规则：桌面 model-access/index.ts 的 onStatusChange 在 failed（437–439）与
 *   disabled / unsupported / idle（440–441）时传空列表，清掉 XD 报价；ok 时才发起下一轮 /models
 *   （432）。继续显示已失效账号的价格，用户会以为还能按那个价格用。
 * - 覆盖缺口：上面三条用例只走 /models 轮次与账号边界；Host 原来不听凭据状态，凭据失败后旧报价照旧答复。
 * - 最小失败输入：一次成功同步后，一次 failed（新 Key 存不下，SAFE_STORAGE_UNAVAILABLE）或一次
 *   disabled（503），再一次恢复到 ok。tier：unit。
 * - 实测：Host 的 node --import tsx --import ./src/loaders/register-raw.mjs --test 单文件，
 *   见交付记录。
 *
 * 清理（集成分支负载下偶发 ENOTEMPTY）：价格快照（modelPricingCore writeDiskCache）和账本币种
 * （accountCurrencyStore 的写链：读、mkdir cache、写临时文件、改名）都是不等待的写入。测试结束时它们
 * 可能还在线程池里，与 t.after 的 rmSync 交错，就会在已清空的 profile 里重建 cache/。每个 profile 上的
 * 异步 fs 调用在这里登记，清理前等它们全部落完（不是重试 rm，也不是固定延时）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProviderCatalog } from './providers.mjs';
import { createHostUsagePricing } from './usage-pricing.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { createHostModelAccess } from './model-access.ts';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { resolveOwnerScopedSecretStorageKey } from '../../../desktop/src/main/secrets/providerSecretOwnerKey.ts';
import { providerSecretStorageKey } from '../../../desktop/src/shared/providerSecrets.ts';

const profileWrites = new Map();
/** Every async fs call the production code makes under a test profile, so cleanup can wait for them. */
for (const name of ['mkdir', 'writeFile', 'rename', 'readFile', 'rm', 'lstat', 'stat']) {
  const original = fs.promises[name];
  fs.promises[name] = function (target, ...rest) {
    const result = original.call(this, target, ...rest);
    const file = String(target);
    for (const [root, pending] of profileWrites) {
      if (file.startsWith(root)) {
        pending.add(result);
        result.then(() => pending.delete(result), () => pending.delete(result));
      }
    }
    return result;
  };
}

/** Until no fs call on the profile is in flight, including those a landing one starts (the currency write chain). */
async function settleProfile(root) {
  const pending = profileWrites.get(root);
  while (pending?.size) {
    await Promise.allSettled([...pending]);
    await new Promise(resolve => setImmediate(resolve));
  }
}

const PRICED = [{ id: 'claude-sonnet-4', currency: 'USD', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 }];

/** A Host profile with one owner, its DB slot, a gateway key file and the two production pieces. */
function setup(t, ownerId) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pricing-'));
  profileWrites.set(profile, new Set());
  configureHostOwner({ userDataDir: profile, ownerId });
  const client = {};
  setCurrentDbClient(client, ownerId);
  const keyFile = path.join(profile, 'safe-storage', `${resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'))}.enc`);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, 'encrypted-key-a');
  t.after(async () => {
    // The price snapshot and the ledger currency are written without waiting: let them land first.
    await settleProfile(profile);
    profileWrites.delete(profile);
    clearCurrentDbClient(client);
    fs.rmSync(profile, { recursive: true, force: true });
  });
  const pricing = () => createHostUsagePricing({ profileDir: profile, modelAccessApiBaseUrl: () => 'https://model-access.example.test' });
  const rounds = [];
  const fed = [];
  let generation = 1;
  const catalog = (usagePricing) => createProviderCatalog({
    readProviders: async () => [],
    applyModels: () => {},
    readModels: () => [],
    fetchModels: async () => { const next = rounds.shift(); if (next instanceof Error) throw next; return next; },
    readOwner: () => ({ dataOwnerId: ownerId, generation, pending: false }),
    applyPricedModels: (models, owner) => { fed.push(models.length); usagePricing.replaceGatewayModelPricing(models, owner); },
    trackModelsSync: sync => usagePricing.trackGatewayModelPricingSync(sync),
  });
  const list = (listProviders, force = false) =>
    listProviders({ gateway: { endpoint: 'https://gateway.example.test', credential: 'key-a' }, ownerId, force });
  return { profile, keyFile, pricing, catalog, rounds, fed, list, cacheFile: path.join(profile, 'cache', 'model-pricing.json'),
    settle: () => settleProfile(profile),
    nextGeneration: () => { generation += 1; } };
}

test('a successful /models round feeds the Host prices; reads between rounds and a failed round keep them', async t => {
  const env = setup(t, 'pricing-owner-rounds');
  const usagePricing = env.pricing();
  const listProviders = env.catalog(usagePricing);
  env.rounds.push(PRICED);
  await env.list(listProviders);
  const first = await usagePricing.getGatewayModelPricing();
  assert.equal(first?.xd?.['claude-sonnet-4']?.inputPerMtok, 3);
  assert.equal(first?.xd?.['claude-sonnet-4']?.currency, 'USD');
  await env.settle();
  assert.ok(fs.existsSync(env.cacheFile), 'the price snapshot reaches the profile');
  const written = fs.readFileSync(env.cacheFile, 'utf8');
  const writtenAt = fs.statSync(env.cacheFile).mtimeMs;

  // Between rounds and after a failed round the catalog re-applies its list; the prices stay.
  await env.list(listProviders);
  env.rounds.push(new Error('model access unavailable'));
  const failed = await env.list(listProviders, true);
  assert.equal(failed.error, 'Model access could not be refreshed. Try again.');
  assert.deepEqual(env.fed, [1], 'only the successful round feeds the prices');
  assert.deepEqual(await usagePricing.getGatewayModelPricing(), first);
  assert.equal(fs.readFileSync(env.cacheFile, 'utf8'), written);
  assert.equal(fs.statSync(env.cacheFile).mtimeMs, writtenAt);
});

test('a fresh Host process restores the price snapshot from its profile before any round', async t => {
  const env = setup(t, 'pricing-owner-restart');
  const before = env.pricing();
  env.rounds.push(PRICED);
  await env.list(env.catalog(before));
  const expected = await before.getGatewayModelPricing();
  await env.settle();
  assert.ok(fs.existsSync(env.cacheFile), 'the price snapshot reaches the profile');

  const after = env.pricing();
  await after.prewarmModelPricing();
  assert.deepEqual(await after.getGatewayModelPricing(), expected);
  assert.equal(await after.getGatewayAccountCurrency('pricing-owner-restart'), 'USD');
});

test('an account boundary clears the prices, and a replaced key file retires the cached snapshot', async t => {
  const env = setup(t, 'pricing-owner-boundary');
  const usagePricing = env.pricing();
  const listProviders = env.catalog(usagePricing);
  env.rounds.push(PRICED);
  await env.list(listProviders);
  assert.ok((await usagePricing.getGatewayModelPricing())?.xd);

  // Another key file (a rotated key) is another cache scope: the old snapshot no longer answers.
  await env.settle();
  assert.ok(fs.existsSync(env.cacheFile), 'the price snapshot reaches the profile');
  fs.rmSync(env.keyFile);
  fs.writeFileSync(env.keyFile, 'encrypted-key-b, rotated');
  assert.equal(await env.pricing().getGatewayModelPricing(), null);

  // A new owner generation is an account boundary: the catalog clears, so do the prices.
  env.nextGeneration();
  env.rounds.push(new Error('the new account has not loaded yet'));
  await env.list(listProviders);
  assert.deepEqual(env.fed, [1, 0], 'the boundary feeds an empty list');
  assert.deepEqual(await usagePricing.getGatewayModelPricing(), {});
});

// The two desktop branches: failed (437–439) and disabled / unsupported / idle (440–441).
for (const state of ['failed', 'disabled']) {
  test(`credentials ${state}: the last prices stop answering, and come back with the /models round after ok`, async t => {
    const env = setup(t, `pricing-owner-${state}`);
    const usagePricing = env.pricing();
    const listProviders = env.catalog(usagePricing);
    const endpoint = 'https://gateway.example.test';
    let key = 'fixture-key-a';
    let writable = true;
    let respond = () => ({ endpoint, apiKey: key });
    const access = createHostModelAccess({ ownerId: `pricing-owner-${state}`, region: 'global',
      readKey: () => key, writeKey: value => { if (!writable) return false; key = value; return true; },
      request: async () => respond(),
      // As main.ts: the status the Host publishes also goes to the catalog.
      publish: status => listProviders.noteCredentialStatus(status),
      onKeyChanged: () => {},
    });
    t.after(() => access.close());
    assert.equal((await access.start()).state, 'ok');
    env.rounds.push(PRICED);
    await env.list(listProviders);
    const priced = await usagePricing.getGatewayModelPricing();
    assert.equal(priced?.xd?.['claude-sonnet-4']?.inputPerMtok, 3);

    if (state === 'failed') {
      writable = false;
      respond = () => ({ endpoint, apiKey: 'fixture-key-b' });
    } else {
      respond = () => { throw Object.assign(new Error('model access disabled'), { code: 'MODEL_ACCESS_DISABLED', statusCode: 503 }); };
    }
    assert.equal((await access.sync.retry()).state, state);
    assert.deepEqual(await usagePricing.getGatewayModelPricing(), {}, 'the failed account\'s prices are gone');
    // A /models round that still succeeds before the credentials recover keeps no prices either.
    env.rounds.push(PRICED);
    await env.list(listProviders, true);
    assert.deepEqual(await usagePricing.getGatewayModelPricing(), {});

    writable = true;
    respond = () => ({ endpoint, apiKey: key });
    assert.equal((await access.sync.retry()).state, 'ok');
    assert.deepEqual(await usagePricing.getGatewayModelPricing(), {}, 'ok alone restores no price');
    // Not forced: ok made the last round stale, so this read runs the next /models round.
    env.rounds.push(PRICED);
    await env.list(listProviders);
    assert.equal(env.rounds.length, 0, 'the read after ok ran a /models round');
    assert.deepEqual(await usagePricing.getGatewayModelPricing(), priced);
  });
}
