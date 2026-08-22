/**
 * C 边界规范化回归:main 侧 `local-db:sessions:create` 经由 sessionCreateToRow
 * 入库,remoteHostId 必须统一收敛成 "trim 后非空字符串 | null"。
 *
 * 背景:IPC 是信任边界,renderer 正常路径已 trim,但脚本/测试/未来新入口可能传入
 * 空串。若空串原样入库,renderer grouping(`s.remoteHostId ? 'remote' : 'local'`)
 * 会把它当本地,而 recent_workdirs 排除(`!insertRow.remoteHostId`)与 maker send
 * 等路径对 remote 的判断会出现不一致。这里把"空值一律落 null"钉死成单一真相。
 */

import { describe, it, expect } from 'vitest';

import {
  normalizeRemoteHostId,
  normalizeRemoteHostRefForCreate,
  sessionCreateToRow,
} from '../mapper';

describe('normalizeRemoteHostId', () => {
  it('保留 trim 后非空字符串', () => {
    expect(normalizeRemoteHostId('host-a')).toBe('host-a');
    expect(normalizeRemoteHostId('  host-a  ')).toBe('host-a');
  });

  it('undefined / null / 空串 / 纯空白 → null', () => {
    expect(normalizeRemoteHostId(undefined)).toBeNull();
    expect(normalizeRemoteHostId(null)).toBeNull();
    expect(normalizeRemoteHostId('')).toBeNull();
    expect(normalizeRemoteHostId('   ')).toBeNull();
    expect(normalizeRemoteHostId('\t\n')).toBeNull();
  });
});

describe('sessionCreateToRow remoteHostId 规范化', () => {
  const now = 1_700_000_000_000;

  it('新 session 把 legacy SSH alias 写成 canonical HostRef', () => {
    const row = sessionCreateToRow('id1', { workingDir: '/repo', remoteHostId: '  host-a ' }, now);
    expect(row.remoteHostId).toBe('ssh-config:host-a');
  });

  it('保留已带命名空间的 HostRef，只在第一个冒号处分隔', () => {
    expect(normalizeRemoteHostRefForCreate('ssh-config:host:with:colons'))
      .toBe('ssh-config:host:with:colons');
    expect(normalizeRemoteHostRefForCreate('cindy:profile-id')).toBe('cindy:profile-id');
    expect(normalizeRemoteHostRefForCreate('host:with:colons'))
      .toBe('ssh-config:host:with:colons');
  });

  it('空串入参落 null(本地语义)', () => {
    const row = sessionCreateToRow('id2', { workingDir: '/repo', remoteHostId: '' }, now);
    expect(row.remoteHostId).toBeNull();
  });

  it('未传 remoteHostId 落 null', () => {
    const row = sessionCreateToRow('id3', { workingDir: '/repo' }, now);
    expect(row.remoteHostId).toBeNull();
  });
});
