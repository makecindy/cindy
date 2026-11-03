import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../appSessionState.js', async () => {
  const nodePath = await import('node:path');
  return {
    ownerScopedUserDataPath: (...parts: string[]): string => nodePath.join(state.dir, ...parts),
  };
});

const {
  copySessionContextWindowBudget,
  isSessionContextWindowBudgetCustomized,
  pruneSessionContextWindowBudget,
  readSessionContextWindowBudget,
  writeSessionContextWindowBudget,
} = await import('../session-context-budget-store.js');

const FILE = 'session-context-budget-prefs.json';

function prefsFile(): string {
  return path.join(state.dir, FILE);
}

function writePrefs(raw: unknown): void {
  writeFileSync(prefsFile(), typeof raw === 'string' ? raw : JSON.stringify(raw), 'utf8');
}

describe('session-context-budget-store', () => {
  beforeEach(() => {
    state.dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-session-budget-'));
  });

  afterEach(() => {
    rmSync(state.dir, { recursive: true, force: true });
  });

  it('follows the model default until a task explicitly saves a budget', () => {
    expect(readSessionContextWindowBudget('s1')).toBeNull();
    expect(isSessionContextWindowBudgetCustomized('s1')).toBe(false);
    expect(existsSync(prefsFile())).toBe(false);

    expect(writeSessionContextWindowBudget('s1', 262_144)).toBe(262_144);
    expect(readSessionContextWindowBudget('s1')).toBe(262_144);
    expect(isSessionContextWindowBudgetCustomized('s1')).toBe(true);
    expect(JSON.parse(readFileSync(prefsFile(), 'utf8'))).toEqual({ budgets: { s1: 262_144 } });
  });

  it('restores the default by deleting the entry instead of snapshotting it', () => {
    writeSessionContextWindowBudget('s1', 262_144);
    writeSessionContextWindowBudget('s2', 500_000);

    expect(writeSessionContextWindowBudget('s1', null)).toBeNull();
    expect(readSessionContextWindowBudget('s1')).toBeNull();
    expect(readSessionContextWindowBudget('s2')).toBe(500_000);
    // 「恢复默认」= 删条目：目录把默认窗口调大后，没自定义过的任务直接吃到新默认。
    expect(JSON.parse(readFileSync(prefsFile(), 'utf8'))).toEqual({ budgets: { s2: 500_000 } });
  });

  it('rejects a budget below the usable floor instead of silently clearing it', () => {
    expect(() => writeSessionContextWindowBudget('s1', 999)).toThrow(/invalid context window budget/);
    expect(() => writeSessionContextWindowBudget('s1', Number.NaN)).toThrow(/invalid context window budget/);
    expect(readSessionContextWindowBudget('s1')).toBeNull();
  });

  it('ignores garbage in a hand-edited file instead of propagating it', () => {
    writePrefs({ budgets: { good: 250_000, zero: 0, text: 'x', nan: null } });
    expect(readSessionContextWindowBudget('good')).toBe(250_000);
    expect(readSessionContextWindowBudget('zero')).toBeNull();
    expect(readSessionContextWindowBudget('text')).toBeNull();
    expect(readSessionContextWindowBudget('nan')).toBeNull();

    writePrefs('not json at all');
    expect(readSessionContextWindowBudget('good')).toBeNull();
  });

  it('lets an externally edited file take effect on the next read', () => {
    // 与另一个偏好 store（单模型上下文上限）同源：缓存以 mtime + 大小判定失效。
    // 同毫秒内等长改写是二者的已知盲区；真正的跨进程编辑会换 mtime。
    writeSessionContextWindowBudget('s1', 250_000);
    writePrefs({ budgets: { s1: 900_000 } });
    const future = new Date(Date.now() + 2_000);
    utimesSync(prefsFile(), future, future);
    expect(readSessionContextWindowBudget('s1')).toBe(900_000);
  });

  it('copies the entry to a forked task and prunes it when the task is gone', () => {
    writeSessionContextWindowBudget('parent', 300_000);
    expect(copySessionContextWindowBudget('parent', 'child')).toBe(300_000);
    expect(readSessionContextWindowBudget('child')).toBe(300_000);
    // 源未自定义时不动目标（新任务跟随默认，而不是复制一个默认值快照）。
    expect(copySessionContextWindowBudget('untouched', 'child2')).toBeNull();
    expect(readSessionContextWindowBudget('child2')).toBeNull();

    expect(pruneSessionContextWindowBudget('parent')).toBe(true);
    expect(pruneSessionContextWindowBudget('parent')).toBe(false);
    expect(readSessionContextWindowBudget('parent')).toBeNull();
    expect(readSessionContextWindowBudget('child')).toBe(300_000);
  });
});
