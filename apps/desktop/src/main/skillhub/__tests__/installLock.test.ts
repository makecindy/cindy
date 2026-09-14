import { describe, expect, it } from 'vitest';

import { getSkillInstallLockOwner, tryAcquireSkillInstallLock } from '../installLock';

describe('installLock(final-switch 共享互斥)', () => {
  it('获取 → 持有者可查;释放后可再次获取', () => {
    const release = tryAcquireSkillInstallLock('skill-a', 'market-install');
    expect(release).toBeTypeOf('function');
    expect(getSkillInstallLockOwner('skill-a')).toBe('market-install');

    release!();
    expect(getSkillInstallLockOwner('skill-a')).toBeNull();

    const again = tryAcquireSkillInstallLock('skill-a', 'learn-apply');
    expect(again).toBeTypeOf('function');
    expect(getSkillInstallLockOwner('skill-a')).toBe('learn-apply');
    again!();
  });

  it('同名持有中,任一方再获取都失败(fail-fast,不排队)', () => {
    const release = tryAcquireSkillInstallLock('skill-b', 'learn-apply');
    expect(release).not.toBeNull();

    expect(tryAcquireSkillInstallLock('skill-b', 'market-install')).toBeNull();
    expect(tryAcquireSkillInstallLock('skill-b', 'market-uninstall')).toBeNull();
    expect(tryAcquireSkillInstallLock('skill-b', 'learn-apply')).toBeNull();
    expect(getSkillInstallLockOwner('skill-b')).toBe('learn-apply');
    release!();
  });

  it('shares case variants across mutation owners and keeps release tokens isolated', () => {
    const first = tryAcquireSkillInstallLock('Mixed-Case', 'market-uninstall')!;
    try {
      expect(getSkillInstallLockOwner('mixed-case')).toBe('market-uninstall');
      for (const owner of ['market-install', 'learn-apply', 'local-import', 'local-rename'] as const) {
        const conflicting = tryAcquireSkillInstallLock('MIXED-CASE', owner);
        conflicting?.();
        expect(conflicting).toBeNull();
      }
    } finally { first(); }
    const second = tryAcquireSkillInstallLock('mixed-case', 'market-install')!;
    try {
      first();
      expect(getSkillInstallLockOwner('Mixed-Case')).toBe('market-install');
    } finally { second(); }
    expect(getSkillInstallLockOwner('MIXED-CASE')).toBeNull();
  });

  it('不同名互不阻塞', () => {
    const a = tryAcquireSkillInstallLock('skill-c', 'market-install');
    const b = tryAcquireSkillInstallLock('skill-d', 'learn-apply');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!();
    b!();
  });

  it('release 幂等,且迟到的旧 release 不会误释放后来者', () => {
    const first = tryAcquireSkillInstallLock('skill-e', 'market-install');
    first!();
    first!(); // 重复调用无副作用

    const second = tryAcquireSkillInstallLock('skill-e', 'learn-apply');
    expect(second).not.toBeNull();
    first!(); // 旧凭据迟到释放 —— 不得删掉 second 的持有
    expect(getSkillInstallLockOwner('skill-e')).toBe('learn-apply');
    second!();
    expect(getSkillInstallLockOwner('skill-e')).toBeNull();
  });
});
