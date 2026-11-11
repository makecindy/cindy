import { describe, it, expect } from 'vitest';
import { lacksTeamManagePermission } from '../manageGuard';

type Role = 'admin' | 'publisher' | 'viewer';

function roleMap(entries: Record<string, Role | undefined>): Map<string, Role | undefined> {
  return new Map(Object.entries(entries));
}

describe('lacksTeamManagePermission', () => {
  it('个人归属(非 org)永远有权,不拦截', () => {
    const map = roleMap({});
    expect(lacksTeamManagePermission({ ownerType: 'personal', authorId: 'me' }, map)).toBe(false);
    expect(lacksTeamManagePermission({ ownerType: undefined, authorId: 'me' }, map)).toBe(false);
    expect(lacksTeamManagePermission({ ownerType: 'user', authorId: 'me' }, map)).toBe(false);
  });

  it('团队归属 + 我是 admin/publisher → 有权,不拦截', () => {
    const map = roleMap({ 'team-a': 'admin', 'team-b': 'publisher' });
    expect(lacksTeamManagePermission({ ownerType: 'org', authorId: 'team-a' }, map)).toBe(false);
    expect(lacksTeamManagePermission({ ownerType: 'org', authorId: 'team-b' }, map)).toBe(false);
  });

  it('团队归属 + 我是 viewer → 无权,拦截', () => {
    const map = roleMap({ 'team-c': 'viewer' });
    expect(lacksTeamManagePermission({ ownerType: 'org', authorId: 'team-c' }, map)).toBe(true);
    expect(lacksTeamManagePermission({ ownerType: 'organization', authorId: 'team-c' }, map)).toBe(true);
  });

  it('角色未知(团队不在列表 / Hub 未返回 myRole)→ 不主动拦截,留给 403 兜底', () => {
    const missing = roleMap({});
    expect(lacksTeamManagePermission({ ownerType: 'org', authorId: 'team-x' }, missing)).toBe(false);
    const undef = roleMap({ 'team-y': undefined });
    expect(lacksTeamManagePermission({ ownerType: 'org', authorId: 'team-y' }, undef)).toBe(false);
  });
});
