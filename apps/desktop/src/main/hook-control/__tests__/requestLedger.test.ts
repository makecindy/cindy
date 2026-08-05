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
    const ledger = createHookRequestLedger({ filePath: filePath(), log });
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
