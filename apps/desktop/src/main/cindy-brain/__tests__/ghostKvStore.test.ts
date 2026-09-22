import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GHOST_KV_MAX_BYTES,
  GhostKvError,
  createGhostKvStore,
  isValidGhostKvValue,
  removeGhostKvBestEffort,
  type GhostKvStore,
} from '../ghostKvStore.js';

/**
 * 纯 Node + tmpdir(规范 23:测试路径一律 os.tmpdir(),收尾清理),
 * 不 mock electron——rootDir 经工厂注入正是为此。
 */
describe('cindy-brain · ghostKvStore(意识自定义参数持久化)', () => {
  let root: string;
  let store: GhostKvStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ghost-kv-test-'));
    store = createGhostKvStore({ getRootDir: () => root });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('读缺省:从未写过 → {}(不建目录不建文件)', () => {
    expect(store.read('demo')).toEqual({});
  });

  it('写读回环 + 覆盖写(整体覆盖 last-write-wins)', () => {
    store.write('demo', { theme: 'dark', count: 3 });
    expect(store.read('demo')).toEqual({ theme: 'dark', count: 3 });
    store.write('demo', { theme: 'light' });
    expect(store.read('demo')).toEqual({ theme: 'light' }); // count 不残留
  });

  it('意识之间文件隔离', () => {
    store.write('alpha', { a: 1 });
    store.write('beta', { b: 2 });
    expect(store.read('alpha')).toEqual({ a: 1 });
    expect(store.read('beta')).toEqual({ b: 2 });
    expect(fs.existsSync(path.join(root, 'alpha.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'beta.json'))).toBe(true);
  });

  it('root helper 与企业 _ns__acme__helper 落成不同文件', () => {
    store.write('helper', { from: 'root' });
    store.write('_ns__acme__helper', { from: 'acme' });
    expect(store.read('helper')).toEqual({ from: 'root' });
    expect(store.read('_ns__acme__helper')).toEqual({ from: 'acme' });
    expect(fs.existsSync(path.join(root, 'helper.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '_ns__acme__helper.json'))).toBe(true);
    store.remove('helper');
    expect(store.read('helper')).toEqual({});
    expect(store.read('_ns__acme__helper')).toEqual({ from: 'acme' });
  });

  it('损坏 JSON → 读回 {} 且不抛', () => {
    fs.writeFileSync(path.join(root, 'demo.json'), '{broken', 'utf8');
    expect(store.read('demo')).toEqual({});
  });

  it('文件内容是数组/标量 → 读回 {}(存储层只认对象)', () => {
    fs.writeFileSync(path.join(root, 'demo.json'), '[1,2]', 'utf8');
    expect(store.read('demo')).toEqual({});
    fs.writeFileSync(path.join(root, 'demo.json'), '"str"', 'utf8');
    expect(store.read('demo')).toEqual({});
  });

  it('readStrict:无文件 → {},正常文件读回内容,损坏 JSON 上抛(setup 检查专用口径)', () => {
    expect(store.readStrict('demo')).toEqual({});
    store.write('demo', { workspace: 'team-x' });
    expect(store.readStrict('demo')).toEqual({ workspace: 'team-x' });
    fs.writeFileSync(path.join(root, 'demo.json'), '{broken', 'utf8');
    expect(() => store.readStrict('demo')).toThrow(); // 「查询失败」≠「未配置」
    expect(store.read('demo')).toEqual({}); // 宽松口径不受影响
  });

  it('写入非 plain object(数组/null/标量)抛 INVALID_VALUE', () => {
    for (const bad of [[1, 2], null, 'str', 42] as unknown[]) {
      expect(
        () => store.write('demo', bad as Record<string, unknown>),
        JSON.stringify(bad),
      ).toThrowError(GhostKvError);
    }
  });

  it('64KB 边界:恰好到上限过,超 1 字节抛 TOO_LARGE', () => {
    // {"k":"<padding>"} 的包装开销 8 字节:{"k":""} → 恰好压线的 padding。
    const wrapOverhead = Buffer.byteLength(JSON.stringify({ k: '' }), 'utf8');
    const fit = { k: 'x'.repeat(GHOST_KV_MAX_BYTES - wrapOverhead) };
    expect(Buffer.byteLength(JSON.stringify(fit), 'utf8')).toBe(GHOST_KV_MAX_BYTES);
    store.write('demo', fit);
    expect(store.read('demo')).toEqual(fit);

    const over = { k: 'x'.repeat(GHOST_KV_MAX_BYTES - wrapOverhead + 1) };
    let caught: unknown;
    try {
      store.write('demo', over);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GhostKvError);
    expect((caught as GhostKvError).code).toBe('TOO_LARGE');
  });

  it('remove 幂等:有文件删掉,没文件静默', () => {
    store.write('demo', { a: 1 });
    store.remove('demo');
    expect(fs.existsSync(path.join(root, 'demo.json'))).toBe(false);
    expect(store.read('demo')).toEqual({});
    expect(() => store.remove('demo')).not.toThrow(); // 二次删不抛
    expect(() => store.remove('never-written')).not.toThrow();
  });

  it('卸载收尾:KV 删除失败只记日志,不阻断后续一致性收尾', () => {
    const log = { warn: vi.fn() };
    const finalizeUninstall = vi.fn();

    removeGhostKvBestEffort(
      {
        remove: () => {
          throw new Error('file locked');
        },
      },
      'demo',
      log,
    );
    finalizeUninstall();

    expect(finalizeUninstall).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith('ghost KV 清理失败', {
      ghostId: 'demo',
      error: 'file locked',
    });
  });

  it('非法 ghostId:写抛 INVALID_GHOST_ID,读回 {},删静默——文件名安全双保险', () => {
    for (const bad of ['../evil', 'UPPER', 'a/b', '', '_ns/acme/helper']) {
      expect(() => store.write(bad, { a: 1 }), bad).toThrowError(GhostKvError);
      expect(store.read(bad), bad).toEqual({});
      expect(() => store.remove(bad), bad).not.toThrow();
    }
    // 穿越尝试没有在 root 之外留下任何文件
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('原子写:成功写入后无 .tmp 残留', () => {
    store.write('demo', { a: 1 });
    expect(fs.readdirSync(root).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('isValidGhostKvValue:对象过,数组/null/超限拒', () => {
    expect(isValidGhostKvValue({})).toBe(true);
    expect(isValidGhostKvValue({ nested: { ok: true } })).toBe(true);
    expect(isValidGhostKvValue([1])).toBe(false);
    expect(isValidGhostKvValue(null)).toBe(false);
    expect(isValidGhostKvValue('str')).toBe(false);
    expect(isValidGhostKvValue({ k: 'x'.repeat(GHOST_KV_MAX_BYTES) })).toBe(false);
  });
});
