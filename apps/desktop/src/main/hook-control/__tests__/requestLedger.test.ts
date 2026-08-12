import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHookRequestLedger, type HookTerminalRecord } from '../requestLedger';

const warnings: string[] = [];
const log = { warn: (message: string) => warnings.push(message) };

let dir: string;
const filePath = (): string => path.join(dir, 'hook-request-ledger.json');

function record(requestId: string, connectionId = 'conn-1'): HookTerminalRecord {
  return {
    connectionId,
    requestId,
    ack: {
      requestId,
      result: 'accepted',
      reason: null,
      sessionId: `session-${requestId}`,
      queuePosition: null,
    },
    turnEnd: {
      requestId,
      externalKey: 'slack:C1:1.1',
      sessionId: `session-${requestId}`,
      status: 'ok',
      finalText: `answer-${requestId}`,
      errorMessage: null,
      usage: { durationMs: 12 },
    },
    delivery: 'sent',
    completedAt: Date.now(),
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-request-ledger-'));
  warnings.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('hook request ledger', () => {
  it('跨实例读回完整终态, 且按 connectionId + requestId 隔离', () => {
    const first = createHookRequestLedger({ filePath: filePath(), log });
    const saved = record('req-1');
    expect(first.set(saved)).toBe(true);

    const second = createHookRequestLedger({ filePath: filePath(), log });
    expect(second.get('conn-1', 'req-1')).toEqual(saved);
    expect(second.get('conn-2', 'req-1')).toBeNull();
  });

  it('损坏文件按空账本继续, 下次写入可重建', () => {
    fs.writeFileSync(filePath(), '{not-json', 'utf8');
    const ledger = createHookRequestLedger({ filePath: filePath(), log });

    expect(ledger.get('conn-1', 'missing')).toBeNull();
    expect(warnings).toContain('read hook request ledger failed (invalid-json)');
    expect(ledger.set(record('req-2'))).toBe(true);
    expect(ledger.get('conn-1', 'req-2')?.turnEnd?.finalText).toBe('answer-req-2');
  });

  it('按 FIFO 限制账本条数', () => {
    const ledger = createHookRequestLedger({ filePath: filePath(), log, maxEntries: 2 });
    expect(ledger.set(record('req-1'))).toBe(true);
    expect(ledger.set(record('req-2'))).toBe(true);
    expect(ledger.set(record('req-3'))).toBe(true);

    expect(ledger.get('conn-1', 'req-1')).toBeNull();
    expect(ledger.get('conn-1', 'req-2')).not.toBeNull();
    expect(ledger.get('conn-1', 'req-3')).not.toBeNull();
  });

  it('按文件总大小淘汰最老终态, 避免异常 ID 撑爆 owner 状态文件', () => {
    const ledger = createHookRequestLedger({
      filePath: filePath(),
      log,
      maxEntries: 10,
      maxFileBytes: 1_024,
    });
    const first = record('req-1');
    first.turnEnd!.finalText = 'a'.repeat(400);
    const second = record('req-2');
    second.turnEnd!.finalText = 'b'.repeat(400);

    expect(ledger.set(first)).toBe(true);
    expect(ledger.set(second)).toBe(true);
    expect(ledger.get('conn-1', 'req-1')).toBeNull();
    expect(ledger.get('conn-1', 'req-2')).not.toBeNull();
  });

  it('读取超大账本按空账本降级, 避免主线程解析异常大文件', () => {
    fs.writeFileSync(filePath(), '🙂'.repeat(600), 'utf8');
    const ledger = createHookRequestLedger({ filePath: filePath(), log, maxFileBytes: 1_024 });

    expect(ledger.get('conn-1', 'missing')).toBeNull();
    expect(warnings).toContain('read hook request ledger failed (file-too-large)');
  });

  it('pending outbox 按完成时间列出, markSent 后不再补发', () => {
    // completedAt 现在既是排序键也是投递时效的年龄基准, 所以本例的 10 / 20 需要
    // 配一个同尺度的时钟; 用真实 Date.now() 会把它们判成上古条目。
    const ledger = createHookRequestLedger({ filePath: filePath(), log, now: () => 100 });
    const later = record('later');
    later.delivery = 'pending';
    later.completedAt = 20;
    const earlier = record('earlier');
    earlier.delivery = 'pending';
    earlier.completedAt = 10;
    expect(ledger.set(later)).toBe(true);
    expect(ledger.set(earlier)).toBe(true);

    expect(ledger.listPending('conn-1').map((entry) => entry.requestId)).toEqual([
      'earlier',
      'later',
    ]);
    expect(ledger.markSent('conn-1', 'earlier')).toBe(true);
    expect(ledger.listPending('conn-1').map((entry) => entry.requestId)).toEqual(['later']);
  });

  it('超过投递时效的 pending 不再补发, 时效内的照常补发', () => {
    let clock = 0;
    const ttl = 1_000;
    const ledger = createHookRequestLedger({
      filePath: filePath(),
      log,
      pendingTtlMs: ttl,
      now: () => clock,
    });
    const stale = record('stale');
    stale.delivery = 'pending';
    stale.completedAt = 0;
    const fresh = record('fresh');
    fresh.delivery = 'pending';
    fresh.completedAt = 500;
    expect(ledger.set(stale)).toBe(true);
    expect(ledger.set(fresh)).toBe(true);

    clock = ttl; // 边界: 恰好等于时效仍算值得发
    expect(ledger.listPending('conn-1').map((entry) => entry.requestId)).toEqual([
      'stale',
      'fresh',
    ]);

    clock = ttl + 1; // stale 越线, fresh 还在窗口内
    expect(ledger.listPending('conn-1').map((entry) => entry.requestId)).toEqual(['fresh']);

    // 越线只取消「补发」这一个角色: 去重墓碑还在, 重放不会再叫一次 Agent。
    expect(ledger.get('conn-1', 'stale')?.turnEnd?.finalText).toBe('answer-stale');
  });

  it('时钟回拨不会误判 pending 过期', () => {
    let clock = 10_000;
    const ledger = createHookRequestLedger({
      filePath: filePath(),
      log,
      pendingTtlMs: 1_000,
      now: () => clock,
    });
    const entry = record('req-1');
    entry.delivery = 'pending';
    entry.completedAt = 10_000;
    expect(ledger.set(entry)).toBe(true);

    clock = 0; // 系统时钟被回拨: 年龄为负, 必须仍视为值得发
    expect(ledger.listPending('conn-1').map((item) => item.requestId)).toEqual(['req-1']);
  });

  it('过期 pending 可被淘汰腾位, 不再让整个账本写入失败', () => {
    let clock = 0;
    const ttl = 1_000;
    const ledger = createHookRequestLedger({
      filePath: filePath(),
      log,
      maxEntries: 2,
      pendingTtlMs: ttl,
      now: () => clock,
    });
    // 刻意让**写入顺序与年龄顺序相反**: 先写新的、后写老的。淘汰必须按 completedAt
    // 选最老的一条, 而不是按数组下标 —— 更新过的记录会被重新追加到末尾(见
    // writeRecord 的 filter + push 与 markSent), 所以数组顺序反映的是最后一次写入,
    // 不是年龄。
    const newer = record('zombie-newer');
    newer.delivery = 'pending';
    newer.completedAt = 500;
    const older = record('zombie-older');
    older.delivery = 'pending';
    older.completedAt = 100;
    expect(ledger.set(newer)).toBe(true);
    expect(ledger.set(older)).toBe(true);

    // 两条永不结算的 pending 已占满上限。越线后它们只剩去重价值, 可被回收。
    clock = ttl + 501;
    expect(ledger.set(record('req-new'))).toBe(true);
    expect(warnings).not.toContain('write hook request ledger skipped (pending-outbox-limit)');
    expect(ledger.get('conn-1', 'req-new')).not.toBeNull();
    expect(ledger.get('conn-1', 'zombie-older')).toBeNull(); // 按年龄最老的先被回收
    expect(ledger.get('conn-1', 'zombie-newer')).not.toBeNull();
  });

  it('时效内的 pending 仍受保护, 宁可写入失败也不丢未送出的答案', () => {
    const ledger = createHookRequestLedger({
      filePath: filePath(),
      log,
      maxEntries: 1,
      pendingTtlMs: 1_000,
      now: () => 0,
    });
    const live = record('live');
    live.delivery = 'pending';
    live.completedAt = 0;
    expect(ledger.set(live)).toBe(true);

    expect(ledger.set(record('req-new'))).toBe(false);
    expect(warnings).toContain('write hook request ledger skipped (pending-outbox-limit)');
    expect(ledger.get('conn-1', 'live')).not.toBeNull();
  });

  it('写入失败时返回 false, 不把磁盘错误升级成任务错误', () => {
    const unwritablePath = path.join(dir, 'ledger-directory');
    fs.mkdirSync(unwritablePath);
    const ledger = createHookRequestLedger({ filePath: unwritablePath, log });

    expect(ledger.set(record('req-fail'))).toBe(false);
    expect(
      warnings.some(
        (message) =>
          message.startsWith('read hook request ledger failed') ||
          message.startsWith('write hook request ledger failed'),
      ),
    ).toBe(true);
  });
});
