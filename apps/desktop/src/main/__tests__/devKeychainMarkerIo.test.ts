/**
 * devKeychainMarkerIo 集成测试:mkdtemp 真实文件系统上验证原子认领协议
 * (review 反馈 P1:手写 crash-consistency / concurrency 协议必须有直接覆盖,
 * 防 O_EXCL 回退 / fsync 顺序 / 短写处理在后续编辑中无声回归)。
 * 决策纯逻辑(resolveDevKeychainDecision)的矩阵在 devKeychainName.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKeychainMarkerIo } from '../devKeychainMarkerIo';
import { KEYCHAIN_IDENTITY_MARKER_FILE } from '../devKeychainName';


// Windows 上创建 symlink 需要管理员或开发者模式;拿不到权限时(EPERM)按仓内
// endpointManifestCache.test.ts 同款探测一次并降级 symlink 相关断言,其余检查照跑
// (review 反馈第三十六轮)。
const canSymlink = (() => {
  const probeDir = fs.mkdtempSync(join(tmpdir(), 'cindy-symlink-probe-'));
  try {
    fs.symlinkSync(join(probeDir, 'target'), join(probeDir, 'link'));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
})();

let profileDir: string;
let markerPath: string;

const makeIo = (fsOverrides?: Parameters<typeof createKeychainMarkerIo>[0]['fsOverrides']) =>
  createKeychainMarkerIo({ markerPath, profileDir, fsOverrides });

/** 模拟不支持硬链接的文件系统(exFAT / 部分 SMB):link 报非 EEXIST 错。 */
const linkUnsupported: typeof fs.linkSync = () => {
  const err = new Error('EPERM: operation not permitted') as NodeJS.ErrnoException;
  err.code = 'EPERM';
  throw err;
};

beforeEach(() => {
  profileDir = fs.mkdtempSync(join(tmpdir(), 'keychain-marker-io-'));
  markerPath = join(profileDir, KEYCHAIN_IDENTITY_MARKER_FILE);
});

afterEach(() => {
  fs.rmSync(profileDir, { recursive: true, force: true });
});

describe('createKeychainMarkerIo', () => {
  it('hard-link 成功路径:认领落位完整标记,临时文件清理干净', () => {
    const io = makeIo();
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
    expect(io.readMarker()).toEqual({ kind: 'present', value: 'CindyDev\n' });
    // 临时文件(<marker>.<pid>-<uuid>.tmp)不残留
    expect(fs.readdirSync(profileDir)).toEqual([KEYCHAIN_IDENTITY_MARKER_FILE]);
  });

  it('认领竞态(link 路径):输家得 exists,胜者内容不被改写', () => {
    const winner = makeIo();
    const loser = makeIo();
    expect(winner.claimMarker('CindyDev')).toBe('claimed');
    expect(loser.claimMarker('Cindy')).toBe('exists');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('O_EXCL 回退路径:link 不支持时仍原子认领,竞态输家得 exists', () => {
    const io = makeIo({ linkSync: linkUnsupported });
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
    const loser = makeIo({ linkSync: linkUnsupported });
    expect(loser.claimMarker('Cindy')).toBe('exists');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('短写场景:writeSync 每次只写 1 字节,协议循环写满,标记仍完整', () => {
    const oneByteWrites = ((fd: number, data: NodeJS.ArrayBufferView, offset?: number | null, _length?: number | null, position?: number | null) =>
      fs.writeSync(fd, data, offset ?? 0, 1, position ?? null)) as typeof fs.writeSync;
    const io = makeIo({ writeSync: oneByteWrites });
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('CindyDev\n');
  });

  it('短写零进展:按写失败收敛为 error,不发布任何标记', () => {
    const stuckWrites: typeof fs.writeSync = () => 0;
    const io = makeIo({ writeSync: stuckWrites });
    expect(io.claimMarker('CindyDev')).toBe('error');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(io.readMarker()).toEqual({ kind: 'absent' });
  });

  it('readMarker 防御:符号链接 / 超限内容 / 目录形态一律 unreadable,缺失为 absent', () => {
    const io = makeIo();
    expect(io.readMarker()).toEqual({ kind: 'absent' });
    // 符号链接(O_NOFOLLOW 拒绝)
    if (canSymlink) {
      const realFile = join(profileDir, 'real.txt');
      fs.writeFileSync(realFile, 'CindyDev\n');
      fs.symlinkSync(realFile, markerPath);
      expect(io.readMarker()).toEqual({ kind: 'unreadable' });
      fs.unlinkSync(markerPath);
    }
    // 超过 256B 上限的外来文件
    fs.writeFileSync(markerPath, `${'x'.repeat(300)}\n`);
    expect(io.readMarker()).toEqual({ kind: 'unreadable' });
    fs.unlinkSync(markerPath);
    // 目录占位(fstat 非普通文件)
    fs.mkdirSync(markerPath);
    expect(io.readMarker()).toEqual({ kind: 'unreadable' });
  });

  it('读后重校验:标记在读取期间被替换(inode 变化)→ 重试耗尽按 unreadable(#912 review)', () => {
    const io = makeIo();
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    // 注入的 statSync 每次返回不同 ino,模拟"每次读取期间都被并发替换"。
    let fakeIno = 10_000;
    const alwaysChanged = (p: string): fs.Stats => {
      const real = fs.statSync(p);
      fakeIno += 1;
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object), real, {
        ino: fakeIno,
      }) as fs.Stats;
    };
    const unstable = makeIo({ statSync: alwaysChanged });
    expect(unstable.readMarker()).toEqual({ kind: 'unreadable' });
    // 路径稳定(真实 statSync)时照常 present——重校验不影响正常读取。
    expect(io.readMarker()).toEqual({ kind: 'present', value: 'CindyDev\n' });
  });

  it('读后重校验:同 inode 原地改写(内容变化)→ 重试耗尽按 unreadable(#912 review 34)', () => {
    const io = makeIo();
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    // 注入 readSync:每个读取 pass 返回不同内容,模拟两次读取之间被原地改写。
    // 每 pass 两次调用(数据 + EOF);奇数 pass 给 "CindyDev\n",偶数 pass 给 "Cindy\n"。
    let call = 0;
    const flipping = ((_fd: number, buffer: NodeJS.ArrayBufferView, offset: number) => {
      const pass = Math.floor(call / 2);
      const isData = call % 2 === 0;
      call += 1;
      if (!isData) return 0;
      const content = Buffer.from(pass % 2 === 0 ? 'CindyDev\n' : 'Cindy\n', 'utf8');
      content.copy(buffer as Buffer, offset);
      return content.length;
    }) as typeof fs.readSync;
    const unstable = makeIo({ readSync: flipping });
    expect(unstable.readMarker()).toEqual({ kind: 'unreadable' });
    // 稳定内容照常 present(真实 readSync 两次 pass 相同)。
    expect(io.readMarker()).toEqual({ kind: 'present', value: 'CindyDev\n' });
  });

  it('读后重校验:路径在读取期间被换成符号链接 → 重试耗尽按 unreadable(#912 review 37)', () => {
    const io = makeIo();
    expect(io.claimMarker('CindyDev')).toBe('claimed');
    // 注入 lstat 语义的 statSync:模拟 open 后路径项被换成符号链接——即使链接
    // 目标内容与 fd 一致,路径项本身是链接就必须拒。
    const linkNow = (p: string): fs.Stats => {
      const real = fs.lstatSync(p);
      return Object.assign(Object.create(Object.getPrototypeOf(real) as object), real, {
        isSymbolicLink: () => true,
      }) as fs.Stats;
    };
    const swapped = makeIo({ statSync: linkNow });
    expect(swapped.readMarker()).toEqual({ kind: 'unreadable' });
    expect(io.readMarker()).toEqual({ kind: 'present', value: 'CindyDev\n' });
  });

  it('profileHasData:标记与 .tmp 半成品不算数据,真实文件算', () => {
    const io = makeIo();
    expect(io.profileHasData()).toBe(false);
    io.claimMarker('CindyDev');
    fs.writeFileSync(join(profileDir, `${KEYCHAIN_IDENTITY_MARKER_FILE}.123-abc.tmp`), 'CindyDev\n');
    expect(io.profileHasData()).toBe(false);
    fs.writeFileSync(join(profileDir, 'config.json'), '{}');
    expect(io.profileHasData()).toBe(true);
  });
});
