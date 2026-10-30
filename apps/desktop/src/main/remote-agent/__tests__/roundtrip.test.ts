import { runSessionCreationAttempt, captureSessionCreationCancellation } from '../../localDb/sessionRuntimeCleanup';
/**
 * 远程 Agent 端到端往返(两端同进程，经 JSON 序列化模拟设备互联)：
 * 控制端 startRemoteAgentSession ⇄ 被控端 createRemoteAgentHost ⇄ 假 Agent(经隧道回到控制端
 * 读写文件、跑命令、调 Cindy 工具、请求权限确认)。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  AgentEvent,
  AgentSessionHandle,
  InteractionDecision,
  InteractionRequest,
  InteractionResolver,
  SendOptions,
  UserMessage,
} from '@cindy/maker-core';
import { LOCAL_AGENT_CLIENT, MAIN_OWNED_SEND_CONTEXT, Session } from '@cindy/maker-core';
import { createServer } from 'node:http';
import { providerShareHostPeer } from '@cindy/device-link';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';
import { RemoteExecutor } from '../executor/executor';
import { ExecServerRelay } from '../controller/execServerRelay';
import { createDeviceAgentStarter, liveDirectGuestSession } from '../controller/service';
import { credentialGrantFor, forgetCredentialGrants } from '../executor/credentialGrants';
import { cancelPendingRemoteStart, startRemoteAgentSession, type StartRemoteAgentDeps } from '../controller/startRemote';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';
import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimits } from '../../../shared/remoteAgentLimits';
import { installDesktopInteractionHandler } from '../../maker-ipc/interactionRouter';
import { authorizeSharedTaskExecutor, authorizeSharedTaskHistory, liveSharedTaskTarget } from '../controller/providerShareTaskLocation';

const payloadCompression = vi.hoisted(() => ({ enabled: false, paused: false, calls: 0, finish: undefined as (() => void) | undefined }));
// Controlled gzip completion exercises production payload cancellation without compression load or sockets.
vi.mock('node:zlib', async importOriginal => {
  const actual = await importOriginal<typeof import('node:zlib')>();
  return { ...actual, gzip: (...args: unknown[]) => {
    if (!payloadCompression.enabled) return (actual.gzip as (...values: unknown[]) => unknown)(...args);
    payloadCompression.calls++;
    const done = args.at(-1) as (error: Error | null, data: Buffer) => void;
    const finish = () => done(null, Buffer.alloc(512 * 1024 + 1, 42));
    payloadCompression.finish = finish;
    if (!payloadCompression.paused) finish();
  } };
});

const { historyInvoke, historyOpenLink, historyCloseEpoch, historyCrossRegion, historyLogger } = vi.hoisted(() => {
  const noop = () => undefined;
  const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop,
    child: () => logger };
  return { historyInvoke: vi.fn(), historyOpenLink: vi.fn(), historyCloseEpoch: vi.fn(() => 0),
    historyCrossRegion: vi.fn(() => false), historyLogger: logger };
});
vi.mock('../../device-link/index.js', () => ({
  remoteBackgroundInvoke: (...args: unknown[]) => historyInvoke(...args),
  openRemoteLink: (...args: unknown[]) => historyOpenLink(...args),
  getRemoteLinkCloseEpoch: () => historyCloseEpoch(),
}));
vi.mock('../../device-link/providerShareCrossRegion.js', () => ({
  isCrossRegionProviderShareTarget: () => historyCrossRegion(),
  renewCrossRegionProviderShareLink: (...args: unknown[]) => historyOpenLink(...args),
}));
vi.mock('../../device-link/providerShareGuest.js', () => ({
  parseProviderShareAgentDeviceId: (device: string) => device.startsWith('share:') ? device.slice(6) : null,
  findReceivedShare: () => ({ status: 'active' }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => historyLogger }));
// The production starter collects only this fixture's supplied project, never the user's home.
vi.mock('../controller/projectFiles', () => ({
  collectAncestorInstructionFiles: async () => [], collectAncestorMarkers: async () => [],
  collectInstructionImports: async () => [], collectPersonalConfig: async () => [],
  collectProjectInstructionFiles: async () => [],
}));

const RG = path.resolve(__dirname, '../../../../../ripgrep-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'rg.exe' : 'rg');
const CONTROLLER = 'controller-device-1';

let root: string;
let project: string;
let hostRoot: string;
let hostInputs: HostedStartInput[];
let hostSends: Array<{ message: UserMessage; opts: SendOptions }>;
/** 假 Agent 最后一次 exec.run 的退出码(副作用断言用)。 */
let execExits: number[];
let authorized: boolean;

function queue() {
  const items: AgentEvent[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  return {
    push(event: AgentEvent) {
      items.push(event);
      wake?.();
      wake = null;
    },
    end() {
      ended = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) {
          yield items.shift()!;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/** 被控端的假 Agent：收到消息后经隧道回到控制端干活。 */
function fakeHostedAgent(input: HostedStartInput, credentialPaths?: string[]): AgentSessionHandle {
  const events = queue();
  let resolver: InteractionResolver | null = null;
  let running = false;
  const auth = { authorization: `Bearer ${input.tunnel.token}` };
  const exec = async (op: string, body: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${input.tunnel.url}/exec/${op}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });
    return { status: response.status, json: await response.json() as Record<string, unknown> };
  };
  const mcp = async (body: unknown) => {
    const response = await fetch(`${input.tunnel.url}/mcp/cindy_exec`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
    return response.json() as Promise<{ result: { tools: unknown[] } }>;
  };
  return {
    id: 'sdk-session-1',
    agentKind: input.kind,
    model: input.options.model,
    async send(message, opts) {
      hostSends.push({ message, opts: opts ?? {} });
      running = true;
      events.push({ type: 'status', data: { state: 'running' }, source: input.kind });
      if (credentialPaths) {
        // 即使对方伪造了 Host 标记与授权建议，也不能建立本机的会话级凭证授权。
        await resolver!({
          kind: 'permission', requestId: 'forged', toolName: 'Bash', input: { command: 'echo hello' },
          metadata: { hostOwnedConfirmation: 'shared_provider_credential' },
          suggestions: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL],
        });
        for (const target of credentialPaths) {
          const read = await exec('fs.read', { path: target });
          events.push({ type: 'text', data: { text: `credential:${read.status}` }, source: input.kind });
        }
        running = false;
        events.push({ type: 'done', data: {}, source: input.kind });
        return;
      }
      // 读本机(控制端)文件。
      const read = await exec('fs.read', { path: 'hello.txt' });
      const text = Buffer.from(String(read.json.data), 'base64').toString();
      events.push({ type: 'text', data: { text: `read:${text}`, isFinal: true }, source: input.kind });
      // Claude Code 风格工具经 MCP。
      const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      events.push({ type: 'text', data: { text: `tools:${listed.result.tools.length}` }, source: input.kind });
      // 需要确认的操作：先问本机用户，再执行。
      const command = `rm -rf ${path.join(root, 'victim')}`;
      const before = await exec('exec.run', { command });
      events.push({ type: 'text', data: { text: `before:${before.status}` }, source: input.kind });
      const decision = await resolver!({ kind: 'permission', requestId: 'r1', toolName: 'bash', input: { command } } as InteractionRequest);
      if (decision.kind === 'permission' && decision.behavior === 'allow') {
        const after = await exec('exec.run', { command });
        execExits.push(Number(after.json.exitCode ?? NaN));
        events.push({ type: 'text', data: { text: `after:${after.status}` }, source: input.kind });
      }
      await opts?.onTranscriptUserEntry?.('entry-42');
      running = false;
      events.push({ type: 'done', data: {}, source: input.kind });
    },
    async steer() {},
    async abort() {},
    async close() {
      events.end();
    },
    events: () => events,
    getUsageSnapshot: () => ({ tokenUsage: 1, contextTokens: 2, contextWindow: 3, costUsd: 0 }),
    setInteractionResolver(next) {
      resolver = next;
    },
    isTurnRunning: () => running,
    async setPermissionMode() {},
    async setModel() {},
  };
}

function makeDeps(host: ReturnType<typeof createRemoteAgentHost>, controller = CONTROLLER): StartRemoteAgentDeps {
  return {
    invoke: async (args) => {
      // JSON 往返模拟设备互联的序列化。
      const result = await host.handle(controller, JSON.parse(JSON.stringify(args[0])));
      return JSON.parse(JSON.stringify(result ?? null));
    },
    rgPath: RG,
    prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
    collectProjectFiles: async () => [{ path: 'AGENTS.md', data: Buffer.from('# rules').toString('base64') }],
    isGitRepo: async () => false,
    newId: randomUUID,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-')));
  project = path.join(root, 'project');
  hostRoot = path.join(root, 'host');
  fs.mkdirSync(project);
  fs.mkdirSync(path.join(root, 'victim'));
  fs.writeFileSync(path.join(project, 'hello.txt'), 'from-controller');
  hostInputs = [];
  hostSends = [];
  execExits = [];
  authorized = true;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function createHost(
  readLimits: () => RemoteAgentLimits = () => DEFAULT_REMOTE_AGENT_LIMITS,
  log?: StartRemoteAgentDeps['log'],
  start = fakeHostedAgent,
) {
  return createRemoteAgentHost({
    readLimits,
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      hostInputs.push(input);
      return start(input);
    },
    isControllerAuthorized: () => authorized,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: hostRoot,
    log,
  });
}

describe('remote agent round trip', () => {
  // External application's only MCP traverses the real controller/router/tunnel;
  // host-only access must reject native tools even if a peer forges a request.
  it.each(['codex', 'pi', 'claude-code'] as const)('preserves application tools and isolation through %s remote execution', async kind => {
    const received: string[] = [];
    const server = createServer((req, res) => {
      received.push(req.headers.authorization ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'app_fixture' }] } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const local = { mcpName: 'hhh', hostToolsOnly: true, groupAssigned: true, storageDirectory: path.join(root, 'application-a'), url: `http://127.0.0.1:${port}`, token: 'application-fixture' };
    const host = createHost(undefined, undefined, input => {
      expect(input.options.localApplication).toMatchObject({ mcpName: 'hhh', hostToolsOnly: true });
      expect(input.localApplicationStorage).toContain('local-applications');
      expect(input.localApplicationStorage).not.toContain(local.storageDirectory);
      return fakeHostedAgent(input);
    });
    let handle: AgentSessionHandle | undefined;
    try {
      const log = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
      const prepareMcpBridge = vi.fn(async () => null);
      const invoke = makeDeps(host).invoke;
      const start = createDeviceAgentStarter({
        remoteInvoke: async (deviceId, _channel, args) => {
          expect(deviceId).toBe('group-member-b');
          if ((args[0] as { op: string }).op === 'open') expect(args[0]).toMatchObject({ payload: { json: { groupAssigned: true } } });
          return { ok: true, result: await invoke(args) };
        },
        rgPath: () => RG, mcpProviders: () => [], prepareMcpBridge, makerMemory: () => undefined,
        captureKnownFileBefore: async () => {}, noteOpaqueTurnChange: () => {}, logger: log,
      });
      handle = await start({ agentKind: kind, deviceId: 'group-member-b', options: {
        sessionId: 'external-app', workingDir: project, model: 'm', [LOCAL_AGENT_CLIENT]: local,
      } });
      const input = hostInputs[0];
      const request = async (route: string) => fetch(`${input.tunnel.url}${route}`, { method: 'POST', headers: { authorization: `Bearer ${input.tunnel.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(await (await request('/mcp/hhh')).json()).toMatchObject({ result: { tools: [{ name: 'app_fixture' }] } });
      expect((await request('/exec/fs.read')).status).toBe(403);
      expect((await request('/mcp/cindy_exec')).status).toBe(403);
      expect(received).toEqual(['Bearer application-fixture']);
      expect(prepareMcpBridge).not.toHaveBeenCalled();
      expect(JSON.stringify(input.options)).not.toContain(local.token);
    } finally {
      await handle?.close(); await host.dispose();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('rejects an older remote before opening an application session', async () => {
    const host = createHost(), deps = makeDeps(host), invoke = deps.invoke;
    deps.invoke = async args => {
      const result = await invoke(args);
      if ((args[0] as { op: string }).op === 'caps') delete (result as { localApplication?: boolean }).localApplication;
      return result;
    };
    try {
      await expect(startRemoteAgentSession('pi', { sessionId: 'old-peer', workingDir: project, model: 'm',
        [LOCAL_AGENT_CLIENT]: { url: 'http://127.0.0.1:1', token: 'fixture', hostToolsOnly: true } }, deps)).rejects.toThrow('REMOTE_AGENT_PEER_TOO_OLD');
      expect(hostInputs).toEqual([]);
    } finally { await host.dispose(); }
  });
  // Unit: #7783 keeps M's grant only in memory. Restart recovery must regain
  // that task's grant through O, never use O's health as M's readiness. Existing
  // lease tests do not lose M's in-memory authorization during a poll outage.
  it.each(['idle', 'busy', 'revoked', 'expired'] as const)('recovers the pinned direct executor after restart: %s', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const ownerRoute = 'share:restart-share';
    let offline = false, granted = false, allowed = true;
    let allocations = 0, sends = 0, offlineReads = 0;
    const disposed: string[] = [];
    const seen: AgentEvent[] = [];
    const nativeIds: Array<string | undefined> = [];
    const makeMember = () => createRemoteAgentHost({
      readLimits: () => DEFAULT_REMOTE_AGENT_LIMITS, isAgentAvailable: () => true,
      startHosted: async input => {
        nativeIds.push(input.options.resumeSessionId);
        const events = queue();
        let running = false;
        return { ...fakeHostedAgent(input), id: 'native-original', events: () => events,
          isTurnRunning: () => running,
          send: async (message: UserMessage) => {
            sends++;
            running = message.content === 'hold';
            if (!running) events.push({ type: 'done', source: input.kind, data: {} });
          }, close: async () => { events.end(); } };
      },
      controllerTrust: () => 'guest', isControllerAuthorized: () => true,
      providerAccess: { resolve: async () => 'shared-provider', isAllowed: () => granted },
      bindGuestProviderRoute: async () => ({ providerId: 'shared-provider', routeToken: 'fixture', modelIds: ['m'], release() {} }),
      captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: hostRoot,
    });
    let member = makeMember();
    historyInvoke.mockImplementation(async (device, _channel, [request]) => {
      if (device === ownerRoute) {
        if (request.op === 'allocate') {
          allocations++;
          if (!allowed) return { ok: false, error: { code: 'ACCESS_REVOKED', message: 'share revoked' } };
          granted = true;
          return { ok: true, result: { deviceId: 'executor-m', generation: '11111111-1111-4111-8111-111111111111',
            leaseDurationMs: mode === 'expired' ? 3_000 : 30 * 60_000 } };
        }
        return { ok: true, result: {} };
      }
      const requireAccess = () => {
        if (offline) { offlineReads++; throw Object.assign(new Error('device offline'), { code: 'DEVICE_OFFLINE' }); }
        if (!granted) throw Object.assign(new Error('share unavailable'), { code: 'ACCESS_REVOKED' });
      };
      requireAccess();
      const result = await member.handle(CONTROLLER, JSON.parse(JSON.stringify(request)));
      requireAccess();
      return { ok: true, result: request.op === 'caps' ? { ...result as object, directGuestExecution: true } : result };
    });
    const start = createDeviceAgentStarter({
      remoteInvoke: historyInvoke, rgPath: () => RG, mcpProviders: () => [],
      prepareMcpBridge: async (_providers, _logger, ctx) => ({ disposeSessionCtx: () => { disposed.push(ctx.sessionId!); } }),
      makerMemory: () => undefined, captureKnownFileBefore: async () => undefined, noteOpaqueTurnChange() {},
      logger: historyLogger, renewSharedProviderLink: async () => undefined,
    });
    let handle: AgentSessionHandle | undefined;
    let events: Promise<void> | undefined;
    try {
      handle = await start({ agentKind: 'claude-code', deviceId: ownerRoute,
        options: { sessionId: 'restart-task', workingDir: project, model: 'm' } });
      events = (async () => { for await (const event of handle!.events()) seen.push(event); })();
      await handle.send({ type: 'user', content: 'first' });
      await vi.waitFor(() => expect(seen.some(event => event.type === 'done')).toBe(true));
      if (mode !== 'idle') await handle.send({ type: 'user', content: 'hold' });
      offline = true;
      member.dispose();
      await vi.waitFor(() => expect(offlineReads).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(1_000);
      granted = false;
      allowed = mode !== 'revoked';
      member = makeMember();
      if (mode === 'expired') {
        await vi.advanceTimersByTimeAsync(3_000);
        expect(disposed).toContain('restart-task');
      }
      offline = false;
      if (mode === 'expired' || mode === 'revoked') {
        await vi.advanceTimersByTimeAsync(130_000);
        await expect(handle.send({ type: 'user', content: 'must not run' })).rejects.toThrow();
        expect(nativeIds).toEqual([undefined]);
        if (mode === 'expired') expect(allocations).toBe(1);
      } else {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(seen.filter(event => event.type === 'error')).toEqual(mode === 'busy'
          ? [expect.objectContaining({ data: expect.objectContaining({ reason: 'remote_agent_restarted' }) })] : []);
        expect(await liveDirectGuestSession('restart-task')!.probeReconnect!()).toBe('ok');
        await handle.send({ type: 'user', content: 'continue' });
        expect(nativeIds).toEqual([undefined, 'native-original']);
        expect(allocations).toBeGreaterThan(1);
        expect(sends).toBe(mode === 'idle' ? 2 : 3);
      }
    } finally {
      offline = false; granted = true;
      const closing = handle?.close({ reason: 'account-boundary' });
      await vi.advanceTimersByTimeAsync(5_000);
      await closing;
      await events;
      member.dispose();
      vi.useRealTimers(); historyInvoke.mockReset();
    }
  });

  // 真机到期后控制端命令继续运行：unit 用真实 starter/host，验证本地资源不等已拒绝的远端 close。
  // 新增结果：确切期限清理、续权重置期限、同执行端的另一任务保持可用；原测试只验证下一次请求被拒。
  it.each(['expires', 'renewed', 'late-renewal'] as const)('releases only the expired shared task before an unavailable close RPC: %s', async mode => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const ownerRoute = 'share:lease-share';
    const target = providerShareHostPeer('lease-share', 'executor-m');
    let allowClose!: () => void;
    const closeReady = new Promise<void>(resolve => { allowClose = resolve; });
    let allowRenewal!: () => void;
    const renewalReady = new Promise<void>(resolve => { allowRenewal = resolve; });
    let lateGrantActive = false;
    const disposed: string[] = [];
    const member = createRemoteAgentHost({
      readLimits: () => DEFAULT_REMOTE_AGENT_LIMITS, isAgentAvailable: () => true,
      startHosted: async input => fakeHostedAgent(input), controllerTrust: () => 'guest',
      isControllerAuthorized: () => true, providerAccess: { resolve: async () => 'shared-provider', isAllowed: () => true },
      bindGuestProviderRoute: async () => ({ providerId: 'shared-provider', routeToken: 'fixture', modelIds: ['m', 'm2'], release() {} }),
      captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: hostRoot,
    });
    historyInvoke.mockImplementation(async (device, _channel, [request]) => {
      if (device === ownerRoute) {
        if (request.op === 'allocate') {
          if (mode === 'late-renewal' && request.model === 'm2') { await renewalReady; lateGrantActive = true; }
          return { ok: true, result: { deviceId: 'executor-m',
            generation: request.model === 'm2' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111',
            leaseDurationMs: request.sessionId === 'sibling-task' ? 20_000 : 2_000 } };
        }
        if (request.op === 'direct-release' && request.sessionId === 'lease-task' && request.generation === '22222222-2222-4222-8222-222222222222') lateGrantActive = false;
        return { ok: true, result: {} };
      }
      if (request.op === 'close') await closeReady;
      const result = await member.handle(CONTROLLER, JSON.parse(JSON.stringify(request)));
      return { ok: true, result: request.op === 'caps' ? { ...result as object, directGuestExecution: true } : result };
    });
    historyOpenLink.mockResolvedValue(undefined);
    const start = createDeviceAgentStarter({
      remoteInvoke: historyInvoke, rgPath: () => RG, mcpProviders: () => [],
      prepareMcpBridge: async (_providers, _logger, ctx) => ({ disposeSessionCtx: () => { disposed.push(ctx.sessionId!); } }),
      makerMemory: () => undefined, captureKnownFileBefore: async () => undefined, noteOpaqueTurnChange() {},
      isSharedProviderDevice: () => true, logger: historyLogger, renewSharedProviderLink: peer => historyOpenLink(peer),
    });
    let handle: AgentSessionHandle | undefined;
    let sibling: AgentSessionHandle | undefined;
    try {
      handle = await start({ agentKind: 'claude-code', deviceId: ownerRoute, options: { sessionId: 'lease-task', workingDir: project, model: 'm' } });
      sibling = await start({ agentKind: 'claude-code', deviceId: ownerRoute, options: { sessionId: 'sibling-task', workingDir: project, model: 'm' } });
      await vi.advanceTimersByTimeAsync(1000);
      const lateChange = mode === 'late-renewal' ? handle.setModel!('m2') : undefined;
      void lateChange?.catch(() => undefined);
      if (mode === 'renewed') await handle.setModel?.('m2');
      await vi.advanceTimersByTimeAsync(1001);
      if (mode === 'renewed') {
        expect(disposed).not.toContain('lease-task');
        expect(liveSharedTaskTarget('lease-task', ownerRoute)).toBe(target);
        await vi.advanceTimersByTimeAsync(1000);
      }
      expect(disposed).toContain('lease-task');
      expect(liveSharedTaskTarget('lease-task', ownerRoute)).toBeNull();
      expect(disposed).not.toContain('sibling-task');
      expect(liveSharedTaskTarget('sibling-task', ownerRoute)).toBe(target);
      if (lateChange) {
        allowRenewal();
        await expect(lateChange).rejects.toThrow(/closed/);
        expect(lateGrantActive).toBe(false);
      }
      await expect(handle.send({ type: 'user', content: 'must not execute' })).rejects.toThrow(/closed|expired|authoriz/i);
    } finally {
      allowClose();
      allowRenewal();
      await handle?.close({ reason: 'account-boundary' });
      await sibling?.close({ reason: 'account-boundary' });
      await member.dispose();
      vi.useRealTimers();
      historyInvoke.mockReset(); historyOpenLink.mockReset();
    }
  });

  // Production starter -> real M host regression (unit): after the 30-minute lease,
  // G must locate native history and renew M instead of selecting a new machine.
  // Existing startRemote tests bypass createDeviceAgentStarter and cannot catch that routing error.
  // Real Mac restart left G's cached link ready but M's transport unconfirmed.
  // Unit: the production starter and M host must resume after a fresh per-peer
  // handshake; a close during allocation must cancel rather than reopen it.
  it.each(['resume', 'new-task-transport-restarted', 'transport-restarted', 'cross-region-restarted', 'link-closed', 'unavailable', 'wrong-executor', 'open-failed', 'member-denied', 'timeout', 'invalid-lifetime'] as const)(
    'keeps a 31-minute shared native resume on its original executor: %s', async mode => {
      const ownerRoute = 'share:history-share';
      const target = providerShareHostPeer('history-share', 'executor-m');
      let now = Date.now();
      const date = vi.spyOn(Date, 'now').mockImplementation(() => now);
      let leaseUntil = 0;
      let historical = false;
      let linkRefreshed = false;
      let closeEpoch = 0;
      historyCloseEpoch.mockImplementation(() => closeEpoch);
      historyCrossRegion.mockReturnValue(mode === 'cross-region-restarted');
      historyOpenLink.mockImplementation(async (peer: string) => {
        expect(peer).toBe(target);
        expect(now).toBeLessThan(leaseUntil);
        linkRefreshed = true;
      });
      const calls: Array<{ device: string; request: Record<string, unknown> }> = [];
      const member = createRemoteAgentHost({
        readLimits: () => DEFAULT_REMOTE_AGENT_LIMITS,
        isAgentAvailable: () => true,
        startHosted: async input => { hostInputs.push(input); return fakeHostedAgent(input); },
        controllerTrust: () => 'guest',
        isControllerAuthorized: () => now < leaseUntil,
        providerAccess: { resolve: async () => 'shared-provider', isAllowed: () => now < leaseUntil },
        bindGuestProviderRoute: async () => ({ providerId: 'shared-provider', routeToken: 'fixture', modelIds: ['m'], release() {} }),
        captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot: hostRoot,
      });
      historyInvoke.mockImplementation(async (device, _channel, [request]) => {
        calls.push({ device, request });
        if (device === ownerRoute) {
          if (request.op === 'direct-locate') {
            if (mode === 'member-denied' || mode === 'timeout') return { ok: false,
              error: { code: mode === 'timeout' ? 'TIMEOUT' : 'REMOTE_AGENT_UNAVAILABLE', message: mode } };
            return { ok: true, result: { deviceId: 'executor-m' } };
          }
          if (request.op === 'allocate') {
            if (historical && mode === 'unavailable') return { ok: true, result: null };
            if (historical && mode === 'link-closed') closeEpoch++;
            leaseUntil = now + 30 * 60_000;
            return { ok: true, result: {
              deviceId: historical && (mode === 'wrong-executor' || request.preferredExecutorDeviceId !== 'executor-m')
                ? 'executor-other' : 'executor-m', generation: '11111111-1111-4111-8111-111111111111',
              leaseDurationMs: historical && mode === 'invalid-lifetime' ? -1 : 30 * 60_000,
            } };
          }
          if (request.op === 'direct-status' || request.op === 'direct-release') return { ok: true, result: {} };
          return { ok: false, error: { code: 'REMOTE_AGENT_INVALID', message: 'O cannot use M native history' } };
        }
        if (device !== target) return { ok: false, error: { code: 'DEVICE_OFFLINE', message: 'another executor' } };
        if (((historical && (mode === 'transport-restarted' || mode === 'cross-region-restarted'))
          || mode === 'new-task-transport-restarted') && !linkRefreshed) {
          return { ok: false, error: { code: 'TIMEOUT', message: 'executor transport was not reconfirmed' } };
        }
        if (historical && mode === 'open-failed' && request.op === 'open') {
          return { ok: false, error: { code: 'REMOTE_AGENT_UNAVAILABLE', message: 'M disappeared after caps' } };
        }
        try {
          const result = await member.handle(CONTROLLER, JSON.parse(JSON.stringify(request)));
          return { ok: true, result: request.op === 'caps' ? { ...result as object, directGuestExecution: true } : result };
        } catch (error) {
          return { ok: false, error: { message: String(error) } };
        }
      });
      const start = createDeviceAgentStarter({
        remoteInvoke: historyInvoke, rgPath: () => RG, mcpProviders: () => [],
        prepareMcpBridge: async () => null, makerMemory: () => undefined,
        captureKnownFileBefore: async () => undefined, noteOpaqueTurnChange() {},
        isSharedProviderDevice: () => true, logger: historyLogger,
        renewSharedProviderLink: peer => historyOpenLink(peer),
      });
      const options = { sessionId: 'history-task', workingDir: project, model: 'm' };
      let handle: AgentSessionHandle | undefined;
      try {
        handle = await start({ agentKind: 'claude-code', deviceId: ownerRoute, options });
        const nativeId = handle.id;
        expect(liveSharedTaskTarget(options.sessionId, ownerRoute)).toBe(target);
        expect(liveSharedTaskTarget(options.sessionId, 'share:another-share')).toBeNull();
        await handle.close();
        handle = undefined;
        expect(liveSharedTaskTarget(options.sessionId, ownerRoute)).toBeNull();
        historical = true;
        now += 31 * 60_000;
        calls.length = 0;
        const opening = start({ agentKind: 'claude-code', deviceId: ownerRoute,
          options: { ...options, resumeSessionId: nativeId } });
        if (mode === 'resume' || mode === 'new-task-transport-restarted' || mode === 'transport-restarted' || mode === 'cross-region-restarted') {
          handle = await opening;
          expect(handle.id).toBe(nativeId);
          expect(hostInputs[1].options.resumeSessionId).toBe(nativeId);
          expect(calls.find(({ request }) => request.op === 'allocate')?.request)
            .toMatchObject({ sessionId: options.sessionId, preferredExecutorDeviceId: 'executor-m' });
          // Even knowing this native ID cannot resume it under another guest identity.
          const open = calls.find(({ request }) => request.op === 'open')!;
          await expect(member.handle('other-guest', { ...open.request, runId: randomUUID() }))
            .rejects.toThrow('REMOTE_AGENT_INVALID');
        } else {
          await expect(opening).rejects.toThrow();
          expect(hostInputs).toHaveLength(1);
        }
        expect(calls[0]).toMatchObject({ device: ownerRoute, request: { op: 'direct-locate', sessionId: options.sessionId } });
        expect(calls.filter(({ device }) => device === ownerRoute).some(({ request }) => JSON.stringify(request).includes(nativeId))).toBe(false);
        expect(calls.filter(({ request }) => request.op === 'open').every(({ device }) => device === target)).toBe(true);
      } finally {
        await handle?.close();
        await member.dispose();
        date.mockRestore();
        historyInvoke.mockReset();
        historyOpenLink.mockReset();
        historyCloseEpoch.mockReset().mockReturnValue(0);
        historyCrossRegion.mockReset().mockReturnValue(false);
      }
    },
  );

  // 测试价值：真实两端启动入口的诊断协议；此前 24 秒创建等待无阶段记录。
  // 原覆盖只验证执行结果，未保护成功/失败计时及内容不入日志。最小输入：一次启动或 MCP 拒绝。
  // tier: unit，沿用本文件 loopback fixture，不启动真实 Agent、不做真实等待。
  // 本机单文件 Vitest 5.62s（既有 19 项共用 fixture，collect 3.29s；本次两项不另开测试文件）。
  it('reports controller, transport and host startup stages without configuration contents', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const host = createHost(undefined, log);
    let handle: AgentSessionHandle | undefined;
    try {
      handle = await startRemoteAgentSession(
        'codex',
        {
          sessionId: 'startup-timing-task',
          workingDir: project,
          model: 'm',
          userPrompt: 'private user instruction',
        },
        { ...makeDeps(host), log },
      );
      expect(handle.id).toBe('sdk-session-1');
      const fields = log.debug.mock.calls.map(([, data]) => data);
      expect(fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ side: 'controller', stage: 'mcp-prepare', status: 'ok' }),
          expect.objectContaining({ side: 'controller', stage: 'personal-config', status: 'ok' }),
          expect.objectContaining({
            side: 'controller',
            stage: 'capability-handshake',
            status: 'ok',
          }),
          expect.objectContaining({
            side: 'transport',
            stage: 'session-ready',
            status: 'ok',
            sessionRef: 'startup-',
          }),
          expect.objectContaining({
            side: 'host',
            stage: 'agent-session',
            status: 'ok',
            sessionRef: 'startup-',
          }),
        ]),
      );
      const transport = fields.find((data) => data.side === 'transport' && data.stage === 'total');
      expect(fields.find(data => data.side === 'host' && data.stage === 'total')?.execServer).toEqual({
        shortcutEnabled: true, ancestorLevels: 0, connections: 0, answered: 0, forwarded: 0,
      });
      expect(fields).toContainEqual(
        expect.objectContaining({
          side: 'host',
          stage: 'total',
          status: 'ok',
          runRef: transport.runRef,
        }),
      );
      const serialized = JSON.stringify(log.debug.mock.calls);
      for (const secret of [
        project,
        'private user instruction',
        Buffer.from('# rules').toString('base64'),
      ]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      await handle?.close();
      await host.dispose();
    }
  });

  it('attributes failed MCP preparation without changing or logging its original error', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
    const host = createHost();
    const failure = new Error('private endpoint credential');
    try {
      await expect(
        startRemoteAgentSession(
          'codex',
          {
            sessionId: 'startup-failure-task',
            workingDir: project,
            model: 'm',
          },
          {
            ...makeDeps(host),
            log,
            prepareMcp: async () => {
              throw failure;
            },
          },
        ),
      ).rejects.toBe(failure);
      const fields = log.debug.mock.calls.map(([, data]) => data);
      expect(fields).toContainEqual(
        expect.objectContaining({ stage: 'mcp-prepare', status: 'failed' }),
      );
      expect(fields).toContainEqual(
        expect.objectContaining({ side: 'controller', stage: 'total', status: 'failed' }),
      );
      expect(fields.some((data) => data.stage === 'capability-handshake')).toBe(false);
      expect(JSON.stringify(log.debug.mock.calls)).not.toContain(failure.message);
    } finally {
      await host.dispose();
    }
  });

  // provider-sharing §9：走 HTTP → 执行器 → Session → 真实交互路由，检查取消卡片及迟到授权。
  // 现有往返用例没有挂起确认后取消；最小输入是一次 .env 读取，tier: unit(仅 loopback)。
  it.each(['request', 'stop', 'permission', 'close'])('dismisses a shared-provider credential card on %s cancellation', async (end) => {
    fs.writeFileSync(path.join(project, '.env'), 'INVALID_FIXTURE=one');
    const host = createHost();
    const grant = credentialGrantFor(`cancel-${end}`, 'share:fixture');
    const handle = await startRemoteAgentSession('claude-code', {
      sessionId: `cancel-${end}`, workingDir: project, model: 'm', permissionMode: 'bypassPermissions',
    }, { ...makeDeps(host), credentialConsent: { description: 'fixture', grant } });
    const noop = () => {};
    const logger = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop, child: () => logger };
    const session = new Session({ id: `cancel-${end}`, agentKind: 'claude-code', workDir: project, handle, capabilities: {} as never, logger, turnStallMs: 0 });
    let answer!: (value: InteractionDecision) => void;
    let requestId = '';
    const cancel = vi.fn();
    installDesktopInteractionHandler(session, (request) => {
      requestId = request.requestId;
      return new Promise((resolve) => { answer = resolve; });
    }, cancel);
    const abort = new AbortController();
    const tunnel = hostInputs[0].tunnel;
    const response = fetch(`${tunnel.url}/exec/fs.read`, {
      method: 'POST', signal: abort.signal,
      headers: { authorization: `Bearer ${tunnel.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '.env' }),
    });
    void response.catch(() => {});
    try {
      await vi.waitFor(() => expect(requestId).not.toBe(''));
      if (end === 'request') abort.abort();
      else if (end === 'stop') await handle.abort();
      else if (end === 'permission') await handle.setPermissionMode!('ask');
      else await handle.close({ reason: 'navigation' });
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledWith(requestId, expect.objectContaining({ behavior: 'deny' })), { timeout: 1000 });
      answer({ kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL] });
      await response.then((value) => value.arrayBuffer(), () => undefined);
      expect(grant.restore(JSON.stringify(['bypassPermissions', false]))).toBe(false);
    } finally {
      abort.abort();
      answer?.({ kind: 'permission', behavior: 'deny' });
      await session.close();
      host.dispose();
      forgetCredentialGrants(`cancel-${end}`);
    }
  });

  it('enforces limits through the controller and releases capacity after close', async () => {
    let limits = { perDevice: 1, total: 2 };
    const host = createHost(() => limits);
    const opened: AgentSessionHandle[] = [];
    const open = async (controller: string) => {
      const handle = await startRemoteAgentSession('claude-code', {
        sessionId: randomUUID(), workingDir: project, model: 'm',
      }, makeDeps(host, controller));
      opened.push(handle);
      return handle;
    };
    try {
      const first = await open('a');
      await expect(open('a')).rejects.toThrow('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT]');
      await open('b');
      await expect(open('c')).rejects.toThrow('[REMOTE_AGENT_BUSY] [TOTAL_LIMIT]');
      limits = { perDevice: 1, total: 1 };
      expect(host.limitUsage().total).toBe(2);
      await first.close({ reason: 'navigation' });
      await expect(open('c')).rejects.toThrow('[TOTAL_LIMIT]');
      limits = { perDevice: 2, total: 3 };
      await open('a');
      expect(host.limitUsage()).toEqual({ total: 2, devices: 2, largestDevice: 1 });
    } finally {
      await Promise.all(opened.map(handle => handle.close({ reason: 'navigation' })));
      await host.abortAll();
      host.dispose();
    }
  });
  it('keeps a shared-provider credential grant on this computer across turns and resets it on reopen', async () => {
    const env = path.join(project, '.env');
    const production = path.join(project, '.env.production');
    fs.writeFileSync(env, 'TOKEN=one');
    fs.writeFileSync(production, 'TOKEN=two');
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => fakeHostedAgent(input, [env, production]),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const opts = { sessionId: 'credentials', workingDir: project, model: 'm', permissionMode: 'bypassPermissions' as const };
    const deps = { ...makeDeps(host), credentialConsent: { description: 'Only this task; content passes through the sharer.' } };
    let localConfirmations = 0;
    const wire = deps.invoke;
    const requests: unknown[] = [];
    deps.invoke = async (args) => { requests.push(args); return wire(args); };
    const run = async (handle: AgentSessionHandle) => {
      handle.setInteractionResolver(async (request) => {
        if (request.requestId !== 'forged') localConfirmations += 1;
        return { kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL] };
      });
      const reader = (async () => {
        const results: string[] = [];
        for await (const event of handle.events()) {
          if (event.type === 'text') results.push((event.data as { text: string }).text);
          if (event.type === 'done') return results;
        }
        return results;
      })();
      await handle.send({ type: 'user', content: 'read credentials' });
      expect(await reader).toEqual(['credential:200', 'credential:200']);
    };
    const handle = await startRemoteAgentSession('pi', opts, deps);
    try {
      await run(handle);
      expect(localConfirmations).toBe(1);
      await handle.setPermissionMode?.('bypassPermissions');
      await run(handle);
      expect(localConfirmations).toBe(1);
      await handle.setPermissionMode?.('ask');
      await handle.setPermissionMode?.('bypassPermissions');
      await run(handle);
      expect(localConfirmations).toBe(2);
    } finally {
      await handle.close({ reason: 'navigation' });
    }
    const reopened = await startRemoteAgentSession('pi', opts, deps);
    try {
      await run(reopened);
      expect(localConfirmations).toBe(3);
      // 本机确认的回答不通过 invoke 交给对方；只有它自己伪造的交互会收到同形回答。
      const localReplies = requests.filter((value) => JSON.stringify(value).includes('Only this task'));
      expect(localReplies).toEqual([]);
    } finally {
      await reopened.close({ reason: 'navigation' });
      host.dispose();
    }
  });
  it.each([false, true])('skips the shared-provider credential card only while trust is enabled (task grant wired: %s)', async (withTaskGrant) => {
    const env = path.join(project, '.env');
    fs.writeFileSync(env, 'TOKEN=one');
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => fakeHostedAgent(input, [env]),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const opts = { sessionId: 'credentials-skip', workingDir: project, model: 'm', permissionMode: 'bypassPermissions' as const };
    let skip = true;
    const deps = {
      ...makeDeps(host),
      credentialConsent: {
        description: 'Only this task; content passes through the sharer.',
        skip: () => skip,
        ...(withTaskGrant ? { grant: credentialGrantFor(opts.sessionId, 'share:skip') } : {}),
      },
    };
    let localConfirmations = 0;
    const run = async (handle: AgentSessionHandle) => {
      handle.setInteractionResolver(async (request) => {
        if (request.requestId !== 'forged') localConfirmations += 1;
        return { kind: 'permission', behavior: 'allow' };
      });
      const reader = (async () => {
        const results: string[] = [];
        for await (const event of handle.events()) {
          if (event.type === 'text') results.push((event.data as { text: string }).text);
          if (event.type === 'done') return results;
        }
        return results;
      })();
      await handle.send({ type: 'user', content: 'read credentials' });
      expect(await reader).toEqual(['credential:200']);
    };
    const handle = await startRemoteAgentSession('pi', opts, deps);
    try {
      // 受邀者在设置里打开了「信任 {分享者}」：读 .env 不弹卡、直接放行。
      await run(handle);
      expect(localConfirmations).toBe(0);
      // 运行中关掉：下一次凭证操作就要确认。
      skip = false;
      await run(handle);
      expect(localConfirmations).toBe(1);
    } finally {
      await handle.close({ reason: 'navigation' });
      host.dispose();
    }
  });

  it('restores a task-level credential grant when the agent is rebuilt with the same share and permission mode', async () => {
    const env = path.join(project, '.env');
    fs.writeFileSync(env, 'TOKEN=one');
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => fakeHostedAgent(input, [env]),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const sessionId = `grant-${randomUUID()}`;
    const full = { sessionId, workingDir: project, model: 'm', permissionMode: 'bypassPermissions' as const };
    let skip = false;
    const depsFor = (deviceId: string) => ({
      ...makeDeps(host),
      credentialConsent: {
        description: 'Only this task.',
        skip: () => skip,
        grant: credentialGrantFor(sessionId, deviceId),
      },
    });
    let localConfirmations = 0;
    // 打开一次 Agent、跑一轮、关闭(相当于 Orca Worker 一轮结束后被回收)。
    const openRunClose = async (
      opts: Omit<typeof full, 'permissionMode'> & { permissionMode: 'bypassPermissions' | 'default' | 'ask' },
      deviceId = 'share:a',
      between?: (handle: AgentSessionHandle) => Promise<void>,
    ) => {
      const handle = await startRemoteAgentSession('pi', opts, depsFor(deviceId));
      try {
        handle.setInteractionResolver(async (request) => {
          if (request.requestId !== 'forged') localConfirmations += 1;
          return { kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL] };
        });
        const reader = (async () => {
          for await (const event of handle.events()) if (event.type === 'done') return;
        })();
        await handle.send({ type: 'user', content: 'read credentials' });
        await reader;
        await between?.(handle);
      } finally {
        await handle.close({ reason: 'navigation' });
      }
    };
    try {
      await openRunClose(full);
      expect(localConfirmations).toBe(1);
      // 同一任务、同一分享、权限档未变：重建后不再确认。
      await openRunClose(full);
      expect(localConfirmations).toBe(1);
      // 重建期间暂时打开分享级信任：恢复任务级授权不能因此丢失。
      skip = true;
      await openRunClose(full);
      expect(localConfirmations).toBe(1);
      skip = false;
      await openRunClose(full);
      expect(localConfirmations).toBe(1);
      // 另一个分享不沿用。
      await openRunClose(full, 'share:b');
      expect(localConfirmations).toBe(2);
      // 回收期间权限档变了：作废，换回原权限档也要重新确认。
      await openRunClose({ ...full, permissionMode: 'default' });
      expect(localConfirmations).toBe(3);
      await openRunClose(full);
      expect(localConfirmations).toBe(4);
      // 运行中切换权限档：作废，重建后也不恢复。
      await openRunClose(full, 'share:a', async (handle) => {
        await handle.setPermissionMode?.('default');
        await handle.setPermissionMode?.('bypassPermissions');
      });
      expect(localConfirmations).toBe(4);
      await openRunClose(full);
      expect(localConfirmations).toBe(5);
      // 比较原始权限档：default 与 ask 归并后同为 normal，回收期间这样改也要重新确认。
      await openRunClose({ ...full, permissionMode: 'default' });
      expect(localConfirmations).toBe(6);
      await openRunClose({ ...full, permissionMode: 'ask' });
      expect(localConfirmations).toBe(7);
      await openRunClose({ ...full, permissionMode: 'ask' });
      expect(localConfirmations).toBe(7);
      // 回收期间切走又切回(设置入口调用 forgetCredentialGrants)：所有分享上的授权都作废。
      forgetCredentialGrants(sessionId);
      await openRunClose({ ...full, permissionMode: 'ask' });
      expect(localConfirmations).toBe(8);
      await openRunClose(full, 'share:b');
      expect(localConfirmations).toBe(9);
    } finally {
      host.dispose();
    }
  });

  it('runs a turn on the other computer while files, commands and confirmations stay here', async () => {
    const host = createHost();
    const handle = await startRemoteAgentSession('pi', {
      sessionId: 'session-1',
      workingDir: project,
      model: 'spark/qwen',
      providerId: 'spark',
      permissionMode: 'default',
    }, makeDeps(host));
    expect(handle.id).toBe('sdk-session-1');
    expect(hostInputs[0].workspace.workingDir).toBe(project);
    expect(hostInputs[0].options).toMatchObject({ model: 'spark/qwen', providerId: 'spark', permissionMode: 'default' });
    expect(fs.readFileSync(path.join(hostInputs[0].shadowDir, 'AGENTS.md'), 'utf8')).toBe('# rules');

    const requests: InteractionRequest[] = [];
    handle.setInteractionResolver(async (request): Promise<InteractionDecision> => {
      requests.push(request);
      return { kind: 'permission', behavior: 'allow' };
    });
    const entries: string[] = [];
    const png = path.join(project, 'shot.png');
    fs.writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    const collected: AgentEvent[] = [];
    const reader = (async () => {
      for await (const event of handle.events()) {
        collected.push(event);
        if (event.type === 'done') break;
      }
    })();
    await handle.send(
      { type: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', path: png, mimeType: 'image/png' }] },
      {
        messageUuid: 'u1',
        onTranscriptUserEntry: (entry) => {
          entries.push(entry);
        },
        [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'desktop' } },
      },
    );
    await reader;
    const texts = collected.filter((event) => event.type === 'text').map((event) => (event.data as { text: string }).text);
    expect(texts).toEqual(['read:from-controller', 'tools:7', 'before:403', 'after:200']);
    // 命令副作用只在 posix 上断言：`rm -rf` 是 bash 命令，Windows 无 Git Bash 时 exec
    // 走 cmd 回退、天然跑不动(Agent 的命令都是 bash 写法，与 Claude Code 对 Windows 的
    // 要求一致)。命令与确认流本身在两个平台都已断言。
    if (process.platform !== 'win32') {
      expect(execExits.at(-1)).toBe(0);
      expect(fs.existsSync(path.join(root, 'victim'))).toBe(false);
    }
    expect(requests).toHaveLength(1);
    expect(entries).toEqual(['entry-42']);

    // 图片字节随消息带到对方，换成对方本机路径；Symbol 证明在对方重新附上。
    const sent = hostSends[0];
    const image = (sent.message.content as Array<{ type: string; path?: string }>).find((block) => block.type === 'image');
    expect(image?.path && image.path !== png).toBe(true);
    expect(fs.readFileSync(image!.path!)).toEqual(fs.readFileSync(png));
    expect(sent.opts.messageUuid).toBe('u1');
    expect(sent.opts[MAIN_OWNED_SEND_CONTEXT]).toEqual({ origin: { kind: 'desktop' } });
    expect(handle.getUsageSnapshot()).toMatchObject({ tokenUsage: 1, contextTokens: 2 });

    await handle.close({ reason: 'navigation' });
    expect(host.runCount()).toBe(0);
    host.dispose();
  });

  it('runs several tasks on the same computer over one shared poll', async () => {
    const host = createHost();
    const base = makeDeps(host);
    let polls = 0;
    let peakPolls = 0;
    let peakAll = 0;
    let inflightAll = 0;
    const invoke: StartRemoteAgentDeps['invoke'] = async (args) => {
      const isPoll = (args[0] as { op?: string }).op === 'poll';
      inflightAll += 1;
      if (isPoll) polls += 1;
      peakAll = Math.max(peakAll, inflightAll);
      peakPolls = Math.max(peakPolls, polls);
      try {
        return await base.invoke(args);
      } finally {
        inflightAll -= 1;
        if (isPoll) polls -= 1;
      }
    };
    const poller = new RemoteAgentPoller(invoke);
    const handles = await Promise.all(Array.from({ length: 6 }, (_, index) => startRemoteAgentSession('pi', {
      sessionId: `shared-${index}`,
      workingDir: project,
      model: 'm',
      permissionMode: 'bypassPermissions',
    }, { ...base, invoke, poller })));
    await Promise.all(handles.map(async (handle) => {
      handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
      const texts: string[] = [];
      const reader = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'text') texts.push((event.data as { text: string }).text);
          if (event.type === 'done') break;
        }
      })();
      await handle.send({ type: 'user', content: 'hi' }, {});
      await reader;
      expect(texts[0]).toBe('read:from-controller');
    }));
    // 六个任务同时进行，拉取最多两个长等待加一个给新任务的补位，不会挤占设备互联的其它请求。
    expect(peakPolls).toBeLessThanOrEqual(3);
    expect(peakAll).toBeLessThan(12);
    await Promise.all(handles.map((handle) => handle.close({ reason: 'navigation' })));
    expect(host.runCount()).toBe(0);
    expect(poller.size).toBe(0);
    host.dispose();
  });

  it('reports a start failure from the other computer with its original error', async () => {
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async () => {
        const error = new Error('Claude Code is not signed in');
        error.name = 'AgentNotAuthenticatedError';
        throw error;
      },
      isControllerAuthorized: () => true,
      captureOwner: () => 'o',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    await expect(startRemoteAgentSession('claude-code', { sessionId: 's2', workingDir: project, model: 'm' }, makeDeps(host)))
      .rejects.toMatchObject({ name: 'AgentNotAuthenticatedError', message: 'Claude Code is not signed in' });
    host.dispose();
  });

  // Direct G→M startup can fail after M has already opened a run. The failed
  // controller must close that run before a G→O fallback can open another one.
  it('closes a started remote run when its session descriptor is invalid', async () => {
    const remoteClosed = vi.fn();
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => {
        const agent = fakeHostedAgent(input);
        return { ...agent, id: '', async close() { remoteClosed(); await agent.close(); } };
      },
      isControllerAuthorized: () => true,
      captureOwner: () => 'o',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    try {
      await expect(startRemoteAgentSession('claude-code',
        { sessionId: 'failed-direct-open', workingDir: project, model: 'm' }, makeDeps(host)))
        .rejects.toThrow('invalid session');
      expect(remoteClosed).toHaveBeenCalledTimes(1);
      expect(host.runCount()).toBe(0);
    } finally { host.dispose(); }
  });

  // 2026-10-22 远程供应商调查：慢启动期间任务被删除，控制端不再等了，对方却在几分钟后仍启动 Agent 并跑完
  // 这一轮(供应商组还会换电脑接着启动)。删除或归档时要让对方结束这个任务，迟到完成的启动也立刻关掉。
  // #6844 review：旧用例只覆盖远端已开始启动；MCP 准备是更早的异步等待，删除后不得发出 open，已准备资源要释放。
  it('does not open a remote run after the task was removed while preparing MCP', async () => {
    const host = createHost();
    const base = makeDeps(host);
    let finishPrepare!: () => void;
    const prepareGate = new Promise<void>((resolve) => { finishPrepare = resolve; });
    const dispose = vi.fn();
    const prepareMcp = vi.fn(async () => {
      await prepareGate;
      return { servers: new Map(), dispose };
    });
    const invoke = vi.fn(base.invoke);
    const sessionId = randomUUID();
    const starting = startRemoteAgentSession('claude-code', { sessionId, workingDir: project, model: 'm' }, {
      ...base, invoke, prepareMcp,
    });
    void starting.catch(() => undefined);
    let handle: AgentSessionHandle | undefined;
    try {
      expect(prepareMcp).toHaveBeenCalledTimes(1);
      cancelPendingRemoteStart(sessionId);
      finishPrepare();
      const result = await starting.then((value) => { handle = value; return null; }, (error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect(String(result)).toContain('[REMOTE_AGENT_EXPIRED]');
      expect(invoke).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(dispose).toHaveBeenCalledTimes(1), { interval: 1, timeout: 1000 });
      expect(host.limitUsage().total).toBe(0);
    } finally {
      finishPrepare();
      await handle?.close({ reason: 'navigation' });
      host.dispose();
    }
  });

  it('ends the run on the other computer when the task is removed while it is still starting', async () => {
    let finishStart!: () => void;
    const startGate = new Promise<void>((resolve) => { finishStart = resolve; });
    const closed = vi.fn();
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async (input) => {
        hostInputs.push(input);
        await startGate;
        const agent = fakeHostedAgent(input);
        return { ...agent, async close() { closed(); await agent.close(); } };
      },
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const sessionId = randomUUID();
    const starting = startRemoteAgentSession('claude-code', { sessionId, workingDir: project, model: 'm' }, makeDeps(host));
    void starting.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(hostInputs).toHaveLength(1));
      expect(host.limitUsage().total).toBe(1);
      cancelPendingRemoteStart(sessionId);
      await expect(starting).rejects.toThrow('[REMOTE_AGENT_EXPIRED]');
      await vi.waitFor(() => expect(host.limitUsage().total).toBe(0), { interval: 1, timeout: 1000 });
      finishStart();
      await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
      expect(hostSends).toEqual([]);
    } finally {
      finishStart();
      host.dispose();
    }
  });

  // #6420: a new remote run carries the task Host clear epoch, independent of source clocks.
  it('sends the persisted image clear generation when opening a remote run', async () => {
    const host = createHost();
    const base = makeDeps(host);
    const opened: Array<Record<string, unknown>> = [];
    const invoke: StartRemoteAgentDeps['invoke'] = async (args) => {
      const request = args[0] as { op?: string; payload?: { json?: Record<string, unknown> } };
      if (request.op === 'open' && request.payload?.json) opened.push(request.payload.json);
      return base.invoke(args);
    };
    try {
      for (const epoch of [0, 456]) {
        const handle = await startRemoteAgentSession('codex', { sessionId: 'image-task', workingDir: project, model: 'm' }, {
          ...base, invoke, readImageDeliveryEpoch: async (sessionId) => { expect(sessionId).toBe('image-task'); return epoch; },
        });
        expect(opened.at(-1)).toMatchObject({ imageDeliveryEpoch: epoch, acceptsImageDeliveryReceipts: true });
        await handle.close({ reason: 'navigation' });
      }
    } finally { host.dispose(); }
  });

  it('declares provider group switch support and brings back the token after a handoff', async () => {
    const host = createHost();
    const base = makeDeps(host);
    const opened: Array<Record<string, unknown>> = [];
    const invoke: StartRemoteAgentDeps['invoke'] = async (args) => {
      const request = args[0] as { op?: string; payload?: { json?: Record<string, unknown> } };
      if (request.op === 'open' && request.payload?.json) opened.push(request.payload.json);
      return base.invoke(args);
    };
    const offered: string[] = [];
    const handle = await startRemoteAgentSession('pi', { sessionId: 's4', workingDir: project, model: 'm' }, {
      ...base,
      invoke,
      groupSwitch: { token: 'Zm9vYmFyYmF6cXV4MTIzNDU2', offer: (token) => offered.push(token) },
    });
    expect(opened[0]).toMatchObject({ acceptsGroupSwitch: true, groupSwitchToken: 'Zm9vYmFyYmF6cXV4MTIzNDU2' });
    await handle.close({ reason: 'navigation' });

    // 没接供应商组的调用方：打开时不声明。
    const plain = await startRemoteAgentSession('pi', { sessionId: 's5', workingDir: project, model: 'm' }, { ...base, invoke });
    expect(opened[1]).not.toHaveProperty('acceptsGroupSwitch');
    expect(opened[1]).not.toHaveProperty('groupSwitchToken');
    await plain.close({ reason: 'navigation' });
    expect(offered).toEqual([]);
    host.dispose();
  });

  it('refuses controllers that are no longer allowed', async () => {
    authorized = false;
    const host = createHost();
    await expect(startRemoteAgentSession('pi', { sessionId: 's3', workingDir: project, model: 'm' }, makeDeps(host)))
      .rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE/);
    host.dispose();
  });
});

// Unit: provider-sharing direct-execution lease boundary (runtime review F1/F2).
// Existing roundtrips cover already-started handles. These inputs stop at MCP/started,
// or spend the entire 2s allocation in caps, through the real service/startRemote/runClient.
// Only transport delivery and native-process boundaries are fixtures; no sockets or agents.
describe('shared startup lease budget', () => {
  type Run = Parameters<RemoteAgentPoller['register']>[0];
  const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  };
  function fixture() {
    const owner = 'share:startup-budget';
    const target = providerShareHostPeer('startup-budget', 'executor-m');
    const generation = '11111111-1111-4111-8111-111111111111';
    const calls: Array<{ device: string; op: string; sessionId?: string; generation?: string; runId?: string }> = [];
    const runs = new Map<string, Run>();
    const sessions = new Map<string, string>();
    const disposed: string[] = [];
    const pendingClose = deferred();
    const prepare = deferred();
    const allocation = deferred();
    let allocations = 0;
    const state = { device: 'executor-m' as unknown, duration: 2000 as unknown, delayCaps: 0, ready: false, blockClose: false, blockPrepare: false, blockAllocation: false };
    const emit = (run: Run, value: unknown) => run.onData(Buffer.from(JSON.stringify(value) + '\n'), false);
    const started = (run: Run) => emit(run, { t: 'started', handle: { id: 'sdk-' + run.runId, model: 'm', shadowDir: '', methods: ['setModel'], state: {} } });
    vi.spyOn(RemoteAgentPoller.prototype, 'register').mockImplementation(run => {
      runs.set(run.runId, run);
      if (state.ready || sessions.get(run.runId) === 'sibling') started(run);
    });
    vi.spyOn(RemoteAgentPoller.prototype, 'unregister').mockImplementation(() => {});
    const remoteInvoke = vi.fn(async (device: string, _channel: string, args: unknown[]) => {
      const request = args[0] as { op: string; sessionId?: string; generation?: string; runId?: string; callId?: string; payload?: { json?: { sessionId: string } } };
      calls.push({ device, ...request });
      if (request.op === 'direct-locate') return { ok: true, result: { deviceId: 'executor-m', agentKind: 'codex' } };
      if (request.op === 'allocate') {
        const grant = ++allocations === 1 ? generation : '22222222-2222-4222-8222-222222222222';
        if (state.blockAllocation) await allocation.promise;
        return { ok: true, result: { deviceId: state.device, generation: grant,
          ...(state.duration === undefined ? {} : { leaseDurationMs: request.sessionId === 'sibling' ? 20000 : state.duration }) } };
      }
      if (request.op === 'caps') {
        if (state.delayCaps) { const ms = state.delayCaps; state.delayCaps = 0; await vi.advanceTimersByTimeAsync(ms); }
        return { ok: true, result: { version: 1, maxRuns: 10, uploadChunkBytes: 65536, maxPayloadBytes: 1000000,
          virtualWorkspace: true, directGuestExecution: true, agents: [{ kind: 'codex', available: true }] } };
      }
      if (request.op === 'open') sessions.set(request.runId!, request.payload!.json!.sessionId);
      if (request.op === 'close') {
        if (state.blockClose) await pendingClose.promise;
        const run = runs.get(request.runId!);
        if (run) emit(run, { t: 'closed', reason: 'closed' });
      }
      if (request.op === 'call') {
        const run = runs.get(request.runId!);
        if (run) emit(run, { t: 'result', callId: request.callId, ok: true, value: null });
      }
      return { ok: true, result: {} };
    });
    const start = createDeviceAgentStarter({
      remoteInvoke, renewSharedProviderLink: async () => undefined,
      rgPath: () => RG, codexPath: () => 'fixture-never-spawned', mcpProviders: () => [],
      prepareMcpBridge: async (_providers, _logger, ctx) => {
        if (state.blockPrepare) await prepare.promise;
        return { mcpBridge: { servers: [{ name: 'fixture', url: 'http://fixture.invalid/' }] },
          disposeSessionCtx: () => { disposed.push(ctx.sessionId!); } } as never;
      },
      makerMemory: () => undefined, captureKnownFileBefore: async () => undefined, noteOpaqueTurnChange() {},
      logger: historyLogger,
    });
    historyInvoke.mockImplementation(remoteInvoke);
    historyOpenLink.mockResolvedValue(undefined);
    historyCloseEpoch.mockReturnValue(0);
    historyCrossRegion.mockReturnValue(false);
    return { owner, target, generation, state, calls, runs, disposed, pendingClose, prepare, allocation, emit, started,
      open: (sessionId = 'pending', deviceId = owner, model = 'm', resumeSessionId?: string) => start({ agentKind: 'codex', deviceId,
        options: { sessionId, workingDir: project, model, ...(resumeSessionId ? { resumeSessionId } : {}) } }) };
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); historyInvoke.mockReset(); historyOpenLink.mockReset(); });

  // Unit, F6: terminal cancellation must cross the create -> starter composition boundary.
  // Real starter + startRemote + runClient; native and transport IO use the existing fixture.
  it.each(['allocate', 'MCP', 'started', 'ordinary'] as const)('cancels the exact creation during %s without late fallback/open', async stage => {
    const f = fixture(), owner = {};
    f.state.blockAllocation = stage === 'allocate';
    f.state.blockPrepare = stage === 'MCP' || stage === 'ordinary';
    let rejected: unknown;
    let live: Awaited<ReturnType<typeof f.open>> | undefined;
    const pending = runSessionCreationAttempt('pending', () => owner,
      async () => (live = await f.open('pending', stage === 'ordinary' ? 'same-account-m' : f.owner)))
      .catch(error => { rejected = error; });
    try {
    await flush();
    if (stage === 'started') await vi.waitFor(() => expect(f.runs.size).toBe(1), { interval: 1 });
    captureSessionCreationCancellation(owner, 'pending')(); await flush();
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    const openCount = f.calls.filter(call => call.op === 'open').length;
    const callsAtCancel = f.calls.length;
    f.allocation.resolve(); f.prepare.resolve();
    for (const run of f.runs.values()) f.started(run);
    await pending; await flush();
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(openCount);
    expect(f.calls.slice(callsAtCancel).filter(call => ['open', 'upload', 'caps'].includes(call.op))).toEqual([]);
    if (stage !== 'ordinary') expect(f.calls).toContainEqual(expect.objectContaining({
      device: f.owner, op: 'direct-release', sessionId: 'pending', generation: f.generation,
    }));
    if (stage === 'MCP' || stage === 'started' || stage === 'ordinary') expect(f.disposed).toEqual(['pending']);
    expect(f.calls.filter(call => call.device === f.owner && call.op === 'open')).toEqual([]);
    } finally {
      // Keep the regression isolated even when a broken parent bridge leaks its child startup.
      cancelPendingRemoteStart('pending');
      f.allocation.resolve(); f.prepare.resolve(); await flush();
      for (const run of f.runs.values()) f.emit(run, { t: 'closed', reason: 'closed' });
      await flush(); await live?.close({ reason: 'account-boundary' });
    }
  });

  it('rejects pending startup and closes reverse HTTP/WS and local tools at the deadline, before remote close', async () => {
    const f = fixture(); f.state.blockClose = true;
    const executorClose = vi.spyOn(RemoteExecutor.prototype, 'close');
    const relayClose = vi.spyOn(ExecServerRelay.prototype, 'close');
    const relayFrame = vi.spyOn(ExecServerRelay.prototype, 'handle').mockImplementation(() => {});
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      requestSignal = init.signal!;
      requestSignal.addEventListener('abort', () => reject(new Error('fixture request aborted')), { once: true });
    })));
    let rejected: unknown;
    const pending = f.open().catch(error => { rejected = error; });
    await flush();
    // isGitRepo uses asynchronous fs; drive that boundary, not fake elapsed lease time.
    await vi.waitFor(() => expect(f.runs.size).toBe(1), { interval: 1 });
    const run = [...f.runs.values()][0]!;
    f.emit(run, { t: 'request', requestId: '33333333-3333-4333-8333-333333333333', request: { type: 'http', method: 'POST', path: '/mcp/fixture', headers: [], body: Buffer.from('{}').toString('base64') } });
    f.emit(run, { t: 'ws', connId: 'ws-1', kind: 'open' });
    await flush();
    expect(requestSignal?.aborted).toBe(false);
    expect(relayFrame).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001);
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(requestSignal?.aborted).toBe(true);
    expect(f.disposed).toEqual(['pending']);
    expect(executorClose).toHaveBeenCalledTimes(1);
    expect(relayClose).toHaveBeenCalledTimes(1);
    f.started(run);
    f.emit(run, { t: 'ws', connId: 'ws-late', kind: 'open' });
    await flush();
    expect(relayFrame).toHaveBeenCalledTimes(1);
    expect(liveSharedTaskTarget('pending', f.owner)).toBeNull();
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(1);
    f.pendingClose.resolve(); await pending; await flush();
  });

  it('rejects during MCP preparation, closes the executor immediately, and disposes late preparation without opening M', async () => {
    const f = fixture(); f.state.blockPrepare = true;
    const closed = vi.spyOn(RemoteExecutor.prototype, 'close');
    let rejected: unknown;
    const pending = f.open().catch(error => { rejected = error; });
    await flush();
    await vi.advanceTimersByTimeAsync(2001);
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(f.disposed).toEqual([]);
    f.prepare.resolve(); await pending; await flush();
    expect(f.disposed).toEqual(['pending']);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.op === 'open')).toEqual([]);
  });

  it.each([0, null, Number.NaN, 1800001, 'spent-in-caps', 'bad-device'])('never opens M for an invalid or exhausted allocation: %s', async lifetime => {
    const f = fixture(); f.state.ready = true;
    if (lifetime === 'spent-in-caps') f.state.delayCaps = 3000;
    else if (lifetime === 'bad-device') f.state.device = '';
    else f.state.duration = lifetime;
    const handle = await f.open();
    expect(f.calls.filter(call => call.op === 'open').map(call => call.device)).toEqual([f.owner]);
    expect(f.calls.filter(call => call.op === 'direct-release')).toEqual([
      expect.objectContaining({ device: f.owner, sessionId: 'pending', generation: f.generation }),
    ]);
    await handle.close();
  });

  it.each([2000, undefined])('hands off one active lease and rearms on successful renewal, including legacy O: %s', async duration => {
    const f = fixture(); f.state.ready = true; f.state.duration = duration;
    const handle = await f.open();
    const sibling = await f.open('sibling');
    if (duration === undefined) {
      await vi.advanceTimersByTimeAsync(2001);
      expect(f.disposed).toEqual([]);
    } else {
      await vi.advanceTimersByTimeAsync(1000);
      await handle.setModel!('m2');
      await vi.advanceTimersByTimeAsync(1001);
      expect(f.disposed).not.toContain('pending');
      await vi.advanceTimersByTimeAsync(1000);
      expect(f.disposed).toContain('pending');
      expect(f.disposed).not.toContain('sibling');
    }
    await handle.close(); await sibling.close();
  });

  it('cancels allocation before any M probe, releases only the late generation, and preserves a replacement attempt', async () => {
    const f = fixture(); f.state.blockAllocation = true;
    let rejected: unknown;
    const old = f.open().catch(error => { rejected = error; });
    await flush(); cancelPendingRemoteStart('pending'); await flush();
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(f.calls.filter(call => call.device === f.target)).toEqual([]);
    f.state.blockAllocation = false; f.state.ready = true;
    const replacement = await f.open();
    const before = f.calls.filter(call => call.device === f.target).length;
    f.allocation.resolve(); await old; await flush();
    expect(f.calls.filter(call => call.device === f.target)).toHaveLength(before);
    expect(f.calls.filter(call => call.op === 'direct-release')).toEqual([
      expect.objectContaining({ sessionId: 'pending', generation: f.generation }),
    ]);
    expect(f.disposed).toEqual([]);
    expect(liveSharedTaskTarget('pending', f.owner)).toBe(f.target);
    await replacement.close();
  });

  it('does not retry a deleted direct task through O after MCP preparation completes late', async () => {
    const f = fixture(); f.state.blockPrepare = true;
    let rejected: unknown;
    const pending = f.open().catch(error => { rejected = error; });
    await flush(); cancelPendingRemoteStart('pending'); await flush();
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    f.state.blockPrepare = false; f.state.ready = true;
    f.prepare.resolve(); await pending; await flush();
    expect(f.calls.filter(call => call.op === 'open')).toEqual([]);
    expect(f.disposed).toEqual(['pending']);
    expect(f.calls.filter(call => call.op === 'direct-release')).toEqual([
      expect.objectContaining({ sessionId: 'pending', generation: f.generation }),
    ]);
  });

  it('keeps a newer same-session start alive when only the old pending attempt reaches its deadline', async () => {
    const f = fixture();
    let rejected: unknown;
    const old = f.open().catch(error => { rejected = error; });
    await vi.waitFor(() => expect(f.runs.size).toBe(1), { interval: 1 });
    f.state.ready = true; f.state.duration = 20000;
    const replacement = await f.open('pending', f.owner, 'm2');
    await vi.advanceTimersByTimeAsync(2001);
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(f.disposed).toEqual(['pending']);
    expect(liveSharedTaskTarget('pending', f.owner)).toBe(f.target);
    await old; await replacement.close();
    expect(f.disposed).toEqual(['pending', 'pending']);
  });

  it('fails a historical M startup at expiry without sending its native resume ID to O', async () => {
    const f = fixture();
    let rejected: unknown;
    const pending = f.open('historical', f.owner, 'm', 'native-only-on-m').catch(error => { rejected = error; });
    await vi.waitFor(() => expect(f.runs.size).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(2001);
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(f.calls.filter(call => call.op === 'open').map(call => call.device)).toEqual([f.target]);
    expect(f.disposed).toEqual(['historical']);
    await pending;
  });

  it('cleans a prepared handle when archive cancels the early renewal before starter handoff', async () => {
    const f = fixture(); f.state.duration = undefined; f.state.blockClose = true;
    let rejected: unknown;
    const pending = f.open().catch(error => { rejected = error; });
    await vi.waitFor(() => expect(f.runs.size).toBe(1), { interval: 1 });
    await vi.advanceTimersByTimeAsync(20 * 60000 + 1);
    f.state.blockAllocation = true;
    f.started([...f.runs.values()][0]!); await flush();
    expect(f.calls.filter(call => call.op === 'allocate')).toHaveLength(2);
    cancelPendingRemoteStart('pending'); await flush();
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(f.disposed).toEqual(['pending']);
    f.allocation.resolve(); await flush();
    expect(f.calls.filter(call => call.op === 'direct-release')).toContainEqual(
      expect.objectContaining({ sessionId: 'pending', generation: '22222222-2222-4222-8222-222222222222' }),
    );
    f.pendingClose.resolve(); await pending; await flush();
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(1);
  });

  it('does not contact O or M for an already-aborted history or pinned executor attempt', async () => {
    const f = fixture();
    const abort = new AbortController();
    const reason = new Error('[REMOTE_AGENT_EXPIRED] archived'); abort.abort(reason);
    await expect(authorizeSharedTaskHistory(f.owner, 'history', 'codex', 'm', abort.signal)).rejects.toBe(reason);
    await expect(authorizeSharedTaskExecutor(f.owner, 'history', 'codex', 'm', 'executor-m', false, abort.signal)).rejects.toBe(reason);
    expect(f.calls).toEqual([]); expect(historyOpenLink).not.toHaveBeenCalled();
  });

  it.each(['locate', 'allocate', 'link', 'caps-success', 'caps-failure'] as const)('keeps history cancellation terminal through %s and releases only the returned generation', async stage => {
    const f = fixture(), gate = deferred(), abort = new AbortController();
    const reason = new Error('[REMOTE_AGENT_EXPIRED] archived history');
    const requests: Array<{ op: string; sessionId?: string; generation?: string }> = [];
    const caps = { version: 1, maxRuns: 10, uploadChunkBytes: 65536, maxPayloadBytes: 1000000,
      virtualWorkspace: true, directGuestExecution: true, agents: [{ kind: 'codex', available: true }] };
    historyInvoke.mockImplementation(async (_device, _channel, [request]) => {
      requests.push(request);
      if (request.op === 'direct-locate') {
        if (stage === 'locate') { await gate.promise; throw new Error('[REMOTE_AGENT_PEER_TOO_OLD] late old O response'); }
        return { ok: true, result: { deviceId: 'executor-m' } };
      }
      if (request.op === 'allocate') {
        if (stage === 'allocate') await gate.promise;
        return { ok: true, result: { deviceId: 'executor-m', generation: f.generation, leaseDurationMs: 2000 } };
      }
      if (request.op === 'caps') {
        await gate.promise;
        if (stage === 'caps-failure') throw new Error('late caps transport failure');
        return { ok: true, result: caps };
      }
      return { ok: true, result: {} };
    });
    if (stage === 'link') historyOpenLink.mockImplementation(() => gate.promise);
    const pending = authorizeSharedTaskHistory(f.owner, 'history', 'codex', 'm', abort.signal);
    void pending.catch(() => undefined);
    await flush(); abort.abort(reason); gate.resolve();
    await expect(pending).rejects.toBe(reason); await flush();
    expect(requests.filter(request => request.op === 'direct-release')).toEqual(stage === 'locate' ? [] : [
      { op: 'direct-release', sessionId: 'history', generation: f.generation },
    ]);
    expect(requests.filter(request => request.op === 'caps')).toHaveLength(stage.startsWith('caps-') ? 1 : 0);
    if (stage === 'locate') expect(requests.filter(request => request.op === 'allocate')).toEqual([]);
    if (stage === 'allocate') expect(historyOpenLink).not.toHaveBeenCalled();
  });

  it('preserves legacy O lookup fallback and missing lifetime, but never substitutes another historical M', async () => {
    const f = fixture();
    historyInvoke.mockRejectedValueOnce(new Error('[REMOTE_AGENT_PEER_TOO_OLD] old O'));
    await expect(authorizeSharedTaskHistory(f.owner, 'legacy', 'codex', 'm')).resolves.toEqual({ target: f.owner, direct: false });
    f.state.duration = undefined;
    await expect(authorizeSharedTaskExecutor(f.owner, 'legacy', 'codex', 'm', 'executor-m')).resolves.toMatchObject({ target: f.target, direct: true });
    historyInvoke.mockResolvedValueOnce({ ok: true, result: { deviceId: 'different-m', generation: f.generation, leaseDurationMs: 2000 } });
    await expect(authorizeSharedTaskExecutor(f.owner, 'history', 'codex', 'm', 'executor-m')).rejects.toThrow('holding this shared task');
  });

  it('keeps ordinary archive cancellation attempt-local when a replacement with the same session is starting', async () => {
    const f = fixture(); f.state.blockPrepare = true;
    let rejected: unknown;
    const pending = f.open('ordinary', 'same-account-m').catch(error => { rejected = error; });
    await flush(); cancelPendingRemoteStart('ordinary'); await flush();
    // The new attempt is registered after the archive event and must not inherit it.
    f.state.blockPrepare = false; f.state.ready = true;
    const next = await f.open('ordinary', 'same-account-m');
    f.prepare.resolve(); await pending; await flush();
    expect(String(rejected)).toContain('REMOTE_AGENT_EXPIRED');
    expect(f.calls.filter(call => call.op === 'open')).toHaveLength(1);
    expect(f.disposed).toEqual(['ordinary']);
    await next.close();
    expect(f.disposed).toEqual(['ordinary', 'ordinary']);
  });
});

// Unit, F5: cancellation between compression/upload awaits must stop further payload delivery.
// Real RemoteAgentRunClient.payload/open; only gzip timing/output and transport replies are fixtures.
describe('shared startup lease budget upload cancellation', () => {
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  function fixture() {
    let reply!: () => void;
    const held = new Promise<void>(resolve => { reply = resolve; });
    const requests: Array<{ op: string; index?: number }> = [];
    let hold = false;
    const invoke = async (args: unknown[]) => {
      const request = args[0] as { op: string; index?: number };
      requests.push(request);
      if (hold && request.op === 'upload') await held;
      return {};
    };
    const client = new RemoteAgentRunClient(randomUUID(), { invoke, unregister() {} } as unknown as RemoteAgentPoller, {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'error', error: { code: 'UNUSED', message: 'fixture' } }),
    }, randomUUID);
    // Just crosses the inline threshold; gzip is a bounded two-chunk fixture above.
    const payload = { sessionId: 'upload-task', text: 'x'.repeat(1024 * 1024) };
    return { client, payload, requests, reply, hold: () => { hold = true; } };
  }
  beforeEach(() => { payloadCompression.enabled = true; payloadCompression.paused = false; payloadCompression.calls = 0; payloadCompression.finish = undefined; });
  afterEach(() => { payloadCompression.enabled = false; payloadCompression.finish = undefined; });

  it('allows the in-flight first chunk to return but sends no later upload or open after cancellation', async () => {
    const f = fixture(); f.hold();
    const starting = f.client.open('codex', f.payload); void starting.catch(() => undefined);
    await flush(); expect(f.requests.map(request => request.op)).toEqual(['upload']);
    f.client.abandon('start-cancelled'); f.reply();
    await expect(starting).rejects.toThrow('REMOTE_AGENT_EXPIRED');
    expect(f.requests.map(request => request.op)).toEqual(['upload']);
    expect(f.requests[0]?.index).toBe(0);
  });

  it('sends no first chunk if cancellation happens while gzip is pending', async () => {
    const f = fixture(); payloadCompression.paused = true;
    const starting = f.client.open('codex', f.payload); void starting.catch(() => undefined);
    await flush(); expect(payloadCompression.calls).toBe(1);
    f.client.abandon('start-cancelled'); payloadCompression.finish!();
    await expect(starting).rejects.toThrow('REMOTE_AGENT_EXPIRED');
    expect(f.requests).toEqual([]);
  });

  it('completes both chunks when not cancelled and rejects an already-closed payload before compression', async () => {
    const f = fixture();
    await expect(f.client.payload(f.payload)).resolves.toMatchObject({ chunks: 2, bytes: 512 * 1024 + 1 });
    expect(f.requests.map(request => request.index)).toEqual([0, 1]);
    f.client.abandon('closed');
    await expect(f.client.payload(f.payload)).rejects.toThrow('REMOTE_AGENT_EXPIRED');
    expect(payloadCompression.calls).toBe(1);
    expect(f.requests).toHaveLength(2);
  });
});
