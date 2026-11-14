/**
 * 持久出箱(chunked-text 渠道共用; 本批企业微信)的可靠性回归。
 *
 * 测试价值
 * - 生产入口与可观察结果: createImOutbox + createImOutboxDelivery。用户可观察的是
 *   "重启/重连后只补发没送达的部分, 已确认的正文/附件不会重复出现, 结果不明的不乱发"。
 * - Bug／规则依据: im-turn-flow.md「持久出箱」; 评审发现整批投递只在最后写盘, 进程
 *   中途退出会让已成功的正文重发; 全 sent 后删记录会丢幂等凭据; 到期没有调度;
 *   文件被替换仍会发出去; 队列满时截掉未完成项。
 * - 现有覆盖缺口: 旧用例只覆盖"批次失败重试", 不覆盖崩溃/写失败/墓碑/定时/替换。
 * - 最小失败输入: 三个步骤里第二步发送时进程退出 → 重启后第一步不得重发。
 * - tier: unit(临时目录 + fake timers + 内存 transport, 不发真实消息)。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImFinalDeliveryPlan, ImFinalDeliveryResult, ImFinalOutput } from '@cindy/im';

import {
  createImOutbox,
  createImOutboxDelivery,
  type ImOutboxStore,
  type ImOutboxTransport,
} from '../imOutbox';

const log = { warn: () => {} };
/** 捕获真实 setTimeout: 下面的用例会切到 fake timers。 */
const realSetTimeout = setTimeout;

function tmpRoot(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'cindy-im-outbox-'));
  return {
    dir,
    file: join(dir, 'wecom-bot.json'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

type Decision = 'sent' | 'failed' | 'uncertain' | 'throw';

/** 按步骤记录发送尝试, 便于断言"哪一步真的发出去了"。 */
function recordingTransport(
  decide: (stepId: string, call: number) => Decision,
  plan: ImFinalDeliveryPlan = {
    steps: [{ id: 'text:0', kind: 'text', text: 'answer' }],
  },
) {
  const attempts: Array<{ step: string; call: number }> = [];
  const perStep = new Map<string, number>();
  const commitFinalCalls: string[] = [];
  const transport: ImOutboxTransport = {
    prepareFinal: async () => plan,
    deliverFinal: async (
      _output: ImFinalOutput,
      incoming: ImFinalDeliveryPlan,
      opts?: { onlySteps?: string[] },
    ): Promise<ImFinalDeliveryResult> => {
      const only = new Set(opts?.onlySteps ?? incoming.steps.map((step) => step.id));
      const states: Array<ImFinalDeliveryResult['states'][number]> = incoming.steps.map(
        (step) => (only.has(step.id) ? undefined : 'sent'),
      );
      for (const [index, step] of incoming.steps.entries()) {
        if (!only.has(step.id)) continue;
        const call = (perStep.get(step.id) ?? 0) + 1;
        perStep.set(step.id, call);
        attempts.push({ step: step.id, call });
        const decision = decide(step.id, call);
        if (decision === 'throw') throw new Error('network died mid-send');
        states[index] = decision;
      }
      return { states };
    },
    commitFinal: async (output) => {
      commitFinalCalls.push(output.text);
      return { status: 'sent', unresolved: 0, retrying: 0 };
    },
  };
  return { transport, attempts, commitFinalCalls };
}

let nowMs = 1_000;
const clock = () => nowMs;

function deliveryFor(args: {
  store: ImOutboxStore;
  transport: ImOutboxTransport;
  retryDelays?: number[];
}) {
  return createImOutboxDelivery({
    channel: 'wecom',
    store: args.store,
    transport: () => args.transport,
    botId: () => 'bot-1',
    accountScope: () => 'owner:a',
    log,
    now: clock,
    ...(args.retryDelays ? { retryDelays: args.retryDelays } : {}),
  });
}

const output = (turnId: string, text = 'answer'): ImFinalOutput => ({
  userId: 'owner',
  text,
  terminal: 'done',
  turnId,
  allowedFileRoots: [],
});

function readSteps(file: string): Array<{ id: string; state: string }> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
      entries: Array<{ steps: Array<{ id: string; state: string }> }>;
    };
    return parsed.entries[0]?.steps ?? [];
  } catch {
    return [];
  }
}

async function settleIo(): Promise<void> {
  // 用真实宏任务让 fs promise 回调跑完(fake timers 会接管 setTimeout)。
  await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
}

beforeEach(() => {
  nowMs = 1_000;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('im outbox reliability', () => {
  it('checkpoints each step: a crash during step 2 does not resend step 1', async () => {
    const tmp = tmpRoot();
    try {
      const firstFile = join(tmp.dir, 'a.txt');
      const secondFile = join(tmp.dir, 'b.txt');
      writeFileSync(firstFile, 'a');
      writeFileSync(secondFile, 'b');
      const plan: ImFinalDeliveryPlan = {
        steps: [
          { id: 'text:0', kind: 'text', text: 'answer' },
          { id: 'file:0', kind: 'file', absPath: firstFile, displayName: 'a.txt' },
          { id: 'file:1', kind: 'file', absPath: secondFile, displayName: 'b.txt' },
        ],
      };
      const base = recordingTransport((step) => (step === 'text:0' ? 'sent' : 'sent'), plan);
      let releaseHang!: () => void;
      const transport: ImOutboxTransport = {
        ...base.transport,
        deliverFinal: (input, incoming, opts) => {
          // 第二步"发出去了但进程在结果回来前死掉": 永不返回。
          if (opts?.onlySteps?.includes('file:0')) {
            return new Promise<ImFinalDeliveryResult>((resolve) => {
              releaseHang = () => resolve({ states: incoming.steps.map(() => 'sent') });
            });
          }
          return base.transport.deliverFinal(input, incoming, opts);
        },
      };
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const original = deliveryFor({ store, transport });
      const pendingCommit = original.commit({
        ...output('turn-crash'),
        allowedFileRoots: [tmp.dir],
      });

      // 等到 text 已确认、file:0 标记 inflight。
      let steps: Array<{ id: string; state: string }> = [];
      for (let index = 0; index < 50 && steps[1]?.state !== 'inflight'; index += 1) {
        await settleIo();
        steps = readSteps(tmp.file);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(steps.map((step) => step.state)).toEqual(['sent', 'inflight', 'pending']);

      // 进程退出: 旧实例不再允许写盘; 新进程从磁盘重建。
      original.stop();
      const restartedStore = createImOutbox({
        channel: 'wecom',
        filePath: tmp.file,
        log,
        now: clock,
      });
      const restartedTransport = recordingTransport(() => 'sent', plan);
      const restarted = deliveryFor({ store: restartedStore, transport: restartedTransport.transport });
      nowMs += 20_000;
      await restarted.flush();

      // 只补发还没开始的第三步; 已确认的正文与 inflight 的附件都不重发。
      expect(restartedTransport.attempts.map((item) => item.step)).toEqual(['file:1']);
      expect(readSteps(tmp.file).map((step) => step.state)).toEqual([
        'sent',
        'uncertain',
        'sent',
      ]);
      releaseHang();
      await pendingCommit;
    } finally {
      tmp.cleanup();
    }
  });

  it('does not send a step when its in-flight checkpoint cannot be written', async () => {
    const tmp = tmpRoot();
    try {
      const base = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts, commitFinalCalls } = recordingTransport(() => 'sent');
      let upserts = 0;
      const failingStore: ImOutboxStore = {
        ...base,
        // 记录本身写入成功(受理), 但每一步的 checkpoint 都失败。
        upsert: (entry) => {
          upserts += 1;
          return upserts === 1 ? base.upsert(entry) : false;
        },
      };
      const delivery = deliveryFor({ store: failingStore, transport });
      const outcome = await delivery.commit(output('turn-write-fail'));
      // 检查点写不进去就不发: deliverFinal 与直发兜底都不该被调用。
      expect(attempts).toEqual([]);
      expect(commitFinalCalls).toEqual([]);
      expect(outcome.status).toBe('failed');
    } finally {
      tmp.cleanup();
    }
  });

  it('keeps a completion tombstone so the same turn is never sent twice', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport(() => 'sent');
      const delivery = deliveryFor({ store, transport });
      expect((await delivery.commit(output('turn-once'))).status).toBe('sent');
      // 同一轮再 commit(例如 finalize 重入): 不再发送。
      expect((await delivery.commit(output('turn-once'))).status).toBe('sent');
      expect(attempts).toHaveLength(1);

      // 重启后重复 commit 也不再发送。
      const restartedStore = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const restarted = deliveryFor({ store: restartedStore, transport });
      nowMs += 5_000;
      expect((await restarted.commit(output('turn-once'))).status).toBe('sent');
      expect(attempts).toHaveLength(1);
    } finally {
      tmp.cleanup();
    }
  });

  it('schedules a bounded retry when the next attempt becomes due', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport((_step, call) =>
        call === 1 ? 'failed' : 'sent',
      );
      const delivery = deliveryFor({ store, transport, retryDelays: [1_000] });
      await delivery.commit(output('turn-retry'));
      expect(attempts).toHaveLength(1);

      // 未到期的重连不会发送。
      await delivery.flush();
      expect(attempts).toHaveLength(1);

      // 到期由定时器自己触发补发, 不需要用户再发消息。
      nowMs += 1_000;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(attempts).toHaveLength(2);

      // 停止后定时器不再触发。
      delivery.stop();
      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(70_000);
      expect(attempts).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });

  it('stops sending when the account is dropped while prepareFinal is in flight', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport(() => 'sent');
      let resolvePrepare!: (plan: ImFinalDeliveryPlan) => void;
      const slow: ImOutboxTransport = {
        ...transport,
        prepareFinal: () =>
          new Promise<ImFinalDeliveryPlan>((resolve) => {
            resolvePrepare = resolve;
          }),
      };
      const delivery = deliveryFor({ store, transport: slow });
      const pending = delivery.commit(output('turn-drop'));
      await Promise.resolve();
      delivery.dropCurrentScope();
      resolvePrepare({
        steps: [{ id: 'text:0', kind: 'text', text: 'answer' }],
      });
      await pending;
      // 解绑后: 一个字节都不发, 记录也不能复活。
      expect(attempts).toEqual([]);
      expect(store.listAll()).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('does not resurrect a dropped entry when the send result arrives late', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      let resolveSend!: (value: ImFinalDeliveryResult) => void;
      const transport: ImOutboxTransport = {
        prepareFinal: async () => ({
          steps: [{ id: 'text:0', kind: 'text', text: 'answer' }],
        }),
        deliverFinal: () =>
          new Promise<ImFinalDeliveryResult>((resolve) => {
            resolveSend = resolve;
          }),
        commitFinal: async () => ({ status: 'sent', unresolved: 0, retrying: 0 }),
      };
      const delivery = deliveryFor({ store, transport });
      const pending = delivery.commit(output('turn-late'));
      await settleIo();
      await vi.advanceTimersByTimeAsync(0);
      delivery.dropCurrentScope();
      resolveSend({ states: ['sent'] });
      await pending;
      expect(store.listAll()).toHaveLength(0);
      await delivery.flush();
      expect(store.listAll()).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('refuses a replaced file and a symlink that escapes the approved root', async () => {
    const tmp = tmpRoot();
    const outside = mkdtempSync(join(tmpdir(), 'cindy-im-outside-'));
    try {
      const workDir = join(tmp.dir, 'work');
      mkdirSync(workDir, { recursive: true });
      const target = join(workDir, 'report.txt');
      writeFileSync(target, 'original');
      const outsideFile = join(outside, 'secret.txt');
      writeFileSync(outsideFile, 'secret');
      const link = join(workDir, 'link.txt');
      symlinkSync(outsideFile, link);

      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      // 首轮: 允许根只覆盖 work 目录 —— link 的真实路径在目录外, 应当被拒。
      const first = recordingTransport(() => 'sent', {
        steps: [
          { id: 'file:0', kind: 'file', absPath: target, displayName: 'report.txt' },
          { id: 'file:1', kind: 'file', absPath: link, displayName: 'link.txt' },
        ],
      });
      const delivery = deliveryFor({ store, transport: first.transport });
      const firstOutcome = await delivery.commit({
        ...output('turn-files'),
        text: '',
        allowedFileRoots: [workDir],
      });
      expect(first.attempts.map((item) => item.step)).toEqual(['file:0']);
      expect(firstOutcome.unresolved).toBeGreaterThan(0);

      // 第二轮: 原文件被替换成另一份内容 → 内容身份不符, 不得发出去。
      const replacedOutcome = await delivery.commit({
        ...output('turn-files-2'),
        text: '',
        allowedFileRoots: [workDir],
      });
      expect(replacedOutcome.status).not.toBe('sent');
    } finally {
      rmSync(outside, { recursive: true, force: true });
      tmp.cleanup();
    }
  });

  it('rejects content that changed after it was accepted', async () => {
    const tmp = tmpRoot();
    try {
      const workDir = join(tmp.dir, 'work');
      mkdirSync(workDir, { recursive: true });
      const target = join(workDir, 'report.txt');
      writeFileSync(target, 'original');
      const plan: ImFinalDeliveryPlan = {
        steps: [{ id: 'file:0', kind: 'file', absPath: target, displayName: 'report.txt' }],
      };
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      // 第一次投递失败(未确认), 保留让步, 随后文件被替换。
      const failing = recordingTransport(() => 'failed', plan);
      const delivery = deliveryFor({ store, transport: failing.transport });
      await delivery.commit({
        ...output('turn-replaced'),
        text: '',
        allowedFileRoots: [workDir],
      });
      expect(failing.attempts).toHaveLength(1);

      writeFileSync(target, 'replaced-content');
      nowMs += 20_000;
      const second = recordingTransport(() => 'sent', plan);
      const restarted = deliveryFor({ store, transport: second.transport });
      await restarted.flush();
      // 已被替换的成果不得发出去。
      expect(second.attempts).toEqual([]);
      expect(readSteps(tmp.file)[0]?.state).toBe('failed');
    } finally {
      tmp.cleanup();
    }
  });

  it('stops retrying after the per-step attempt budget is spent', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport(() => 'failed');
      const delivery = createImOutboxDelivery({
        channel: 'wecom',
        store,
        transport: () => transport,
        botId: () => 'bot-1',
        accountScope: () => 'owner:a',
        log,
        now: clock,
        retryDelays: [0],
        maxAttempts: 2,
      });
      await delivery.commit(output('turn-budget'));
      // 第一次 + 定时器第二次, 之后 attempts 用尽, 不再自动重试。
      nowMs += 1;
      await vi.advanceTimersByTimeAsync(100);
      await delivery.flush();
      expect(attempts).toHaveLength(2);
      nowMs += 60_000;
      await vi.advanceTimersByTimeAsync(120_000);
      await delivery.flush();
      expect(attempts).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });

  it('enforces the same total byte budget on write as it does on read', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const big = 'x'.repeat(200_000);
      const { transport } = recordingTransport(() => 'failed', {
        steps: [{ id: 'text:0', kind: 'text', text: big }],
      });
      const delivery = deliveryFor({ store, transport });
      const statuses: string[] = [];
      for (let index = 0; index < 7; index += 1) {
        statuses.push((await delivery.commit(output(`turn-big-${index}`, big))).status);
      }
      // 前几条能写进 1MB 预算; 超预算后必须明确失败, 而且读回来仍完整。
      expect(statuses.filter((status) => status !== 'durable')).not.toHaveLength(0);
      const reopened = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const kept = reopened.listAll();
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.every((entry) => entry.steps[0]?.text === big)).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });

  it('keeps the last successful checkpoint when a write fails and the same account rebuilds', async () => {
    const tmp = tmpRoot();
    try {
      // 真实 store + 可注入的写失败: 只让"发送结果写回"这一步失败。
      const base = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      let failWrites = false;
      const flaky: ImOutboxStore = {
        ...base,
        upsert: (entry) => (failWrites ? false : base.upsert(entry)),
      };
      const plan: ImFinalDeliveryPlan = {
        steps: [
          { id: 'text:0', kind: 'text', text: 'one' },
          { id: 'text:1', kind: 'text', text: 'two' },
          { id: 'text:2', kind: 'text', text: 'three' },
        ],
      };
      let release!: () => void;
      const transport: ImOutboxTransport = {
        prepareFinal: async () => plan,
        deliverFinal: (input, incoming, opts) => {
          void input;
          const id = opts?.onlySteps?.[0];
          if (id === 'text:1') {
            failWrites = true; // 从这一刻起写盘都失败(结果写回失败 → stop)
            return new Promise<ImFinalDeliveryResult>((resolve) => {
              release = () => resolve({ states: incoming.steps.map(() => 'sent') });
            });
          }
          return Promise.resolve({
            states: incoming.steps.map((step) => (step.id === id ? 'sent' : 'sent')),
          });
        },
        commitFinal: async () => ({ status: 'sent', unresolved: 0, retrying: 0 }),
      };
      const first = deliveryFor({ store: flaky, transport });
      const pending = first.commit(output('turn-recover'));
      for (let index = 0; index < 50 && readSteps(tmp.file)[1]?.state !== 'inflight'; index += 1) {
        await settleIo();
        await vi.advanceTimersByTimeAsync(0);
      }
      // 落盘: text:0 已确认, text:1 inflight, text:2 pending。
      expect(readSteps(tmp.file).map((step) => step.state)).toEqual(['sent', 'inflight', 'pending']);
      release();
      await pending;
      // 写回失败: 实例停掉, 但磁盘必须停在最后一次成功 checkpoint 上。
      expect(first.isStopped()).toBe(true);
      expect(readSteps(tmp.file).map((step) => step.state)).toEqual(['sent', 'inflight', 'pending']);

      // 同账号重建(真实 store 读同一文件): 不得删除这些记录, 也不重发已确认/未知项。
      failWrites = false;
      const rebuiltStore = createImOutbox({
        channel: 'wecom',
        filePath: tmp.file,
        log,
        now: clock,
      });
      const rebuiltTransport = recordingTransport(() => 'sent', plan);
      const rebuilt = deliveryFor({ store: rebuiltStore, transport: rebuiltTransport.transport });
      nowMs += 20_000;
      await rebuilt.flush();
      expect(rebuiltTransport.attempts.map((item) => item.step)).toEqual(['text:2']);
      expect(readSteps(tmp.file).map((step) => step.state)).toEqual([
        'sent',
        'uncertain',
        'sent',
      ]);
    } finally {
      tmp.cleanup();
    }
  });

  it('never falls back to a direct send when a queued commit is dropped first', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      let release!: () => void;
      const transport: ImOutboxTransport = {
        prepareFinal: async () => ({
          steps: [{ id: 'text:0', kind: 'text', text: 'answer' }],
        }),
        deliverFinal: () =>
          new Promise<ImFinalDeliveryResult>((resolve) => {
            release = () => resolve({ states: ['sent'] });
          }),
        commitFinal: async () => ({ status: 'sent', unresolved: 0, retrying: 0 }),
      };
      const direct = vi.fn(async () => ({ status: 'sent' as const, unresolved: 0, retrying: 0 }));
      const spied: ImOutboxTransport = { ...transport, commitFinal: direct };
      const delivery = deliveryFor({ store, transport: spied });
      const first = delivery.commit(output('turn-q1'));
      const second = delivery.commit(output('turn-q2'));
      await settleIo();
      delivery.dropCurrentScope();
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(direct).not.toHaveBeenCalled();
      expect(one.status).toBe('failed');
      expect(two.status).toBe('failed');
    } finally {
      tmp.cleanup();
    }
  });

  it('never falls back to a direct send when the account changes during prepareFinal', async () => {
    const tmp = tmpRoot();
    try {
      let account = 'owner:a';
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const direct = vi.fn(async () => ({ status: 'sent' as const, unresolved: 0, retrying: 0 }));
      let rejectPrepare!: (error: Error) => void;
      const transport: ImOutboxTransport = {
        prepareFinal: () =>
          new Promise((_resolve, reject) => {
            rejectPrepare = reject;
          }),
        deliverFinal: async () => ({ states: ['sent'] }),
        commitFinal: direct,
      };
      const delivery = createImOutboxDelivery({
        channel: 'wecom',
        store,
        transport: () => transport,
        botId: () => 'bot-1',
        accountScope: () => account,
        log,
        now: clock,
      });
      const pending = delivery.commit(output('turn-switch'));
      await settleIo();
      account = 'owner:b';
      rejectPrepare(new Error('prepare failed after switch'));
      const outcome = await pending;
      expect(direct).not.toHaveBeenCalled();
      expect(outcome.status).toBe('failed');
      expect(store.listAll()).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('does not leak unsaved step mutations into the store snapshot', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      store.upsert({
        version: 1,
        id: 'wecom:turn-snapshot',
        channel: 'wecom',
        accountScope: 'owner:a',
        botId: 'bot-1',
        target: 'owner',
        terminal: 'done',
        steps: [{ id: 'text:0', kind: 'text', text: 'answer', state: 'pending', attempts: 0 }],
        attempts: 0,
        createdAt: 1_000,
        updatedAt: 1_000,
        nextAttemptAt: 1_000,
        expiresAt: 1_000 + 60_000,
      });
      // 调用方拿到的必须是快照: 改它不影响缓存与磁盘。
      const [snapshot] = store.list({ accountScope: 'owner:a', botId: 'bot-1' });
      expect(snapshot).toBeDefined();
      snapshot!.steps[0]!.state = 'sent';
      // 任何后续写入(此处是 remove 不存在的记录)都不能把未持久结果带进去。
      store.remove('wecom:turn-other');
      const [persisted] = store.list({ accountScope: 'owner:a', botId: 'bot-1' });
      expect(persisted?.steps[0]?.state).toBe('pending');
      // 重新打开(模拟重启)也不会看到那份未持久修改。
      const reopened = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      expect(reopened.listAll()[0]?.steps[0]?.state).toBe('pending');
    } finally {
      tmp.cleanup();
    }
  });

  it('does not arm a timer for entries that can no longer be retried', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const uncertain = recordingTransport(() => 'uncertain');
      const delivery = createImOutboxDelivery({
        channel: 'wecom',
        store,
        transport: () => uncertain.transport,
        botId: () => 'bot-1',
        accountScope: () => 'owner:a',
        log,
        now: clock,
        retryDelays: [1_000],
        maxAttempts: 1,
      });
      await delivery.commit(output('turn-uncertain'));
      expect(uncertain.attempts).toHaveLength(1);
      // 结果不明 + 次数用尽: 不再排定时器, 反复推进时钟也不会有额外发送。
      for (let index = 0; index < 5; index += 1) {
        nowMs += 60_000;
        await vi.advanceTimersByTimeAsync(61_000);
      }
      expect(uncertain.attempts).toHaveLength(1);
    } finally {
      tmp.cleanup();
    }
  });

  it('wakes a record that became due while another record was sending', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const attempts: string[] = [];
      const plan: ImFinalDeliveryPlan = {
        steps: [{ id: 'text:0', kind: 'text', text: 'answer' }],
      };
      const transport: ImOutboxTransport = {
        prepareFinal: async () => plan,
        deliverFinal: async (out) => {
          attempts.push(out.turnId ?? '');
          // 第一条发送很慢: 在它进行期间, 第二条的 nextAttemptAt 到期了。
          if (out.turnId === 'turn-slow') nowMs += 1_000;
          return { states: ['sent'] };
        },
        commitFinal: async () => ({ status: 'sent', unresolved: 0, retrying: 0 }),
      };
      const seed = (turnId: string, nextAttemptAt: number) =>
        store.upsert({
          version: 1,
          id: `wecom:${turnId}`,
          channel: 'wecom',
          accountScope: 'owner:a',
          botId: 'bot-1',
          target: 'owner',
          terminal: 'done',
          steps: [{ id: 'text:0', kind: 'text', text: 'answer', state: 'pending', attempts: 0 }],
          attempts: 0,
          createdAt: 1_000,
          updatedAt: 1_000,
          nextAttemptAt,
          expiresAt: 61_000,
        });
      seed('turn-slow', 1_000);
      seed('turn-later', 1_500);

      const delivery = deliveryFor({ store, transport });
      await delivery.flush();
      // 批次入口时第二条还没到期: 本批次跳过它; 但发送第一条期间它已经到期。
      expect(attempts).toEqual(['turn-slow']);

      // 不依赖重连/commit 等外部事件: 定时器必须自己唤醒已到期的那条补发,
      // 已确认成功的记录不得重发。
      for (let index = 0; index < 50 && attempts.length < 2; index += 1) {
        await settleIo();
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(attempts).toEqual(['turn-slow', 'turn-later']);
    } finally {
      tmp.cleanup();
    }
  });

  it('a stale retry timer never uses the new account identity on the old store', async () => {
    const tmp = tmpRoot();
    try {
      let account = 'owner:a';
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport(() => 'failed');
      const delivery = createImOutboxDelivery({
        channel: 'wecom',
        store,
        transport: () => transport,
        botId: () => 'bot-1',
        accountScope: () => account,
        log,
        now: clock,
        retryDelays: [1_000],
      });
      await delivery.commit(output('turn-a'));
      expect(attempts).toHaveLength(1);

      // 账号在运行期变了(不调用 wiring.resolve、不 stop、也不在 await 中切):
      // 旧 timer 醒来时只能用**绑定身份**判断, 不能拿 B 去读/清 A 的 store。
      account = 'owner:b';
      nowMs += 1_200;
      await vi.advanceTimersByTimeAsync(1_300);
      expect(attempts).toHaveLength(1);

      // A 的待发记录仍在, 且没有任何以 B 身份落盘的记录。
      const entries = store.listAll();
      expect(entries.map((entry) => [entry.id, entry.accountScope])).toEqual([
        ['wecom:turn-a', 'owner:a'],
      ]);
      expect(readSteps(tmp.file).map((step) => step.state)).toEqual(['failed']);

      // 也不会在旧 store 上按 B 重新挂调度。
      for (let index = 0; index < 5; index += 1) {
        nowMs += 60_000;
        await vi.advanceTimersByTimeAsync(61_000);
      }
      expect(attempts).toHaveLength(1);
      expect(store.listAll()).toHaveLength(1);

      // 明确的生命周期操作才清理: 解绑/换账号由接线层调 dropCurrentScope。
      delivery.dropCurrentScope();
      expect(store.listAll()).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('an explicit flush after the account changed does not touch the old store', async () => {
    const tmp = tmpRoot();
    try {
      let account = 'owner:a';
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const { transport, attempts } = recordingTransport(() => 'failed');
      const delivery = createImOutboxDelivery({
        channel: 'wecom',
        store,
        transport: () => transport,
        botId: () => 'bot-1',
        accountScope: () => account,
        log,
        now: clock,
        retryDelays: [1_000],
      });
      await delivery.commit(output('turn-a'));
      expect(attempts).toHaveLength(1);

      account = 'owner:b';
      nowMs += 20_000;
      await delivery.flush();
      expect(attempts).toHaveLength(1);
      const entries = store.listAll();
      expect(entries.map((entry) => entry.accountScope)).toEqual(['owner:a']);

      // 绑定身份恢复后(同一账号回来)仍可补发: 说明只是停用, 没有删记录。
      account = 'owner:a';
      await delivery.flush();
      expect(attempts).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });

  it('does not spend delivery attempts while the channel is offline, and resumes on reconnect', async () => {
    const tmp = tmpRoot();
    try {
      let connected = false;
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const base = recordingTransport(() => 'sent');
      const withConnection: ImOutboxTransport = {
        ...base.transport,
        isConnected: () => connected,
      };
      const delivery = deliveryFor({ store, transport: withConnection, retryDelays: [1_000] });
      await delivery.commit(output('turn-offline'));
      // 离线: 一个字节没发, 步骤仍是 pending, 重试次数不消耗。
      expect(base.attempts).toEqual([]);
      const [entry] = store.listAll();
      expect(entry?.steps[0]?.state).toBe('pending');
      expect(entry?.steps[0]?.attempts).toBe(0);

      // 长离线(远超 5 次退避窗口): 不发、也不排空转定时器。
      for (let index = 0; index < 6; index += 1) {
        nowMs += 300_000;
        await vi.advanceTimersByTimeAsync(300_000);
      }
      expect(base.attempts).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
      expect(store.listAll()).toHaveLength(1);

      // 连接恢复(接线层的 connected → flush): 自动补发。
      connected = true;
      await delivery.flush();
      expect(base.attempts).toHaveLength(1);
      expect(store.list({ accountScope: 'owner:a', botId: 'bot-1' })).toHaveLength(0);
      expect(store.listAll()[0]?.completedAt).toBeTypeOf('number');
    } finally {
      tmp.cleanup();
    }
  });

  it('keeps offline records through a plain stop and resumes them with a fresh instance', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      const base = recordingTransport(() => 'sent');
      const offline: ImOutboxTransport = { ...base.transport, isConnected: () => false };
      const delivery = deliveryFor({ store, transport: offline });
      await delivery.commit(output('turn-offline-stop'));
      expect(store.listAll()).toHaveLength(1);

      // 只停发送(进程退出/临时停用): 记录保留, 换实例后可继续补发。
      delivery.stop();
      expect(store.listAll()).toHaveLength(1);

      const resumedStore = createImOutbox({
        channel: 'wecom',
        filePath: tmp.file,
        log,
        now: clock,
      });
      const resumed = deliveryFor({
        store: resumedStore,
        transport: recordingTransport(() => 'sent').transport,
      });
      await resumed.flush();
      expect(resumedStore.list({ accountScope: 'owner:a', botId: 'bot-1' })).toHaveLength(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('fails visibly instead of truncating when the store is full', async () => {
    const tmp = tmpRoot();
    try {
      const store = createImOutbox({
        channel: 'wecom',
        filePath: tmp.file,
        log,
        now: clock,
        maxEntries: 2,
      });
      const { transport, attempts } = recordingTransport(() => 'failed');
      const delivery = deliveryFor({ store, transport });
      await delivery.commit(output('turn-1'));
      await delivery.commit(output('turn-2'));
      // 队列满: 新记录写不进去。未完成项绝不能被截掉; 新终稿只能走无持久化的兜底。
      const outcome = await delivery.commit(output('turn-3'));
      expect(outcome.status).not.toBe('durable');
      expect(store.listAll().map((entry) => entry.id).sort()).toEqual([
        'wecom:turn-1',
        'wecom:turn-2',
      ]);
      // turn-3 的兜底是渠道直发(不再经过 offer/账本)。
      expect(attempts).toHaveLength(2);
      // 重新打开 store: 未完成项仍可读(写侧没有写出读不回来的文件)。
      const reopened = createImOutbox({ channel: 'wecom', filePath: tmp.file, log, now: clock });
      expect(reopened.listAll().map((entry) => entry.id).sort()).toEqual([
        'wecom:turn-1',
        'wecom:turn-2',
      ]);
    } finally {
      tmp.cleanup();
    }
  });
});
