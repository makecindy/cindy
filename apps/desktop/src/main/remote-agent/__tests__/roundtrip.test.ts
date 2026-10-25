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
import { MAIN_OWNED_SEND_CONTEXT, Session } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { credentialGrantFor, forgetCredentialGrants } from '../executor/credentialGrants';
import { cancelPendingRemoteStart, startRemoteAgentSession, type StartRemoteAgentDeps } from '../controller/startRemote';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';
import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';
import { DEFAULT_REMOTE_AGENT_LIMITS, type RemoteAgentLimits } from '../../../shared/remoteAgentLimits';
import { installDesktopInteractionHandler } from '../../maker-ipc/interactionRouter';

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

function createHost(readLimits: () => RemoteAgentLimits = () => DEFAULT_REMOTE_AGENT_LIMITS) {
  return createRemoteAgentHost({
    readLimits,
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      hostInputs.push(input);
      return fakeHostedAgent(input);
    },
    isControllerAuthorized: () => authorized,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: hostRoot,
  });
}

describe('remote agent round trip', () => {
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
      expect(dispose).toHaveBeenCalledTimes(1);
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
      expect(host.limitUsage().total).toBe(0);
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
