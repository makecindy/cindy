/**
 * codex-auth-link 单测 — 真实 fs tmpdir fixture。
 *
 * 这套测试守护 reconcile 替换 codex auth.json 共享链接时的原子性、自愈与并发安全。
 * 名 + 无串行化导致并发撞 `EEXIST` / `ENOENT`,且 rename 失败会让用户的 auth.json 凭空消失。
 * 覆盖:
 *   - 基本 link(myAuth 已存在 / 不存在)→ 'linked' 且与 systemAuth 同 inode、内容一致
 *   - systemAuth 不存在 → 'link-unsupported' 且 myAuth 不受影响
 *   - 并发回归(核心):大量并发 relink 全部 settle、无 'lost'、结束后 myAuth 完好且共享 inode
 *   - recoverCodexAuth 兜底:systemAuth 在→重建成功;不在→失败
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  inspectCodexAuthLink,
  relinkSharedCodexAuth,
  recoverCodexAuth,
} from '../maker-host/codex-auth-link';

let tmpRoot: string;
let systemAuth: string;
let myAuth: string;

const SYSTEM_CONTENT = JSON.stringify({ tokens: { access_token: 'system-token' } });
const MY_CONTENT = JSON.stringify({ tokens: { access_token: 'stale-local-token' } });

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-link-test-'));
  // 模拟 ~/.codex/auth.json 与 codex-home/auth.json 两个独立路径。
  systemAuth = path.join(tmpRoot, 'system', 'auth.json');
  myAuth = path.join(tmpRoot, 'codex-home', 'auth.json');
  fs.mkdirSync(path.dirname(systemAuth), { recursive: true });
  fs.mkdirSync(path.dirname(myAuth), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 两个路径最终是否解析到同一个 inode。 */
function sameInode(a: string, b: string): boolean {
  const sa = fs.statSync(a);
  const sb = fs.statSync(b);
  return sa.dev === sb.dev && sa.ino === sb.ino;
}

/** 列出 myAuth 同目录下残留的 .linktmp sidecar 文件。 */
function leftoverSidecars(): string[] {
  return fs.readdirSync(path.dirname(myAuth)).filter((name) => name.includes('.linktmp'));
}

describe('relinkSharedCodexAuth', () => {
  it('POSIX:myAuth 已存在→原子替换为 symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out.kind).toBe('linked');
    expect(out.linkType).toBe('symlink');
    expect(out.error).toBeUndefined();
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('POSIX:myAuth 不存在 → linked,直接建出 symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out.kind).toBe('linked');
    expect(out.linkType).toBe('symlink');
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('POSIX:系统 auth 原子替换后 symlink 自动跟随新 inode', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');
    const oldInode = fs.statSync(myAuth).ino;
    const replacement = `${systemAuth}.new`;
    fs.writeFileSync(replacement, JSON.stringify({ tokens: { access_token: 'rotated' } }));

    fs.renameSync(replacement, systemAuth);

    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(true);
    expect(fs.statSync(myAuth).ino).not.toBe(oldInode);
    expect(fs.readFileSync(myAuth, 'utf-8')).toContain('rotated');
  });

  it('Windows 策略保留 hardlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32');

    expect(out).toMatchObject({ kind: 'linked', linkType: 'hardlink' });
    expect(fs.lstatSync(myAuth).isSymbolicLink()).toBe(false);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
  });

  it('Windows 跨分区 hardlink 失败时保留原凭证', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'win32');

    expect(out.kind).toBe('link-unsupported');
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(MY_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('POSIX 会原子替换 dangling symlink', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.symlinkSync(path.join(tmpRoot, 'missing-auth.json'), myAuth);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    expect(out).toMatchObject({ kind: 'linked', linkType: 'symlink' });
    expect(fs.readFileSync(myAuth, 'utf8')).toBe(SYSTEM_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('systemAuth 不存在 → link-unsupported,myAuth 一字未动', async () => {
    fs.writeFileSync(myAuth, MY_CONTENT);

    const out = await relinkSharedCodexAuth(systemAuth, myAuth);

    expect(out.kind).toBe('link-unsupported');
    expect(out.error).toBeInstanceOf(Error);
    // myAuth 原样保留,绝不能被删。
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(MY_CONTENT);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('并发回归:20 个并发 relink 全部 settle、无 lost,结束后 myAuth 完好且共享 inode', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    // 旧实现(固定 sidecar + rm→rename)在这里会撞 EEXIST/ENOENT,甚至把 myAuth 弄丢。
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => relinkSharedCodexAuth(systemAuth, myAuth)),
    );

    // 没有任何一次把 auth.json 弄丢。
    expect(outcomes.some((o) => o.kind === 'lost')).toBe(false);
    // 至少有人成功建立了共享链接。
    expect(outcomes.some((o) => o.kind === 'linked')).toBe(true);
    // 终态:myAuth 存在、内容是 systemAuth、与 systemAuth 同 inode、无残留 sidecar。
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
  });

  it('幂等:对已是 symlink 的 myAuth 再 relink 仍 linked、仍共享', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    const first = await relinkSharedCodexAuth(systemAuth, myAuth);
    expect(first.kind).toBe('linked');
    const second = await relinkSharedCodexAuth(systemAuth, myAuth);

    expect(second.kind).toBe('linked');
    expect(sameInode(systemAuth, myAuth)).toBe(true);
    expect(leftoverSidecars()).toEqual([]);
  });
});

describe('recoverCodexAuth', () => {
  it('systemAuth 存在 → 重建 myAuth 并返回 true', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    expect(fs.existsSync(myAuth)).toBe(false);

    const ok = await recoverCodexAuth(systemAuth, myAuth);

    expect(ok).toBe(true);
    expect(fs.existsSync(myAuth)).toBe(true);
    expect(fs.readFileSync(myAuth, 'utf-8')).toBe(SYSTEM_CONTENT);
  });

  it('systemAuth 不存在 → 返回 false,不创建 myAuth', async () => {
    const ok = await recoverCodexAuth(systemAuth, myAuth);

    expect(ok).toBe(false);
    expect(fs.existsSync(myAuth)).toBe(false);
  });

  it('Windows recovery hardlink 失败时不复制 token 副本', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    vi.spyOn(fs.promises, 'link').mockRejectedValueOnce(
      Object.assign(new Error('cross-device link'), { code: 'EXDEV' }),
    );

    await expect(recoverCodexAuth(systemAuth, myAuth, 'win32')).resolves.toBe(false);
    expect(fs.existsSync(myAuth)).toBe(false);
  });
});

describe('inspectCodexAuthLink', () => {
  it('本地缺失时仍返回系统权威文件元数据', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toMatchObject({
      linkType: 'missing',
      healthy: false,
      systemAuthMtimeMs: expect.any(Number),
      systemAuthLinkCount: 1,
    });
  });

  it('返回 symlink 健康度与权威文件元数据', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    await relinkSharedCodexAuth(systemAuth, myAuth, 'darwin');

    const diagnostics = await inspectCodexAuthLink(systemAuth, myAuth);

    expect(diagnostics).toMatchObject({ linkType: 'symlink', healthy: true });
    expect(diagnostics.systemAuthMtimeMs).toEqual(expect.any(Number));
    expect(diagnostics.systemAuthLinkCount).toBe(1);
  });

  it('识别 dangling symlink', async () => {
    fs.symlinkSync(systemAuth, myAuth);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toEqual({
      linkType: 'dangling-symlink',
      healthy: false,
    });
  });

  it('识别无 provenance 普通文件为不健康', async () => {
    fs.writeFileSync(systemAuth, SYSTEM_CONTENT);
    fs.writeFileSync(myAuth, MY_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toMatchObject({
      linkType: 'file',
      healthy: false,
    });
  });

  it('系统权威文件缺失时仍识别本地普通文件', async () => {
    fs.writeFileSync(myAuth, MY_CONTENT);

    await expect(inspectCodexAuthLink(systemAuth, myAuth)).resolves.toEqual({
      linkType: 'file',
      healthy: false,
    });
  });
});
