/**
 * 持久出箱的接线生命周期与账号隔离(共享层)。
 *
 * 测试价值
 * - 生产入口与可观察结果: createChannelOutbox + attachOutboxLifecycle(企微 adapter
 *   的真实接线方式)。用户可观察的是: 退出/断线后重启仍能补发未送达的终稿; 解绑或换
 *   账号后旧记录绝不再发、也不会串进新账号。
 * - Bug／规则依据: im-turn-flow.md「持久出箱」; 评审发现 dispose() 也落 idle,
 *   若 idle 一律删记录, 重启补发就永远不会发生; 另外缓存只按 botId 命中会让同一 bot
 *   的另一个账号复用上一个账号的 store。
 * - 现有覆盖缺口: imOutbox.test.ts 只测 store/投递本身, 不测生命周期接线与账号切换。
 * - 最小失败输入: ① commit 失败后 dispose(idle) → 重启 flush 应补发；
 *   ② 同 bot 从账号 A 切到 B → B 的提交不能落进 A 的 store。
 * - tier: unit(临时目录 + fake timers + 内存 transport, 不发真实消息)。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ImFinalDeliveryPlan, ImFinalOutput } from '@cindy/im';

const holder = vi.hoisted(() => ({
  /** 当前账号(A/B/null=登出)。 */
  owner: 'owner-a' as string | null,
  root: '',
  botId: 'bot-1',
}));

vi.mock('../../../appSessionState', () => ({
  getActiveAppSession: () => ({ dataOwnerId: holder.owner }),
  dataOwnerStorageKey: (id: string) => `k${id}`,
}));
vi.mock('../../ownerScopedStorage', () => ({
  ownerScopedImUserDataPath: (...parts: string[]) =>
    [holder.root, ...parts].filter(Boolean).join('/'),
}));
vi.mock('../../../logger', () => ({
  createLogger: () => ({
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  }),
}));

import { createImOutbox, type ImOutboxStore, type ImOutboxTransport } from '../imOutbox';
import { attachOutboxLifecycle, createChannelOutbox } from '../imOutboxWiring';

interface SentCall {
  text: string;
  steps: string[];
}

let sent: SentCall[] = [];
let direct: string[] = [];
let failDelivery = true;

function transport() {
  return {
    prepareFinal: async (output: ImFinalOutput): Promise<ImFinalDeliveryPlan> => ({
      steps: [{ id: 'text:0', kind: 'text', text: output.text }],
    }),
    deliverFinal: async (
      _output: ImFinalOutput,
      plan: ImFinalDeliveryPlan,
      opts?: { onlySteps?: string[] },
    ) => {
      const text = plan.steps.map((step) => (step.kind === 'text' ? step.text : '')).join('');
      sent.push({ text, steps: opts?.onlySteps ?? [] });
      return {
        states: plan.steps.map(() => (failDelivery ? ('failed' as const) : ('sent' as const))),
      };
    },
    commitFinal: async (output: ImFinalOutput) => {
      direct.push(output.text);
    },
  };
}

function imStub() {
  const handlers: Array<(status: { kind: string }) => void> = [];
  return {
    onStatusChange: (handler: (status: { kind: string }) => void) => {
      handlers.push(handler);
      return () => undefined;
    },
    getStatus: () => ({ kind: 'connecting' }),
    emit(kind: string) {
      for (const handler of handlers) handler({ kind });
    },
  };
}

function outboxFile(owner: string | null = holder.owner): string {
  // 与 ownerScopedImUserDataPath 的拼接方式一致(目录由 mock 提供, 文件名由 wiring 决定)。
  return join(holder.root, 'im-outbox', `wecom-${holder.botId}.json`);
}

function readEntries(): Array<{
  id: string;
  accountScope: string;
  completedAt?: number;
  steps: Array<{ id: string; state: string }>;
}> {
  try {
    const parsed = JSON.parse(readFileSync(outboxFile(), 'utf8')) as {
      entries: Array<{
        id: string;
        accountScope: string;
        completedAt?: number;
        steps: Array<{ id: string; state: string }>;
      }>;
    };
    return parsed.entries;
  } catch {
    return [];
  }
}

function makeOutbox(
  createStore?: Parameters<typeof createChannelOutbox>[0]['createStore'],
  transportOverride?: ImOutboxTransport,
) {
  return createChannelOutbox({
    channel: 'wecom',
    botId: () => holder.botId,
    transport: () => transportOverride ?? transport(),
    ...(createStore ? { createStore } : {}),
  });
}

const output = (turnId: string): ImFinalOutput => ({
  userId: 'owner',
  text: `answer-${turnId}`,
  terminal: 'done',
  turnId,
  allowedFileRoots: [],
});

beforeEach(() => {
  holder.root = mkdtempSync(join(tmpdir(), 'cindy-outbox-wiring-'));
  holder.owner = 'owner-a';
  holder.botId = 'bot-1';
  sent = [];
  direct = [];
  failDelivery = true;
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(holder.root, { recursive: true, force: true });
});

describe('channel outbox lifecycle', () => {
  it('keeps pending records on dispose(idle) and replays them after a restart', async () => {
    const im = imStub();
    const outbox = makeOutbox();
    attachOutboxLifecycle(im, outbox, () => false);

    await outbox.commit(output('turn-1'));
    expect(sent).toHaveLength(1);
    expect(readEntries()).toHaveLength(1);

    // 应用退出: 连接 dispose 也会落 idle, 但凭证还在 —— 记录必须保留。
    im.emit('idle');
    expect(readEntries()).toHaveLength(1);
    // 进程退出会带走内存里的定时器: 新进程必须自己补发。
    outbox.stop();

    // 重启: 新实例 + 已连接事件 → 只补发未完成项。
    failDelivery = false;
    const restarted = makeOutbox();
    attachOutboxLifecycle(imStub(), restarted, () => false);
    vi.advanceTimersByTime(20_000);
    await restarted.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ text: 'answer-turn-1', steps: ['text:0'] });
    // 全部送达后保留的是完成墓碑(幂等凭据), 不再有待发记录。
    const [tombstone] = readEntries();
    expect(tombstone?.completedAt).toBeTypeOf('number');
    expect(tombstone?.steps.every((step) => step.state === 'sent')).toBe(true);
  });

  it('drops pending records when the bot is really unbound', async () => {
    const im = imStub();
    const outbox = makeOutbox();
    // 解绑: 凭证已经清掉, 状态事件才落 idle。
    attachOutboxLifecycle(im, outbox, () => true);

    await outbox.commit(output('turn-unbind'));
    expect(readEntries()).toHaveLength(1);
    im.emit('idle');
    expect(readEntries()).toHaveLength(0);

    failDelivery = false;
    await outbox.flush();
    // 旧记录不会复活。
    expect(sent).toHaveLength(1);
  });

  it('never reuses the previous account store when the same bot switches account', async () => {
    const outbox = makeOutbox();
    await outbox.commit(output('turn-a'));
    expect(sent).toHaveLength(1);
    expect(readEntries()[0]?.accountScope).toBe('owner:kowner-a');

    // 切换账号(同一 bot): 新提交必须进新账号的 store, 旧 store 的记录作废。
    holder.owner = 'owner-b';
    await outbox.commit(output('turn-b'));

    expect(sent).toHaveLength(2);
    // 第二次提交走的是 B 的 store: 发的是 turn-b 且 A 的失败项没有被重放。
    expect(sent[1]).toEqual({ text: 'answer-turn-b', steps: ['text:0'] });
    const entries = readEntries();
    expect(entries.every((entry) => entry.accountScope === 'owner:kowner-b')).toBe(true);
    // A 那条失败记录已被作废, 只剩 B 自己尚未送达的一条。
    expect(entries.map((entry) => entry.id)).toEqual(['wecom:turn-b']);
  });

  it('does not use the cached store after logout and starts clean on the next account', async () => {
    const outbox = makeOutbox();
    await outbox.commit(output('turn-a'));
    expect(sent).toHaveLength(1);

    // 登出: 没有账号代次 → 不进持久出箱, 回落渠道原有直发语义。
    holder.owner = null;
    await outbox.commit(output('turn-logged-out'));
    expect(direct).toEqual(['answer-turn-logged-out']);
    expect(sent).toHaveLength(1);

    // 重新登录同一账号: 旧记录仍是自己的, 可以按退避补发。
    holder.owner = 'owner-a';
    failDelivery = false;
    vi.advanceTimersByTime(20_000);
    await outbox.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({ text: 'answer-turn-a', steps: ['text:0'] });
  });

  it('keeps the last successful checkpoint when a write fails and the same account rebuilds', async () => {
    // 同身份、写盘失败导致 delivery 停掉: resolve() 只能重读, 绝不能删盘上的记录。
    let failWrites = false;
    // 发送成功(这一步真的发出去了), 但紧接着的结果写回失败。
    const flakyTransport = {
      prepareFinal: async (out: ImFinalOutput) => ({
        steps: [{ id: 'text:0', kind: 'text' as const, text: out.text }],
      }),
      deliverFinal: async (_out: ImFinalOutput, plan: ImFinalDeliveryPlan) => {
        failWrites = true;
        sent.push({ text: plan.steps.map((step) => (step.kind === 'text' ? step.text : '')).join(''), steps: ['text:0'] });
        return { states: plan.steps.map(() => 'sent' as const) };
      },
      commitFinal: async () => ({ status: 'sent' as const, unresolved: 0, retrying: 0 }),
    };
    const outbox = makeOutbox(
      ({ channel, filePath }) => {
        const base = createImOutbox({ channel, filePath, log: { warn: () => {} } });
        const flaky: ImOutboxStore = {
          ...base,
          upsert: (entry) => (failWrites ? false : base.upsert(entry)),
        };
        return flaky;
      },
      flakyTransport,
    );
    await outbox.commit(output('turn-recover'));
    failWrites = false;
    const before = readEntries();
    expect(before).toHaveLength(1);
    expect(before[0]?.steps[0]?.state).toBe('inflight');

    // 同账号重建: 不删除、不重发 inflight(结果不明), 记录仍保留。
    await outbox.flush();
    const after = readEntries();
    expect(after).toHaveLength(1);
    expect(after[0]?.steps[0]?.state).toBe('uncertain');
    expect(sent).toHaveLength(1);
  });

  it('resumes an offline delivery when the channel reports connected', async () => {
    let connected = false;
    const offlineTransport: ImOutboxTransport = {
      prepareFinal: async (out) => ({
        steps: [{ id: 'text:0', kind: 'text' as const, text: out.text }],
      }),
      deliverFinal: async (_out, plan) => {
        sent.push({
          text: plan.steps.map((step) => (step.kind === 'text' ? step.text : '')).join(''),
          steps: ['text:0'],
        });
        return { states: plan.steps.map(() => 'sent' as const) };
      },
      commitFinal: async () => ({ status: 'sent' as const, unresolved: 0, retrying: 0 }),
      isConnected: () => connected,
    };
    const outbox = makeOutbox(undefined, offlineTransport);
    const im = imStub();
    attachOutboxLifecycle(im, outbox, () => false);

    await outbox.commit(output('turn-offline'));
    // 离线: 不发、记录留着。
    expect(sent).toEqual([]);
    expect(readEntries()).toHaveLength(1);

    // 连接恢复事件 → 自动补发, 不需要用户再发消息。
    connected = true;
    im.emit('connected');
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ text: 'answer-turn-offline', steps: ['text:0'] });
  });

  it('flushes immediately when the adapter attaches to an already connected channel', async () => {
    const outbox = makeOutbox();
    await outbox.commit(output('turn-ready'));
    expect(sent).toHaveLength(1);

    failDelivery = false;
    vi.advanceTimersByTime(20_000);
    const connected = {
      onStatusChange: () => () => undefined,
      getStatus: () => ({ kind: 'connected' }),
    };
    attachOutboxLifecycle(connected, outbox, () => false);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
  });
});
