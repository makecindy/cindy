/**
 * 市场缓存删除的**结构门禁**。
 *
 * 这块反复出过七八轮同一类事故:每轮都是"又发现一个删除点没查租约"——交换旧
 * 目录、清理历史版本、清理暂存目录、移除来源、失败回滚,各自直接 `fs.rm`。行为
 * 用例只能覆盖已知的那几条路径;真正防止下一轮的是这里的两条约束:
 *
 * 1. `sources/index.ts` 不得出现任何直接的文件系统删除——所有删除必须经
 *    `cacheLease.removeCachePath` 这个唯一入口。新增删除点会在这里失败。
 * 2. 守卫的判据是"路径重叠"(任一方向),因此整槽删、版本目录删、以及 git 的
 *    `<dest>.staging-*` 兄弟目录都落在同一条规则里,不需要各自记得判断。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isCachePathLeased,
  releaseCachePath,
  removeCachePath,
  resetCacheLeasesForTest,
  retainCachePath,
  settleCachePathRemovals,
  withCachePath,
} from '../sources/cacheLease';

const roots: string[] = [];

afterEach(() => {
  resetCacheLeasesForTest();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeTree(): { root: string; slot: string; version: string; staging: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cache-lease-'));
  roots.push(root);
  const slot = path.join(root, 'slot');
  const version = path.join(slot, 'versions', 'v1');
  const staging = path.join(slot, 'incoming', 'job1');
  fs.mkdirSync(version, { recursive: true });
  fs.mkdirSync(`${staging}.staging-abc`, { recursive: true });
  fs.writeFileSync(path.join(version, 'file.txt'), 'content');
  return { root, slot, version, staging };
}

async function waitFor(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 给"推迟的删除"留出执行窗口,用于断言它**没有**发生。 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('cacheLease 删除守卫', () => {
  it('deletes immediately when nothing is leased', async () => {
    const tree = makeTree();
    expect(await removeCachePath(tree.version)).toBe(true);
    expect(fs.existsSync(tree.version)).toBe(false);
  });

  it('defers deleting a leased path until the last lease is released', async () => {
    const tree = makeTree();
    retainCachePath(tree.version);
    expect(await removeCachePath(tree.version)).toBe(false);
    expect(fs.existsSync(tree.version)).toBe(true);

    releaseCachePath(tree.version);
    await waitFor(() => !fs.existsSync(tree.version));
    expect(fs.existsSync(tree.version)).toBe(false);
  });

  it('protects an ancestor delete while a descendant is leased (removeSource)', async () => {
    const tree = makeTree();
    await withCachePath(tree.version, async () => {
      // 整槽递归删:租约在目标之下,同样必须被挡住。
      expect(await removeCachePath(tree.slot)).toBe(false);
      expect(fs.readFileSync(path.join(tree.version, 'file.txt'), 'utf8')).toBe('content');
    });
    await waitFor(() => !fs.existsSync(tree.slot));
    expect(fs.existsSync(tree.slot)).toBe(false);
  });

  it('protects the git staging sibling of a leased staging dir', async () => {
    const tree = makeTree();
    const sibling = `${tree.staging}.staging-abc`;
    await withCachePath(tree.staging, async () => {
      // `<dest>.staging-<uuid>` 是兄弟目录而不是子目录,按路径分段比较盖不住它,
      // 守卫用字符串前缀判据才拦得下。
      expect(await removeCachePath(sibling)).toBe(false);
      expect(fs.existsSync(sibling)).toBe(true);
    });
    await waitFor(() => !fs.existsSync(sibling));
    expect(fs.existsSync(sibling)).toBe(false);
  });

  it('honours skipIf at execution time, not at scheduling time', async () => {
    const tree = makeTree();
    let stillCurrent = true;
    retainCachePath(tree.version);
    await removeCachePath(tree.version, { skipIf: () => stillCurrent });
    releaseCachePath(tree.version);
    // 推迟执行时条件仍然成立 → 放弃删除。
    await settle();
    expect(fs.existsSync(tree.version)).toBe(true);

    // 条件不再成立后重新排一次,这次真的删。
    stillCurrent = false;
    await removeCachePath(tree.version, { skipIf: () => stillCurrent });
    expect(fs.existsSync(tree.version)).toBe(false);
  });

  it('lets callers await an already-started removal before reusing the path', async () => {
    const tree = makeTree();
    // 让 rm 变慢,模拟"删除已经启动、还没跑完"这个窗口。skipIf 只挡得住尚未开始的
    // 删除;已经在跑的那笔必须能被复用方等到,否则它会落在刚重建出来的内容上。
    const realRm = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, 'rm').mockImplementation(async (target, options) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return realRm(target as never, options as never);
    });
    try {
      retainCachePath(tree.version);
      await removeCachePath(tree.slot);
      releaseCachePath(tree.version); // 触发推迟删除:此刻它开始跑但没结束

      await settleCachePathRemovals(tree.slot);
      // 等到之后重建:内容不能再被那笔在途删除带走。
      fs.mkdirSync(tree.version, { recursive: true });
      fs.writeFileSync(path.join(tree.version, 'file.txt'), 'rebuilt');
      // 等待必须**长于**上面模拟的 rm 耗时(40ms),否则在途删除还没落地就断言完了,
      // 用例会在缺少 settleCachePathRemovals 时照样通过(没有牙齿)。
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fs.readFileSync(path.join(tree.version, 'file.txt'), 'utf8')).toBe('rebuilt');
    } finally {
      spy.mockRestore();
    }
  });

  it('blocks a still-queued removal from starting while the path is leased for reuse', async () => {
    const tree = makeTree();
    // 场景:移除来源时旧安装仍持有版本租约 → 整槽删除进 deferred(尚未启动)。
    retainCachePath(tree.version);
    let configured = false;
    await removeCachePath(tree.slot, { skipIf: () => configured });

    // 复用方对整个槽持租约后再重建:此时 deferred 里那笔删除**启动不了**——
    // 只等 inFlight 是不够的,它当时还没开始跑。
    retainCachePath(tree.slot);
    releaseCachePath(tree.version); // 旧租约释放,但槽租约仍在
    fs.mkdirSync(tree.version, { recursive: true });
    fs.writeFileSync(path.join(tree.version, 'file.txt'), 'rebuilt');
    await settle();
    expect(fs.readFileSync(path.join(tree.version, 'file.txt'), 'utf8')).toBe('rebuilt');

    // 配置在释放槽租约之前写入 → 释放时 skipIf 直接否决那笔删除。
    configured = true;
    releaseCachePath(tree.slot);
    await settle();
    expect(fs.readFileSync(path.join(tree.version, 'file.txt'), 'utf8')).toBe('rebuilt');
  });

  it('counts nested leases so an inner release does not unblock deletion', async () => {
    const tree = makeTree();
    retainCachePath(tree.version);
    retainCachePath(tree.version);
    await removeCachePath(tree.version);

    releaseCachePath(tree.version);
    expect(isCachePathLeased(tree.version)).toBe(true);
    await settle();
    expect(fs.existsSync(tree.version)).toBe(true);

    releaseCachePath(tree.version);
    await waitFor(() => !fs.existsSync(tree.version));
    expect(fs.existsSync(tree.version)).toBe(false);
  });
});

describe('缓存删除收口(结构门禁)', () => {
  const sourcesDir = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'sources',
  );
  // 容忍链式换行(fs.promises\n.rm(…)):否则漏数 cacheLease/git 的真实删除点。
  const countRawDeletions = (file: string): number =>
    [
      ...fs
        .readFileSync(path.join(sourcesDir, file), 'utf8')
        .matchAll(/fs\s*\.\s*(?:promises\s*\.\s*)?rm(?:Sync|dir)?\s*\(/g),
    ].length;

  // 门禁扩到整个 sources/,而不只 index.ts:任一 lease 管理的文件新增直接删除点
  // 就是又一个绕过租约守卫的口子——这正是此前每一轮返工的形态。
  it.each(['index.ts', 'store.ts', 'discover.ts', 'parse.ts', 'preflight.ts'])(
    'sources/%s never deletes filesystem paths directly',
    (file) => {
      expect(countRawDeletions(file)).toBe(0);
    },
  );

  it('git.ts only deletes its own private clone staging, nothing else', () => {
    // git.ts 的唯一直接删除是它自己 clone 出的 `<dest>.staging-<uuid>` 私有目录
    // (UUID 私有、同函数内建同函数内删、从不被租约持有),是经过审阅的例外。
    // 断言"只删 stagingPath":出现任何删别的路径的调用都要重新确认边界。
    const git = fs.readFileSync(path.join(sourcesDir, 'git.ts'), 'utf8');
    const deletions = [...git.matchAll(/\.\s*rm(?:Sync|dir)?\s*\(\s*([A-Za-z]+)/g)].map((m) => m[1]);
    expect(deletions).toEqual(['stagingPath']);
  });
});
