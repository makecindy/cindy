/*
 * 测试价值
 * - 生产入口与可观察结果：Host 交给 Maker 的 prepareStartOptions 写进创建参数的结果（Fast 策略、
 *   任务上下文预算、Pi 思考开关、价格档）和它登记的进程内状态（冻结的 provider、Fast 轴），
 *   以及账号已切换时的拒绝。
 * - 规则依据：桌面的 Maker 启动钩子（maker-host/index.ts lifecycleHooks.prepareStartOptions）对
 *   每个本机任务都做这几步；Host 之前一个都没做，Pi 价格档恒为 standard，任务预算在 Host 上丢失。
 * - 最小失败输入：不冻结 provider；不写 Fast 轴导致 Pi 价格档读不到 Fast；账号切换后照样启动。
 * - tier：unit（进程内，临时 profile 与 owner，不起子进程、不调模型）。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureHostOwner } from './claude-auth.mjs';
import { createHostModelContext } from './model-context.ts';
import { createHostStartOptions } from './start-options.ts';
import { storedSessionOptions } from './input-queue.mjs';
import { getSessionProvider } from '../../../desktop/src/main/maker-host/session-provider-store.ts';
import { getSessionFastMode, setSessionFastMode } from '../../../desktop/src/main/maker-host/session-effort-store.ts';
import { setThinkingEnabledInMemory } from '../../../desktop/src/main/maker-host/newMakerDefaultsCache.ts';
import { captureUsagePricing } from '../../../desktop/src/main/maker-host/model-usage-pricing.ts';
import { writeSessionContextWindowBudget } from '../../../desktop/src/main/maker-host/session-context-budget-store.ts';
import { createSessionContextBudget } from '../../../desktop/src/main/maker-host/sessionContextBudgetCore.ts';
import { readSessionContextWindowBudget } from '../../../desktop/src/main/maker-host/session-context-budget-store.ts';
import { getActiveCatalog } from '../../../desktop/src/main/maker-host/active-catalog.ts';
import { CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY } from '../../../desktop/src/main/mcp-integrations/codexBuiltinToolPolicy.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

function setup(t, ownerId, ensureProviderCatalog, refreshModels) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-start-options-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  const modelContext = createHostModelContext({ readGatewayKey: () => null, hasCodexOAuthLogin: () => false,
    codexAccountState: () => ({ authenticated: false }) });
  const policies = [];
  const fastPolicies = {
    createSubscriptionFastPolicy: (sessionId, resolveProvider) => {
      const policy = { sessionId, resolveProvider };
      policies.push(policy);
      return policy;
    },
  };
  const warnings = [];
  const start = createHostStartOptions({ modelContext, fastPolicies, ensureProviderCatalog, refreshModels,
    logger: { warn: (message) => warnings.push(message) } });
  return { start, modelContext, policies, warnings };
}

test('a Codex start freezes its provider, gets the Fast policy and a price-tier reader', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { start, policies } = setup(t, 'start-options-codex');
  const opts = { agentKind: 'codex', providerId: 'openai', model: 'fixture-model', fastMode: true };
  await start.prepareStartOptions('codex-task', opts);
  assert.equal(getSessionProvider('codex-task'), 'openai');
  assert.equal(policies.length, 1);
  assert.equal(opts.fastModePolicy, policies[0]);
  // The policy resolves the frozen provider first, as on the desktop.
  assert.equal(policies[0].resolveProvider(), 'openai');
  assert.equal(getSessionFastMode('codex-task'), true);
  assert.equal(typeof opts.resolveUsagePriceVariant, 'function');
  assert.equal(opts.getPriceVariant, undefined);
  // The reader returns what the proxy captured for this runtime, and nothing after close.
  captureUsagePricing('codex-task', 'priority', 'thread-1')({ type: 'response.completed',
    response: { usage: { input_tokens: 10, output_tokens: 2 } } });
  assert.equal(opts.resolveUsagePriceVariant({ threadId: 'thread-1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }), 'priority');
  start.onClose('codex-task');
  captureUsagePricing('codex-task', 'priority', 'thread-1')({ type: 'response.completed',
    response: { usage: { input_tokens: 10, output_tokens: 2 } } });
  assert.equal(opts.resolveUsagePriceVariant({ threadId: 'thread-1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 }), undefined);
});

test('a Pi start follows the session Fast axis for its price tier and restores the remembered thinking switch', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { start } = setup(t, 'start-options-pi');
  setThinkingEnabledInMemory('pi', 'fixture-provider', 'fixture-model', false);
  const opts = { agentKind: 'pi', providerId: 'fixture-provider', model: 'fixture-model', fastMode: true };
  await start.prepareStartOptions('pi-task', opts);
  assert.equal(opts.thinkingEnabled, false);
  assert.equal(opts.getPriceVariant(), 'priority');
  // A later Fast change (session-settings.mjs) moves the tier without a restart.
  setSessionFastMode('pi-task', false);
  assert.equal(opts.getPriceVariant(), 'standard');

  // An explicit thinking choice is kept.
  const explicit = { agentKind: 'pi', providerId: 'fixture-provider', model: 'fixture-model', thinkingEnabled: true };
  await start.prepareStartOptions('pi-task-2', explicit);
  assert.equal(explicit.thinkingEnabled, true);
});

test('the saved task budget is settled against the catalog with the Host route resolver', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { start, modelContext } = setup(t, 'start-options-budget');
  const catalog = getActiveCatalog();
  const route = catalog.providers.flatMap(provider => (provider.models['claude-code'] ?? [])
    .filter(model => provider.routing['claude-code']?.disabled !== true && Number.isSafeInteger(model.contextWindow) && model.contextWindow > 100_000)
    .map(model => ({ providerId: provider.id, model })))[0];
  assert.ok(route, 'the catalog routes a Claude model with a large window');
  writeSessionContextWindowBudget('budget-task', 60_000);
  const opts = { agentKind: 'claude-code', providerId: route.providerId, model: route.model.id };
  await start.prepareStartOptions('budget-task', opts);
  const expected = createSessionContextBudget({
    resolveContextProviderId: modelContext.resolveContextProviderId, readSessionContextWindowBudget, logger: { warn() {} },
  }).resolveConfiguredContextWindow(catalog, 'claude-code', route.providerId, route.model.id, 60_000);
  assert.equal(opts.contextWindowBudget, expected ?? undefined);

  // Without a saved or explicit budget the field is removed, never passed unsettled.
  const plain = { agentKind: 'claude-code', providerId: route.providerId, model: route.model.id, contextWindowBudget: undefined };
  await start.prepareStartOptions('no-budget-task', plain);
  assert.equal(Object.hasOwn(plain, 'contextWindowBudget'), false);
});

test('a start after the account changed is refused with the desktop marker', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { start } = setup(t, 'start-options-owner-a');
  configureHostOwner({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-start-options-b-')), ownerId: 'start-options-owner-b' });
  await assert.rejects(
    start.prepareStartOptions('stale-task', { agentKind: 'codex', providerId: 'openai', model: 'fixture-model' }),
    error => error.code === 'ACCOUNT_PROVIDER_NOT_READY' && /^ACCOUNT_PROVIDER_NOT_READY: /.test(error.message),
  );
  assert.equal(getSessionProvider('stale-task'), null);
});

test('a start waits for the account provider catalog before it freezes the provider', { timeout: TEST_TIMEOUT_MS }, async t => {
  const order = [];
  const { start } = setup(t, 'start-options-catalog', async () => { order.push('catalog'); });
  const opts = { agentKind: 'codex', providerId: 'openai', model: 'fixture-model' };
  await start.prepareStartOptions('catalog-task', opts);
  order.push(getSessionProvider('catalog-task'));
  assert.deepEqual(order, ['catalog', 'openai']);
});

test('a start whose catalog refresh fails, or whose owner changes during it, is refused with the desktop marker', { timeout: TEST_TIMEOUT_MS }, async t => {
  const failing = setup(t, 'start-options-catalog-fail', async () => { throw new Error('PROVIDER_OWNER_CHANGED'); });
  await assert.rejects(failing.start.prepareStartOptions('fail-task', { agentKind: 'codex', providerId: 'openai', model: 'm' }),
    error => error.code === 'ACCOUNT_PROVIDER_NOT_READY');
  assert.equal(getSessionProvider('fail-task'), null);

  const switching = setup(t, 'start-options-catalog-switch', async () => {
    configureHostOwner({ userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-start-options-c-')), ownerId: 'start-options-other-owner' });
  });
  await assert.rejects(switching.start.prepareStartOptions('switch-task', { agentKind: 'codex', providerId: 'openai', model: 'm' }),
    error => error.code === 'ACCOUNT_PROVIDER_NOT_READY');
  assert.equal(getSessionProvider('switch-task'), null);
});

test('a start refreshes the model lists after the catalog wait and passes the disabled plugins', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const order = [];
  const { start } = setup(t, 'start-options-plugins', async () => { order.push('catalog'); }, () => { order.push('models'); });
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-host-start-options-work-'));
  t.after(() => fs.rmSync(workingDir, { recursive: true, force: true }));
  const opts = { agentKind: 'claude-code', providerId: 'xd', model: 'fixture-model', workingDir, vendorOptions: { kept: true } };
  await start.prepareStartOptions('plugins-task', opts);
  assert.deepEqual(order, ['catalog', 'models']);
  assert.equal(opts.vendorOptions.kept, true);
  // The workdir's disabled plugins (none here), set for every engine as on the desktop.
  assert.deepEqual(opts.vendorOptions[CODEX_DISABLED_BUILTIN_PLUGIN_IDS_KEY], []);
});

/*
 * 一个运行中开过快速模式的任务被恢复时，创建参数取自任务行（input-queue.mjs storedSessionOptions，
 * 发送、恢复、续接三条路径共用）。若这条映射丢了 fastMode，Pi 的价格档会被改回 standard。
 */
test('a task restored with Fast saved on its row starts on the priority price tier', { timeout: TEST_TIMEOUT_MS }, async t => {
  const { start } = setup(t, 'start-options-restore-fast');
  const opts = storedSessionOptions({ agentKind: 'pi', model: 'fixture-model', providerId: 'fixture-provider', fastMode: true });
  assert.equal(opts.fastMode, true);
  await start.prepareStartOptions('restored-pi-task', opts);
  assert.equal(opts.getPriceVariant(), 'priority');
});
