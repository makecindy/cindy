import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { Logger, McpProvider } from '@cindy/maker-core';
import { withMcpRouteIdentity } from '../codexHttpBridge.js';
import {
  HERMES_BRIDGE_COLLAB_SERVERS,
  HERMES_BRIDGE_EXPERT_SERVERS,
  HERMES_BRIDGE_GATED_SERVERS,
  HERMES_BRIDGE_SAFE_SERVERS,
  buildHermesShimServerConfig,
  createHermesBridgePreparer,
  isHermesCollabEnabled,
  selectHermesBridgeServers,
  syncHermesShimRegistrations,
  type HermesShimRegistrationDeps,
  type HermesShimServerConfig,
} from '../hermesBridgeHost.js';
import { readHermesBridgeRuntimeFile } from '../hermesBridgeRuntimeFile.js';
import { CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY } from '../codexBuiltinToolPolicy.js';
import {
  getPiExtraSpawnConfig,
  resetPiEnvironmentForTest,
  setHermesOnlyBridgeProviders,
  shutdownPiEnvironment,
} from '../piEnvironment.js';

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

const SHIM = '/opt/cindy/hermes-bridge-shim.mjs';

describe('hermes bridge exposure policy', () => {
  it('exposes only SAFE servers by default and only running ones', () => {
    expect(
      selectHermesBridgeServers(['cindy_docs', 'cindy_ssh', 'cindy_browser', 'cindy_memory']),
    ).toEqual(['cindy_docs']);
    expect(selectHermesBridgeServers(['cindy_ssh'])).toEqual([]);
  });

  it('adds a GATED server only when opted in AND running', () => {
    const all = [...HERMES_BRIDGE_SAFE_SERVERS, ...HERMES_BRIDGE_GATED_SERVERS];
    expect(selectHermesBridgeServers(all, new Set(['cindy_ssh']))).toEqual([
      'cindy_docs',
      'cindy_ssh',
    ]);
    expect(selectHermesBridgeServers(['cindy_docs'], new Set(['cindy_ssh']))).toEqual([
      'cindy_docs',
    ]);
    // Not on either list → never exposed, opt-in or not.
    expect(selectHermesBridgeServers(['cindy_memory'], new Set(['cindy_memory']))).toEqual([]);
  });

  it('adds the Orca team server only when collaboration is enabled (ADR 0006, 3.7a)', () => {
    const all = [...HERMES_BRIDGE_SAFE_SERVERS, ...HERMES_BRIDGE_GATED_SERVERS, ...HERMES_BRIDGE_COLLAB_SERVERS];
    expect(selectHermesBridgeServers(all)).toEqual(['cindy_docs']);
    expect(selectHermesBridgeServers(all, new Set(), true)).toEqual(['cindy_docs', 'cindy_orca']);
    // The worker-side bridge is not exposed to Hermes in 3.7a.
    expect(selectHermesBridgeServers([...all, 'orca_worker_bridge'], new Set(), true)).not.toContain('orca_worker_bridge');
    expect(selectHermesBridgeServers(['cindy_docs'], new Set(), true)).toEqual(['cindy_docs']);
  });

  it('adds the expert creator server only for an expert-creator session (3.8)', () => {
    const all = [...HERMES_BRIDGE_SAFE_SERVERS, ...HERMES_BRIDGE_COLLAB_SERVERS, ...HERMES_BRIDGE_EXPERT_SERVERS];
    expect(selectHermesBridgeServers(all, new Set(), true)).toEqual(['cindy_docs', 'cindy_orca']);
    expect(selectHermesBridgeServers(all, new Set(), false, true)).toEqual(['cindy_docs', 'cindy_experts']);
    expect(selectHermesBridgeServers(['cindy_docs'], new Set(), false, true)).toEqual(['cindy_docs']);
  });

  it('mirrors the Pi collab gate: global switch or active team member, never when the project disabled it', () => {
    expect(isHermesCollabEnabled(undefined, [], true)).toBe(true);
    expect(isHermesCollabEnabled(undefined, [], false)).toBe(false);
    expect(isHermesCollabEnabled({ orcaRole: 'lead' }, [], false)).toBe(true);
    expect(isHermesCollabEnabled({ orcaRole: 'worker' }, [], false)).toBe(true);
    expect(isHermesCollabEnabled({ orcaRole: 'lead' }, ['collab'], true)).toBe(false);
  });

  it('builds a static shim command with an unexpanded ${VAR} and no secret', () => {
    expect(buildHermesShimServerConfig(SHIM, 'cindy_docs')).toEqual({
      command: 'node',
      args: [SHIM, '--server', 'cindy_docs'],
      env: { CINDY_BRIDGE_SESSION: '${CINDY_BRIDGE_SESSION}' },
    });
  });
});

describe('syncHermesShimRegistrations', () => {
  function fakeConfig(
    initial: Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>,
  ) {
    const servers = { ...initial };
    const calls: string[] = [];
    const deps: HermesShimRegistrationDeps = {
      listServers: async () => ({ ...servers }),
      setServer: async (name: string, server: HermesShimServerConfig) => {
        calls.push(`set:${name}`);
        servers[name] = server;
      },
      removeServer: async (name: string) => {
        calls.push(`remove:${name}`);
        delete servers[name];
      },
    };
    return { servers, calls, deps };
  }

  it('writes missing entries and is idempotent', async () => {
    const cfg = fakeConfig({});
    expect(await syncHermesShimRegistrations(cfg.deps, SHIM, ['cindy_docs'])).toEqual({
      written: ['cindy_docs'],
      removed: [],
    });
    expect(await syncHermesShimRegistrations(cfg.deps, SHIM, ['cindy_docs'])).toEqual({
      written: [],
      removed: [],
    });
    expect(cfg.calls).toEqual(['set:cindy_docs']);
  });

  it('removes our own no-longer-exposed entries but never a user-owned one', async () => {
    const cfg = fakeConfig({
      cindy_ssh: buildHermesShimServerConfig(SHIM, 'cindy_ssh'),
      cindy_browser: { command: 'npx', args: ['my-own-browser-mcp'] },
    });
    expect(await syncHermesShimRegistrations(cfg.deps, SHIM, ['cindy_docs'])).toEqual({
      written: ['cindy_docs'],
      removed: ['cindy_ssh'],
    });
    expect(cfg.servers.cindy_browser).toEqual({ command: 'npx', args: ['my-own-browser-mcp'] });
  });

  it('does not overwrite a user-owned entry that squats an exposed name', async () => {
    const cfg = fakeConfig({ cindy_docs: { command: 'npx', args: ['mine'] } });
    expect((await syncHermesShimRegistrations(cfg.deps, SHIM, ['cindy_docs'])).written).toEqual([]);
    expect(cfg.servers.cindy_docs).toEqual({ command: 'npx', args: ['mine'] });
  });
});

describe('createHermesBridgePreparer (real bridge, stub providers)', () => {
  let dir: string;
  let runtimeFile: string;

  const stubProvider = (name: string, text: string): McpProvider =>
    ({
      name,
      toClaudeSdkConfig: () => {
        const instance = new McpServer({ name, version: '1.0.0' });
        instance.tool('ping', 'ping', {}, async () => ({
          content: [{ type: 'text' as const, text }],
        }));
        return { type: 'sdk', name, instance };
      },
    }) as unknown as McpProvider;

  beforeEach(async () => {
    resetPiEnvironmentForTest();
    dir = await mkdtemp(path.join(tmpdir(), 'hermes-host-'));
    runtimeFile = path.join(dir, 'hermes-bridge.json');
  });

  afterEach(async () => {
    await shutdownPiEnvironment();
    resetPiEnvironmentForTest();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  async function callTool(
    server: string,
    sessionId: string,
  ): Promise<{ status: number; body: string }> {
    const file = (await readHermesBridgeRuntimeFile(runtimeFile))!;
    const url = withMcpRouteIdentity(`http://127.0.0.1:${file.port}/mcp/${server}`, { sessionId });
    const headers: Record<string, string> = {
      authorization: `Bearer ${file.sessions[sessionId]}`,
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };
    const init = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'shim', version: '1' },
        },
      }),
    });
    if (init.status !== 200) return { status: init.status, body: await init.text() };
    headers['mcp-session-id'] = init.headers.get('mcp-session-id')!;
    await init.text();
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'ping', arguments: {} },
      }),
    });
    return { status: res.status, body: await res.text() };
  }

  it('registers identity, writes only SAFE shim entries, blocks a gated plugin, and cleans up', async () => {
    const written: string[] = [];
    const prepare = createHermesBridgePreparer({
      providers: () => [
        stubProvider('cindy_docs', 'docs-ok'),
        stubProvider('cindy_browser', 'browser-ok'),
      ],
      logger: noopLogger(),
      runtimeFile,
      resolveShimPath: () => SHIM,
      registration: {
        listServers: async () => ({}),
        setServer: async (name) => {
          written.push(name);
        },
        removeServer: async () => undefined,
      },
    });

    const session = await prepare({ sessionId: 'sess-H', workingDir: dir, permissionMode: 'bypassPermissions' });
    expect(session).not.toBeNull();
    expect(session!.env).toEqual({ CINDY_BRIDGE_SESSION: 'sess-H' });
    expect(written).toEqual(['cindy_docs']);
    if (process.platform !== 'win32') {
      expect((await stat(runtimeFile)).mode & 0o777).toBe(0o600);
    }

    const docs = await callTool('cindy_docs', 'sess-H');
    expect(docs.body).toContain('docs-ok');
    const browser = await callTool('cindy_browser', 'sess-H');
    expect(browser.body).not.toContain('browser-ok');

    session!.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const after = await readHermesBridgeRuntimeFile(runtimeFile);
    expect(after?.sessions['sess-H']).toBeUndefined();
  });

  it('exposes cindy_orca with collaboration on, and a runtime patch cannot widen the frozen tool policy (3.7a)', async () => {
    const written: string[] = [];
    const prepare = createHermesBridgePreparer({
      providers: () => [
        stubProvider('cindy_docs', 'docs-ok'),
        stubProvider('cindy_orca', 'orca-ok'),
        stubProvider('cindy_browser', 'browser-ok'),
      ],
      logger: noopLogger(),
      runtimeFile,
      resolveShimPath: () => SHIM,
      globalCollabEnabled: () => true,
      registration: {
        listServers: async () => ({}),
        setServer: async (name) => {
          written.push(name);
        },
        removeServer: async () => undefined,
      },
    });
    const session = await prepare({ sessionId: 'sess-L', workingDir: dir, permissionMode: 'bypassPermissions' });
    expect(written).toEqual(['cindy_docs', 'cindy_orca']);
    expect((await callTool('cindy_orca', 'sess-L')).body).toContain('orca-ok');

    // start_team marks the lead in place; a patch naming policy keys is ignored.
    session!.setVendorOptions!({ orcaRole: 'lead', [CODEX_ALLOWED_BUILTIN_PLUGIN_IDS_KEY]: ['browser'] });
    expect((await callTool('cindy_browser', 'sess-L')).body).not.toContain('browser-ok');
    expect((await callTool('cindy_orca', 'sess-L')).body).toContain('orca-ok');
    session!.dispose();
  });

  it('keeps cindy_orca off with collaboration off, unless the resumed session is already a team member', async () => {
    const run = async (sessionId: string, vendorOptions?: Record<string, unknown>) => {
      const written: string[] = [];
      const prepare = createHermesBridgePreparer({
        providers: () => [stubProvider('cindy_docs', 'docs-ok'), stubProvider('cindy_orca', 'orca-ok')],
        logger: noopLogger(),
        runtimeFile,
        resolveShimPath: () => SHIM,
        globalCollabEnabled: () => false,
        registration: {
          listServers: async () => ({}),
          setServer: async (name) => {
            written.push(name);
          },
          removeServer: async () => undefined,
        },
      });
      const session = await prepare({
        sessionId,
        workingDir: dir,
        permissionMode: 'bypassPermissions',
        ...(vendorOptions ? { vendorOptions } : {}),
      });
      const orca = await callTool('cindy_orca', sessionId);
      session!.dispose();
      return { written, orca: orca.body };
    };
    const plain = await run('sess-P');
    expect(plain.written).toEqual(['cindy_docs']);
    expect(plain.orca).not.toContain('orca-ok');
    const lead = await run('sess-R', { orcaRole: 'lead', orcaLeadSessionId: 'sess-R' });
    expect(lead.written).toEqual(['cindy_docs', 'cindy_orca']);
    expect(lead.orca).toContain('orca-ok');
  });

  it('serves cindy_experts on the shared bridge to an expert-creator Hermes session only, never to Pi (3.8)', async () => {
    setHermesOnlyBridgeProviders([stubProvider('cindy_experts', 'experts-ok')]);
    const run = async (sessionId: string, creator: boolean) => {
      const written: string[] = [];
      const removed: string[] = [];
      const prepare = createHermesBridgePreparer({
        providers: () => [stubProvider('cindy_docs', 'docs-ok')],
        logger: noopLogger(),
        runtimeFile,
        resolveShimPath: () => SHIM,
        globalCollabEnabled: () => false,
        expertCreator: (id) => creator && id === sessionId,
        registration: {
          listServers: async () => ({ cindy_experts: buildHermesShimServerConfig(SHIM, 'cindy_experts') }),
          setServer: async (name) => {
            written.push(name);
          },
          removeServer: async (name) => {
            removed.push(name);
          },
        },
      });
      const session = await prepare({ sessionId, workingDir: dir, permissionMode: 'bypassPermissions' });
      const experts = await callTool('cindy_experts', sessionId);
      session!.dispose();
      return { written, removed, experts: experts.body };
    };
    const creator = await run('sess-C', true);
    expect(creator.written).toEqual(['cindy_docs']);
    expect(creator.removed).toEqual([]);
    expect(creator.experts).toContain('experts-ok');
    const plain = await run('sess-N', false);
    expect(plain.removed).toEqual(['cindy_experts']);
    expect(plain.experts).not.toContain('experts-ok');

    // Pi shares the bridge but never mounts the Hermes-only server.
    const pi = await getPiExtraSpawnConfig([stubProvider('cindy_docs', 'docs-ok')], noopLogger(), {
      sessionId: 'pi-1',
      workingDir: dir,
    } as Parameters<typeof getPiExtraSpawnConfig>[2]);
    const piServers = pi?.mcpBridge?.servers.map((server) => server.name) ?? [];
    expect(piServers).toContain('cindy_docs');
    expect(piServers).not.toContain('cindy_experts');
    pi?.disposeSessionCtx?.();
  });

  it('returns null and touches nothing unless the session is full access (1.5b-5d)', async () => {
    let touched = false;
    const prepare = createHermesBridgePreparer({
      providers: () => [stubProvider('cindy_docs', 'docs-ok')],
      logger: noopLogger(),
      runtimeFile,
      resolveShimPath: () => SHIM,
      registration: {
        listServers: async () => {
          touched = true;
          return {};
        },
        setServer: async () => undefined,
        removeServer: async () => undefined,
      },
    });
    for (const permissionMode of [undefined, 'default', 'acceptEdits', 'plan']) {
      expect(
        await prepare({ sessionId: 'sess-D', workingDir: dir, ...(permissionMode ? { permissionMode } : {}) }),
      ).toBeNull();
    }
    expect(touched).toBe(false);
    expect(await readHermesBridgeRuntimeFile(runtimeFile)).toBeNull();
  });

  it('fails open (null) without a shim bundle, and registers nothing', async () => {
    let touched = false;
    const prepare = createHermesBridgePreparer({
      providers: () => [stubProvider('cindy_docs', 'docs-ok')],
      logger: noopLogger(),
      runtimeFile,
      resolveShimPath: () => null,
      registration: {
        listServers: async () => {
          touched = true;
          return {};
        },
        setServer: async () => undefined,
        removeServer: async () => undefined,
      },
    });
    expect(await prepare({ sessionId: 'sess-N', workingDir: dir, permissionMode: 'bypassPermissions' })).toBeNull();
    expect(touched).toBe(false);
    expect(await readHermesBridgeRuntimeFile(runtimeFile)).toBeNull();
  });
});
