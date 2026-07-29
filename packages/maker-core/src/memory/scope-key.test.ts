/**
 * buildMemoryScopeKey — Maker Memory 的 store 定位键规则:
 * 本地会话原样用 workdir(既有存储目录不迁移);SSH remote 会话用
 * `ssh:<hostId>:<workdir>` 复合键,远端路径与本地同名路径、不同 host 上的
 * 同名路径都必须落到不同 store。
 */

import { describe, expect, it } from 'vitest';

import { buildMemoryScopeKey, sanitizeWorkdir } from './storage.js';

describe('buildMemoryScopeKey', () => {
  it('本地会话 (无 remoteHostId) 原样返回 workdir — 既有 store 目录不迁移', () => {
    expect(buildMemoryScopeKey('/Users/sam/proj')).toBe('/Users/sam/proj');
    expect(buildMemoryScopeKey('E:\\AIWork\\xdt-maker', null)).toBe('E:\\AIWork\\xdt-maker');
    expect(buildMemoryScopeKey('/Users/sam/proj', undefined)).toBe('/Users/sam/proj');
  });

  it('SSH remote 会话产出 ssh:<hostId>:<workdir> 复合键', () => {
    expect(buildMemoryScopeKey('/home/me/proj', 'my-host')).toBe('ssh:my-host:/home/me/proj');
  });

  it('远端路径与本地同名路径隔离;不同 host 上的同名路径互相隔离', () => {
    const local = buildMemoryScopeKey('/home/me/proj');
    const hostA = buildMemoryScopeKey('/home/me/proj', 'host-a');
    const hostB = buildMemoryScopeKey('/home/me/proj', 'host-b');
    expect(new Set([local, hostA, hostB]).size).toBe(3);
    // sanitize 后的目录名同样不撞车 (store 目录按 sanitizeWorkdir(key) 落盘)。
    expect(new Set([sanitizeWorkdir(local), sanitizeWorkdir(hostA), sanitizeWorkdir(hostB)]).size).toBe(3);
  });

  it('复合键可被 sanitizeWorkdir 转成合法目录名', () => {
    const key = buildMemoryScopeKey('/home/me/proj', 'my-host');
    const dir = sanitizeWorkdir(key);
    expect(dir).not.toMatch(/[\\/:]/);
    expect(dir.length).toBeGreaterThan(0);
  });
});
