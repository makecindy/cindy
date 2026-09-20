import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-native-compat-'));

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tempRoot) },
}));

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn() }),
  },
}));

import {
  __testing,
  readPiNativeCompatOverride,
  recordPiNativeCompatOverride,
} from '../pi-native-compat-overrides-store.js';

const FILE = path.join(tempRoot, 'pi-native-compat-overrides.json');

describe('pi native compat overrides store', () => {
  beforeEach(() => {
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.rmSync(FILE, { force: true });
    fs.rmSync(`${FILE}.lock`, { force: true });
  });

  it('records and returns a learned per-model compat override', async () => {
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toBeUndefined();
    await expect(
      recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
    // 只影响精确的 provider/model 组合。
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3')).toBeUndefined();
    expect(readPiNativeCompatOverride('opencode', 'glm-5.3-flash')).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(FILE, 'utf8'))).toEqual({
      models: { 'opencode-go': { 'glm-5.3-flash': { supportsLongCacheRetention: false } } },
    });
  });

  it('keeps the first learned entry when the same pair is recorded again', async () => {
    await recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
      supportsLongCacheRetention: false,
    });
    // 幂等：重复记录保持原值；返回 true = 调用后条目在盘上（含并发先写入的情形）。
    await expect(
      recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', { somethingElse: true }),
    ).resolves.toBe(true);
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
  });

  it('picks up an external file edit without an app restart', async () => {
    await recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
      supportsLongCacheRetention: false,
    });
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
    // 用户手改文件（删掉这条学到的修正）后，read 走 mtime 失效立即生效。
    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(FILE, JSON.stringify({ models: {} }), 'utf8');
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toBeUndefined();
  });

  it('accepts real catalog model ids with @ / ~ prefixes', async () => {
    // cloudflare-workers-ai / cloudflare-ai-gateway / openrouter 的真实模型 id。
    await expect(
      recordPiNativeCompatOverride('cloudflare-workers-ai', '@cf/zai-org/glm-5.3-flash', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    await expect(
      recordPiNativeCompatOverride('cloudflare-ai-gateway', 'workers-ai/@cf/moonshotai/kimi-k2.6', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    await expect(
      recordPiNativeCompatOverride('openrouter', '~z-ai/glm-flash-latest', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    expect(readPiNativeCompatOverride('cloudflare-workers-ai', '@cf/zai-org/glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
    expect(readPiNativeCompatOverride('openrouter', '~z-ai/glm-flash-latest')).toEqual({
      supportsLongCacheRetention: false,
    });
  });

  it('rejects prototype-polluting identity keys from a hand-edited file', () => {
    const poisoned = JSON.parse(
      '{"models":{"__proto__":{"polluted":{"supportsLongCacheRetention":false}},'
      + '"opencode-go":{"__proto__":{"supportsLongCacheRetention":false},'
      + '"glm-5.3-flash":{"supportsLongCacheRetention":false}}}}',
    );
    expect(__testing.normalize(poisoned)).toEqual({
      models: { 'opencode-go': { 'glm-5.3-flash': { supportsLongCacheRetention: false } } },
    });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(readPiNativeCompatOverride('constructor', 'name')).toBeUndefined();
    expect(readPiNativeCompatOverride('prototype', 'toString')).toBeUndefined();
  });

  it('keeps an unreadable override file instead of deleting learned entries', async () => {
    await recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
      supportsLongCacheRetention: false,
    });
    fs.writeFileSync(FILE, '{ broken json', 'utf8');
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toBeUndefined();
    expect(fs.readFileSync(FILE, 'utf8')).toBe('{ broken json');
  });

  it('quarantines a broken file on the next write so learning can recover', async () => {
    fs.writeFileSync(FILE, '{ broken json', 'utf8');
    await expect(
      recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    // 坏文件被挪到备份，学习结果写进新文件；否则每个 400 都白关一次 runtime。
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
    expect(
      fs.readdirSync(tempRoot).some((name) => name.startsWith('pi-native-compat-overrides.json.broken-')),
    ).toBe(true);
  });

  it('quarantines empty / non-object-root files so learning can recover', async () => {
    for (const raw of ['', '   ', '[]', 'null', '"text"']) {
      fs.writeFileSync(FILE, raw, 'utf8');
      await expect(
        recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
          supportsLongCacheRetention: false,
        }),
      ).resolves.toBe(true);
      expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
        supportsLongCacheRetention: false,
      });
      fs.rmSync(FILE, { force: true });
    }
  });

  it('quarantines a directory squatting on the override path', async () => {
    fs.rmSync(FILE, { force: true });
    fs.mkdirSync(FILE);
    await expect(
      recordPiNativeCompatOverride('opencode-go', 'glm-5.3-flash', {
        supportsLongCacheRetention: false,
      }),
    ).resolves.toBe(true);
    expect(readPiNativeCompatOverride('opencode-go', 'glm-5.3-flash')).toEqual({
      supportsLongCacheRetention: false,
    });
  });

  it('drops malformed entries instead of writing them into models.json', async () => {
    fs.writeFileSync(
      FILE,
      JSON.stringify({
        models: {
          'opencode-go': {
            'glm-5.3-flash': { supportsLongCacheRetention: false },
            broken: { nested: { object: true } },
            'also-broken': ['array'],
          },
          'not-an-object': 'nope',
        },
      }),
      'utf8',
    );
    expect(__testing.normalize(JSON.parse(fs.readFileSync(FILE, 'utf8')))).toEqual({
      models: { 'opencode-go': { 'glm-5.3-flash': { supportsLongCacheRetention: false } } },
    });
    await expect(
      recordPiNativeCompatOverride('opencode-go', 'bad-key', { 'bad key': true }),
    ).resolves.toBe(false);
  });
});
