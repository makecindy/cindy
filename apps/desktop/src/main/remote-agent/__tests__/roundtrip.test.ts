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
import { MAIN_OWNED_SEND_CONTEXT } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { startRemoteAgentSession, type StartRemoteAgentDeps } from '../controller/startRemote';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';

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
function fakeHostedAgent(input: HostedStartInput): AgentSessionHandle {
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

function makeDeps(host: ReturnType<typeof createRemoteAgentHost>): StartRemoteAgentDeps {
  return {
    invoke: async (args) => {
      // JSON 往返模拟设备互联的序列化。
      const result = await host.handle(CONTROLLER, JSON.parse(JSON.stringify(args[0])));
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

function createHost() {
  return createRemoteAgentHost({
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
    // 六个任务同时进行，拉取始终最多两个在途，不会挤占设备互联的其它请求。
    expect(peakPolls).toBeLessThanOrEqual(2);
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

  it('refuses controllers that are no longer allowed', async () => {
    authorized = false;
    const host = createHost();
    await expect(startRemoteAgentSession('pi', { sessionId: 's3', workingDir: project, model: 'm' }, makeDeps(host)))
      .rejects.toThrow(/REMOTE_AGENT_UNAVAILABLE/);
    host.dispose();
  });
});
