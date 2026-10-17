/**
 * 输入建议持久缓存（#6184）的纯逻辑测试：命中条件与容量淘汰，
 * 以及真实 electron-store 落盘的写入 / 读取 / 清除闭环。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ userDataDir: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => h.userDataDir,
    getVersion: () => '0.0.0-test',
    getName: () => 'Cindy Test',
  },
}));
vi.mock('../../appSessionState.js', () => ({
  ownerScopedUserDataPath: () => h.userDataDir,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => undefined, warn: () => undefined, error: () => undefined }),
}));

import {
  __resetPromptRecommendationCacheForTests,
  clearCachedPromptRecommendation,
  pickCachedPrompt,
  pruneCachedEntries,
  readCachedPromptRecommendation,
  writeCachedPromptRecommendation,
  type CachedPromptRecommendation,
} from '../promptRecommendationCache.js';

function entry(overrides: Partial<CachedPromptRecommendation> = {}): CachedPromptRecommendation {
  return {
    revision: 100,
    workingDir: '/tmp/project',
    prompt: '继续把剩下两个页面做完',
    createdAt: 1_000,
    ...overrides,
  };
}

describe('pickCachedPrompt', () => {
  it('命中完成点与工作目录都一致的条目', () => {
    expect(pickCachedPrompt({ s1: entry() }, 's1', 100, '/tmp/project')).toBe(
      '继续把剩下两个页面做完',
    );
  });

  it('revision 不匹配视为未命中', () => {
    expect(pickCachedPrompt({ s1: entry() }, 's1', 101, '/tmp/project')).toBeNull();
  });

  it('workingDir 不匹配视为未命中（含 null 与字符串互换）', () => {
    expect(pickCachedPrompt({ s1: entry() }, 's1', 100, '/tmp/other')).toBeNull();
    expect(pickCachedPrompt({ s1: entry({ workingDir: null }) }, 's1', 100, null)).toBe(
      '继续把剩下两个页面做完',
    );
    expect(
      pickCachedPrompt({ s1: entry({ workingDir: null }) }, 's1', 100, '/tmp/project'),
    ).toBeNull();
    expect(pickCachedPrompt({ s1: entry() }, 's1', 100, null)).toBeNull();
  });

  it('缺失或损坏条目按未命中处理', () => {
    expect(pickCachedPrompt({}, 's1', 100, '/tmp/project')).toBeNull();
    expect(pickCachedPrompt({ s1: null }, 's1', 100, '/tmp/project')).toBeNull();
    expect(pickCachedPrompt({ s1: 'text' }, 's1', 100, '/tmp/project')).toBeNull();
    expect(pickCachedPrompt({ s1: entry({ revision: 0 }) }, 's1', 0, '/tmp/project')).toBeNull();
    expect(pickCachedPrompt({ s1: entry({ revision: 1.5 }) }, 's1', 1.5, '/tmp/project')).toBeNull();
    expect(pickCachedPrompt({ s1: entry({ prompt: '' }) }, 's1', 100, '/tmp/project')).toBeNull();
    expect(
      pickCachedPrompt({ s1: entry({ createdAt: Number.NaN }) }, 's1', 100, '/tmp/project'),
    ).toBeNull();
    expect(
      pickCachedPrompt(
        { s1: { ...entry(), workingDir: 7 } as unknown },
        's1',
        100,
        null,
      ),
    ).toBeNull();
  });
});

describe('pruneCachedEntries', () => {
  it('未超过上限时原样返回', () => {
    const sessions = { a: entry(), b: entry() };
    expect(pruneCachedEntries(sessions, 5)).toBe(sessions);
  });

  it('超过上限时淘汰最旧的条目', () => {
    const sessions = {
      a: entry({ createdAt: 10 }),
      b: entry({ createdAt: 30 }),
      c: entry({ createdAt: 20 }),
    };
    const pruned = pruneCachedEntries(sessions, 2);
    expect(Object.keys(pruned).sort()).toEqual(['b', 'c']);
    expect(pruned.a).toBeUndefined();
  });
});

describe('promptRecommendationCache（真实 electron-store 落盘）', () => {
  beforeEach(() => {
    h.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdt-prompt-rec-'));
    __resetPromptRecommendationCacheForTests();
  });

  afterEach(() => {
    __resetPromptRecommendationCacheForTests();
    fs.rmSync(h.userDataDir, { recursive: true, force: true });
  });

  it('写入后同一完成点命中；revision / workingDir 变化不命中', () => {
    writeCachedPromptRecommendation('session-1', {
      revision: 100,
      workingDir: '/tmp/project',
      prompt: '继续把剩下两个页面做完',
    });

    expect(readCachedPromptRecommendation('session-1', 100, '/tmp/project')).toBe(
      '继续把剩下两个页面做完',
    );
    expect(readCachedPromptRecommendation('session-1', 101, '/tmp/project')).toBeNull();
    expect(readCachedPromptRecommendation('session-1', 100, '/tmp/other')).toBeNull();
  });

  it('重复写入同一会话只保留最新完成点', () => {
    writeCachedPromptRecommendation('session-1', {
      revision: 100,
      workingDir: null,
      prompt: '旧建议',
    });
    writeCachedPromptRecommendation('session-1', {
      revision: 200,
      workingDir: null,
      prompt: '新建议',
    });

    expect(readCachedPromptRecommendation('session-1', 100, null)).toBeNull();
    expect(readCachedPromptRecommendation('session-1', 200, null)).toBe('新建议');
  });

  it('清除后不再命中（会话删除路径）', () => {
    writeCachedPromptRecommendation('session-1', {
      revision: 100,
      workingDir: null,
      prompt: '继续',
    });
    clearCachedPromptRecommendation('session-1');

    expect(readCachedPromptRecommendation('session-1', 100, null)).toBeNull();
  });
});
