import { describe, it, expect } from 'vitest';

import { __extraDirsPathOverlapForTesting } from '../components/new-chat/extraDirsActions';

describe('ExtraDirsButton path overlap normalization', () => {
  const { hasExtraDir, isParentOrAncestor, isSelfOrSubdir } = __extraDirsPathOverlapForTesting;

  it('dedupes picked Windows paths against stored POSIX-style draft paths', () => {
    expect(hasExtraDir(['D:/repo/refs'], 'D:\\repo\\refs\\')).toBe(true);
  });

  it('compares workingDir parent/subdir relationships after storage normalization', () => {
    expect(isSelfOrSubdir('D:\\repo\\app\\src', 'D:/repo/app')).toBe(true);
    expect(isParentOrAncestor('D:\\repo', 'D:/repo/app')).toBe(true);
    expect(isSelfOrSubdir('D:\\repo-other', 'D:/repo')).toBe(false);
  });
});
