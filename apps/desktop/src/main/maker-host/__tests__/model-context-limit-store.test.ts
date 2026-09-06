import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-model-context-limit-'));
let ownerId = 'test-owner';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempRoot) },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

vi.mock('../../appSessionState.js', () => ({
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: ownerId, generation: 1 }),
  ownerScopedUserDataPath: (...parts: string[]) => path.join(tempRoot, ownerId, ...parts),
}));

import {
  __testing,
  isModelContextLimitCustomized,
  modelContextLimitKey,
  readModelContextLimit,
  readModelContextLimits,
  resetModelContextLimits,
  writeModelContextLimit,
  writeModelContextLimits,
  writeModelContextLimitsWithRefresh,
} from '../model-context-limit-store';

const PREFS = path.join(tempRoot, 'test-owner', 'model-context-limit-prefs.json');

function writeRawPrefs(value: unknown): void {
  fs.writeFileSync(PREFS, JSON.stringify(value), 'utf-8');
  __testing.invalidate();
}

describe('model context limit store', () => {
  beforeEach(() => {
    ownerId = 'test-owner';
    fs.mkdirSync(path.dirname(PREFS), { recursive: true });
    if (fs.existsSync(PREFS)) fs.unlinkSync(PREFS);
    __testing.invalidate();
  });

  it.each([1_000_000, null])('rolls back failed refresh for limit %s, including mixed/absent aliases', async (limit) => {
    const targets = [
      { agent: 'codex' as const, providerId: 'xd', modelId: 'gpt' },
      { agent: 'pi' as const, providerId: 'xd', modelId: 'gpt' },
      { agent: 'claude-code' as const, providerId: 'xd', modelId: 'gpt' },
    ];
    writeModelContextLimit('codex', 'xd', 'gpt', 272_000);
    writeModelContextLimit('pi', 'xd', 'gpt', 500_000);
    await expect(writeModelContextLimitsWithRefresh(targets, limit, async () => {
      expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(limit);
      writeModelContextLimit('codex', 'xd', 'unrelated', 128_000);
      throw new Error('runtime close failed');
    })).rejects.toThrow('runtime close failed');
    expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(272_000);
    expect(readModelContextLimit('pi', 'xd', 'gpt')).toBe(500_000);
    expect(readModelContextLimit('claude-code', 'xd', 'gpt')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'unrelated')).toBe(128_000);
  });

  it('rolls back the original owner after an account switch without changing the new owner', async () => {
    const target = { agent: 'codex' as const, providerId: 'xd', modelId: 'gpt' };
    writeModelContextLimit('codex', 'xd', 'gpt', 272_000);
    await expect(writeModelContextLimitsWithRefresh([target], 1_000_000, async () => {
      ownerId = 'other-owner';
      writeModelContextLimit('codex', 'xd', 'gpt', 500_000);
      throw new Error('account changed');
    })).rejects.toThrow('account changed');
    expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(500_000);
    ownerId = 'test-owner';
    expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(272_000);
  });

  it('keeps successful changes and never overwrites a newer external edit on rollback', async () => {
    const target = { agent: 'codex' as const, providerId: 'xd', modelId: 'gpt' };
    await writeModelContextLimitsWithRefresh([target], 1_000_000, async () => {});
    expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(1_000_000);
    await expect(writeModelContextLimitsWithRefresh([target], 272_000, async () => {
      writeModelContextLimit('codex', 'xd', 'gpt', 500_000);
      throw new Error('refresh failed');
    })).rejects.toThrow('refresh failed');
    expect(readModelContextLimit('codex', 'xd', 'gpt')).toBe(500_000);
  });

  it('未设置时不落盘、不视为自定义', () => {
    expect(readModelContextLimit('claude-code', 'anthropic', 'claude-opus-5')).toBeNull();
    expect(isModelContextLimitCustomized('claude-code', 'anthropic', 'claude-opus-5')).toBe(false);
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('写入后只存 override 条目，不快照默认值', () => {
    writeModelContextLimit('claude-code', 'anthropic', 'claude-opus-5', 500_000);
    expect(readModelContextLimit('claude-code', 'anthropic', 'claude-opus-5')).toBe(500_000);
    expect(isModelContextLimitCustomized('claude-code', 'anthropic', 'claude-opus-5')).toBe(true);
    const raw: unknown = JSON.parse(fs.readFileSync(PREFS, 'utf-8'));
    expect(raw).toEqual({
      limits: { [modelContextLimitKey('claude-code', 'anthropic', 'claude-opus-5')]: 500_000 },
    });
  });

  it('键含 agent：同一模型在不同引擎下互不影响', () => {
    writeModelContextLimit('claude-code', 'xd', 'gpt-5.6-sol', 500_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBeNull();
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000);
    expect(readModelContextLimit('claude-code', 'xd', 'gpt-5.6-sol')).toBe(500_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(272_000);
  });

  it('写 null = 恢复默认：删条目而不是写一个默认值快照', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000);
    expect(writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', null)).toBeNull();
    expect(isModelContextLimitCustomized('codex', 'xd', 'gpt-5.6-sol')).toBe(false);
    // 最后一个条目被删掉后整份 override 文件应当消失（= 完全跟随默认）。
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('删掉一个条目不影响其它条目', () => {
    writeModelContextLimit('codex', 'xd', 'a', 100_000);
    writeModelContextLimit('codex', 'xd', 'b', 200_000);
    writeModelContextLimit('codex', 'xd', 'a', null);
    expect(readModelContextLimit('codex', 'xd', 'a')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'b')).toBe(200_000);
  });

  it('低于下限的值不落盘（会让压缩在第一条消息就触发）', () => {
    expect(() => writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 10)).toThrow(
      'invalid context limit',
    );
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBeNull();
    expect(fs.existsSync(PREFS)).toBe(false);
  });

  it('小数取整、荒谬量级收敛到上限', () => {
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 272_000.6);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(272_001);
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 1e12);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(__testing.MAX_LIMIT_TOKENS);
  });

  it('不 clamp 到模型窗口：路由配错时用户能强行往上填', () => {
    // 上游窗口 272K，用户填 1M —— 必须原样存下来（UI 侧给警示，不在这里拦）。
    writeModelContextLimit('codex', 'xd', 'gpt-5.6-sol', 1_024_000);
    expect(readModelContextLimit('codex', 'xd', 'gpt-5.6-sol')).toBe(1_024_000);
  });

  it('手改文件后下一次读取生效（隐藏配置也是正式契约）', () => {
    writeRawPrefs({ limits: { [modelContextLimitKey('codex', 'xd', 'm')]: 300_000 } });
    expect(readModelContextLimit('codex', 'xd', 'm')).toBe(300_000);
  });

  it('文件里的坏条目被丢弃 = 跟随默认，不污染同文件其它条目', () => {
    writeRawPrefs({
      limits: {
        [modelContextLimitKey('codex', 'xd', 'ok')]: 300_000,
        [modelContextLimitKey('codex', 'xd', 'nan')]: 'not-a-number',
        [modelContextLimitKey('codex', 'xd', 'zero')]: 0,
        [modelContextLimitKey('codex', 'xd', 'negative')]: -5,
        '': 400_000,
      },
    });
    expect(readModelContextLimit('codex', 'xd', 'ok')).toBe(300_000);
    expect(readModelContextLimit('codex', 'xd', 'nan')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'zero')).toBeNull();
    expect(readModelContextLimit('codex', 'xd', 'negative')).toBeNull();
    expect(Object.keys(readModelContextLimits())).toHaveLength(1);
  });

  it('keeps accounts isolated when the active owner changes', () => {
    writeModelContextLimit('codex', 'openai', 'm', 500_000);
    ownerId = 'other-owner';
    expect(readModelContextLimit('codex', 'openai', 'm')).toBeNull();
    writeModelContextLimit('codex', 'openai', 'm', 272_000);
    ownerId = 'test-owner';
    expect(readModelContextLimit('codex', 'openai', 'm')).toBe(500_000);
  });

  it('preserves an unreadable preferences file instead of overwriting it', () => {
    fs.writeFileSync(PREFS, '{broken');
    expect(readModelContextLimit('codex', 'openai', 'm')).toBeNull();
    expect(() => writeModelContextLimit('codex', 'openai', 'm', 272_000)).toThrow();
    expect(fs.readFileSync(PREFS, 'utf8')).toBe('{broken');
  });

  it('整体 reset 清空全部 override', () => {
    writeModelContextLimit('codex', 'xd', 'a', 100_000);
    writeModelContextLimit('claude-code', 'anthropic', 'b', 200_000);
    resetModelContextLimits();
    expect(readModelContextLimits()).toEqual({});
    expect(fs.existsSync(PREFS)).toBe(false);
  });
});

afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

describe('atomic context edits', () => {
  it('writes all harness aliases together and reset deletes only those overrides', () => {
    resetModelContextLimits();
    const targets = [
      { agent: 'codex' as const, providerId: 'openai', modelId: 'gpt-6' },
      { agent: 'claude-code' as const, providerId: 'openai', modelId: 'chatgpt/gpt-6' },
    ];
    writeModelContextLimit('pi', 'other', 'gpt-6', 200_000);
    writeModelContextLimits(targets, 500_000);
    for (const target of targets)
      expect(readModelContextLimit(target.agent, target.providerId, target.modelId)).toBe(500_000);
    expect(() =>
      writeModelContextLimits([...targets, { ...targets[0], modelId: '' }], 300_000),
    ).toThrow();
    expect(readModelContextLimit('codex', 'openai', 'gpt-6')).toBe(500_000);
    writeModelContextLimits(targets, null);
    expect(Object.keys(readModelContextLimits())).toHaveLength(1);
    expect(readModelContextLimit('pi', 'other', 'gpt-6')).toBe(200_000);
  });
});
