import { describe, expect, it } from 'vitest';

import { deriveSkillSource } from '../skillSource';

describe('deriveSkillSource', () => {
  it('treats explicit installed origin as skillhub', () => {
    // 显式 origin 优先,不受 registry/isMine 影响
    expect(deriveSkillSource('installed', true, false)).toBe('skillhub');
    expect(deriveSkillSource('installed', true, true)).toBe('skillhub');
  });

  it('treats explicit published origin as local', () => {
    // 自己发布的本地目录是 dev 副本,没走 SkillHub 安装
    expect(deriveSkillSource('published', true, true)).toBe('local');
  });

  it('treats explicit learned origin as local', () => {
    expect(deriveSkillSource('learned', true, false)).toBe('local');
  });

  it('treats explicit imported origin as local', () => {
    expect(deriveSkillSource('imported', true, false)).toBe('local');
    expect(deriveSkillSource('imported', true, true)).toBe('local');
  });

  it('treats pre-origin foreign registry records as skillhub', () => {
    // 历史遗留:有 registry 记录、origin 缺失,server 明确判定不是我的 → 他人历史安装
    expect(deriveSkillSource(undefined, true, false)).toBe('skillhub');
    expect(deriveSkillSource(null, true, false)).toBe('skillhub');
  });

  it('treats pre-origin own / unknown registry records as local (conservative)', () => {
    // 我的历史记录(reconcile 会回填为 published);isMine 未知时保守判 local
    expect(deriveSkillSource(undefined, true, true)).toBe('local');
    expect(deriveSkillSource(undefined, true, null)).toBe('local');
    expect(deriveSkillSource(undefined, true, undefined)).toBe('local');
  });

  it('treats hand-authored skills without registry as local', () => {
    // 纯本地手写:无 registry 记录,即便 server 恰好判定 foreign 也不算 skillhub
    expect(deriveSkillSource(undefined, false, null)).toBe('local');
    expect(deriveSkillSource(undefined, false, false)).toBe('local');
  });
});
