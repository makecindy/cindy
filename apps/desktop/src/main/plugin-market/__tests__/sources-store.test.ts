import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { MarketSourceConfig } from '../../../shared/pluginMarket';
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

  it('sourcesEqual treats undefined and empty ref as identical', () => {
    expect(
      sourcesEqual(
        { type: 'git', url: 'u', sparsePaths: [] },
        { type: 'git', url: 'u', ref: undefined, sparsePaths: [] },
      ),
    ).toBe(true);
  });
});
