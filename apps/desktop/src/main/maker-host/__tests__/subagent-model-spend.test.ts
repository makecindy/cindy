// P0-C 记账回归(模拟费用/模拟场景,不碰任何真实 Provider)。
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/cindy-spend-test'),
  },
}));

vi.mock('./logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'test-owner', generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) =>
    path.join('/tmp/cindy-spend-test', ...parts),
}));

import {
  addSubagentModelSpend,
  readSubagentModelSpend,
  releaseSubagentModelSpend,
  reserveSubagentModelSpend,
  subagentModelSpendFilePath,
} from '../subagent-model-spend.js';

const dir = '/tmp/cindy-spend-test';

beforeEach(() => fs.mkdirSync(dir, { recursive: true }));
afterEach(() => {
  fs.rmSync(path.join(dir, 'subagent-model-spend.json'), { force: true });
  fs.rmSync(path.join(dir, 'subagent-model-spend.json.lock'), { force: true });
  delete (globalThis as Record<string, unknown>).__cindySpendCache;
});

describe('subagent model spend', () => {
  it('accumulates actual and estimated separately and reads the total', () => {
    expect(subagentModelSpendFilePath()).toBe(path.join(dir, 'subagent-model-spend.json'));
    addSubagentModelSpend('session:sess-a', 0.4, false);
    addSubagentModelSpend('session:sess-a', 0.1, true);
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(0.5);
    expect(readSubagentModelSpend('session:missing')).toBeUndefined();
  });

  it('ignores non-positive and non-finite amounts', () => {
    addSubagentModelSpend('session:sess-a', 0, false);
    addSubagentModelSpend('session:sess-a', Number.NaN, false);
    addSubagentModelSpend('session:sess-a', -1, false);
    expect(readSubagentModelSpend('session:sess-a')).toBeUndefined();
  });

  it('reserves budget for concurrent workers and releases on settlement', () => {
    addSubagentModelSpend('session:sess-a', 0.4, false);
    const reserved = reserveSubagentModelSpend('session:sess-a', 'child-1', 1);
    expect(reserved).toBe(1);
    // 并发可见:读到的记账包含实际 + 预留
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(1.4);
    // 幂等:同一 reservationId 重复预留不放大
    expect(reserveSubagentModelSpend('session:sess-a', 'child-1', 1)).toBe(1);
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(1.4);
    // 第二个子会话独立预留
    expect(reserveSubagentModelSpend('session:sess-a', 'child-2', 0.5)).toBe(0.5);
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(1.9);
    // 释放第一个
    releaseSubagentModelSpend('session:sess-a', 'child-1');
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(0.9);
    releaseSubagentModelSpend('session:sess-a', 'child-2');
    expect(readSubagentModelSpend('session:sess-a')).toBeCloseTo(0.4);
  });

  it('readSpend includes reserved in caps read by deciders', () => {
    reserveSubagentModelSpend('session:sess-b', 'only', 2);
    expect(readSubagentModelSpend('session:sess-b')).toBeCloseTo(2);
  });

  it('first paid task with a missing ledger creates the ledger and reserves', () => {
    const ledgerPath = subagentModelSpendFilePath();
    fs.rmSync(ledgerPath, { force: true });
    expect(reserveSubagentModelSpend('session:sess-first', 'child-1', 1, 5)).toBe(1);
    expect(fs.existsSync(ledgerPath)).toBe(true);
    expect(readSubagentModelSpend('session:sess-first')).toBeCloseTo(1);
  });

  it('two workers racing for the last balance: the second reservation is refused', () => {
    addSubagentModelSpend('session:sess-race', 1.8, false);
    const first = reserveSubagentModelSpend('session:sess-race', 'child-a', 1, 2);
    expect(first).toBeCloseTo(0.2); // 只能预留到上限
    const second = reserveSubagentModelSpend('session:sess-race', 'child-b', 1, 2);
    expect(second).toBe(0); // 已耗尽 —— 不穿透
    expect(readSubagentModelSpend('session:sess-race')).toBeCloseTo(2);
  });

  it('expired reservations are pruned so crashed runners do not leak budget forever', () => {
    reserveSubagentModelSpend('session:sess-dead', 'child-dead', 1, 5);
    expect(readSubagentModelSpend('session:sess-dead')).toBeCloseTo(1);
    // 回写一个 11 分钟前的 TTL 时间戳,模拟 runner 崩溃留下的在途预留。
    const ledgerPath = subagentModelSpendFilePath();
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    const scope = raw.byScope['session:sess-dead'];
    const backdated = Date.now() - 11 * 60 * 1000;
    scope.reservedAtById['child-dead'] = backdated;
    fs.writeFileSync(ledgerPath, JSON.stringify(raw), { mode: 0o600 });
    expect(reserveSubagentModelSpend('session:sess-dead', 'child-new', 1, 5)).toBe(1);
    expect(readSubagentModelSpend('session:sess-dead')).toBeCloseTo(1); // 旧预留已被回收
  });

  it('corrupt ledger fails closed: reservations are refused, never silently overwritten', () => {
    const ledgerPath = subagentModelSpendFilePath();
    fs.writeFileSync(ledgerPath, '{ this is not json', { mode: 0o600 });
    expect(reserveSubagentModelSpend('session:sess-corrupt', 'child-1', 1, 5)).toBe(0);
    // 损坏文件没有被覆盖成空账本 —— 后续结算/排查能看见它。
    expect(fs.readFileSync(ledgerPath, 'utf8')).toBe('{ this is not json');
  });

  it('tolerant settlement-side read cannot resurrect an exhausted cap', () => {
    addSubagentModelSpend('session:sess-x', 5, false); // 真实耗尽
    // 结算的宽容读侧容忍损坏文件,但预留裁决始终按已耗尽状态拒绝追加。
    expect(reserveSubagentModelSpend('session:sess-x', 'child-1', 1, 5)).toBe(0);
    expect(readSubagentModelSpend('session:sess-x')).toBeCloseTo(5);
  });
});
