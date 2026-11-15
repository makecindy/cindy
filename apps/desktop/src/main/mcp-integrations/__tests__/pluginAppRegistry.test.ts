import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getPluginToolUi } from '@cindy/plugin-protocol';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { sharedPluginConnection, type AppServerConfig } from '../../mcp-apps/connection.js';
import { McpAppsHost, appServerRevision } from '../../mcp-apps/host.js';
import type { InstalledGhost } from '../../../shared/ghost.js';
import { ghostHostUiApprovalTokens } from '../../../shared/ghost.js';
import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import type { McpAppRecord } from '../../../shared/mcpApps.js';
import { publishPluginAppResult } from '../../mcp-apps/pluginCards.js';
import { refreshGhostLocalizationIfChanged } from '../../cindy-brain/ghostLocalizationRefresh.js';
import { createGhostProductionCallbacks } from '../../cindy-brain/__tests__/ghostProductionCallbacksFixture.js';
const state = vi.hoisted(() => ({
  owner: 'A',
  configs: new Map<string, () => AppServerConfig>(),
  reads: 0,
  realFiles: false,
}));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => state.owner }));
vi.mock('../../mcp-apps/runtime.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mcp-apps/runtime.js')>();
  return {
    ...actual,
    replacePluginAppServers: (next: typeof state.configs) => {
      actual.replacePluginAppServers(next);
      state.configs = next;
    },
  };
});
vi.mock('../../cindy-brain/ghostContentTree.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cindy-brain/ghostContentTree.js')>();
  return { resolveGhostContentPathSync: (...args: Parameters<typeof actual.resolveGhostContentPathSync>) => {
    state.reads++;
    if (state.realFiles) return actual.resolveGhostContentPathSync(...args);
    throw new Error('no file may be read');
  } };
});
import { resetAppServers, setMcpAppsHost, readAppServer } from '../../mcp-apps/runtime.js';
import { pagePermissionGrants } from '../../mcp-apps/pagePermissions.js';
import { refreshPluginApps, pluginAppServerId, readPluginHostUi } from '../plugin-app-registry.js';
// Production registration entry, no Node process or network. Existing App host tests
// do not own plugin receipts. Minimal failure: missing ui fact or old owner callback.
// Tier: unit; mocks only external account/storage boundaries, real SDK discovery.
afterEach(() => {
  resetAppServers();
  state.owner = 'A';
  state.configs.clear();
  state.reads = 0;
  state.realFiles = false;
});
function fixture() {
  let ghost: InstalledGhost = {
    manifest: {
      schemaVersion: 3,
      id: 'planner',
      name: 'Planner',
      kind: 'chip',
      entry: 'main.js',
      version: '1',
      tools: [{ name: 'open', description: 'Open' }],
      mcpApps: { ui: { resources: [{
            uri: "ui://form",
            file: 'form.html'
        }], tools: { open: { resourceUri: "ui://form" } } } },
    },
    enabled: true,
    dir: '/fixture',
    approval: { state: 'approved', revision: 'one' },
    uiCapabilityApproved: true,
  };
  let fingerprint = 'hash',
    available = true;
  const refresh = () =>
    refreshPluginApps([ghost], {
      find: () => ghost,
      evidence: () => ({ packageSha256: fingerprint }),
      available: () => available,
    });
  return {
    ghost,
    refresh,
    setGhost: (next: InstalledGhost) => {
      ghost = next;
    },
    setFingerprint: () => {
      fingerprint = 'changed';
    },
    unavailable: () => {
      available = false;
    },
  };
}

// Registered native settings do not imply approval for an MCP App transport.
// Minimal failure: a settings-approved plugin with UI approval absent (unit).
it('projects settings without opening UI servers and revokes an old UI binding independently', () => {
  const f = fixture();
  f.ghost.manifest.mcpApps = { ui: getPluginToolUi(f.ghost.manifest), host: {
    views: [{ id: 'view', title: 'View', resourceUri: 'ui://form' }],
    settings: [{ id: 'enabled', title: 'Enabled', type: 'boolean', default: true }] } };
  f.ghost.approvedHostUi = ghostHostUiApprovalTokens(f.ghost.manifest);
  const instance = installedGhostStoragePart(f.ghost);
  f.refresh();
  const old = readPluginHostUi(instance)!;
  f.setGhost({ ...f.ghost, uiCapabilityApproved: undefined });
  expect(() => old.config.plugin!.assertCurrent()).toThrow();
  f.refresh();
  expect(readPluginHostUi(instance)?.host.settings).toHaveLength(1);
  expect(readPluginHostUi(instance)?.host.views).toBeUndefined();
  expect(state.configs.size).toBe(0);
});

// Stable binding identity is part of View lifecycle: list/localization updates
// cannot reload a live resource, while actual approval changes must revoke it (unit).
it('preserves Host UI bindings across unchanged directory refreshes and revokes changed approval', () => {
  const f = fixture();
  f.ghost.manifest.mcpApps = { ui: getPluginToolUi(f.ghost.manifest), host: {
    views: [{ id: 'workspace', title: 'Workspace', resourceUri: 'ui://form' }], capabilities: ['context'],
  } };
  f.ghost.approvedHostUi = ghostHostUiApprovalTokens(f.ghost.manifest);
  const instance = installedGhostStoragePart(f.ghost);
  f.refresh();
  const binding = readPluginHostUi(instance);
  expect(binding).toBeDefined();
  f.ghost.manifest.name = 'Localized';
  f.refresh();
  expect(readPluginHostUi(instance)).toBe(binding);
  expect(state.reads).toBe(0);
  f.setGhost({ ...f.ghost, approval: { state: 'approved', revision: 'two' } });
  f.refresh();
  expect(readPluginHostUi(instance)).not.toBe(binding);
  expect(() => binding!.config.plugin!.assertCurrent()).toThrow();
});

// PR #8752: locale-only refresh skipped App registry localization, so new cards
// retained the old title. Unit through the real locale entry, registry and card writer;
// the existing direct-registry refresh test cannot catch the missing caller update.
const localeCallbacks = createGhostProductionCallbacks<{ refreshGhostLocalization(locale: string): void }>({
  functions: ['refreshGhostLocalization'],
});
it('uses the new locale for cards published after a locale-only refresh', async () => {
  const f = fixture();
  f.refresh();
  const owner = {};
  const records: McpAppRecord[] = [];
  const host = new McpAppsHost({
    owner: () => owner, config: readAppServer,
    readCard: async () => { throw new Error('no existing card'); },
    writeCard: async (_session, _client, record) => { records.push(record); },
    authorizeTool: async () => {}, sendMessage: async () => {},
  });
  setMcpAppsHost(host);
  try {
    await publishPluginAppResult(f.ghost, 'task', 'open', {}, 'done');
    expect(records.at(-1)?.tool.title).toBe('Planner');
    const localized = { ...f.ghost, manifest: { ...f.ghost.manifest, name: 'Planificateur' } };
    f.setGhost(localized);
    const manager = { list: () => [localized], approvedInstallEvidence: () => ({ packageSha256: 'hash' }) };
    const { refreshGhostLocalization } = localeCallbacks({
      managerSingleton: manager, getGhostManager: () => manager,
      currentGhostAppContext: () => ({ context: { region: 'global' } }),
      getResolvedMainLocale: () => 'fr', refreshGhostLocalizationIfChanged, refreshPluginApps,
      findGhostForInstanceId: () => localized, isGhostBoundaryPending: () => false,
      broadcastGhostsChanged: vi.fn(), sendToGhostLogic: vi.fn(),
    });
    refreshGhostLocalization('en');
    await publishPluginAppResult(localized, 'task', 'open', {}, 'done');
    expect(records.at(-1)?.tool).toMatchObject({
      title: 'Planificateur', _meta: { 'cindy/plugin': { name: 'Planificateur' } },
    });
  } finally {
    await host.reset();
  }
});
it.each(['unapproved', 'disabled', 'invalid'] as const)(
  'does not register or read HTML for %s page authority',
  (kind) => {
    const f = fixture();
    if (kind === 'unapproved') delete f.ghost.uiCapabilityApproved;
    if (kind === 'disabled') f.ghost.enabled = false;
    if (kind === 'invalid') f.ghost.manifest.mcpApps = { ui: { resources: null, tools: null } } as never;
    f.refresh();
    expect(state.configs.size).toBe(0);
    expect(state.reads).toBe(0);
  },
);
it('discovers tools with the real SDK without reading HTML during registration or initialization', async () => {
  const f = fixture();
  f.refresh();
  const config = state.configs.get(pluginAppServerId(f.ghost))!();
  const client = new Client({ name: 'host', version: '1' });
  try {
    await client.connect(config.plugin!.createTransport());
    expect((await client.listTools()).tools[0]._meta?.ui).toMatchObject({
      resourceUri: 'ui://form',
    });
    expect(state.reads).toBe(0);
  } finally {
    await client.close();
  }
});
it.each(['owner', 'revision', 'package', 'directory', 'disabled', 'boundary'] as const)(
  'rejects an existing virtual connection after %s changes',
  (kind) => {
    const f = fixture();
    f.refresh();
    const old = state.configs.get(pluginAppServerId(f.ghost))!();
    if (kind === 'owner') state.owner = 'B';
    if (kind === 'revision')
      f.setGhost({ ...f.ghost, approval: { state: 'approved', revision: 'two' } });
    if (kind === 'package') f.setFingerprint();
    if (kind === 'directory') f.setGhost({ ...f.ghost, dir: '/moved/planner' });
    if (kind === 'disabled') f.ghost.enabled = false;
    if (kind === 'boundary') f.unavailable();
    expect(() => old.plugin!.assertCurrent()).toThrow('MCP_APP_SERVER_CHANGED');
    if (kind === 'owner') {
      f.refresh();
      expect(() => state.configs.get(old.id)!().plugin!.assertCurrent()).not.toThrow();
      expect(() => old.plugin!.assertCurrent()).toThrow();
    }
  },
);
it('keeps organization and personal instances separate', () => {
  const { ghost } = fixture();
  expect(pluginAppServerId({ ...ghost, namespace: null })).not.toBe(
    pluginAppServerId({ ...ghost, namespace: 'xd' }),
  );
});

// PR #7924: list broadcasts discarded every remembered page approval. Unit through
// production refresh/registry + page grant store; previous tests mocked replacement.
// Minimum failure: refresh the unchanged approved package after granting one task/tool.
it('preserves unchanged page grants across localization and unrelated plugin updates', () => {
  const f = fixture();
  const other = { ...f.ghost, manifest: { ...f.ghost.manifest, id: 'other' } };
  const ghosts = [f.ghost, other];
  const refresh = () => refreshPluginApps(ghosts, {
    find: (id) => ghosts.find(g => g.manifest.id === id) ?? null,
    evidence: () => ({ packageSha256: 'hash' }), available: () => true,
  });
  refresh();
  const grant = { sessionId: 'task', serverId: pluginAppServerId(f.ghost), tool: 'open', revision: 'one', clearedAt: null };
  const otherGrant = { ...grant, serverId: pluginAppServerId(other) };
  pagePermissionGrants.allow('A', grant);
  pagePermissionGrants.allow('A', otherGrant);
  f.ghost.manifest.name = 'Localized title';
  refresh();
  expect(pagePermissionGrants.has('A', grant)).toBe(true);
  other.approval = { state: 'approved', revision: 'two' };
  refresh();
  expect(pagePermissionGrants.has('A', grant)).toBe(true);
  expect(pagePermissionGrants.has('A', otherGrant)).toBe(false);
  expect(pagePermissionGrants.has('A', { ...grant, tool: 'another' })).toBe(false);
  expect(pagePermissionGrants.has('A', { ...grant, sessionId: 'another' })).toBe(false);
});
it.each(['revision', 'resource-package', 'approval', 'instance', 'owner'] as const)(
  'revokes remembered page grants when %s changes', kind => {
    const f = fixture(); f.refresh();
    const grant = { sessionId: 'task', serverId: pluginAppServerId(f.ghost), tool: 'open', revision: 'one', clearedAt: null };
    pagePermissionGrants.allow('A', grant);
    if (kind === 'revision') f.setGhost({ ...f.ghost, approval: { state: 'approved', revision: 'two' } });
    if (kind === 'resource-package') { getPluginToolUi(f.ghost.manifest)!.resources[0].file = 'new.html'; f.setFingerprint(); }
    if (kind === 'approval') delete f.ghost.uiCapabilityApproved;
    if (kind === 'instance') f.setGhost({ ...f.ghost, namespace: 'another' });
    if (kind === 'owner') state.owner = 'B';
    f.refresh();
    expect(pagePermissionGrants.has('A', grant)).toBe(false);
  },
);

// #7924 / 4420763923: real SDK resources/read + disk file must honor the App host's
// 4 MiB contract. Prior tests never read HTML. Unit; 4 MiB is valid, +1 byte is not.
it('reads a 4 MiB plugin page and rejects an oversized resource', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-resource-'));
  const client = new Client({ name: 'host', version: '1' });
  try {
    const f = fixture();
    f.ghost.dir = dir;
    state.realFiles = true;
    const html = 'x'.repeat(4 * 1024 * 1024);
    await fs.writeFile(path.join(dir, 'form.html'), html);
    f.refresh();
    await client.connect(state.configs.get(pluginAppServerId(f.ghost))!().plugin!.createTransport());
    expect((await client.readResource({ uri: 'ui://form' })).contents[0]).toMatchObject({ text: html });
    await fs.appendFile(path.join(dir, 'form.html'), 'x');
    await expect(client.readResource({ uri: 'ui://form' })).rejects.toThrow('MCP_APP_RESOURCE_UNAVAILABLE');
  } finally {
    await client.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// 4421388596: owner recovery can move an approved instance without changing its
// revision/hash. Unit through real registry, Host, SDK and disk; existing tests
// never moved the directory. Old transport/View must retire and new reads use it.
it('revokes old Views and transports when the approved package moves directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'plugin-ui-move-'));
  const beforeDir = path.join(root, 'before');
  const afterDir = path.join(root, 'after');
  const f = fixture();
  const owner = {};
  let host: McpAppsHost | undefined;
  try {
    await fs.mkdir(beforeDir);
    await fs.writeFile(path.join(beforeDir, 'form.html'), '<p>Approved page</p>');
    f.ghost.dir = beforeDir;
    f.ghost.instanceKey = '_root__planner';
    state.realFiles = true;
    f.refresh();
    const before = readAppServer(pluginAppServerId(f.ghost))!;
    const connection = sharedPluginConnection(before, owner);
    const client = await connection.getClient();
    const tool = (await connection.tools())[0];
    host = new McpAppsHost({
      owner: () => owner, config: readAppServer,
      readCard: async () => ({ version: 1, serverId: before.id,
        serverRevision: appServerRevision(before), resourceUri: 'ui://form', tool,
        arguments: {}, result: { content: [] } }),
      writeCard: async () => {}, authorizeTool: async () => {}, sendMessage: async () => {},
    });
    setMcpAppsHost(host);
    const view = await host.open('renderer:1', 'task', 'card', {});
    await fs.rename(beforeDir, afterDir);
    await fs.mkdir(beforeDir);
    await fs.writeFile(path.join(beforeDir, 'form.html'), '<p>Unrelated installation</p>');
    f.setGhost({ ...f.ghost, dir: afterDir });
    await expect(client.readResource({ uri: 'ui://form' })).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    const revoke = vi.spyOn(host, 'revokePluginServers');
    f.refresh();
    await revoke.mock.results[0].value;
    const after = readAppServer(before.id)!;
    expect(appServerRevision(after)).not.toBe(appServerRevision(before));
    expect(connection.isClosed).toBe(true);
    await expect(host.poll('renderer:1', 'task', view.viewId, 0)).rejects.toThrow();
    const next = sharedPluginConnection(after, owner);
    try {
      expect(next).not.toBe(connection);
      expect((await (await next.getClient()).readResource({ uri: 'ui://form' })).contents[0])
        .toMatchObject({ text: '<p>Approved page</p>' });
    } finally { await next.close(); }
  } finally {
    await host?.reset();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  }
});
