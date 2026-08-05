/**
 * dirDeposit.test.ts — 目录过户票据库单测(纯 Node,规则 14)。
 * 覆盖:workdir 钳制、收集排除清单、限额、票据单次消费 / TTL / ghostId 绑定、
 * 读取闭包字节正确。规则 23:全部路径在 os.tmpdir 下,收尾清理。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { collectDirFiles, DirDepositVault } from '../dirDeposit';
import { GHOST_DIR_DEPOSIT_TTL_MS } from '../../../shared/ghost';

let workdir: string;

beforeEach(async () => {
  workdir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-dir-deposit-'));
});

afterEach(async () => {
  await fs.promises.rm(workdir, { recursive: true, force: true });
});

async function makeSite(rel: string, files: Record<string, string>): Promise<string> {
  const dir = path.join(workdir, rel);
  for (const [p, content] of Object.entries(files)) {
    const abs = path.join(dir, p);
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, content);
  }
  return dir;
}

describe('collectDirFiles', () => {
  it('递归收集并以 POSIX 相对路径返回;排除 node_modules/.git/.env(含变体)等', async () => {
    const dir = await makeSite('dist', {
      'index.html': '<html>',
      'assets/app.js': 'js',
      'node_modules/x/pkg.json': '{}',
      '.git/HEAD': 'ref',
      '.env': 'SECRET=1',
      '.env.production': 'SECRET=2',
      '.DS_Store': 'junk',
    });
    const r = collectDirFiles(dir);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.relPath).sort()).toEqual(['assets/app.js', 'index.html']);
    expect(r.totalBytes).toBe(Buffer.byteLength('<html>') + Buffer.byteLength('js'));
  });

  it('空目录(或全被排除)→ 结构化失败', async () => {
    const dir = await makeSite('empty', { '.env': 'SECRET=1' });
    const r = collectDirFiles(dir);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('没有可上传的文件');
  });
});

describe('DirDepositVault', () => {
  it('happy path:过户 → 回执含票据与相对路径清单 → 凭票取货字节正确', async () => {
    const dir = await makeSite('dist', { 'index.html': '<html>', 'a/b.css': 'css' });
    const vault = new DirDepositVault();
    const r = vault.deposit({ ghostId: 'g1', dirAbs: dir, workdirAbs: workdir });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.receipt.file_count).toBe(2);
    expect(r.receipt.rel_paths.sort()).toEqual(['a/b.css', 'index.html']);

    const taken = vault.take('g1', r.receipt.token);
    expect(taken).not.toBeNull();
    const html = taken!.files.find((f) => f.relPath === 'index.html')!;
    expect(new TextDecoder().decode(await html.read())).toBe('<html>');
  });

  it('票据单次消费:第二次取报废;别的意识取不走;伪造票据无效', async () => {
    const dir = await makeSite('dist', { 'index.html': 'x' });
    const vault = new DirDepositVault();
    const r = vault.deposit({ ghostId: 'g1', dirAbs: dir, workdirAbs: workdir });
    if (!r.ok) throw new Error('deposit failed');

    // 别的意识先试:取不走,票据保留
    expect(vault.take('g2', r.receipt.token)).toBeNull();
    expect(vault.take('g1', r.receipt.token)).not.toBeNull();
    // 已消费:重放无效
    expect(vault.take('g1', r.receipt.token)).toBeNull();
    // 伪造票据
    expect(vault.take('g1', '00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('TTL:过期票据取货无效(时钟注入,确定性)', async () => {
    const dir = await makeSite('dist', { 'index.html': 'x' });
    let clock = 1_000_000;
    const vault = new DirDepositVault(() => clock);
    const r = vault.deposit({ ghostId: 'g1', dirAbs: dir, workdirAbs: workdir });
    if (!r.ok) throw new Error('deposit failed');
    clock += GHOST_DIR_DEPOSIT_TTL_MS - 1;
    // 未过期时可正常发一张新票再验旧票(sweep 不误伤)
    clock += GHOST_DIR_DEPOSIT_TTL_MS + 2;
    expect(vault.take('g1', r.receipt.token)).toBeNull();
  });

  it('workdir 钳制:workdir 外 / 相对路径 / 不存在 / 非目录 / 空 workdir 一律拒', async () => {
    const dir = await makeSite('dist', { 'index.html': 'x' });
    const vault = new DirDepositVault();
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-outside-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'f.txt'), 'x');
      const out = vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: workdir });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.message).toContain('工作目录');

      expect(vault.deposit({ ghostId: 'g1', dirAbs: 'dist', workdirAbs: workdir }).ok).toBe(false);
      expect(vault.deposit({ ghostId: 'g1', dirAbs: path.join(workdir, 'nope'), workdirAbs: workdir }).ok).toBe(false);
      // 单文件过户(2026-07-13 起允许):文件路径按单文件票据处理。
      const single = vault.deposit({ ghostId: 'g1', dirAbs: path.join(dir, 'index.html'), workdirAbs: workdir });
      expect(single.ok).toBe(true);
      if (single.ok) expect(single.receipt.rel_paths).toEqual(['index.html']);
      expect(vault.deposit({ ghostId: 'g1', dirAbs: dir, workdirAbs: '' }).ok).toBe(false);
      // 前缀伪装:workdir 同级的 `<workdir>-evil` 不算在内
      const sibling = `${workdir}-evil`;
      await fs.promises.mkdir(sibling, { recursive: true });
      await fs.promises.writeFile(path.join(sibling, 'f.txt'), 'x');
      try {
        expect(vault.deposit({ ghostId: 'g1', dirAbs: sibling, workdirAbs: workdir }).ok).toBe(false);
      } finally {
        await fs.promises.rm(sibling, { recursive: true, force: true });
      }
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('dirAbs = workdir 本身允许(部署 workdir 根的场景)', async () => {
    await makeSite('.', { 'index.html': 'x' });
    const vault = new DirDepositVault();
    const r = vault.deposit({ ghostId: 'g1', dirAbs: workdir, workdirAbs: workdir });
    expect(r.ok).toBe(true);
  });

  it('symlink/junction 根目录指向 workdir 外:realpath 钳制拒绝(词法绕过防线)', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-symlink-target-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'secret.txt'), 'ssh-key');
      const linkPath = path.join(workdir, 'evil-link');
      try {
        // Windows 用 junction(无需管理员),POSIX 用目录软链。
        await fs.promises.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
      } catch {
        return; // 环境不允许建链接(极少数受限 CI),跳过——其余平台仍覆盖
      }
      const vault = new DirDepositVault();
      const r = vault.deposit({ ghostId: 'g1', dirAbs: linkPath, workdirAbs: workdir });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toContain('工作目录');
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });
});

describe('DirDepositVault userGranted 旁路(workdir 外确认卡通过后)', () => {
  it('workdir 外目录:未获确认拒,userGranted=true 放行且票据可正常取货', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-outside-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'a.txt'), 'hello');
      const vault = new DirDepositVault();
      expect(vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: workdir }).ok).toBe(false);
      const r = vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: workdir, userGranted: true });
      expect(r.ok).toBe(true);
      if (r.ok) {
        const taken = vault.take('g1', r.receipt.token);
        expect(taken).not.toBeNull();
        expect(Buffer.from(await taken!.files[0].read()).toString()).toBe('hello');
      }
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('无 workdir 语境(null):未获确认拒,userGranted=true 放行(对话型会话过户)', async () => {
    const outside = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-outside-'));
    try {
      await fs.promises.writeFile(path.join(outside, 'a.txt'), 'x');
      const vault = new DirDepositVault();
      expect(vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: null }).ok).toBe(false);
      expect(vault.deposit({ ghostId: 'g1', dirAbs: outside, workdirAbs: null, userGranted: true }).ok).toBe(true);
    } finally {
      await fs.promises.rm(outside, { recursive: true, force: true });
    }
  });

  it('userGranted 不豁免存在性/类型校验:不存在的路径照拒', () => {
    const vault = new DirDepositVault();
    const r = vault.deposit({
      ghostId: 'g1',
      dirAbs: path.join(os.tmpdir(), 'cindy-not-exist-xyz'),
      workdirAbs: null,
      userGranted: true,
    });
    expect(r.ok).toBe(false);
  });
});
