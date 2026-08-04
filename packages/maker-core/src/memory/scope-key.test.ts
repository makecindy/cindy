/**
 * buildMemoryScopeKey / memoryScopeDirName — Maker Memory 的 store 定位键与
 * 落盘目录名规则:
 *  - 本地会话原样用 workdir(既有存储目录不迁移,目录名走 sanitizeWorkdir);
 *  - SSH remote 会话用 `ssh:<hostId>:<workdir>` 复合键,目录名走碰撞安全的
 *    hash 形态 — 有损的 sanitizeWorkdir 会让 `ssh:prod:/repo` 与本地路径
 *    `/ssh/prod:/repo` 撞成同一目录 (review R4 P2)。
 */

import { describe, expect, it } from 'vitest';

import { buildMemoryScopeKey, memoryScopeDirName, sanitizeWorkdir } from './storage.js';

describe('buildMemoryScopeKey', () => {
  it('本地会话 (无 remoteHostId) 原样返回 workdir — 既有 store 目录不迁移', () => {
    expect(buildMemoryScopeKey('/Users/sam/proj')).toBe('/Users/sam/proj');
    expect(buildMemoryScopeKey('E:\\AIWork\\xdt-maker', null)).toBe('E:\\AIWork\\xdt-maker');
    expect(buildMemoryScopeKey('/Users/sam/proj', undefined)).toBe('/Users/sam/proj');
  });

  it('SSH remote 会话产出 ssh:<host 段>:<workdir> 复合键 (常规 alias 编码前后相同)', () => {
    expect(buildMemoryScopeKey('/home/me/proj', 'my-host')).toBe('ssh:my-host:/home/me/proj');
  });

  it('key 对 (hostId, workdir) 是单射 — 分隔符拼接歧义回归 (review R5 P2)', () => {
    // 裸拼接时这两组会撞成同一个 `ssh:prod:/x:/repo`。
    const a = buildMemoryScopeKey('/x:/repo', 'prod');
    const b = buildMemoryScopeKey('/repo', 'prod:/x');
    expect(a).not.toBe(b);
    expect(memoryScopeDirName(a)).not.toBe(memoryScopeDirName(b));
  });

  it('远端路径与本地同名路径隔离;不同 host 上的同名路径互相隔离', () => {
    const local = buildMemoryScopeKey('/home/me/proj');
    const hostA = buildMemoryScopeKey('/home/me/proj', 'host-a');
    const hostB = buildMemoryScopeKey('/home/me/proj', 'host-b');
    expect(new Set([local, hostA, hostB]).size).toBe(3);
    expect(
      new Set([memoryScopeDirName(local), memoryScopeDirName(hostA), memoryScopeDirName(hostB)]).size,
    ).toBe(3);
  });
});

describe('memoryScopeDirName', () => {
  it('本地键沿用 sanitizeWorkdir — 既有目录不迁移', () => {
    for (const dir of ['/Users/sam/proj', 'E:\\AIWork\\xdt-maker']) {
      expect(memoryScopeDirName(buildMemoryScopeKey(dir))).toBe(sanitizeWorkdir(dir));
    }
  });

  it('远端键的目录名对 sanitize 撞车免疫 (review R4 P2 回归)', () => {
    // sanitizeWorkdir 有损:这两个 key 的 sanitize 结果相同, 目录名必须不同。
    const remote = buildMemoryScopeKey('/repo', 'prod'); // ssh:prod:/repo
    const localTrap = buildMemoryScopeKey('/ssh/prod:/repo'); // 本地路径
    expect(sanitizeWorkdir(remote)).toBe(sanitizeWorkdir(localTrap)); // 前提成立
    expect(memoryScopeDirName(remote)).not.toBe(memoryScopeDirName(localTrap));
    // hostId 含冒号 (SSH alias 未限制冒号) 也互不相撞。
    const tricky = buildMemoryScopeKey('/repo', 'prod:/x');
    expect(memoryScopeDirName(tricky)).not.toBe(memoryScopeDirName(remote));
  });

  it('远端目录名定长有界且只含文件名安全字符 (非 ASCII / 超长路径免疫)', () => {
    const long = buildMemoryScopeKey(`/远端/项目/${'x'.repeat(500)}`, '跳板机-α');
    const dir = memoryScopeDirName(long);
    expect(dir.length).toBeLessThanOrEqual(64);
    expect(dir).toMatch(/^ssh-.*-[0-9a-f]{16}$/);
    expect(dir).not.toMatch(/[\\/:]/);
    // 同 key 稳定 (目录名是持久事实, 不能随进程变)。
    expect(memoryScopeDirName(long)).toBe(dir);
  });
});
