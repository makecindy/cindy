/**
 * 被控端任务生命周期收尾：
 *  - 影子工作目录(同步过去的项目与个人说明副本)在任务收尾后删除，替换实例还在用时保留；
 *  - 去重 / 丢弃路径上的上传载荷显式取走，不留着占暂存配额到过期。
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AgentEvent, AgentSessionHandle } from '@cindy/maker-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteAgentPoller } from '../controller/poller';
import { RemoteAgentRunClient } from '../controller/runClient';
import { createRemoteAgentHost, hostSessionIdFor, type HostedStartInput } from '../host/runHost';

/** 协议层 id 是 36 位 UUID 形态。 */
const RUN_1 = '11111111-1111-4111-8111-111111111111';
const RUN_2 = '22222222-2222-4222-8222-222222222222';
const UPLOAD_1 = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UPLOAD_2 = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let root: string;
let runsRoot: string;
let clock = 0;

function idleHandle(input: HostedStartInput): AgentSessionHandle {
  return {
    id: `sdk-${input.hostSessionId}`,
    agentKind: input.kind,
    model: input.options.model,
    async send() {},
    async steer() {},
    async abort() {},
    async close() {},
    events: () => ({
      async *[Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
        // 不产生事件。
      },
    }),
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver() {},
  };
}

function makeHost(started: Array<() => void>) {
  return createRemoteAgentHost({
    isAgentAvailable: () => true,
    startHosted: async (input) => {
      started.shift()?.();
      return idleHandle(input);
    },
    isControllerAuthorized: () => true,
    captureOwner: () => 'owner',
    isOwnerCurrent: () => true,
    runsRoot,
    now: () => clock,
  });
}

function openPayload(sessionId: string, projectFiles: Array<{ path: string; data: string }> = []) {
  return {
    sessionId,
    options: { model: 'claude-opus' },
    workspace: { workingDir: '/Users/me/proj', platform: 'darwin', shell: 'bash' },
    projectFiles,
    ancestorFiles: [],
    personal: { files: [] },
    mcpServers: [],
  };
}

/** 把载荷 gzip 后经 upload op 暂存，返回引用(uploadId 分段上传的形态)。 */
async function stageUpload(
  host: ReturnType<typeof createRemoteAgentHost>,
  uploadId: string,
  value: unknown,
): Promise<{ uploadId: string; chunks: number; bytes: number }> {
  const gz = gzipSync(Buffer.from(JSON.stringify(value ?? null), 'utf8'));
  await host.handle('controller-1', {
    op: 'upload',
    uploadId,
    index: 0,
    data: gz.toString('base64'),
  });
  return { uploadId, chunks: 1, bytes: gz.length };
}

function whenStarted(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-ra-host-')));
  runsRoot = path.join(root, 'host');
  clock = 1_000;
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});

function sessionRoot(controller: string, sessionId: string): string {
  const controllerDir = createHash('sha256').update(controller).digest('hex').slice(0, 16);
  return path.join(runsRoot, 'workspaces', controllerDir, hostSessionIdFor(controller, sessionId));
}

describe('hosted shadow workspace cleanup', () => {
  it('authorizes policy updates before persistence and waits for native confirmation', async () => {
    let allowed = false;
    let confirm!: () => void;
    const fastPolicy = vi.fn(async (_origin: string, command: { revision: number; allowFast: boolean }) => {
      await new Promise<void>(resolve => { confirm = resolve; });
      return { revision: command.revision, allowFast: command.allowFast };
    });
    const host = createRemoteAgentHost({ isAgentAvailable: () => true, startHosted: async input => idleHandle(input),
      isControllerAuthorized: () => allowed, captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot, fastPolicy });
    try {
      const command = { op: 'fast-policy', group: 'openai', revision: 2, allowFast: false };
      await expect(host.handle('controller-1', command)).rejects.toThrow();
      expect(fastPolicy).not.toHaveBeenCalled();
      allowed = true;
      expect(await host.handle('controller-1', { op: 'caps' })).toHaveProperty('subscriptionFastPolicy', true);
      let acknowledged = false;
      const pending = host.handle('controller-1', command).then(value => { acknowledged = true; return value; });
      await vi.waitFor(() => expect(fastPolicy).toHaveBeenCalledOnce());
      expect(acknowledged).toBe(false);
      confirm();
      await expect(pending).resolves.toEqual({ revision: 2, allowFast: false });
      expect(fastPolicy).toHaveBeenCalledWith('controller-1', expect.objectContaining({ group: 'openai', revision: 2, allowFast: false }));
    } finally { host.dispose(); }
  });
  it.each(['dispose', 'sweep'] as const)('waits for %s shadow deletion and shares disposal completion', async entry => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const starts: Array<() => void> = [];
    const first = whenStarted();
    starts.push(first.resolve);
    const host = makeHost(starts);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, openPayload('task-1')) });
    await first.promise;
    expect(fs.existsSync(sessionRoot('controller-1', 'task-1'))).toBe(true);

    // #7976: disposal returned before recursive deletion finished. Waiting for
    // the native deletion boundary must work even when the filesystem is slow.
    const deleting = whenStarted();
    const releaseDelete = whenStarted();
    const deleted = whenStarted();
    const realRm = fs.promises.rm.bind(fs.promises);
    const workspace = sessionRoot('controller-1', 'task-1');
    const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      if (String(target) === workspace) {
        deleting.resolve();
        await releaseDelete.promise;
      }
      try { return await realRm(target, options); }
      finally { if (String(target) === workspace) deleted.resolve(); }
    });
    if (entry === 'sweep') {
      await settle();
      clock += 61_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await deleting.promise;
    }
    let completed = false;
    const disposal = host.dispose();
    const completion = Promise.resolve(disposal).then(() => { completed = true; });
    try {
      expect(host.dispose()).toBe(disposal);
      await deleting.promise;
      expect(completed).toBe(false);
      releaseDelete.resolve();
      await completion;
      expect(fs.existsSync(workspace)).toBe(false);
    } finally {
      releaseDelete.resolve();
      await completion;
      await deleted.promise;
      rm.mockRestore();
    }
  });

  // #7991 review: close/revocation can already be finishing when dispose starts.
  // Unit: real close dispatch must retain the workspace until native teardown,
  // preserve the first mode/reason, and coalesce a reentrant revocation request.
  it.each(['close', 'detach'] as const)('waits for an in-flight %s before deleting the workspace', async mode => {
    const ready = whenStarted();
    const closing = whenStarted();
    const releaseClose = whenStarted();
    const endEvents = whenStarted();
    const eventsEnded = whenStarted();
    let reentrant: Promise<void> | undefined;
    const stop = vi.fn(async () => {
      reentrant = host.abortControllers(() => true);
      endEvents.resolve();
      await eventsEnded.promise;
      closing.resolve();
      await releaseClose.promise;
    });
    const close = vi.fn(stop);
    const detach = vi.fn(stop);
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: async input => ({
        ...idleHandle(input), close, detach,
        events: () => ({ async *[Symbol.asyncIterator]() {
          ready.resolve();
          try {
            await endEvents.promise;
            yield { type: 'done' as const, data: {}, source: 'claude-code' as const };
          } finally { eventsEnded.resolve(); }
        } }),
      }),
      isControllerAuthorized: () => true, captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot,
    });
    let request: Promise<unknown> | undefined;
    let duplicate: Promise<unknown> | undefined;
    let disposal: Promise<void> | undefined;
    try {
      await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: { json: openPayload('task-1') } });
      await ready.promise;
      const initial = await host.handle('controller-1', { op: 'poll', runs: [{ runId: RUN_1, cursor: 0 }], waitMs: 0 }) as { runs: Array<{ cursor: number }> };
      const boundary = host.handle('controller-1', { op: 'poll', runs: [{ runId: RUN_1, cursor: initial.runs[0].cursor }], waitMs: 10_000 });
      request = host.handle('controller-1', { op: 'close', runId: RUN_1, mode, reason: 'navigation' });
      await closing.promise;
      let duplicateFinished = false;
      duplicate = host.handle('controller-1', { op: 'close', runId: RUN_1, mode: 'close', reason: 'app-quit' }).then(() => { duplicateFinished = true; });
      let disposed = false;
      disposal = host.dispose().then(() => { disposed = true; });
      await settle();
      expect(disposed).toBe(false);
      expect(duplicateFinished).toBe(false);
      expect(fs.existsSync(sessionRoot('controller-1', 'task-1'))).toBe(true);
      releaseClose.resolve();
      await Promise.all([request, duplicate, reentrant, disposal]);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(mode === 'detach' ? detach : close).toHaveBeenCalledWith({ reason: 'navigation' });
      expect(mode === 'detach' ? close : detach).not.toHaveBeenCalled();
      const result = await boundary as { runs: Array<{ data?: string }> };
      const rows = result.runs.flatMap(run => run.data ? Buffer.from(run.data, 'base64').toString().trim().split('\n').map(line => JSON.parse(line)) : []);
      expect(rows.at(-1)).toEqual({ t: 'closed', reason: mode === 'detach' ? 'detached' : 'closed' });
      expect(fs.existsSync(sessionRoot('controller-1', 'task-1'))).toBe(false);
    } finally {
      endEvents.resolve();
      releaseClose.resolve();
      await Promise.all([request, duplicate, reentrant, disposal, host.dispose()]);
    }
  });

  it('keeps the workspace of a replacement run and removes it when that run ends', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const starts: Array<() => void> = [];
    const first = whenStarted();
    const second = whenStarted();
    starts.push(first.resolve, second.resolve);
    const host = makeHost(starts);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, openPayload('task-1', [{ path: 'CLAUDE.md', data: Buffer.from('v1').toString('base64') }])) });
    await first.promise;
    // 同一任务重新打开：旧实例让位给新实例，目录按新内容重建。
    await host.handle('controller-1', { op: 'open', runId: RUN_2, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_2, openPayload('task-1', [{ path: 'CLAUDE.md', data: Buffer.from('v2').toString('base64') }])) });
    await second.promise;
    const sessionRootPath = sessionRoot('controller-1', 'task-1');
    expect(fs.readFileSync(path.join(sessionRootPath, 'fs', 'Users', 'me', 'proj', 'CLAUDE.md'), 'utf8')).toBe('v2');

    // 旧实例收尾保留期到点后被清理：替换实例还在用，目录必须保留。
    clock += 61_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    expect(fs.existsSync(sessionRootPath)).toBe(true);
    expect(fs.readFileSync(path.join(sessionRootPath, 'fs', 'Users', 'me', 'proj', 'CLAUDE.md'), 'utf8')).toBe('v2');

    // 替换实例也结束后，目录随之删除。
    await host.handle('controller-1', { op: 'close', runId: RUN_2, mode: 'close', reason: 'navigation' });
    clock += 61_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await settle();
    await vi.waitFor(() => expect(fs.existsSync(sessionRootPath)).toBe(false));
    host.dispose();
  });
});

describe('duplicate op payloads', () => {
  it('discards the staged upload of a duplicate open instead of leaving it until expiry', async () => {
    const starts: Array<() => void> = [];
    const first = whenStarted();
    starts.push(first.resolve);
    const host = makeHost(starts);
    const payload = openPayload('task-1');
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: await stageUpload(host, UPLOAD_1, payload) });
    await first.promise;

    // 同一 runId 重发 open(歧义交付后的重试)：按 id 去重，但载荷要取走。
    const ref2 = await stageUpload(host, UPLOAD_2, payload);
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: 'claude-code', payload: ref2 });
    await expect(host.handle('controller-1', { op: 'open', runId: RUN_2, agentKind: 'claude-code', payload: ref2 }))
      .rejects.toThrow(/upload is missing or expired/);
    host.dispose();
  });
});

/*
 * 测试价值
 * - 生产入口与可观察结果：createRemoteAgentHost 的 handle(open / call / poll / caps)与巡检；控制端读到的事件流收尾行与
 *   caps 声明的闲置收回时长。
 * - Bug／规则依据：provider-sharing.md §3「闲置收回由提供方决定」；闲着的任务一直被拉取，原来的「控制端离开」回收永远不触发。
 * - 现有覆盖缺口：上面只覆盖收尾清理；没有用例证明忙的任务不被收回、闲置满时长才收回、收尾行让旧控制端静默收起。
 * - 最小失败输入：设置 1 分钟；回合在跑 / 后台任务 / 待唤醒续跑 / 控制端报 hold / 回退后下一轮没跑完时各推进 2 分钟。
 * - tier：unit，假时钟 + 假 setInterval，Agent 是内存假句柄。
 */
describe('idle reclaim by the provider', () => {
  interface Busy { turn: boolean; background: number; wake: number }

  function busyHandle(input: HostedStartInput, busy: Busy) {
    const queued: AgentEvent[] = [];
    let wake: (() => void) | null = null;
    const handle: AgentSessionHandle & { emit(event: AgentEvent): void } = {
      ...idleHandle(input),
      isTurnRunning: () => busy.turn,
      listBackgroundTasks: () => Array.from({ length: busy.background }, (_, index) => ({ taskId: `bg-${index}` }) as never),
      countPendingWakeContinuations: () => busy.wake,
      commitRewindFiles: async () => ({ ok: true }) as never,
      events: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queued.length) { yield queued.shift()!; continue; }
            await new Promise<void>((resolve) => { wake = resolve; });
          }
        },
      }),
      emit(event) { queued.push(event); wake?.(); wake = null; },
    };
    return handle;
  }

  async function openBusy(minutes: number, busy: Busy, kind: 'claude-code' | 'codex' | 'pi' = 'claude-code') {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let handle!: ReturnType<typeof busyHandle>;
    const started = whenStarted();
    const host = createRemoteAgentHost({
      readLimits: () => ({ perDevice: 16, total: 64, idleMinutes: minutes }),
      isAgentAvailable: () => true,
      startHosted: async (input) => { handle = busyHandle(input, busy); started.resolve(); return handle; },
      isControllerAuthorized: () => true, captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot,
      now: () => clock,
    });
    await host.handle('controller-1', { op: 'open', runId: RUN_1, agentKind: kind, payload: { json: openPayload('task-1') } });
    await started.promise;
    await settle();
    let cursor = 0;
    const rows: Array<Record<string, unknown>> = [];
    /** 控制端照常拉取(闲着的任务也一直在拉)，推进时钟并跑一轮巡检。 */
    const pass = async (ms: number, hold = false) => {
      clock += ms;
      const result = await host.handle('controller-1', {
        op: 'poll', runs: [{ runId: RUN_1, cursor, ...(hold ? { hold: true } : {}) }], waitMs: 0,
      }) as { runs: Array<{ cursor: number; data?: string }> };
      const entry = result.runs[0];
      if (entry) {
        cursor = entry.cursor;
        if (entry.data) rows.push(...Buffer.from(entry.data, 'base64').toString().trim().split('\n').map((line) => JSON.parse(line)));
      }
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
    };
    return { host, handle: () => handle, pass, rows, cursor: () => cursor };
  }

  // Unit regression: app shutdown used to mark even idle runs aborted. Read the
  // real shutdown stream, including the reason an older controller will see.
  it.each([
    ['dispose', false], ['dispose', true], ['shutdown', false], ['shutdown', true],
    ['shutdown-then-dispose', false], ['shutdown-then-dispose', true],
  ] as const)('publishes a compatible shutdown boundary through %s; running=%s', async (entry, running) => {
    const { host, pass, cursor } = await openBusy(0, { turn: running, background: 0, wake: 0 });
    await pass(0);
    const pending = host.handle('controller-1', { op: 'poll', runs: [{ runId: RUN_1, cursor: cursor() }], waitMs: 10_000 });
    const closing = entry === 'dispose' ? undefined : host.abortAll('app-quit');
    if (entry !== 'shutdown') host.dispose();
    await closing;
    const result = await pending as { runs: Array<{ data?: string }> };
    const rows = result.runs.flatMap(run => run.data ? Buffer.from(run.data, 'base64').toString().trim().split('\n').map(line => JSON.parse(line)) : []);
    expect(rows.at(-1)).toEqual(running
      ? { t: 'closed', reason: 'provider-restarting' }
      : { t: 'closed', reason: 'ended', idleReclaimed: true });
    host.dispose();
    await settle();
  });

  // An explicit disconnect can race the later host dispose; it must never acquire
  // idleReclaimed, otherwise the controller would reconnect despite user intent.
  it.each([false, true])('keeps intentional disconnect terminal across disposal; running=%s', async running => {
    const { host, pass, cursor } = await openBusy(0, { turn: running, background: 0, wake: 0 });
    await pass(0);
    const pending = host.handle('controller-1', { op: 'poll', runs: [{ runId: RUN_1, cursor: cursor() }], waitMs: 10_000 });
    const closing = host.abortAll('navigation');
    host.dispose();
    await closing;
    const result = await pending as { runs: Array<{ data?: string }> };
    const rows = result.runs.flatMap(run => run.data ? Buffer.from(run.data, 'base64').toString().trim().split('\n').map(line => JSON.parse(line)) : []);
    expect(rows.at(-1)).toEqual({ t: 'closed', reason: 'controller-disconnected' });
    await settle();
  });

  it.each(['turn', 'background', 'wake', 'hold', 'rewind'] as const)('keeps a run while it is busy (%s) and reclaims it after a full idle period', async (reason) => {
    const busy: Busy = { turn: reason === 'turn', background: reason === 'background' ? 1 : 0, wake: reason === 'wake' ? 1 : 0 };
    const { host, handle, pass, rows } = await openBusy(1, busy);
    try {
      if (reason === 'rewind') {
        await host.handle('controller-1', { op: 'call', runId: RUN_1, callId: RUN_2, method: 'commitRewindFiles', payload: { json: ['user-1', 'assistant-1'] } });
        await settle();
      }
      for (let i = 0; i < 3; i += 1) await pass(50_000, reason === 'hold');
      expect(host.runCount()).toBe(1);
      // 忙完之后从这一刻重新计时：再闲置不满 1 分钟不收回。
      busy.turn = false; busy.background = 0; busy.wake = 0;
      if (reason === 'rewind') {
        handle().emit({ type: 'done', data: {}, source: 'claude-code' } as AgentEvent);
        await settle();
      }
      await pass(50_000);
      expect(host.runCount()).toBe(1);
      await pass(20_000);
      await pass(0);
      expect(host.runCount()).toBe(0);
      // 旧控制端按 `ended` 静默收起；新控制端看 idleReclaimed。
      expect(rows.at(-1)).toEqual({ t: 'closed', reason: 'ended', idleReclaimed: true });
    } finally { host.dispose(); }
  });

  // 1000 个任务按批轮询时，同一任务可能超过 1 分钟才再次被拉取。hold 必须在控制端存活窗口内持续保护，
  // 后续 poll 明确不带 hold 时解除，不能把仍在本机执行的进程误当闲置收回。
  it('keeps a held run between poll batches and starts its idle period after the hold is cleared', async () => {
    const { host, pass, rows } = await openBusy(1, { turn: false, background: 0, wake: 0 });
    try {
      await pass(0, true);
      clock += 70_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(host.runCount()).toBe(1);
      await pass(0);
      await pass(50_000);
      expect(host.runCount()).toBe(1);
      await pass(20_000);
      await pass(0);
      expect(host.runCount()).toBe(0);
      expect(rows.at(-1)).toEqual({ t: 'closed', reason: 'ended', idleReclaimed: true });
    } finally { host.dispose(); }
  });

  // Unit regression: a Codex process starts just after this run's poll batch. Its push must protect the
  // first 70-second gap before another poll can report hold; a previously waiting poll must not clear it.
  // Real RunClient.push -> Host.handle entry points; the existing held-run test begins after the first hold.
  it.each([false, true])('keeps new local work before its first held poll (older poll waiting: %s)', async (waiting) => {
    const { host, handle, pass, rows, cursor } = await openBusy(1, { turn: false, background: 0, wake: 0 }, 'codex');
    let localBusy = true;
    const client = new RemoteAgentRunClient(RUN_1, new RemoteAgentPoller(args => host.handle('controller-1', args[0])), {
      onEvent() {}, onState() {}, onWs() {}, onClosed() {},
      onRequest: async () => ({ type: 'callback', value: undefined }),
      holdsRemote: () => localBusy,
    }, () => RUN_2);
    const abort = new AbortController();
    let previousPoll: Promise<unknown> | undefined;
    try {
      await pass(0);
      if (waiting) {
        let returned = false;
        previousPoll = host.handle('controller-1', {
          op: 'poll', runs: [{ runId: RUN_1, cursor: cursor() }], waitMs: 10_000,
        }, abort.signal).then(result => { returned = true; return result; });
        await settle();
        expect(returned).toBe(false);
      }
      await client.push([{ connId: 'exec-1', kind: 'message', data: '{"id":1,"result":{}}' }]);
      handle().emit({ type: 'done', data: {}, source: 'codex' } as AgentEvent);
      await previousPoll;
      await settle();
      clock += 70_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      expect(host.runCount()).toBe(1);
      localBusy = false;
      await pass(0);
      await pass(50_000);
      expect(host.runCount()).toBe(1);
      await pass(20_000);
      await pass(0);
      expect(host.runCount()).toBe(0);
      expect(rows.at(-1)).toEqual({ t: 'closed', reason: 'ended', idleReclaimed: true });
    } finally {
      abort.abort();
      await previousPoll?.catch(() => undefined);
      client.abandon('test-finished');
      host.dispose();
    }
  });

  // Codex / Pi 在 commitRewindFiles 返回前已经完成原生回退，不需要等待下一次发送保存。
  // 只有 Claude Code 的 pendingRewindTo 要保留进程；否则这两个引擎回退后再也不会被闲置收回。
  it.each(['codex', 'pi'] as const)('reclaims an idle %s run after its rewind has already completed', async kind => {
    const { host, pass } = await openBusy(1, { turn: false, background: 0, wake: 0 }, kind);
    try {
      await host.handle('controller-1', { op: 'call', runId: RUN_1, callId: RUN_2, method: 'commitRewindFiles', payload: { json: ['user-1', 'assistant-1'] } });
      await settle();
      await pass(50_000);
      expect(host.runCount()).toBe(1);
      await pass(20_000);
      await pass(0);
      expect(host.runCount()).toBe(0);
    } finally { host.dispose(); }
  });

  // poller 允许断链后重试 2 分钟：收回通知不能在普通收尾的 60 秒后被删掉，否则连回只读到 missing，
  // 使用方会关闭本应保留的本机部分。用 90 秒无 poll 复现，再确认恢复窗口结束后仍能清理。
  it('retains the idle reclaim notification across a recoverable disconnect and eventually removes it', async () => {
    const { host, pass, rows } = await openBusy(1, { turn: false, background: 0, wake: 0 });
    try {
      await pass(70_000);
      expect(host.runCount()).toBe(0);
      clock += 90_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      await pass(0);
      expect(rows.at(-1)).toEqual({ t: 'closed', reason: 'ended', idleReclaimed: true });
      clock += 200_000;
      await vi.advanceTimersByTimeAsync(5_000);
      await settle();
      const result = await host.handle('controller-1', {
        op: 'poll', runs: [{ runId: RUN_1, cursor: 0 }], waitMs: 0,
      });
      expect(result).toMatchObject({ runs: [{ runId: RUN_1, missing: true }] });
    } finally { host.dispose(); }
  });

  it('never reclaims with 0 minutes and declares the setting in caps', async () => {
    const { host, pass } = await openBusy(0, { turn: false, background: 0, wake: 0 });
    try {
      for (let i = 0; i < 4; i += 1) await pass(50_000);
      expect(host.runCount()).toBe(1);
      expect(await host.handle('controller-1', { op: 'caps' })).toMatchObject({ idleReclaimMinutes: 0 });
    } finally { host.dispose(); }
  });
});

// #6412: asynchronous source reads used to lose the final image when the native stream ended.
it.each([false, true])('drains image preparation and forwards the controller receipt capability (%s)', async (receipts) => {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const entered = whenStarted();
  const host = createRemoteAgentHost({
    isAgentAvailable: () => true, isControllerAuthorized: () => true,
    captureOwner: () => 'owner', isOwnerCurrent: () => true, runsRoot,
    startHosted: async (input) => ({ ...idleHandle(input), events: () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'image', source: 'codex', data: { kind: 'generation', blockId: 'native', path: '/linux/image.png' } } as AgentEvent;
        yield { type: 'done', source: 'codex', data: {} } as AgentEvent;
      },
    }) }),
    prepareImageEvent: async (_id, event, _upstream, retainForRecovery) => { expect(retainForRecovery).toBe(receipts); expect(event.data).toMatchObject({ deliveryEpoch: 321 }); entered.resolve(); await waiting; return { ...event, data: { kind: 'generation', blockId: 'native', url: 'data:image/png;base64,bytes' } }; },
  });
  try {
    await host.handle('controller', { op: 'open', runId: RUN_1, agentKind: 'codex', payload: { json: { ...openPayload('task-1'), imageDeliveryEpoch: 321, ...(receipts ? { acceptsImageDeliveryReceipts: true } : {}) } } });
    await entered.promise;
    await settle();
    let closeFinished = false;
    const closing = host.handle('controller', { op: 'close', runId: RUN_1, mode: 'close', reason: 'navigation' }).then(() => { closeFinished = true; });
    await settle();
    expect(closeFinished).toBe(false);
    release();
    await closing;
    await settle();
    const result = await host.handle('controller', { op: 'poll', runs: [{ runId: RUN_1, cursor: 0 }], waitMs: 0 }) as { runs: Array<{ data?: string; done?: boolean }> };
    const rows = Buffer.from(result.runs[0].data!, 'base64').toString().trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.filter((row) => row.t === 'event').map((row) => row.event.type)).toEqual(['image', 'done']);
    expect(rows.find((row) => row.t === 'event').event.data).not.toHaveProperty('path');
    expect(rows.at(-1)).toMatchObject({ t: 'closed' });
    expect(result.runs[0].done).toBe(true);
  } finally { release(); host.dispose(); }
});

it.each(['authorization', 'owner'])('scopes image recovery to the caller and rejects %s changes during a read', async (boundary) => {
  let allowed = true;
  let ownerCurrent = true;
  const imageArtifacts = vi.fn(async () => { if (boundary === 'owner') ownerCurrent = false; else allowed = false; return { images: [] }; });
  const host = createRemoteAgentHost({
    isAgentAvailable: () => true, startHosted: async (input) => idleHandle(input),
    isControllerAuthorized: () => allowed, captureOwner: () => 'owner', isOwnerCurrent: () => ownerCurrent,
    runsRoot, imageArtifacts,
  });
  try {
    await expect(host.handle('caller', { op: 'images', sessionId: RUN_1, action: 'list' })).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    expect(imageArtifacts.mock.calls[0]).toEqual([hostSessionIdFor('caller', RUN_1), { op: 'images', sessionId: RUN_1, action: 'list', offset: 0 }]);
    allowed = false;
    await expect(host.handle('other', { op: 'images', sessionId: RUN_1, action: 'list' })).rejects.toThrow('REMOTE_AGENT_UNAVAILABLE');
    expect(imageArtifacts).toHaveBeenCalledTimes(1);
  } finally { host.dispose(); }
});
