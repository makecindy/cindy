/**
 * 受邀者经供应商组分叉真实 Claude Code 任务：
 *   受邀者 G ⇄ 组所在电脑 O(createRemoteAgentHost + groupRelay) ⇄ 组内电脑 M(真 Claude Code + 假 Anthropic 网关)
 * 三端同进程、经 JSON 往返模拟设备互联。
 *
 * Bug：组内电脑上原生分叉失败(如锚点不在会话记录里)时，报错被组内电脑写成「请求失败」、再被组所在电脑
 * 换成「暂时不可用」，受邀者只看到「电脑连不上」，任何一端都查不到原因。groupRelay.test.ts 的分叉用假 Agent，
 * 覆盖不到真实原生分叉与它的失败。最小失败输入：锚点 uuid 不在会话里。tier: e2e(真实 CLI)；
 * 依赖 apps/claude-code-bin，缺失时跳过。
 */
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ClaudeCodeAgent, type AgentDeps, type AgentEvent, type Logger } from '@cindy/maker-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';
import { createRemoteAgentHost, type GroupRelayMember, type RemoteAgentGroupRelayDeps } from '../host/runHost';
import { hostedStartOptions } from '../host/service';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CLAUDE = path.join(REPO, 'apps', 'claude-code-bin', ARCH, process.platform === 'win32' ? 'claude.exe' : 'claude');
const available = fs.existsSync(CLAUDE);
const MODEL = 'claude-sonnet-4-5';
const GUEST = 'share-guest-a';
const OWNER_DEVICE = 'group-owner';
const MEMBER: GroupRelayMember = { memberKey: 'device:member:gateway', agentDeviceId: 'member', providerId: 'shared-gateway', sameAccount: true };

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function text(value: string): string {
  return [
    { type: 'message_start', message: { id: 'msg_text', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value ?? null)) as T;

describe.skipIf(!available)('a shared user forks a real Claude Code task through a provider group', () => {
  let server: Server;
  let endpoint = '';
  let root = '';

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-group-fork-')));
    // Claude Code 读写 ~/.claude：指向临时目录，不碰开发机的真实配置。
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { recursive: true });
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, home);
    server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (req.url?.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 100 }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(text('hello back'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 异步等待 CLI 退出并释放 Windows 文件句柄。
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  // Direct history lives only on M; the existing relay-only scenario cannot catch
  // accidentally sending that native ID to O. Both routes use the real CLI (e2e).
  it.each(['relay', 'direct'] as const)('forks native history on M with %s routing and preserves native failures', { timeout: 180_000 }, async route => {
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-test-key' }),
      },
      runtimeConfig: { endpoint },
      binaryPath: CLAUDE,
      logger: noopLogger,
    };
    const agent = new ClaudeCodeAgent(deps);
    const ownerWarnings: Array<{ msg: string; data?: unknown }> = [];
    const memberWarnings: Array<{ msg: string; data?: unknown }> = [];
    const member = createRemoteAgentHost({
      isAgentAvailable: (kind) => kind === 'claude-code',
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      forkHosted: (_kind, opts) => agent.forkSdkSession(opts),
      isControllerAuthorized: () => true,
      controllerTrust: controller => controller === OWNER_DEVICE ? 'owner' : 'guest',
      providerAccess: { resolve: async (_kind, _model, providerId) => providerId ?? MEMBER.providerId, isAllowed: () => true },
      bindGuestProviderRoute: async () => ({ routeToken: 'route', modelIds: [MODEL], release: () => {} }),
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: path.join(root, 'member'),
      log: { info: () => {}, warn: (msg, data) => { memberWarnings.push({ msg, data }); } },
    });
    // 组内电脑经设备互联回的错误：与生产 device-link/dispatch.ts 一样，不带远程 Agent 码的报错一律换成「请求失败」。
    const poller = new RemoteAgentPoller(async (args) => {
      try {
        return roundTrip(await member.handle(OWNER_DEVICE, roundTrip(args[0])));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(/^\[REMOTE_AGENT_[A-Z_]+\]/.test(message) ? message : '[REMOTE_AGENT_UNAVAILABLE] remote agent request failed');
      }
    });
    let planned = false;
    const relay = {
      plan: vi.fn(async () => {
        if (planned) return null;
        planned = true;
        return { kind: 'member' as const, ...MEMBER };
      }),
      connect: vi.fn(() => ({ invoke: poller.invoke, poller })),
      noteStartFailure: vi.fn(() => false),
      noteRunFailure: vi.fn(() => false),
      trackRun: vi.fn(() => ({ setRunning: vi.fn(), release: vi.fn() })),
      forget: vi.fn(async () => {}),
    } satisfies RemoteAgentGroupRelayDeps;
    const owner = createRemoteAgentHost({
      // 组所在电脑不必装组内电脑的 Agent。
      isAgentAvailable: () => false,
      startHosted: async () => { throw new Error('the group owner does not run this task'); },
      isControllerAuthorized: () => true,
      controllerTrust: (controller) => (controller.startsWith('share-') ? 'guest' : 'owner'),
      providerAccess: { resolve: async (_kind, _model, providerId) => providerId ?? 'shared', isAllowed: () => true },
      bindGuestProviderRoute: async () => ({ routeToken: 'route', modelIds: [MODEL], release: () => {} }),
      groupRelay: relay,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: path.join(root, 'owner'),
      log: { info: () => {}, warn: (msg, data) => { ownerWarnings.push({ msg, data }); } },
    });

    const executionHost = route === 'direct' ? member : owner;
    const guestPoller = new RemoteAgentPoller(async (args) => roundTrip(await executionHost.handle(GUEST, roundTrip(args[0]))));
    const events: AgentEvent[] = [];
    let turnDone: () => void = () => {};
    const turn = new Promise<void>((resolve) => { turnDone = resolve; });
    let seq = 0;
    const client = new RemoteAgentRunClient('11111111-1111-4111-8111-000000000001', guestPoller, {
      onEvent: (event) => {
        events.push(event as AgentEvent);
        if ((event as AgentEvent).type === 'done') turnDone();
      },
      onState: () => undefined,
      onRequest: async () => ({ type: 'callback', value: undefined }),
      onWs: () => undefined,
      onClosed: () => undefined,
    }, () => `22222222-2222-4222-8222-${String(++seq).padStart(12, '0')}`);
    const project = path.join(root, 'guest-project');
    fs.mkdirSync(project, { recursive: true });
    try {
      const started = await client.open('claude-code', {
        sessionId: 'guest-task',
        virtualWorkspace: true,
        options: { model: MODEL, permissionMode: 'bypassPermissions' },
        workspace: { workingDir: project, platform: process.platform, shell: process.platform === 'win32' ? 'powershell' : 'zsh' },
        projectFiles: [],
        ancestorFiles: [],
        personal: { files: [] },
        mcpServers: [],
      });
      await client.call('send', [{ content: 'Say hello.', attachments: [] }, {}]);
      await turn;
      await client.close('close', 'navigation');
      expect(events.some((event) => event.type === 'error')).toBe(false);
      // 与控制端落库一致：助手文本行的 agentMeta.uuid 就是分叉锚点。
      const anchor = events.filter((event) => event.type === 'text').map((event) => event.agentMeta?.uuid)
        .find((uuid): uuid is string => typeof uuid === 'string');
      expect(anchor).toBeDefined();
      const forkRequest = (upToMessageId: string, newSessionId: string, acceptsForkFailed = true) => roundTrip({
        op: 'fork', sourceSessionId: 'guest-task', newSessionId, agentKind: 'claude-code',
        sourceSdkSessionId: started.id, model: MODEL, upToMessageId,
        ...(acceptsForkFailed ? { acceptsForkFailed: true } : {}),
      });
      const fork = (upToMessageId: string, newSessionId: string, acceptsForkFailed = true) =>
        executionHost.handle(GUEST, forkRequest(upToMessageId, newSessionId, acceptsForkFailed));

      await expect(fork(anchor!, 'guest-child')).resolves.toMatchObject({ newSdkSessionId: expect.any(String) });
      if (route === 'direct') {
        await expect(owner.handle(GUEST, forkRequest(anchor!, 'wrong-owner-child'))).rejects.toThrow('REMOTE_AGENT_INVALID');
        await expect(member.handle('share-other-guest', forkRequest(anchor!, 'wrong-guest-child'))).rejects.toThrow('REMOTE_AGENT_INVALID');
        expect(relay.plan).not.toHaveBeenCalled();
      }

      const missing = '00000000-0000-4000-8000-000000000000';
      const failure = await fork(missing, 'guest-child-2').then(() => null, (error: unknown) => error as Error);
      expect(failure?.message).toMatch(/^\[REMOTE_AGENT_FORK_FAILED\]/);
      // 原因只留在各自电脑的日志里：组内电脑记原生报错，组所在电脑记转发失败。
      expect(memberWarnings).toEqual([expect.objectContaining({
        msg: 'remote agent: native fork failed',
        data: expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining(missing) }) }),
      })]);
      expect(ownerWarnings).toEqual(route === 'direct' ? [] : [expect.objectContaining({
        msg: 'remote agent: a computer in the provider group could not fork the shared task',
        data: expect.objectContaining({ error: expect.objectContaining({ code: 'REMOTE_AGENT_FORK_FAILED' }) }),
      })]);

      // 不认识新错误码的旧受邀者(分叉请求不带 acceptsForkFailed)照旧收到「暂时不可用」。
      const legacy = await fork(missing, 'guest-child-3', false).then(() => null, (error: unknown) => error as Error);
      expect(legacy?.message).toMatch(/^\[REMOTE_AGENT_UNAVAILABLE\]/);
    } finally {
      for (const host of [owner, member]) { await host.abortAll(); await host.purgeControllers(() => true); host.dispose(); }
    }
  });
});
