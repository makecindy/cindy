import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CodexModelCatalogSync } from '../codex-model-catalog-sync.js';
import { CodexModelCatalogNeedsNativeModelsError } from '../codex-model-catalog-sync.js';

const makerHostSource = readFileSync(resolve(__dirname, '..', 'index.ts'), 'utf8');

/** 取出某个顶层函数体(到下一个顶层 `}` 为止),用于断言接线而非实现细节。 */
function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) throw new Error(`signature not found: ${signature}`);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error(`unterminated function: ${signature}`);
  return source.slice(start, end);
}

function createSync(revision = 1) {
  let currentRevision = revision;
  const writeModelsCache = vi.fn(async (_revision: number) => {});
  const sync = new CodexModelCatalogSync({
    revision: () => currentRevision,
    writeModelsCache,
    logger: { debug: vi.fn(), warn: vi.fn() } as never,
  });
  return {
    sync,
    writeModelsCache,
    setRevision(next: number) { currentRevision = next; },
  };
}

describe('CodexModelCatalogSync', () => {
  it('writes a fresh cache and refreshes once per catalog revision', async () => {
    const { sync, writeModelsCache, setRevision } = createSync();
    const refresh = vi.fn(async () => {});

    await sync.ensureFresh(refresh);
    await sync.ensureFresh(refresh);
    expect(writeModelsCache).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();

    setRevision(2);
    await sync.ensureFresh(refresh);
    expect(writeModelsCache).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent refreshes', async () => {
    const { sync, writeModelsCache } = createSync();
    let resolve!: () => void;
    const refresh = vi.fn(() => new Promise<void>((done) => { resolve = done; }));

    const first = sync.ensureFresh(refresh);
    const second = sync.ensureFresh(refresh);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    resolve();
    await Promise.all([first, second]);

    expect(writeModelsCache).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('retries after cache write or refresh failure', async () => {
    const { sync, writeModelsCache } = createSync();
    writeModelsCache.mockRejectedValueOnce(new Error('locked'));
    const refresh = vi.fn(async () => {});

    await expect(sync.ensureFresh(refresh)).rejects.toThrow('locked');
    await expect(sync.ensureFresh(refresh)).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('warms the vendor cache through model/list when the native cache is missing', async () => {
    const { sync, writeModelsCache } = createSync();
    writeModelsCache
      .mockRejectedValueOnce(new CodexModelCatalogNeedsNativeModelsError())
      .mockResolvedValueOnce(undefined);
    const refresh = vi.fn(async () => {});

    await sync.ensureFresh(refresh);

    expect(writeModelsCache).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('does not apply a revision that changed while synchronization was in flight', async () => {
    const { sync, writeModelsCache, setRevision } = createSync(1);
    let first = true;
    const refresh = vi.fn(async () => {
      if (first) {
        first = false;
        setRevision(2);
      }
    });

    await sync.ensureFresh(refresh);

    expect(writeModelsCache.mock.calls.map(([revision]) => revision)).toEqual([1, 2]);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('retires an in-flight generation on reset and synchronizes the new boundary', async () => {
    const { sync, writeModelsCache } = createSync(1);
    let release!: () => void;
    let calls = 0;
    const refresh = vi.fn(() => {
      calls += 1;
      if (calls === 1) return new Promise<void>((resolve) => { release = resolve; });
      return Promise.resolve();
    });

    const first = sync.ensureFresh(refresh);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    sync.reset();
    release();
    await first;

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(writeModelsCache).toHaveBeenCalledTimes(2);
  });
});

/**
 * 换号 / 切鉴权模式后,上一条边界的 applied revision 与 native ModelInfo 快照都不能被
 * 新账号继承 —— 否则 A 账号的模型清单会被写进 B 账号的 models_cache。快照按 auth 形态
 * 分桶只防住「模式不同」,同模式换号(ChatGPT A → ChatGPT B)只能靠这两个边界主动清。
 */
describe('Codex 模型目录的鉴权边界重置接线', () => {
  it('边界助手同时作废 sync 世代与 native 快照', () => {
    const body = functionBody(makerHostSource, 'function resetCodexModelCatalogBoundary(');
    expect(body).toContain('codexModelCatalogSync.reset()');
    expect(body).toContain('resetCodexNativeModelsSnapshots()');
  });

  it('resetMaker 与 finalizeCodexAfterAuthModeChange 两处边界都调用它', () => {
    for (const signature of [
      'export function resetMaker(',
      'export async function finalizeCodexAfterAuthModeChange(',
    ]) {
      expect(functionBody(makerHostSource, signature)).toContain('resetCodexModelCatalogBoundary()');
    }
  });

  it('写缓存时把世代判定透传进去(过期世代不得落盘)', () => {
    // deps.writeModelsCache 的第二参就是 isCurrent;缺了它,旧世代的慢 I/O 会覆盖新账号的缓存。
    expect(makerHostSource).toContain('writeModelsCache: (revision, isCurrent) => writeCodexModelCatalogCache({');
    expect(functionBody(makerHostSource, 'const codexModelCatalogSync = new CodexModelCatalogSync('))
      .toContain('isCurrent,');
  });
});
