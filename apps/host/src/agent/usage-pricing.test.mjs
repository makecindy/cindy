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
 * - 实测：Host 的 node --import tsx --import ./src/loaders/register-raw.mjs --test 单文件，
 *   见交付记录。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createProviderCatalog } from './providers.mjs';
import { createHostUsagePricing } from './usage-pricing.ts';
import { configureHostOwner } from './claude-auth.mjs';
import { setCurrentDbClient, clearCurrentDbClient } from '../../../desktop/src/main/localDb/client/current.ts';
import { resolveOwnerScopedSecretStorageKey } from '../../../desktop/src/main/secrets/providerSecretOwnerKey.ts';
import { providerSecretStorageKey } from '../../../desktop/src/shared/providerSecrets.ts';

const PRICED = [{ id: 'claude-sonnet-4', currency: 'USD', inputCostPerToken: 0.000003, outputCostPerToken: 0.000015 }];

/** A Host profile with one owner, its DB slot, a gateway key file and the two production pieces. */
function setup(t, ownerId) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-pricing-'));
  configureHostOwner({ userDataDir: profile, ownerId });
  const client = {};
  setCurrentDbClient(client, ownerId);
  const keyFile = path.join(profile, 'safe-storage', `${resolveOwnerScopedSecretStorageKey(providerSecretStorageKey('xd'))}.enc`);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, 'encrypted-key-a');
  t.after(() => { clearCurrentDbClient(client); fs.rmSync(profile, { recursive: true, force: true }); });
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
  await waitForFile(env.cacheFile);
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
  await waitForFile(env.cacheFile);

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
  await waitForFile(env.cacheFile);
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

async function waitForFile(file) {
  // The cache write is fire-and-forget (writeDiskCache); wait for the event, not a fixed delay.
  for (let i = 0; i < 200 && !fs.existsSync(file); i += 1) await new Promise(resolve => setImmediate(resolve));
  assert.ok(fs.existsSync(file), 'the price snapshot reaches the profile');
}
