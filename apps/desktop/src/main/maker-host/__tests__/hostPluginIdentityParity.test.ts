/**
 * 测试价值（放行表第 2b 行，3c 第一段）
 * - 可观察结果：同一 owner 目录里装好的四类插件（第三方、市场公开的 cindy- 插件、需要账号的
 *   市场公开 cindy- 插件、组织命名空间里的组织市场安装），桌面 cindy-brain/index.ts 的生产函数
 *   （loadGhostFirstPartyFactsForGhost、isGhostTokenBrokerAuthorized、resolveConnectionAudienceForGhost、
 *   listAvailableGhostsAsync，从源码原样取出执行）与 Node Host 插件运行时读出的首方事实、市场
 *   公开校验、令牌代理授权、连接受众和托管 Skill 清单逐项相同。账号服务可用（云端登录、组织成员）
 *   与不可用（本机模式、未登录）两种情况都比；首方事实没就绪时 Skill 不标官方，两边一样。
 * - 规则依据：Host 的插件身份读取与托管 Skill 清单要与桌面同源（3c 审核：查找对齐桌面，
 *   包括账号可用性收紧）。
 * - 最小失败输入：Host 绕开账号可用性查找；成员身份取法与桌面不同；台账目标取法不同。
 * - tier：integration（真实安装、快照子进程、真实台账文件与临时 profile，不调模型）。两边共用
 *   同一个 GhostManager 实例（选项同 Host 的 createHostGhostManager，快照像其它桌面 GhostManager 测试一样
 *   在进程内执行）：类相同，桌面只是把它做成单例。桌面判定“已验证官方”的表达式在
 *   浏览器扩展槽的回调里（index.ts isVerifiedOfficial，打包版分支），这里照抄那一行。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
import { afterAll, describe, expect, it, vi } from 'vitest';

import { createGhostProductionCallbacks } from '../../cindy-brain/__tests__/ghostProductionCallbacksFixture.js';
import { loadGhostFirstPartyFactsLoader, type GhostFirstPartyFactsLoad } from '../../cindy-brain/ghostFirstPartyFacts.js';
import { authorizeGhostTokenBroker, isTrustedPublicMarketPackage } from '../../cindy-brain/ghostFirstPartyPrivilege.js';
import { loadConnectionAudienceResolver } from '../../cindy-brain/connectionAudienceResolver.js';
import { PluginMarketLedger } from '../../plugin-market/ledger.js';
import { createOrganizationPrefixStore } from '../../plugin-market/organizationPrefixStore.js';
import { installedMarketManifestIdentity } from '../../plugin-market/installedManifestIdentity.js';
import { readInstalledGhostManifestSnapshot } from '../../installedGhostManifest.js';
import {
  commitVolatileAppSession,
  getActiveAppSession,
  isAppSessionBoundaryPending,
  LOCAL_DATA_OWNER_ID,
  ownerScopedUserDataPath,
} from '../../appSessionState.js';
import { getAppCapabilities } from '../../appCapabilities.js';
import { configureAppDataDir } from '../../userDataPath.js';
import { createManagedSkills } from '../managedSkillsCore.js';
import { deliveryNamespaceFields, installedGhostStoragePart, parsePluginInstanceId } from '../../../shared/pluginIdentity.js';
import { GHOST_INSTALL_MANIFEST_MAX_BYTES, type InstalledGhost } from '../../../shared/ghost.js';
import type { User } from '../../../shared/authUser.js';
import { GhostManager } from '../../cindy-brain/GhostManager.js';
import { runGhostSnapshotWorkerRequest } from '../../cindy-brain/ghostSnapshotWorkerProcess.js';
import { dataOwnerStorageKey } from '../../dataOwnerPath.js';

// The cases carry PARITY_TIMEOUT_MS below; the cleanup hook removes real temporary
// directories and gets an explicit bound too.
vi.setConfig({ hookTimeout: 60_000 });

type Desktop = {
  loadGhostFirstPartyFactsForGhost(id: string, purpose: 'runtime'): GhostFirstPartyFactsLoad;
  isGhostTokenBrokerAuthorized(id: string, purpose: 'runtime'): boolean;
  resolveConnectionAudienceForGhost(id: string): unknown;
  listAvailableGhostsAsync(): Promise<InstalledGhost[]>;
};
type HostRuntime = {
  identity: {
    loadFirstPartyFacts(id: string, purpose: 'runtime'): GhostFirstPartyFactsLoad;
    isVerifiedPublicMarket(id: string): boolean;
    brokerAuthorized(id: string): boolean;
    connectionAudience(id: string): unknown;
  };
  listManagedSkills(): Promise<Array<{ claudeCommandName?: string; cindyOfficial: boolean; path?: string }>>;
  close(): Promise<void>;
};

const createDesktop = createGhostProductionCallbacks<Desktop>({
  functions: [
    'isGhostAvailableForActiveSession', 'availableGhosts', 'findGhostForInstanceId',
    'listInstalledGhostsAsync', 'listAvailableGhostsAsync', 'captureGhostMutationOwner', 'isSameAppSession',
    'getPluginMarketLedger', 'pluginMarketAuthorizationTargetFor',
    'getGhostFirstPartyFactsLoader', 'loadGhostFirstPartyFactsForGhost', 'isGhostTokenBrokerAuthorized',
    'readInstalledGhostManifestIdentity', 'getConnectionAudienceResolver', 'resolveConnectionAudienceForGhost',
  ],
  variables: ['ghostOwnerScope'],
  initialize: 'let pluginMarketLedgerSingleton = null; let ghostFirstPartyFactsLoaderSingleton = null; let connectionAudienceResolverSingleton = null;',
});

const PLUGINS = {
  thirdParty: { id: 'skill-fixture', namespace: null },
  marketOfficial: { id: 'cindy-market-fixture', namespace: null, market: 'public' },
  accountOfficial: { id: 'cindy-account-fixture', namespace: null, market: 'public', account: true },
  // Declares an organization identity token, so it also needs an account.
  organization: { id: 'skill-fixture', namespace: 'acme', market: 'organization', oidc: true },
} as const;

// Each case installs four plugins and loads both plugin graphs; the parallel
// desktop pool can make the cold transform alone take tens of seconds.
const PARITY_TIMEOUT_MS = 120_000;

const ORG_USER = { id: 'user_1', email: 'member@example.com', membershipKind: 'org', orgId: 'org_1', orgSlug: 'acme' } as User;

describe('plugin identity and managed Skills: desktop production functions and the Node Host read the same', () => {
  const roots: string[] = [];
  afterAll(async () => { for (const root of roots) await fs.rm(root, { recursive: true, force: true }); });

  async function setup(mode: 'cloud' | 'local', user: User | null) {
    const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-plugin-identity-')));
    roots.push(profile);
    // Non-literal specifiers keep the Host sources out of the desktop typecheck.
    const hostModule = (name: string) => import(/* @vite-ignore */ `../../../../../host/src/${name}`);
    const { configureHostOwner } = await hostModule('agent/claude-auth.mjs');
    const { createHostPluginRuntime } = await hostModule('plugins/runtime.ts');
    configureHostOwner({ userDataDir: profile, ownerId: `parity-${mode}` });
    if (mode === 'local') commitVolatileAppSession('local', null, true);
    configureAppDataDir(path.join(profile, 'app-data'));
    const owner = mode === 'local' ? LOCAL_DATA_OWNER_ID : `parity-${mode}`;
    const ownerRoot = path.join(profile, 'owners', dataOwnerStorageKey(owner));
    const manager = new GhostManager({
      getRootDir: () => path.join(ownerRoot, 'cindy-brain'),
      getStateDir: () => path.join(ownerRoot, 'ghost-install-state'),
      getOwnerContextKey: () => dataOwnerStorageKey(owner),
      getLocale: () => 'en',
      mutateSnapshot: async ({ parentDir, ...request }) => runGhostSnapshotWorkerRequest(request, parentDir),
    });
    const ledger = new PluginMarketLedger(ownerScopedUserDataPath('plugin-market', 'ledger.v1.json'));
    const parts: Record<string, string> = {};
    for (const [name, plugin] of Object.entries(PLUGINS)) {
      const zip = new JSZip();
      zip.file('ghost.json', JSON.stringify({ schemaVersion: 3, minCindyVersion: '0.1.61', id: plugin.id,
        name: `Fixture ${plugin.id}`, kind: 'chip', version: '1.0.0', entry: 'main.js',
        tools: [{ name: 'noop', description: 'fixture tool', parameters: { type: 'object' } }],
        ...('account' in plugin ? { network: { hosts: ['api.example.com'], secrets: [{ key: 'email', label: 'Email',
          source: 'login-email', inject: { header: 'X-User', format: '{value}' } }] } } : {}),
        ...('oidc' in plugin ? { network: { hosts: ['api.example.com'], secrets: [{ key: 'cindy_identity', label: 'Organization identity',
          source: 'oidc-token', inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.example.com'] } }] } } : {}),
        skill: { items: [{ dir: 'skills/demo', name: 'demo', description: `Skill of ${plugin.id}` }] } }));
      zip.file('main.js', '// fixture');
      zip.file('skills/demo/SKILL.md', `---\nname: demo\ndescription: Skill of ${plugin.id}\n---\n\nApproved body of ${plugin.id}\n`);
      const archive = path.join(profile, `${name}.cindy`);
      await fs.writeFile(archive, await zip.generateAsync({ type: 'nodebuffer' }));
      const result = await manager.install(archive, { namespace: plugin.namespace, uiCapabilityApproved: true });
      if (!('ghost' in result)) throw new Error(JSON.stringify(result));
      const part = installedGhostStoragePart(result.ghost);
      parts[name] = part;
      if (!('market' in plugin)) continue;
      const sha256 = manager.approvedInstallEvidence(part)?.packageSha256 ?? '';
      expect(sha256).toMatch(/^[0-9a-f]{64}$/);
      // A market install also records the exact ghost.json bytes it placed.
      const snapshot = readInstalledGhostManifestSnapshot(result.ghost.dir, GHOST_INSTALL_MANIFEST_MAX_BYTES);
      expect(snapshot.ok).toBe(true);
      const rawManifestSha256 = snapshot.ok ? snapshot.snapshot.rawManifestSha256 : '';
      ledger.upsertInstallation({ pluginId: `c${String(Object.keys(parts).length).repeat(24)}`, ghostId: plugin.id,
        releaseId: 'release-1', version: '1.0.0', sha256,
        ...(plugin.market === 'organization'
          ? { scope: 'organization' as const, organizationId: ORG_USER.orgId, namespace: plugin.namespace }
          : { scope: 'public' as const, organizationId: null, namespace: null }),
        source: 'market', installed: true, updatedAt: '2026-11-13T00:00:00.000Z', rawManifestSha256 });
    }
    const desktop = createDesktop({
      managerSingleton: manager, getGhostManager: () => manager,
      getActiveAppSession, isAppSessionBoundaryPending, ownerScopedUserDataPath,
      getAuthState: () => ({ isAuthenticated: user !== null, user }),
      PluginMarketLedger, loadGhostFirstPartyFactsLoader, authorizeGhostTokenBroker, createOrganizationPrefixStore,
      loadConnectionAudienceResolver, readInstalledGhostManifestSnapshot, installedMarketManifestIdentity,
      GHOST_INSTALL_MANIFEST_MAX_BYTES, deliveryNamespaceFields, parsePluginInstanceId,
      getGhostRuntime: () => ({ stop() {} }), log: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const secrets = new Map<string, string>();
    const host = await createHostPluginRuntime({ profileDir: profile, ownerId: owner, manager,
      credentials: { read: (key: string) => secrets.get(key) ?? null, write: (key: string, value: string) => { secrets.set(key, value); },
        remove: (key: string) => { secrets.delete(key); } },
      getLoginEmail: () => user?.email ?? null, getUser: () => user,
      appContext: () => ({ ok: false, error: 'unavailable' }), getSession: () => undefined,
      requestFileConfirmation: async () => false, publish() {},
      assets: { nodeWorker: path.join(profile, 'unused-node-worker.cjs'), libraryWorker: path.join(profile, 'unused-library-worker.mjs'),
        bridgeSource: '', executablePath: null, close: async () => {} } }) as HostRuntime;
    const desktopSkills = createManagedSkills({
      listAvailableGhosts: () => desktop.listAvailableGhostsAsync(),
      getGhostManager: () => manager,
      loadGhostFirstPartyFactsForGhost: (id, purpose) => desktop.loadGhostFirstPartyFactsForGhost(id, purpose as 'runtime'),
    });
    return { manager, parts, desktop, host, desktopSkills };
  }

  async function compare(mode: 'cloud' | 'local', user: User | null) {
    const { manager, parts, desktop, host, desktopSkills } = await setup(mode, user);
    try {
      const summary: Record<string, unknown> = {};
      for (const [name, part] of Object.entries(parts)) {
        const facts = desktop.loadGhostFirstPartyFactsForGhost(part, 'runtime');
        expect(host.identity.loadFirstPartyFacts(part, 'runtime'), name).toEqual(facts);
        // index.ts isVerifiedOfficial (packaged branch).
        const verified = facts.kind === 'ready' && isTrustedPublicMarketPackage(facts.facts);
        expect(host.identity.isVerifiedPublicMarket(part), name).toBe(verified);
        const broker = desktop.isGhostTokenBrokerAuthorized(part, 'runtime');
        expect(host.identity.brokerAuthorized(part), name).toBe(broker);
        const audience = desktop.resolveConnectionAudienceForGhost(part);
        expect(host.identity.connectionAudience(part), name).toEqual(audience);
        summary[name] = { facts: facts.kind, verified, broker, audience: audience !== null };
      }
      const hostSkills = await host.listManagedSkills();
      expect(hostSkills).toEqual(await desktopSkills.listCindyManagedSkills());
      return { summary, skills: Object.fromEntries(hostSkills.map(skill => [skill.claudeCommandName, skill.cindyOfficial])), parts };
    } finally {
      await host.close();
      manager.disposeNotificationIndex();
    }
  }

  it('with account services available (an organization member signed in)', async () => {
    const { summary, skills, parts } = await compare('cloud', ORG_USER);
    expect(getAppCapabilities().canUseCindyAccountServices).toBe(true);
    // Not vacuous: each class lands on a different answer.
    expect(summary).toEqual({
      // An organization member without a known plugin prefix: facts are not ready.
      thirdParty: { facts: 'unavailable', verified: false, broker: false, audience: false },
      marketOfficial: { facts: 'ready', verified: true, broker: false, audience: false },
      accountOfficial: { facts: 'ready', verified: true, broker: false, audience: false },
      organization: { facts: 'ready', verified: false, broker: true, audience: true },
    });
    expect(skills).toEqual({
      [`cindy-plugin-${parts.thirdParty}:demo`]: false,
      [`cindy-plugin-${parts.marketOfficial}:demo`]: true,
      [`cindy-plugin-${parts.accountOfficial}:demo`]: true,
      [`cindy-plugin-${parts.organization}:demo`]: false,
    });
  }, PARITY_TIMEOUT_MS);

  it('with account services unavailable (local mode, nobody signed in)', async () => {
    const { summary, skills, parts } = await compare('local', null);
    expect(getAppCapabilities().canUseCindyAccountServices).toBe(false);
    // Both account-requiring plugins drop out of the Skill list.
    expect(skills).toEqual({
      [`cindy-plugin-${parts.thirdParty}:demo`]: false,
      [`cindy-plugin-${parts.marketOfficial}:demo`]: true,
    });
    // The lookup drops them too, yet a market install is still found in the ledger
    // through its instance id (pluginMarketAuthorizationTargetFor), on both sides.
    expect(summary).toEqual({
      thirdParty: { facts: 'ready', verified: false, broker: false, audience: false },
      marketOfficial: { facts: 'ready', verified: true, broker: false, audience: false },
      accountOfficial: { facts: 'ready', verified: true, broker: false, audience: false },
      organization: { facts: 'ready', verified: false, broker: false, audience: false },
    });
  }, PARITY_TIMEOUT_MS);
});
