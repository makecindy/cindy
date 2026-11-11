// @vitest-environment jsdom

import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { useSkillhubIdentityPolicy } from '../useSkillhubIdentityPolicy';

describe('useSkillhubIdentityPolicy', () => {
  it('keeps the organization publish entry available without probing server capabilities', () => {
    const { result } = renderHook(() => useSkillhubIdentityPolicy({
      membershipKind: 'org',
      orgSlug: 'example-org',
    }));

    expect(result.current.canWrite).toBe(true);
    expect(result.current.allowedVisibilities).toEqual(['PUBLIC', 'DEPARTMENT_SCOPED']);
  });

  it('does not special-case organization slugs in the renderer', () => {
    const first = renderHook(() => useSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'xd' }));
    const second = renderHook(() => useSkillhubIdentityPolicy({ membershipKind: 'org', orgSlug: 'other' }));

    expect(first.result.current).toEqual(second.result.current);
  });
});
