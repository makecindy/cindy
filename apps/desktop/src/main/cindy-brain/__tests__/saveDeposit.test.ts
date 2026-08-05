/**
 * SaveDepositVault 单测:下行落盘票据(workdir 钳制 / 文件名消毒去重 /
 * TTL / 次数与字节双预算 / ghostId 绑定)。临时目录一律 os.tmpdir(规则 23)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaveDepositVault, sanitizeSaveFileName } from '../dirDeposit.js';
import { GHOST_SAVE_DEPOSIT_MAX_USES, GHOST_SAVE_DEPOSIT_TTL_MS } from '../../../shared/ghost.js';

let workdir: string;
let saveDir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-deposit-'));
  saveDir = path.join(workdir, 'downloads');
  await fs.promises.mkdir(saveDir);
});
afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

describe('sanitizeSaveFileName', () => {
  it('剥路径 / 控制字符 / 前导点;空与 .. 回退 download;超长截尾', () => {
    expect(sanitizeSaveFileName('../../evil.txt')).toBe('evil.txt');
    expect(sanitizeSaveFileName('a\\b/c.pdf')).toBe('c.pdf');
    expect(sanitizeSaveFileName('.env')).toBe('env');
    expect(sanitizeSaveFileName('re:po|rt?.docx')).toBe('report.docx');
    expect(sanitizeSaveFileName('bad\u0000name\u001f.txt')).toBe('badname.txt');
    expect(sanitizeSaveFileName('')).toBe('download');
    expect(sanitizeSaveFileName(undefined)).toBe('download');
    expect(sanitizeSaveFileName('x'.repeat(300)).length).toBe(128);
  });

  it('Windows 保留设备名加前缀避写;尾部点/空格剥除(名字可被远端控制,规则 15)', () => {
    expect(sanitizeSaveFileName('NUL')).toBe('_NUL');
    expect(sanitizeSaveFileName('nul.pdf')).toBe('_nul.pdf');
    expect(sanitizeSaveFileName('CON.tar.gz')).toBe('_CON.tar.gz');
    expect(sanitizeSaveFileName('COM3')).toBe('_COM3');
    expect(sanitizeSaveFileName('LPT9.txt')).toBe('_LPT9.txt');
    // 非保留:形近但不命中(COM10 / CONSOLE 都是合法名)。
    expect(sanitizeSaveFileName('COM10.txt')).toBe('COM10.txt');
    expect(sanitizeSaveFileName('CONSOLE.txt')).toBe('CONSOLE.txt');
    // 尾部点/空格会被 Windows 静默截断 → 主机先剥,回执名 = 落盘名。
    expect(sanitizeSaveFileName('report. ')).toBe('report');
    expect(sanitizeSaveFileName('foo...')).toBe('foo');
  });
});

describe('SaveDepositVault', () => {
  it('deposit:钳制 workdir 内已存在目录;receipt 只带 token + 目录名', () => {
    const vault = new SaveDepositVault();
    const ok = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.receipt.dir_name).toBe('downloads');
      expect(Object.keys(ok.receipt).sort()).toEqual(['dir_name', 'token']);
    }
    expect(vault.deposit({ ghostId: 'g1', dirAbs: 'downloads', workdirAbs: workdir }).ok).toBe(false);
    expect(vault.deposit({ ghostId: 'g1', dirAbs: path.join(workdir, 'nope'), workdirAbs: workdir }).ok).toBe(false);
    expect(vault.deposit({ ghostId: 'g1', dirAbs: os.tmpdir(), workdirAbs: workdir }).ok).toBe(false);
    expect(vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: '' }).ok).toBe(false);
  });

  it('write:落盘 + 消毒 + 去重不覆盖;错 ghost / 伪造票据统一 null', async () => {
    const vault = new SaveDepositVault();
    const ok = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!ok.ok) throw new Error('deposit failed');
    const token = ok.receipt.token;

    const w1 = await vault.write('g1', token, '../../evil.txt', new Uint8Array([1, 2]));
    expect(w1).toEqual({ fileName: 'evil.txt' });
    expect(fs.readFileSync(path.join(saveDir, 'evil.txt'))).toEqual(Buffer.from([1, 2]));
    // 同名第二次:去重后缀,原文件不被覆盖。
    const w2 = await vault.write('g1', token, 'evil.txt', new Uint8Array([3]));
    expect(w2).toEqual({ fileName: 'evil (1).txt' });
    expect(fs.readFileSync(path.join(saveDir, 'evil.txt'))).toEqual(Buffer.from([1, 2]));

    expect(await vault.write('g2', token, 'a.txt', new Uint8Array([1]))).toBeNull();
    expect(await vault.write('g1', '00000000-0000-4000-8000-000000000000', 'a.txt', new Uint8Array([1]))).toBeNull();
  });

  it('写入前完整性校验失败会清掉本次创建的空文件，重试仍可使用原文件名', async () => {
    const vault = new SaveDepositVault();
    const deposited = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!deposited.ok) throw new Error('deposit failed');

    const originalStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementationOnce((filePath) => {
      const stat = originalStatSync(filePath);
      const tamperedIno = stat.ino === 0 ? 1 : 0;
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === 'ino') return tamperedIno;
          return Reflect.get(target, property, receiver);
        },
      });
    });
    try {
      await expect(
        vault.write('g1', deposited.receipt.token, 'integrity.txt', new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      statSpy.mockRestore();
    }

    const target = path.join(saveDir, 'integrity.txt');
    expect(fs.existsSync(target)).toBe(false);
    await expect(
      vault.write('g1', deposited.receipt.token, 'integrity.txt', new Uint8Array([4])),
    ).resolves.toEqual({ fileName: 'integrity.txt' });
    expect(fs.readFileSync(target)).toEqual(Buffer.from([4]));
  });

  it('部分写入失败会清掉残留字节，重试不会被迫改名', async () => {
    const vault = new SaveDepositVault();
    const deposited = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!deposited.ok) throw new Error('deposit failed');

    const target = path.join(saveDir, 'partial.bin');
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      return {
        stat: handle.stat.bind(handle),
        writeFile: async (data: Uint8Array) => {
          await originalWriteFile(data.subarray(0, 1));
          throw new Error('simulated EIO');
        },
        truncate: handle.truncate.bind(handle),
        close: handle.close.bind(handle),
      } as unknown as fs.promises.FileHandle;
    });
    try {
      await expect(
        vault.write('g1', deposited.receipt.token, 'partial.bin', new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.existsSync(target)).toBe(false);
    await expect(
      vault.write('g1', deposited.receipt.token, 'partial.bin', new Uint8Array([4, 5])),
    ).resolves.toEqual({ fileName: 'partial.bin' });
    expect(fs.readFileSync(target)).toEqual(Buffer.from([4, 5]));
  });

  it('写入失败期间目标被替换时不误删替代文件', async () => {
    if (process.platform === 'win32') return;

    const vault = new SaveDepositVault();
    const deposited = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!deposited.ok) throw new Error('deposit failed');

    const target = path.join(saveDir, 'replacement.bin');
    const moved = `${target}.moved`;
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      return {
        stat: handle.stat.bind(handle),
        writeFile: async (data: Uint8Array) => {
          await originalWriteFile(data.subarray(0, 1));
          await fs.promises.rename(target, moved);
          await fs.promises.writeFile(target, Buffer.from('replacement'));
          throw new Error('simulated EIO');
        },
        truncate: handle.truncate.bind(handle),
        close: handle.close.bind(handle),
      } as unknown as fs.promises.FileHandle;
    });
    try {
      await expect(
        vault.write('g1', deposited.receipt.token, 'replacement.bin', new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.readFileSync(target, 'utf8')).toBe('replacement');
    expect(fs.existsSync(moved)).toBe(true);
    expect(fs.readFileSync(moved)).toHaveLength(0);
  });

  it('写入完成后目标被移出批准目录时拒绝并清空原 inode', async () => {
    if (process.platform === 'win32') return;

    const vault = new SaveDepositVault();
    const deposited = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!deposited.ok) throw new Error('deposit failed');

    const target = path.join(saveDir, 'post-write-move.bin');
    const moved = `${target}.moved`;
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      return {
        stat: handle.stat.bind(handle),
        writeFile: async (data: Uint8Array) => {
          await originalWriteFile(data);
          await fs.promises.rename(target, moved);
        },
        truncate: handle.truncate.bind(handle),
        close: handle.close.bind(handle),
      } as unknown as fs.promises.FileHandle;
    });
    try {
      await expect(
        vault.write('g1', deposited.receipt.token, 'post-write-move.bin', new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readFileSync(moved)).toHaveLength(0);
  });

  it('close 失败按统一 null 语义返回并清理已创建文件', async () => {
    const vault = new SaveDepositVault();
    const deposited = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!deposited.ok) throw new Error('deposit failed');

    const target = path.join(saveDir, 'close-failure.bin');
    const originalOpen = fs.promises.open.bind(fs.promises);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      const originalClose = handle.close.bind(handle);
      let closeCalls = 0;
      return {
        stat: handle.stat.bind(handle),
        writeFile: (data: Uint8Array) => originalWriteFile(data),
        truncate: handle.truncate.bind(handle),
        close: async () => {
          closeCalls += 1;
          if (closeCalls === 1) throw new Error('simulated close failure');
          await originalClose();
        },
      } as unknown as fs.promises.FileHandle;
    });
    try {
      await expect(
        vault.write('g1', deposited.receipt.token, 'close-failure.bin', new Uint8Array([1, 2, 3])),
      ).resolves.toBeNull();
    } finally {
      openSpy.mockRestore();
    }

    expect(fs.existsSync(target)).toBe(false);
  });

  it('TTL 过期 / 次数写满自动作废', async () => {
    let now = 1_000_000;
    const vault = new SaveDepositVault(() => now);
    const ok = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!ok.ok) throw new Error('deposit failed');
    now += GHOST_SAVE_DEPOSIT_TTL_MS + 1;
    expect(await vault.write('g1', ok.receipt.token, 'late.txt', new Uint8Array([1]))).toBeNull();

    const ok2 = vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: workdir });
    if (!ok2.ok) throw new Error('deposit failed');
    for (let i = 0; i < GHOST_SAVE_DEPOSIT_MAX_USES; i++) {
      expect(await vault.write('g1', ok2.receipt.token, `f${i}.bin`, new Uint8Array([i]))).not.toBeNull();
    }
    expect(await vault.write('g1', ok2.receipt.token, 'over.bin', new Uint8Array([1]))).toBeNull();
  });
});

describe('SaveDepositVault userGranted 旁路(workdir 外确认卡通过后)', () => {
  it('workdir 外目录:未获确认拒,userGranted=true 放行且票据可写盘', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-outside-'));
    try {
      const vault = new SaveDepositVault();
      expect(vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: workdir }).ok).toBe(false);
      const expectedRealPath = await fs.promises.realpath(outside);
      const r = vault.deposit({
        ghostId: 'g1',
        dirAbs: expectedRealPath,
        workdirAbs: workdir,
        userGranted: true,
        expectedRealPath,
      });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const written = await vault.write('g1', r.receipt.token, 'a.txt', new TextEncoder().encode('hi'));
        expect(written?.fileName).toBe('a.txt');
        expect(await fs.promises.readFile(path.join(outside, 'a.txt'), 'utf8')).toBe('hi');
      }
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('无 workdir 语境(null):未获确认拒,userGranted=true 放行', () => {
    const vault = new SaveDepositVault();
    expect(vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: null }).ok).toBe(false);
    expect(vault.deposit({ ghostId: 'g1', dirAbs: saveDir, workdirAbs: null, userGranted: true }).ok).toBe(true);
  });

  it('授权后的 canonical 路径被换成 symlink 时拒绝出票', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-approved-dir-'));
    try {
      const approved = path.join(root, 'approved');
      const replacement = path.join(root, 'replacement');
      await fs.promises.mkdir(approved);
      await fs.promises.mkdir(replacement);
      const expectedRealPath = await fs.promises.realpath(approved);
      const replacementRealPath = await fs.promises.realpath(replacement);
      const moved = path.join(path.dirname(expectedRealPath), 'approved-moved');
      await fs.promises.rename(expectedRealPath, moved);
      try {
        await fs.promises.symlink(
          replacementRealPath,
          expectedRealPath,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch {
        return;
      }

      const result = new SaveDepositVault().deposit({
        ghostId: 'g1',
        dirAbs: expectedRealPath,
        workdirAbs: workdir,
        userGranted: true,
        expectedRealPath,
      });

      expect(result).toEqual({ ok: false, message: '路径在授权后发生变化，请重新确认' });
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it('出票后目标根被换成外部 symlink:write 拒绝且不在外部落盘', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'save-ticket-swap-'));
    try {
      const approved = path.join(root, 'approved');
      const outside = path.join(root, 'outside');
      await fs.promises.mkdir(approved);
      await fs.promises.mkdir(outside);
      const vault = new SaveDepositVault();
      const deposited = vault.deposit({
        ghostId: 'g1',
        dirAbs: approved,
        workdirAbs: workdir,
        userGranted: true,
      });
      if (!deposited.ok) throw new Error('deposit failed');

      await fs.promises.rename(approved, `${approved}-moved`);
      try {
        await fs.promises.symlink(
          outside,
          approved,
          process.platform === 'win32' ? 'junction' : 'dir',
        );
      } catch {
        return;
      }

      await expect(
        vault.write('g1', deposited.receipt.token, 'escaped.txt', new TextEncoder().encode('no')),
      ).resolves.toBeNull();
      await expect(fs.promises.stat(path.join(outside, 'escaped.txt'))).rejects.toThrow();
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
});
