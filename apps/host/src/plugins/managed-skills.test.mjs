/*
 * 测试价值（放行表第 2b 行，3c 第一段的 Host 接线）
 * - 可观察结果：Host 的正式插件运行时（createHostPluginRuntime）列出的托管 Skill：
 *   用夹具先按桌面的发布流程（prepareBuiltInSkills）发布仓库里的内置 Skill 后，它们以
 *   cindy:<名字> 出现并标为官方；没发布过时没有内置 Skill、不报错，插件 Skill 照常列出；
 *   插件 Skill 以 cindy-plugin-<实例>:<名字> 出现，只有市场公开、包指纹对得上的 cindy- 插件标为官方。
 *   身份读取改用桌面的 findGhostForInstanceId 之后：账号服务可用时，四类插件的首方事实、
 *   isVerifiedPublicMarket、brokerAuthorized 与改之前（运行时自己的 getGhost）完全相同；
 *   账号服务不可用时，需要账号的插件不进托管 Skill 清单，它的连接受众读不到安装清单。
 * - 规则依据：桌面 managed-skills.ts（经 managedSkillsCore.ts）与 cindy-brain/index.ts 的
 *   findGhostForInstanceId、listAvailableGhostsAsync（经 ghostAvailability.ts）；内置 Skill 只读
 *   桌面最后一次发布的快照（放行表第 25 行）。
 * - 最小失败输入：运行时不接托管 Skill；未发布时抛错；身份读取绕过账号可用性；
 *   账号服务不可用时仍列出需要账号的插件 Skill。
 * - tier：integration（真实安装、快照子进程、真实市场台账文件与临时 profile，不起插件进程、不调模型）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { configureHostOwner } from '../agent/claude-auth.mjs';
import { createSnapshotProcess } from '../snapshot-process.mjs';
import { createHostGhostManager } from '../plugins-installed.ts';
import { createHostPluginRuntime } from './runtime.ts';
import { createHostPluginIdentity } from './identity.ts';
import { configureGhostSnapshotProcess } from '../../../desktop/src/main/cindy-brain/ghostSnapshotCapability.ts';
import { prepareBuiltInSkills } from '../../../desktop/src/main/maker-host/built-in-skills.ts';
import { configureAppDataDir } from '../../../desktop/src/main/userDataPath.ts';
import { commitVolatileAppSession, LOCAL_DATA_OWNER_ID } from '../../../desktop/src/main/appSessionState.ts';
import { getAppCapabilities } from '../../../desktop/src/main/appCapabilities.ts';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.ts';
import { PluginMarketLedger } from '../../../desktop/src/main/plugin-market/ledger.ts';
import { findInstalledGhostByInstanceId, installedGhostStoragePart } from '../../../desktop/src/shared/pluginIdentity.ts';
import { lifoCleanup } from '../test-support/cleanup.mjs';

// node:test has no default timeout. These tests start subprocesses or use real temporary
// files; an explicit bound turns a stuck child or lock into a failure, not a stalled gate.
const TEST_TIMEOUT_MS = 120_000;

const require = createRequire(new URL('../../../desktop/package.json', import.meta.url));
const JSZip = require('jszip');
const SYSTEM_SKILLS = fileURLToPath(new URL('../../../desktop/resources/system-skills', import.meta.url));

/** The four plugin classes the comparison covers (Host cannot mark a builtin, see the report). */
const PLUGINS = {
  thirdParty: { id: 'skill-fixture', namespace: null },
  marketOfficial: { id: 'cindy-market-fixture', namespace: null, market: true },
  accountOfficial: { id: 'cindy-account-fixture', namespace: null, market: true, account: true },
  organization: { id: 'skill-fixture', namespace: 'acme', organizationMarket: true },
};

/** A member of the organization that owns the acme namespace. */
const ORG_USER = { id: 'user_1', email: 'member@example.com', membershipKind: 'org', orgId: 'org_1', orgSlug: 'acme' };

async function profileFor(t, mode, ownerId) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-host-plugin-skills-'));
  t.after(() => fs.rm(profile, { recursive: true, force: true }));
  configureHostOwner({ userDataDir: profile, ownerId });
  if (mode === 'local') commitVolatileAppSession('local', null, true);
  // Host main injects the machine app-data root at startup (main.ts configureAppDataDir).
  configureAppDataDir(path.join(profile, 'app-data'));
  configureGhostSnapshotProcess(createSnapshotProcess);
  const owner = mode === 'local' ? LOCAL_DATA_OWNER_ID : ownerId;
  const manager = createHostGhostManager({ userDataDir: profile, ownerId: owner });
  t.after(() => manager.disposeNotificationIndex());
  return { profile, owner, manager };
}

async function install(manager, profile, { id, namespace, account }) {
  const zip = new JSZip();
  zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.61', id,
    name: `Fixture ${id}`, kind: 'chip', version: '1.0.0', entry: 'main.js',
    tools: [{ name: 'noop', description: 'fixture tool', parameters: { type: 'object' } }],
    ...(account ? { network: { hosts: ['api.example.com'], secrets: [{ key: 'email', label: 'Email', source: 'login-email', inject: { header: 'X-User', format: '{value}' } }] } } : {}),
    skill: { items: [{ dir: 'skills/demo', name: 'demo', description: `Skill of ${id}` }] } }));
  zip.file('main.js', '// fixture');
  zip.file('skills/demo/SKILL.md', `---\nname: demo\ndescription: Skill of ${id}\n---\n\nApproved body\n`);
  const archive = path.join(profile, `${id}-${namespace ?? 'root'}.cindy`);
  await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
  const result = await manager.install(archive, { namespace, uiCapabilityApproved: true });
  assert.ok(result.ghost, JSON.stringify(result));
  return installedGhostStoragePart(result.ghost);
}

async function installAll(manager, profile, owner, plugins = PLUGINS) {
  const parts = {};
  const ledger = new PluginMarketLedger(ownerScopedPath(profile, owner, 'plugin-market', 'ledger.v1.json'));
  for (const [name, plugin] of Object.entries(plugins)) {
    parts[name] = await install(manager, profile, plugin);
    if (!plugin.market && !plugin.organizationMarket) continue;
    // What a market install records: the approved package's own sha256.
    const sha256 = manager.approvedInstallEvidence(parts[name])?.packageSha256;
    assert.match(sha256 ?? '', /^[0-9a-f]{64}$/);
    ledger.upsertInstallation({ pluginId: `c${String(Object.keys(parts).length).repeat(24)}`, ghostId: plugin.id,
      releaseId: 'release-1', version: '1.0.0', sha256,
      ...(plugin.organizationMarket ? { scope: 'organization', organizationId: ORG_USER.orgId, namespace: plugin.namespace }
        : { scope: 'public', organizationId: null, namespace: null }),
      source: 'market', installed: true, updatedAt: '2026-11-13T00:00:00.000Z' });
  }
  return parts;
}

async function hostRuntime(t, { profile, owner, manager }, user = null) {
  const secrets = new Map();
  const runtime = await createHostPluginRuntime({ profileDir: profile, ownerId: owner, manager,
    credentials: { read: key => secrets.get(key) ?? null, write: (key, value) => { secrets.set(key, value); }, remove: key => { secrets.delete(key); } },
    getLoginEmail: () => user?.email ?? null, getUser: () => user,
    appContext: () => ({ ok: false, error: 'unavailable' }), getSession: () => undefined,
    requestFileConfirmation: async () => false, publish() {},
    // No plugin process is started here; the worker assets are never read.
    assets: { nodeWorker: path.join(profile, 'unused-node-worker.cjs'), libraryWorker: path.join(profile, 'unused-library-worker.mjs'),
      bridgeSource: '', executablePath: null, close: async () => {} } });
  t.after(() => runtime.close());
  return runtime;
}

/** The identity as it was before 3c: the runtime's own lookup (manager.findInstalledInstance, then the list). */
function previousIdentity({ profile, owner, manager }, user = null) {
  return createHostPluginIdentity({ manager, root: (...parts) => ownerScopedPath(profile, owner, ...parts),
    findGhost: id => manager.findInstalledInstance(id) ?? findInstalledGhostByInstanceId(manager.list(), id) ?? null,
    getUser: () => user, assertCurrent() {} });
}

const byCommand = skills => Object.fromEntries(skills.map(skill => [skill.claudeCommandName, skill.cindyOfficial]));

test('the Host plugin runtime lists the published built-in Skills and approved plugin Skills, marking official ones like the desktop', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const fixture = await profileFor(t, 'cloud', 'plugin-skills-published');
  const published = await prepareBuiltInSkills({ bundledRoot: SYSTEM_SKILLS, userDataDir: fixture.profile,
    appDataDir: path.join(fixture.profile, 'app-data'), homeDir: path.join(fixture.profile, 'home'),
    withSharedMutation: async (_names, work) => work() });
  assert.deepEqual(published.warnings, []);
  assert.ok(published.descriptors.length >= 4, 'the repository bundle publishes its built-in Skills');
  const parts = await installAll(fixture.manager, fixture.profile, fixture.owner);
  const runtime = await hostRuntime(t, fixture);
  const listed = byCommand(await runtime.listManagedSkills());
  for (const descriptor of published.descriptors) assert.equal(listed[`cindy:${descriptor.name}`], true, descriptor.name);
  assert.ok('cindy:learn' in listed, 'the /learn Skill row 18 depends on');
  assert.equal(listed[`cindy-plugin-${parts.thirdParty}:demo`], false);
  assert.equal(listed[`cindy-plugin-${parts.marketOfficial}:demo`], true);
  assert.equal(listed[`cindy-plugin-${parts.accountOfficial}:demo`], true);
  assert.equal(listed[`cindy-plugin-${parts.organization}:demo`], false);
  assert.equal(Object.keys(listed).length, published.descriptors.length + 4);
});

test('a profile the desktop never published lists no built-in Skill and does not fail', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const fixture = await profileFor(t, 'cloud', 'plugin-skills-unpublished');
  const parts = await installAll(fixture.manager, fixture.profile, fixture.owner, { thirdParty: PLUGINS.thirdParty });
  const runtime = await hostRuntime(t, fixture);
  const listed = byCommand(await runtime.listManagedSkills());
  assert.deepEqual(listed, { [`cindy-plugin-${parts.thirdParty}:demo`]: false });
});

test('with account services available, plugin identity reads are the same as before the lookup change', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const fixture = await profileFor(t, 'cloud', 'plugin-identity-cloud');
  assert.equal(getAppCapabilities().canUseCindyAccountServices, true);
  const parts = await installAll(fixture.manager, fixture.profile, fixture.owner);
  const { identity } = await hostRuntime(t, fixture, ORG_USER);
  const previous = previousIdentity(fixture, ORG_USER);
  const verified = {}, broker = {};
  for (const [name, part] of Object.entries(parts)) {
    assert.deepEqual(identity.loadFirstPartyFacts(part, 'runtime'), previous.loadFirstPartyFacts(part, 'runtime'), name);
    assert.equal(identity.isVerifiedPublicMarket(part), previous.isVerifiedPublicMarket(part), name);
    assert.equal(identity.brokerAuthorized(part), previous.brokerAuthorized(part), name);
    verified[name] = identity.isVerifiedPublicMarket(part);
    broker[name] = identity.brokerAuthorized(part);
  }
  // The comparison is not vacuous: public market installs are verified, and the
  // current organization's own market install may use the token broker.
  assert.deepEqual(verified, { thirdParty: false, marketOfficial: true, accountOfficial: true, organization: false });
  assert.deepEqual(broker, { thirdParty: false, marketOfficial: false, accountOfficial: false, organization: true });
});

test('with account services unavailable, a plugin that needs an account is left out of the Skill list; its identity facts read as on the desktop', { timeout: TEST_TIMEOUT_MS }, async t => {
  t = lifoCleanup(t);
  const fixture = await profileFor(t, 'local', 'plugin-identity-local');
  assert.equal(getAppCapabilities().canUseCindyAccountServices, false);
  const parts = await installAll(fixture.manager, fixture.profile, fixture.owner,
    { thirdParty: PLUGINS.thirdParty, accountOfficial: PLUGINS.accountOfficial });
  const runtime = await hostRuntime(t, fixture);
  assert.deepEqual(byCommand(await runtime.listManagedSkills()), { [`cindy-plugin-${parts.thirdParty}:demo`]: false });
  // The lookup now drops the account-requiring instance (desktop findGhostForInstanceId),
  // but a market install is still found in the ledger through its instance id, exactly
  // as desktop pluginMarketAuthorizationTargetFor falls back. Its facts do not change.
  const previous = previousIdentity(fixture);
  for (const [name, part] of Object.entries(parts)) {
    assert.deepEqual(runtime.identity.loadFirstPartyFacts(part, 'runtime'), previous.loadFirstPartyFacts(part, 'runtime'), name);
    assert.equal(runtime.identity.isVerifiedPublicMarket(part), previous.isVerifiedPublicMarket(part), name);
    assert.equal(runtime.identity.brokerAuthorized(part), previous.brokerAuthorized(part), name);
  }
  assert.equal(runtime.identity.isVerifiedPublicMarket(parts.accountOfficial), true);
});
