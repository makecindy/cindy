import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MarketSourceConfig } from '../../../shared/pluginMarket';
import { marketSourceKey } from '../../../shared/pluginMarket';
import { MarketSourceStore, sourcesEqual } from '../sources/store';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-store-'));
  roots.push(root);
  return new MarketSourceStore(path.join(root, 'sources.v1.json'));
}

function config(overrides: Partial<MarketSourceConfig> = {}): MarketSourceConfig {
  return {
    name: 'openai/plugins',
    addedAt: '2026-07-31T00:00:00.000Z',
    lastSyncedAt: null,
    lastRevision: null,
    source: { type: 'git', url: 'https://github.com/openai/plugins.git', sparsePaths: [] },
    ...overrides,
  };
}

describe('MarketSourceStore', () => {
  it('returns an empty list when the file does not exist', () => {
    expect(makeStore().list()).toEqual([]);
  });

  it('persists configs across instances (atomic write + read back)', () => {
    const store = makeStore();
    store.add(config());
    store.add(config({ name: 'local-lib', source: { type: 'local', path: '/x' } }));

    const reread = new MarketSourceStore(
      (store as unknown as { filePathSource: string }).filePathSource,
    );
    expect(reread.list().map((source) => source.name)).toEqual([
      'openai/plugins',
      'local-lib',
    ]);
  });

  it('add replaces a same-name config instead of duplicating it', () => {
    const store = makeStore();
    store.add(config());
    store.add(config({ lastSyncedAt: '2026-07-31T01:00:00.000Z' }));
    expect(store.list()).toHaveLength(1);
    expect(store.get('openai/plugins')?.lastSyncedAt).toBe('2026-07-31T01:00:00.000Z');
  });

  it('updates sync metadata without touching identity fields', () => {
    const store = makeStore();
    store.add(config());
    store.update('openai/plugins', {
      lastSyncedAt: '2026-07-31T02:00:00.000Z',
      lastRevision: 'abc123',
    });
    const updated = store.get('openai/plugins');
    expect(updated?.lastRevision).toBe('abc123');
    expect(updated?.source).toEqual(config().source);
    expect(store.update('missing', { lastRevision: 'x' })).toBeUndefined();
  });

  it('removes configs and reports what was removed', () => {
    const store = makeStore();
    store.add(config());
    expect(store.remove('openai/plugins')?.name).toBe('openai/plugins');
    expect(store.remove('openai/plugins')).toBeNull();
    expect(store.list()).toEqual([]);
  });

  it('drops malformed entries instead of failing the whole file', () => {
    const store = makeStore();
    store.add(config());
    const file = (store as unknown as { filePathSource: string }).filePathSource;
    fs.writeFileSync(
      file,
      JSON.stringify({
        schemaVersion: 1,
        sources: [config(), { name: '' }, { name: 'bad', source: { type: 'other' } }],
      }),
    );
    expect(store.list().map((source) => source.name)).toEqual(['openai/plugins']);
  });

  it('detects equivalent sources by type + location + ref + sparse paths', () => {
    const store = makeStore();
    store.add(config({ source: { type: 'git', url: 'https://x.test/r.git', ref: 'v1', sparsePaths: ['a'] } }));
    expect(
      store.hasEquivalent({ type: 'git', url: 'https://x.test/r.git', ref: 'v1', sparsePaths: ['a'] }),
    ).toBe(true);
    expect(
      store.hasEquivalent({ type: 'git', url: 'https://x.test/r.git', sparsePaths: ['a'] }),
    ).toBe(false);
    expect(store.hasEquivalent({ type: 'local', path: 'https://x.test/r.git' })).toBe(false);
  });

  it('recovers sources from .bak instead of reading a missing file as empty', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-market-store-'));
    roots.push(root);
    const filePath = path.join(root, 'sources.v1.json');
    const store = new MarketSourceStore(filePath);
    store.add(config());
    // 模拟 Windows 备份交换与回滚都失败:主文件缺失,.bak 是唯一有效快照。
    fs.renameSync(filePath, `${filePath}.bak`);

    // 读取入口必须恢复 .bak;否则读成空来源表,后续写入会覆盖唯一快照,
    // 用户添加过的自定义市场来源全部丢失。
    expect(store.list().map((item) => item.name)).toEqual(['openai/plugins']);
    store.add(config({ name: 'other/hub' }));
    expect(store.list().map((item) => item.name).sort()).toEqual(['openai/plugins', 'other/hub']);
  });

  it('marketSourceKey never collides across distinct sources', () => {
    // 拼接式指纹(join/定界符)存在可构造碰撞,而这个 key 承担账本所有权判定:
    // 碰撞 = 两个不同来源被判成同一个,同名异源防线随之失效。
    const keys = [
      marketSourceKey({ type: 'git', url: 'u', sparsePaths: ['a,b', 'c'] }),
      marketSourceKey({ type: 'git', url: 'u', sparsePaths: ['a', 'b,c'] }),
      marketSourceKey({ type: 'git', url: 'u', ref: 'x', sparsePaths: ['p'] }),
      marketSourceKey({ type: 'git', url: 'u', ref: 'x:p', sparsePaths: [] }),
      marketSourceKey({ type: 'git', url: 'u#x', sparsePaths: ['p'] }),
      marketSourceKey({ type: 'local', path: 'u' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('sourcesEqual treats undefined and empty ref as identical', () => {
    expect(
      sourcesEqual(
        { type: 'git', url: 'u', sparsePaths: [] },
        { type: 'git', url: 'u', ref: undefined, sparsePaths: [] },
      ),
    ).toBe(true);
  });

  it('sourcesEqual 不被 sparsePaths 的分隔符碰撞骗过', () => {
    // 旧写法 `sparsePaths.join('\n')` 会把这两个**不同**的来源判成同一个:
    // ['a\nb'] 与 ['a','b'] 的 join 结果字面相同。身份判据必须让数组边界
    // 不可伪造(与 marketSourceKey 同一实现)。
    expect(
      sourcesEqual(
        { type: 'git', url: 'u', sparsePaths: ['a\nb'] },
        { type: 'git', url: 'u', sparsePaths: ['a', 'b'] },
      ),
    ).toBe(false);
    // 同样不能被顺序变化骗过(顺序不同 = 不同的稀疏检出集合声明)。
    expect(
      sourcesEqual(
        { type: 'git', url: 'u', sparsePaths: ['a', 'b'] },
        { type: 'git', url: 'u', sparsePaths: ['b', 'a'] },
      ),
    ).toBe(false);
    // 真正相同的仍判相同。
    expect(
      sourcesEqual(
        { type: 'git', url: 'u', sparsePaths: ['a', 'b'] },
        { type: 'git', url: 'u', sparsePaths: ['a', 'b'] },
      ),
    ).toBe(true);
  });

  it('sourcesEqual 与 marketSourceKey 是同一判据(不允许两套逻辑漂移)', () => {
    const samples: Array<[Parameters<typeof sourcesEqual>[0], Parameters<typeof sourcesEqual>[1]]> = [
      [
        { type: 'local', path: '/a' },
        { type: 'local', path: '/a' },
      ],
      [
        { type: 'local', path: '/a' },
        { type: 'local', path: '/b' },
      ],
      [
        { type: 'git', url: 'u', ref: 'v1', sparsePaths: ['x'] },
        { type: 'git', url: 'u', ref: 'v1', sparsePaths: ['x'] },
      ],
      [
        { type: 'git', url: 'u', ref: 'v1', sparsePaths: ['x'] },
        { type: 'git', url: 'u', ref: 'v2', sparsePaths: ['x'] },
      ],
      [
        { type: 'local', path: '/a' },
        { type: 'git', url: 'u', sparsePaths: [] },
      ],
    ];
    for (const [a, b] of samples) {
      expect(sourcesEqual(a, b)).toBe(marketSourceKey(a) === marketSourceKey(b));
    }
  });
});
