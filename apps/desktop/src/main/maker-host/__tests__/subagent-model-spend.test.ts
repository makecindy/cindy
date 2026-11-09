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
});
