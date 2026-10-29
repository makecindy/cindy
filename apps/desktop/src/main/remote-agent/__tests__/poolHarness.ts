/**
 * 连接池的真实 Agent 场景(claudeHosted / codexHosted / piHosted 三个 e2e 共用)：同一进程里跑使用方、
 * 提供方(createRemoteAgentHost，按 readLimits 计名额)与真 Agent + 假模型网关。
 *
 *  - 上限 1：打开前已满 → 让出闲置的 a → b 打开；a 再发消息 → 让出 b、带原生会话 id 接回 a，模型看到之前的对话；
 *    闲置不足设置时长或设置为 0 时不让，对方拒绝后照原样报错；会话 id 会被对方改写的 Pi 任务不让；
 *  - 上限 2：本机计数没到上限、对方以名额拒绝 → 让一个再重试一次；
 *  - 上限 5：到水位线(4)后台按最久没活动让出。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { RemoteAgentKind } from '@cindy/device-link';
import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { expect, vi } from 'vitest';

import { RemoteConnectionPool } from '../controller/connectionPool';
import { hostRewritesResumeId, startRemoteAgentSession, type StartRemoteAgentDeps } from '../controller/startRemote';
import { createRemoteAgentHost, type HostedStartInput } from '../host/runHost';
import type { RemoteAgentLimits } from '../../../shared/remoteAgentLimits';

export interface PoolScenarioOptions {
  kind: RemoteAgentKind;
  root: string;
  /** 任务的工作目录；缺省在 root 下。 */
  projectDir?: string;
  /** 第一个任务的原生会话 id 能不能原样带给对方(Pi 的会话文件路径可能被改写)；缺省 true。 */
  expectResumable?: boolean;
  model: string;
  rgPath: string;
  startHosted(input: HostedStartInput): Promise<AgentSessionHandle>;
  /** 使用方的额外接线(Codex 的 codexPath 等)。 */
  deps?: Partial<StartRemoteAgentDeps>;
  /** 模型网关到目前为止收到的请求(原文)。 */
  modelRequests(): string[];
  /** 第一轮(记住暗号)与接回后那一轮各自的额外断言。 */
  afterFirstTurn?(handle: AgentSessionHandle): Promise<void> | void;
  afterResumedTurn?(handle: AgentSessionHandle): Promise<void> | void;
}

/** 闲置阈值(分钟)：100ms。 */
const SHORT_IDLE_MINUTES = 100 / 60_000;
/**
 * 「闲置满阈值」靠把时钟拨快，不真等：场景里只假 `Date`(照常往前走，计时器与真实 Agent 进程不受影响)，
 * 连接的最后活动时间与连接池判断用的都是它。
 */
const passTime = (ms: number) => vi.setSystemTime(Date.now() + ms);

export async function exerciseConnectionPool(options: PoolScenarioOptions): Promise<void> {
  const project = options.projectDir ?? path.join(options.root, `pool-project-${options.kind}`);
  const tag = randomUUID().slice(0, 8);
  const hostRoot = path.join(options.root, `pool-host-${options.kind}-${tag}`);
  fs.mkdirSync(project, { recursive: true });
  let limits: RemoteAgentLimits = { perDevice: 1, total: 64 };
  let idleMinutes = SHORT_IDLE_MINUTES;
  const started: HostedStartInput[] = [];
  const host = createRemoteAgentHost({
    readLimits: () => limits,
    isAgentAvailable: (kind) => kind === options.kind,
    startHosted: (input) => {
      started.push(input);
      return options.startHosted(input);
    },
    isControllerAuthorized: () => true,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot: hostRoot,
  });
  const pool = new RemoteConnectionPool({ idleMinutes: () => idleMinutes, checkMs: 3_600_000, now: () => Date.now() });
  let opens = 0;
  /** 发出 close 的任务(让出名额或关闭)。 */
  const closedBy: string[] = [];
  const handles: AgentSessionHandle[] = [];
  const open = async (name: string, withPool = true) => {
    const handle = await startRemoteAgentSession(options.kind, {
      sessionId: `pool-${options.kind}-${tag}-${name}`,
      workingDir: project,
      model: options.model,
      permissionMode: 'bypassPermissions',
    }, {
      invoke: async (args) => {
        const request = JSON.parse(JSON.stringify(args[0])) as { op?: string };
        if (request.op === 'open') opens += 1;
        if (request.op === 'close') closedBy.push(name);
        return JSON.parse(JSON.stringify(await host.handle('controller-1', request) ?? null));
      },
      rgPath: options.rgPath,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      collectProjectFiles: async () => [],
      isGitRepo: async () => false,
      newId: randomUUID,
      ...options.deps,
      ...(withPool ? { pool } : {}),
    });
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
    handles.push(handle);
    return handle;
  };
  const events = new Map<AgentSessionHandle, AgentEvent[]>();
  const turn = async (handle: AgentSessionHandle, content: string) => {
    let seen = events.get(handle);
    if (!seen) {
      const list: AgentEvent[] = [];
      seen = list;
      events.set(handle, list);
      void (async () => {
        for await (const event of handle.events()) list.push(event);
      })();
    }
    const doneBefore = seen.filter((event) => event.type === 'done').length;
    await handle.send({ type: 'user', content });
    await vi.waitFor(() => {
      const terminal = seen!.find((event) => event.type === 'error' && (event.data as { isTerminal?: boolean }).isTerminal !== false);
      if (terminal) throw new Error(`terminal error: ${JSON.stringify(terminal.data)}`);
      expect(seen!.filter((event) => event.type === 'done').length).toBeGreaterThan(doneBefore);
    }, { timeout: 90_000, interval: 50 });
  };
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  try {
    // ── 上限 1：打开前已满 → 让出；再发消息 → 接回同一个会话 ──
    const a = await open('a');
    await turn(a, 'Remember the codeword PINEAPPLE-42.');
    await options.afterFirstTurn?.(a);
    const nativeA = a.id;
    expect(nativeA).not.toBe('<pending>');
    // Pi 的会话 id 是对方的会话文件路径：同一台电脑上它落在工作目录的上级目录下，带过去会被对方改写，
    // 这样的任务不让出(接不回就会丢上下文)。
    const resumable = !hostRewritesResumeId(nativeA, { workingDir: project, homeDir: os.homedir(), extraDirs: [], writableDirs: [] });
    expect(resumable).toBe(options.expectResumable ?? true);
    passTime(150);
    if (!resumable) {
      opens = 0;
      await expect(open('b')).rejects.toThrow('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT]');
      expect(opens).toBe(1);
      expect(closedBy).toEqual([]);
      await a.close({ reason: 'navigation' });
    } else {
      const b = await open('b');
      expect(host.limitUsage().total).toBe(1);
      expect(started.at(-1)!.options.resumeSessionId).toBeUndefined();
      await turn(b, 'Hello from b.');
      passTime(150);
      const requestsBefore = options.modelRequests().length;
      await turn(a, 'What was the codeword?');
      expect(host.limitUsage().total).toBe(1);
      expect(started.at(-1)!.options.resumeSessionId).toBe(nativeA);
      const resumed = options.modelRequests().slice(requestsBefore);
      expect(resumed.length).toBeGreaterThan(0);
      // 模型在接回后的这一轮看得到之前的对话。
      expect(resumed.some((body) => body.includes('PINEAPPLE-42') && body.includes('What was the codeword?'))).toBe(true);
      expect(events.get(a)!.some((event) => event.type === 'error')).toBe(false);
      await options.afterResumedTurn?.(a);

      // 闲置不足设置时长：没有能让的，对方拒绝后照原样报错，不重试。
      idleMinutes = 30;
      opens = 0;
      await expect(open('c')).rejects.toThrow('[REMOTE_AGENT_BUSY] [DEVICE_LIMIT]');
      expect(opens).toBe(1);
      // 设置为 0：同样不让。
      idleMinutes = 0;
      passTime(150);
      opens = 0;
      await expect(open('c')).rejects.toThrow('[DEVICE_LIMIT]');
      expect(opens).toBe(1);
      idleMinutes = SHORT_IDLE_MINUTES;
      for (const handle of [a, b]) await handle.close({ reason: 'navigation' });
    }
    expect(host.limitUsage().total).toBe(0);

    // ── 上限 2：不进连接池的任务占了一个名额，本机计数没满 → 对方拒绝 → 让一个再重试一次 ──
    limits = { perDevice: 2, total: 64 };
    const e = await open('e');
    const outside = await open('outside', false);
    expect(host.limitUsage().total).toBe(2);
    passTime(150);
    opens = 0;
    closedBy.length = 0;
    const d = await open('d');
    expect(opens).toBe(2);
    expect(closedBy).toEqual(['e']);
    expect(host.limitUsage().total).toBe(2);
    for (const handle of [e, outside, d]) await handle.close({ reason: 'navigation' });
    expect(host.limitUsage().total).toBe(0);

    // ── 上限 5：水位线 4，到了就在后台按最久没活动让出 ──
    limits = { perDevice: 5, total: 64 };
    const p1 = await open('p1');
    passTime(150);
    const p2 = await open('p2');
    passTime(20);
    const p3 = await open('p3');
    expect(host.limitUsage().total).toBe(3);
    passTime(150);
    closedBy.length = 0;
    await open('p4');
    await vi.waitFor(() => expect(host.limitUsage().total).toBe(3), { timeout: 30_000 });
    // 只让了一个(Agent 启动时还在往来的不算闲置，所以不一定是 p1)；它还没有对话，连回时开新会话，不算接不回。
    expect(closedBy).toHaveLength(1);
    const released = ({ p1, p2, p3 } as Record<string, AgentSessionHandle>)[closedBy[0]];
    expect(released).toBeDefined();
    const beforeAgain = started.length;
    await turn(released, 'Back again.');
    expect(started.length).toBe(beforeAgain + 1);
    expect(started.at(-1)!.options.resumeSessionId).toBeUndefined();
    expect(events.get(released)!.some((event) => event.type === 'error')).toBe(false);
  } finally {
    vi.useRealTimers();
    await Promise.allSettled(handles.map((handle) => handle.close({ reason: 'navigation' })));
    await host.abortAll();
    host.dispose();
  }
}
