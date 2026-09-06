/**
 * blobStore.test.ts — cindy-media 字节仓单测。
 * 覆盖:内容寻址写入(指纹/分桶/幂等去重)、URL 形状校验(指纹正则 + 扩展名
 * 白名单,爬目录类输入一律拒)、resolveSafe 仓内双保险、读回一致性。
 * 文件落 os.tmpdir() 临时目录并收尾清理(规则 23:凭证不入仓同族约束)。
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let tmpUserData = '';
let scratchRoot = '';

vi.mock('electron', () => ({
  app: { getPath: () => tmpUserData },
}));

const blobStore = await import('../blobStore');

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_HASH = createHash('sha256').update(PNG_BYTES).digest('hex');

beforeAll(() => {
  tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-media-test-'));
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-media-scratch-'));
});

afterAll(() => {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function hashedPng(label: string) {
  const buffer = Buffer.concat([PNG_BYTES, Buffer.from(label)]);
  const hash = createHash('sha256').update(buffer).digest('hex');
  const dest = path.join(tmpUserData, 'cindy-media', 'blobs', hash.slice(0, 2), `${hash}.png`);
  return { buffer, hash, dest, shard: path.dirname(dest) };
}

function scratchDir(label: string): string {
  return fs.mkdtempSync(path.join(scratchRoot, `${label}-`));
}

function seedDest(dest: string, contents: Buffer | 'dir' | { symlink: string }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  if (contents === 'dir') {
    fs.mkdirSync(dest);
    return;
  }
  if (typeof contents === 'object' && 'symlink' in contents) {
    fs.symlinkSync(contents.symlink, dest);
    return;
  }
  fs.writeFileSync(dest, contents);
}

async function withUnsupportedLink<T>(fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(fsp, 'link').mockRejectedValue(
    Object.assign(new Error('hard-link unsupported'), { code: 'ENOTSUP' }),
  );
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

describe('writeBlob(内容寻址写入)', () => {
  it('支持 Telegram voice 使用的 Ogg/Opus 容器 MIME', () => {
    expect(blobStore.supportedMime('audio/ogg')).toBe(true);
    expect(blobStore.mimeForExt('.ogg')).toBe('audio/ogg');
  });

  it('按指纹分桶落盘,返回稳定 URL', async () => {
    const written = await blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(written.hash).toBe(PNG_HASH);
    expect(written.ext).toBe('.png');
    expect(written.url).toBe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(written.deduplicated).toBe(false);
    const expected = path.join(
      tmpUserData,
      'cindy-media',
      'blobs',
      PNG_HASH.slice(0, 2),
      `${PNG_HASH}.png`,
    );
    expect(fs.existsSync(expected)).toBe(true);
  });

  it('同内容重复写入 = 去重命中,不产生第二份', async () => {
    const again = await blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'image/png' });
    expect(again.deduplicated).toBe(true);
    expect(again.hash).toBe(PNG_HASH);
    const shard = path.join(tmpUserData, 'cindy-media', 'blobs', PNG_HASH.slice(0, 2));
    expect(fs.readdirSync(shard)).toHaveLength(1);
  });

  it('空字节 / 未知类型拒绝', async () => {
    await expect(
      blobStore.writeBlob({ buffer: new Uint8Array(0), mimeType: 'image/png' }),
    ).rejects.toThrow('empty buffer');
    await expect(
      blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'application/x-msdownload' }),
    ).rejects.toThrow('unsupported mime');
  });
});

describe('writeBlob(已存在副本核验与自愈)', () => {
  it.each(['link', 'rename'] as const)('%s 分支:正确副本去重不重写', async (mode) => {
    const sample = hashedPng(`ok-${mode}`);
    seedDest(sample.dest, sample.buffer);
    const before = fs.statSync(sample.dest);
    const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
    const written = mode === 'rename' ? await withUnsupportedLink(run) : await run();
    expect(written.deduplicated).toBe(true);
    const after = fs.statSync(sample.dest);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
  });

  it.each(['link', 'rename'] as const)('%s 分支:损坏文件按输入 hash 修复', async (mode) => {
    const sample = hashedPng(`bad-${mode}`);
    seedDest(sample.dest, Buffer.from('poisoned-bytes'));
    const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
    const written = mode === 'rename' ? await withUnsupportedLink(run) : await run();
    expect(written.deduplicated).toBe(false);
    expect(written.hash).toBe(sample.hash);
    expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
    expect(createHash('sha256').update(fs.readFileSync(sample.dest)).digest('hex')).toBe(sample.hash);
  });

  it.each(['link', 'rename'] as const)('%s 分支:缺失补写', async (mode) => {
    const sample = hashedPng(`missing-${mode}`);
    fs.mkdirSync(sample.shard, { recursive: true });
    const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
    const written = mode === 'rename' ? await withUnsupportedLink(run) : await run();
    expect(written.deduplicated).toBe(false);
    expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
  });

  it.each(['link', 'rename'] as const)('%s 分支:symlink 不当成去重成功', async (mode) => {
    const sample = hashedPng(`symlink-${mode}`);
    const outsideDir = scratchDir(`outside-${mode}`);
    const outside = path.join(outsideDir, 'payload.bin');
    fs.writeFileSync(outside, sample.buffer);
    seedDest(sample.dest, { symlink: outside });
    const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
    await expect(mode === 'rename' ? withUnsupportedLink(run) : run()).rejects.toThrow(/symlink/);
    expect(fs.lstatSync(sample.dest).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(outside)).toEqual(sample.buffer);
  });

  it.each(['link', 'rename'] as const)('%s 分支:目录不当成去重成功', async (mode) => {
    const sample = hashedPng(`dir-${mode}`);
    seedDest(sample.dest, 'dir');
    const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
    await expect(mode === 'rename' ? withUnsupportedLink(run) : run()).rejects.toThrow(/directory/);
    expect(fs.statSync(sample.dest).isDirectory()).toBe(true);
  });

  it.each(['link', 'rename'] as const)('%s 分支:检查期间替换不当成去重成功', async (mode) => {
    const sample = hashedPng(`swap-${mode}`);
    seedDest(sample.dest, sample.buffer);
    const outsideDir = scratchDir(`swap-${mode}`);
    const outside = path.join(outsideDir, 'not-the-blob.bin');
    fs.writeFileSync(outside, Buffer.from('not-the-blob'));
    const originalOpen = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, 'open').mockImplementation(async (target, flags, perm) => {
      if (path.resolve(String(target)) === path.resolve(sample.dest)) {
        fs.rmSync(sample.dest, { force: true });
        fs.symlinkSync(outside, sample.dest);
      }
      return originalOpen(target, flags, perm);
    });
    try {
      const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
      await expect(mode === 'rename' ? withUnsupportedLink(run) : run()).rejects.toThrow();
      expect(fs.lstatSync(sample.dest).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(outside).toString()).toBe('not-the-blob');
    } finally {
      spy.mockRestore();
    }
  });

  it('bucket 被换成指向仓外的 symlink 时 fail closed,不追随写入', async () => {
    const sample = hashedPng('bucket-symlink');
    const outsideDir = scratchDir('bucket-outside');
    fs.mkdirSync(sample.shard, { recursive: true });
    fs.rmSync(sample.shard, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, sample.shard);
    await expect(
      blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }),
    ).rejects.toThrow(/symlink|out of bounds/);
    expect(fs.lstatSync(sample.shard).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outsideDir)).toEqual([]);
  });

  it.each(['cindy-media', 'blobs'] as const)('%s 祖先 symlink fail closed', async (kind) => {
    const sample = hashedPng(`anc-${kind}`);
    const target = path.join(tmpUserData, 'cindy-media', ...(kind === 'blobs' ? ['blobs'] : []));
    const outside = scratchDir(`anc-${kind}`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.symlinkSync(outside, target);
    await expect(blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' })).rejects.toThrow(/symlink|out of bounds/);
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(path.join(tmpUserData, 'cindy-media', 'blobs'), { recursive: true });
  });

  it('hash 后 size 变化视为替换,不得去重成功', async () => {
    const sample = hashedPng('size-drift');
    seedDest(sample.dest, sample.buffer);
    const originalOpen = fsp.open.bind(fsp);
    let n = 0;
    vi.spyOn(fsp, 'open').mockImplementation(async (target, flags, perm) => {
      const handle = await originalOpen(target, flags, perm);
      if (path.resolve(String(target)) !== path.resolve(sample.dest)) return handle;
      const originalStat = handle.stat.bind(handle);
      handle.stat = async () => {
        const st = await originalStat();
        return ++n < 2 ? st : Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: st.size + 1 });
      };
      return handle;
    });
    await expect(blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' })).rejects.toThrow(/not a regular file|did not match input hash/);
  });

  it('Windows 上 path/fd stat 一侧 dev=0 时仍识别同一正确副本', async () => {
    const sample = hashedPng('win-dev');
    seedDest(sample.dest, sample.buffer);
    const originalLstat = fsp.lstat.bind(fsp);
    const originalOpen = fsp.open.bind(fsp);
    vi.spyOn(fsp, 'lstat').mockImplementation(async (target, opts) => {
      const st = await originalLstat(target, opts);
      if (path.resolve(String(target)) === path.resolve(sample.dest)) {
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: 0 });
      }
      return st;
    });
    vi.spyOn(fsp, 'open').mockImplementation(async (target, flags, perm) => {
      const handle = await originalOpen(target, flags, perm);
      if (path.resolve(String(target)) !== path.resolve(sample.dest)) return handle;
      const originalStat = handle.stat.bind(handle);
      handle.stat = async () => {
        const st = await originalStat();
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { dev: 42 });
      };
      return handle;
    });
    const previous = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const written = await blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
      expect(written.deduplicated).toBe(true);
      expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
    } finally {
      Object.defineProperty(process, 'platform', { value: previous });
    }
  });
});

describe('writeBlob(串行与原子发布)', () => {
  it('进程内同目标串行,正确副本幂等收敛', async () => {
    const sample = hashedPng('serial');
    const [first, second] = await Promise.all([
      blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }),
      blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }),
    ]);
    expect([first.deduplicated, second.deduplicated].sort()).toEqual([false, true]);
    expect(fs.readdirSync(sample.shard).filter((name) => !name.startsWith('.tmp-'))).toEqual([
      `${sample.hash}.png`,
    ]);
    expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
  });

  it('损坏目标并发写入后读回正确内容,不暴露半截文件', async () => {
    const sample = hashedPng('race-repair');
    seedDest(sample.dest, Buffer.from('truncated'));
    const results = await Promise.all([
      blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }),
      blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }),
    ]);
    expect(results.every((item) => item.hash === sample.hash)).toBe(true);
    expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
    expect(fs.readdirSync(sample.shard).some((name) => name.startsWith('.tmp-'))).toBe(false);
  });

  it.each(['link', 'rename'] as const)('%s 分支:跨进程同 hash 并发发布后读回验证,正确即幂等收敛', async (mode) => {
    const sample = hashedPng(`cross-proc-${mode}`);
    seedDest(sample.dest, Buffer.from('poison'));
    const workDir = scratchDir(`cross-proc-${mode}`);
    const helper = path.join(workDir, 'write-blob-child.mjs');
    const childReady = path.join(workDir, 'child-ready');
    const parentReady = path.join(workDir, 'parent-ready');
    const resultFile = path.join(workDir, 'result.json');
    const payloadB64 = sample.buffer.toString('base64');
    fs.writeFileSync(
      helper,
      `
        import { createHash, randomUUID } from 'node:crypto';
        import { writeFileSync, existsSync, mkdirSync, lstatSync } from 'node:fs';
        import { writeFile, link, rename, rm, lstat } from 'node:fs/promises';
        const dest = ${JSON.stringify(sample.dest)};
        const shard = ${JSON.stringify(sample.shard)};
        const buffer = Buffer.from(${JSON.stringify(payloadB64)}, 'base64');
        const hash = createHash('sha256').update(buffer).digest('hex');
        mkdirSync(shard, { recursive: true });
        const tmpPath = ${JSON.stringify(path.join(sample.shard, `.tmp-${sample.hash}-child-`))} + randomUUID();
        await writeFile(tmpPath, buffer, { flag: 'wx' });
        writeFileSync(${JSON.stringify(childReady)}, 'ready');
        const waitUntil = async (file) => {
          const deadline = Date.now() + 5000;
          while (!existsSync(file)) {
            if (Date.now() > deadline) throw new Error('timeout waiting ' + file);
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        };
        await waitUntil(${JSON.stringify(parentReady)});
        try {
          try {
            await link(tmpPath, dest);
          } catch {
            const st = await lstat(dest).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
            if (st && (st.isSymbolicLink() || st.isDirectory() || !st.isFile())) {
              throw Object.assign(new Error('child refused non-regular dest'), { code: 'EINVAL' });
            }
            try {
              await rename(tmpPath, dest);
            } catch {
              const again = await lstat(dest);
              if (!again.isFile() || again.size !== buffer.length) throw new Error('child publish did not converge');
            }
          }
        } finally {
          await rm(tmpPath, { force: true }).catch(() => {});
        }
        writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ hash, bytes: buffer.length }));
      `,
    );
    const child = spawn(process.execPath, [helper], { stdio: 'pipe' });
    const waitFor = async (file: string) => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(file)) {
        if (Date.now() > deadline) throw new Error(`missing ${path.basename(file)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    try {
      await waitFor(childReady);
      const parentPromise =
        mode === 'rename'
          ? withUnsupportedLink(() => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' }))
          : blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
      fs.writeFileSync(parentReady, 'ready');
      const [parent, childCode] = await Promise.all([
        parentPromise,
        new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => resolve(code));
        }),
      ]);
      expect(childCode).toBe(0);
      const childWritten = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      expect(parent.hash).toBe(sample.hash);
      expect(childWritten.hash).toBe(sample.hash);
      expect(fs.readFileSync(sample.dest)).toEqual(sample.buffer);
      expect(fs.readdirSync(sample.shard).some((name) => name.startsWith('.tmp-'))).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  });

  it.each(['link', 'rename'] as const)('%s 分支:发布失败后读回仍错误且清理自建 temp', async (mode) => {
    const sample = hashedPng(`publish-fail-${mode}`);
    seedDest(sample.dest, Buffer.from('still-bad'));
    const spy = vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    );
    try {
      const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
      await expect(mode === 'rename' ? withUnsupportedLink(run) : run()).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(fs.readFileSync(sample.dest).toString()).toBe('still-bad');
      expect(fs.readdirSync(sample.shard).some((name) => name.startsWith('.tmp-'))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['link', 'rename'] as const)('%s 分支:磁盘满时失败且不把半截内容当成功', async (mode) => {
    const sample = hashedPng(`enospc-${mode}`);
    const spy = vi.spyOn(fsp, 'writeFile').mockRejectedValue(
      Object.assign(new Error('no space left'), { code: 'ENOSPC' }),
    );
    try {
      const run = () => blobStore.writeBlob({ buffer: sample.buffer, mimeType: 'image/png' });
      await expect(mode === 'rename' ? withUnsupportedLink(run) : run()).rejects.toMatchObject({
        code: 'ENOSPC',
      });
      expect(fs.existsSync(sample.dest)).toBe(false);
      if (fs.existsSync(sample.shard)) {
        expect(fs.readdirSync(sample.shard).some((name) => name.startsWith('.tmp-'))).toBe(false);
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parseBlobUrl / resolveSafe(取件形状校验)', () => {
  it('合法地址往返解析', () => {
    const parsed = blobStore.parseBlobUrl(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(parsed).toEqual({ hash: PNG_HASH, ext: '.png' });
    const resolved = blobStore.resolveSafe(`cindy-media://blobs/${PNG_HASH}.png`);
    expect(resolved.hash).toBe(PNG_HASH);
    expect(resolved.mimeType).toBe('image/png');
    const root = path.resolve(path.join(tmpUserData, 'cindy-media', 'blobs'));
    expect(resolved.absPath.startsWith(root + path.sep)).toBe(true);
  });

  it('指纹形状不合 / 扩展名不在白名单 / 其它 host 一律拒', () => {
    for (const bad of [
      'cindy-media://blobs/short.png', // 非 64 位指纹
      `cindy-media://blobs/${PNG_HASH.toUpperCase()}.png`, // 大写不收
      `cindy-media://blobs/${PNG_HASH}.exe`, // 扩展名白名单外
      `cindy-media://blobs/${PNG_HASH}`, // 无扩展名
      `cindy-media://other/${PNG_HASH}.png`, // 未知 host
      'cindy-media://blobs/../../secrets.png', // 爬目录企图(形状即拒)
      `xdt-image://blobs/${PNG_HASH}.png`, // 别家协议
      'not-a-url',
    ]) {
      expect(blobStore.parseBlobUrl(bad)).toBeNull();
      expect(() => blobStore.resolveSafe(bad)).toThrow();
    }
  });

  it('拒绝为同一 blob 制造缓存别名的 URL 附加部分', () => {
    const canonical = `cindy-media://blobs/${PNG_HASH}.png`;
    for (const alias of [
      `${canonical}?nonce=1`,
      `${canonical}?`,
      `${canonical}#preview`,
      `${canonical}#`,
      `cindy-media://user@blobs/${PNG_HASH}.png`,
      `cindy-media://blobs:443/${PNG_HASH}.png`,
      `cindy-media://blobs/${PNG_HASH}.PNG`,
      `cindy-media://@blobs/${PNG_HASH}.png`,
      `cindy-media://blobs:/${PNG_HASH}.png`,
      `cindy-media://blobs/a/../${PNG_HASH}.png`,
    ]) {
      expect(blobStore.parseBlobUrl(alias)).toBeNull();
      expect(() => blobStore.resolveSafe(alias)).toThrow('invalid url');
    }
  });

  it('resolveHashRef 拒绝非法指纹与扩展名(供图分支复用同一校验)', () => {
    expect(() => blobStore.resolveHashRef('..', '.png')).toThrow('invalid hash');
    expect(() => blobStore.resolveHashRef(PNG_HASH, '.sh')).toThrow('unsupported ext');
    const ok = blobStore.resolveHashRef(PNG_HASH, '.png');
    expect(ok.mimeType).toBe('image/png');
  });
});

describe('readFile(读回一致性)', () => {
  it('读回的字节与写入完全一致', async () => {
    await blobStore.writeBlob({ buffer: PNG_BYTES, mimeType: 'image/png' });
    const { buffer, mimeType } = await blobStore.readFile(
      `cindy-media://blobs/${PNG_HASH}.png`,
    );
    expect(mimeType).toBe('image/png');
    expect(Buffer.compare(buffer, PNG_BYTES)).toBe(0);
  });

  it('查无此文件 → ENOENT 上抛(协议层译 404)', async () => {
    const missing = createHash('sha256').update('missing').digest('hex');
    await expect(
      blobStore.readFile(`cindy-media://blobs/${missing}.png`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
