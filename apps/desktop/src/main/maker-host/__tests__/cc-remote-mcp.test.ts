/**
 * cc-remote-mcp 的 buildCcRemoteHttpMcpServers:
 * bridge 不可用时降级为空;server 名单按白名单过滤;session ctx 注册进 bridge
 * 并以 ?session=&instance= query + persistent token 下发;cleanup 注销 ctx;同 session
 * 重建直接覆盖注册不累积。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RemoteHost } from '@cindy/maker-remote-ssh';

import type { CodexHttpBridge } from '../../mcp-integrations/codexHttpBridge.js';
import { buildCcRemoteHttpMcpServers } from '../cc-remote-mcp.js';

function fakeBridge() {
  const registered = new Map<string, {
    sessionId: string;
    sessionInstanceId?: string;
    agentKind: string;
    vendorOptions: unknown;
  }>();
  const bridge = {
    registerSessionCtx: vi.fn((sessionId: string, ctx: {
      sessionId: string;
      sessionInstanceId?: string;
      agentKind: string;
      vendorOptions: unknown;
    }) => {
      registered.set(sessionId, ctx);
    }),
    unregisterSessionCtx: vi.fn((sessionId: string, expectedCtx?: unknown) => {
      if (expectedCtx !== undefined && registered.get(sessionId) !== expectedCtx) return;
      registered.delete(sessionId);
    }),
  };
  return {
    bridge: bridge as unknown as CodexHttpBridge,
    registered,
    spies: bridge,
  };
}

const HOST = { id: 'host-1' } as unknown as RemoteHost;

describe('buildCcRemoteHttpMcpServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when the bridge is unavailable', async () => {
    const { servers, cleanup } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => null,
        ensureForward: vi.fn(async () => 47921),
      },
    );
    expect(servers).toEqual({});
    expect(() => cleanup()).not.toThrow();
  });

  it('returns empty when collab is globally disabled even though the bridge still lists cindy_orca (R20 P2)', async () => {
    // provider 层为工具面稳定在禁用时仍注册 cindy_orca — bridge 名单不
    // 反映开关, 远端 cc 注入以同一全局闸门为准: 禁用即整个不注入。
    const { bridge, registered } = fakeBridge();
    const { servers, cleanup } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        isCollabEnabled: () => false,
      },
    );
    expect(servers).toEqual({});
    expect(registered.size).toBe(0); // 不注册任何 session ctx
    expect(() => cleanup()).not.toThrow();
  });

  it('flags needsFreshStart when the bridge token is unavailable (R21 P2)', async () => {
    // token 失效但本要注入:调用方必须 forceFresh — 否则 attach 回带旧
    // Authorization header 的 alive query, 协同 MCP 持续 401。
    const { bridge } = fakeBridge();
    const { servers, needsFreshStart } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => null,
      },
    );
    expect(servers).toEqual({});
    expect(needsFreshStart).toBe(true);
  });

  it('does not flag needsFreshStart when the token is available', async () => {
    const { bridge } = fakeBridge();
    const { needsFreshStart } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
      },
    );
    expect(needsFreshStart).toBeFalsy();
  });

  it('unregisters the stale session ctx when collab is disabled (R26 P2: no leftover auth route)', async () => {
    // 此前注入注册过 ctx 的 session, collab 禁用后 build 必须摘掉它 —
    // 否则 ?session=<id> 的授权路由在禁用后仍可用到 bridge 关闭。
    const { bridge, registered } = fakeBridge();
    registered.set('s-disable', { sessionId: 's-disable', agentKind: 'claude-code', vendorOptions: {} });
    const { servers, fingerprint } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's-disable', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        isCollabEnabled: () => false,
      },
    );
    expect(servers).toEqual({});
    expect(fingerprint).toBe('disabled');
    expect(registered.has('s-disable')).toBe(false); // 旧 ctx 已摘
  });

  it('returns a generation fingerprint on successful injection, and the disabled constant when gated off (R23 P2)', async () => {
    const { bridge } = fakeBridge();
    const injected = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
      },
    );
    expect(typeof injected.fingerprint).toBe('string');
    expect(injected.fingerprint!.length).toBeGreaterThan(0);

    const gated = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's2', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        isCollabEnabled: () => false,
      },
    );
    expect(gated.servers).toEqual({});
    expect(gated.fingerprint).toBe('disabled');
  });

  it('returns no fingerprint when the bridge token is unavailable (drift stays idle)', async () => {
    const { bridge } = fakeBridge();
    const { fingerprint, needsFreshStart } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => null,
      },
    );
    expect(fingerprint).toBeUndefined();
    expect(needsFreshStart).toBe(true);
  });

  it('injects only whitelisted servers with persistent token and instance-bound routing', async () => {
    const { bridge, registered } = fakeBridge();
    const { servers } = await buildCcRemoteHttpMcpServers(
      {
        host: HOST,
        sessionId: 's1',
        sessionInstanceId: 'instance-1',
        workingDir: '/remote/repo',
      },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge', 'cindy_memory', 'cindy_ssh'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        synthesizeVendorOptions: async () => ({ orcaRole: 'lead', orcaLeadSessionId: 's1' }),
      },
    );

    expect(Object.keys(servers).sort()).toEqual(['cindy_orca', 'orca_worker_bridge']);
    expect(servers.cindy_orca).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:47921/mcp/cindy_orca?session=s1&instance=instance-1',
      headers: { Authorization: 'Bearer persistent-test-token' },
    });
    // ctx 以 sessionId 为 key 注册,带 agentKind / vendorOptions。
    expect(registered.get('s1')).toMatchObject({
      sessionId: 's1',
      sessionInstanceId: 'instance-1',
      agentKind: 'claude-code',
      mcpCallerKind: 'root',
      mcpCallerAttested: true,
      vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: 's1' },
    });
  });

  it('cleanup unregisters the session ctx', async () => {
    const { bridge, spies } = fakeBridge();
    const { cleanup } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'tok',
        synthesizeVendorOptions: async () => ({}),
      },
    );
    cleanup();
    expect(spies.unregisterSessionCtx).toHaveBeenCalledWith('s1', expect.objectContaining({ sessionId: 's1' }));
  });

  it('re-registering the same session overwrites instead of accumulating (resume/rebuild)', async () => {
    const { bridge, spies, registered } = fakeBridge();
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
      ensureForward: vi.fn(async () => 47921),
      getBridgeToken: async () => 'tok',
      synthesizeVendorOptions: async () => ({ orcaRole: 'lead' as const }),
    };
    await buildCcRemoteHttpMcpServers({ host: HOST, sessionId: 's1', workingDir: '/a' }, deps);
    await buildCcRemoteHttpMcpServers({ host: HOST, sessionId: 's1', workingDir: '/b' }, deps);
    // sessionId 即 key:两次注册只是覆盖,不累积,也无需先清。
    expect(spies.registerSessionCtx).toHaveBeenCalledTimes(2);
    expect(registered.size).toBe(1);
    expect(registered.get('s1')).toMatchObject({ sessionId: 's1' });
  });

  it('a stale cleanup from the previous query does not delete the rebuilt ctx', async () => {
    // race P1 回归:Q1 register → Q2 重建覆盖 → Q1 close 的迟到 cleanup
    // 不得误删 Q2 的 ctx (代际比较)。
    const { bridge, registered } = fakeBridge();
    const deps = {
      ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
      ensureForward: vi.fn(async () => 47921),
      getBridgeToken: async () => 'tok',
      synthesizeVendorOptions: async () => ({}),
    };
    const first = await buildCcRemoteHttpMcpServers({ host: HOST, sessionId: 's1', workingDir: '/a' }, deps);
    await buildCcRemoteHttpMcpServers({ host: HOST, sessionId: 's1', workingDir: '/b' }, deps);
    first.cleanup();
    expect(registered.has('s1')).toBe(true);
  });

  it('prefers the session vendorOptions over the DB synthesize (worker bootstrap race)', async () => {
    // 验收实锤回归:worker 首次创建时 DB 的 orca 标记在 bootstrap 之后才写,
    // 现场查库会拿到空角色, worker 的 send_to_lead 被 fail-closed 成
    // "not an orca worker session"。session 透传的 vendorOptions 必须优先。
    const { bridge, registered } = fakeBridge();
    const synthesize = vi.fn(async () => ({}));
    const workerVendorOptions = {
      orcaRole: 'worker',
      orcaWorkflowId: 'team-1',
      orcaLeadSessionId: 'lead-1',
      orcaWorkerId: 'w-1',
      orcaWorkerSessionId: 's1',
    };
    await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo', vendorOptions: workerVendorOptions },
      {
        ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'tok',
        synthesizeVendorOptions: synthesize,
      },
    );
    expect(registered.get('s1')).toMatchObject({ vendorOptions: workerVendorOptions });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('falls back to the DB synthesize when session vendorOptions is absent', async () => {
    const { bridge, registered } = fakeBridge();
    await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'tok',
        synthesizeVendorOptions: async () => ({ orcaRole: 'lead', orcaLeadSessionId: 's1' }),
      },
    );
    expect(registered.get('s1')).toMatchObject({
      vendorOptions: { orcaRole: 'lead', orcaLeadSessionId: 's1' },
    });
  });

  it('returns empty without registering when the bridge token is unavailable', async () => {
    // race P1 回归:token null 不得下发 "Bearer null", 也不得残留已注册 ctx。
    const { bridge, registered } = fakeBridge();
    const { servers, cleanup } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => null,
        synthesizeVendorOptions: async () => ({}),
      },
    );
    expect(servers).toEqual({});
    expect(registered.size).toBe(0);
    expect(() => cleanup()).not.toThrow();
  });

  it('leaves no registered ctx when a pre-register step fails', async () => {
    // race P1 回归:token 已前置确认, synthesize 等失败发生在 register 之前,
    // 不得残留 ctx;register 之后的构建段另有 try/catch 回滚兜底。
    const { bridge, registered } = fakeBridge();
    await expect(
      buildCcRemoteHttpMcpServers(
        { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
        {
          ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_orca'], bridge }),
          ensureForward: vi.fn(async () => 47921),
          getBridgeToken: async () => 'tok',
          synthesizeVendorOptions: async () => {
            throw new Error('db exploded');
          },
        },
      ),
    ).rejects.toThrow('db exploded');
    expect(registered.size).toBe(0);
  });

  it('returns empty when no whitelisted server is on the bridge (collab disabled)', async () => {
    const { bridge } = fakeBridge();
    const ensureForward = vi.fn(async () => 47921);
    const { servers } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      {
        ensureBridgeStarted: async () => ({ port: 38080, serverNames: ['cindy_memory'], bridge }),
        ensureForward,
      },
    );
    expect(servers).toEqual({});
    expect(ensureForward).not.toHaveBeenCalled();
  });

  it('injects cindy_memory alongside collab servers when the session Maker Memory flag is on, with remoteHostId in ctx', async () => {
    const { bridge, registered } = fakeBridge();
    const { servers } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo', makerMemoryEnabled: true },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge', 'cindy_memory', 'cindy_ssh'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        synthesizeVendorOptions: async () => ({}),
      },
    );
    expect(Object.keys(servers).sort()).toEqual(['cindy_memory', 'cindy_orca', 'orca_worker_bridge']);
    expect(servers.cindy_memory).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:47921/mcp/cindy_memory?session=s1',
      headers: { Authorization: 'Bearer persistent-test-token' },
    });
    // ctx 必须带 remoteHostId — cindy_memory 据此把远端路径隔离到
    // ssh:<hostId>:<path> 的独立 store。
    expect(registered.get('s1')).toMatchObject({ remoteHostId: 'host-1', workingDir: '/remote/repo' });
  });

  it('injects only cindy_memory when collab is disabled but the session Maker Memory flag is on', async () => {
    const { bridge } = fakeBridge();
    const { servers } = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo', makerMemoryEnabled: true },
      {
        ensureBridgeStarted: async () => ({
          port: 38080,
          serverNames: ['cindy_orca', 'orca_worker_bridge', 'cindy_memory'],
          bridge,
        }),
        ensureForward: vi.fn(async () => 47921),
        getBridgeToken: async () => 'persistent-test-token',
        isCollabEnabled: () => false,
        synthesizeVendorOptions: async () => ({}),
      },
    );
    expect(Object.keys(servers)).toEqual(['cindy_memory']);
  });

  it('memory flag flips change the generation fingerprint (server set is part of the generation)', async () => {
    const { bridge } = fakeBridge();
    const deps = {
      ensureBridgeStarted: async () => ({
        port: 38080,
        serverNames: ['cindy_orca', 'orca_worker_bridge', 'cindy_memory'],
        bridge,
      }),
      ensureForward: vi.fn(async () => 47921),
      getBridgeToken: async () => 'persistent-test-token',
      synthesizeVendorOptions: async () => ({}),
    };
    const withMemory = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo', makerMemoryEnabled: true },
      deps,
    );
    const withoutMemory = await buildCcRemoteHttpMcpServers(
      { host: HOST, sessionId: 's1', workingDir: '/remote/repo' },
      deps,
    );
    expect(withMemory.fingerprint).toBeDefined();
    expect(withoutMemory.fingerprint).toBeDefined();
    // 开关翻转 = 注入集合变化 = 新代际, attach 回旧集合的 alive query 必须
    // 被判 drift 重建。
    expect(withMemory.fingerprint).not.toBe(withoutMemory.fingerprint);
  });

  it('changes the generation fingerprint when the Session instance changes', async () => {
    const { bridge } = fakeBridge();
    const deps = {
      ensureBridgeStarted: async () => ({
        port: 38080,
        serverNames: ['cindy_orca'],
        bridge,
      }),
      ensureForward: vi.fn(async () => 47921),
      getBridgeToken: async () => 'persistent-test-token',
      synthesizeVendorOptions: async () => ({}),
    };
    const first = await buildCcRemoteHttpMcpServers(
      {
        host: HOST,
        sessionId: 'same-business-session',
        sessionInstanceId: 'instance-old',
        workingDir: '/remote/repo',
      },
      deps,
    );
    const replacement = await buildCcRemoteHttpMcpServers(
      {
        host: HOST,
        sessionId: 'same-business-session',
        sessionInstanceId: 'instance-new',
        workingDir: '/remote/repo',
      },
      deps,
    );

    expect(first.fingerprint).toBeDefined();
    expect(replacement.fingerprint).toBeDefined();
    expect(first.fingerprint).not.toBe(replacement.fingerprint);
  });
});
