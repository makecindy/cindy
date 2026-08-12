import { describe, expect, it } from 'vitest';

import { isPathInside, repoRelativeFsPath } from '../fsPathGuard';

describe('git-review filesystem path guards', () => {
  it('keeps remote POSIX paths stable on a Windows controller', () => {
    expect(repoRelativeFsPath('/srv/repo', 'docs/readme.md')).toBe('/srv/repo/docs/readme.md');
    expect(isPathInside('/srv/repo', '/srv/repo/docs/readme.md')).toBe(true);
    expect(isPathInside('/srv/repo', '/srv/secret.txt')).toBe(false);
  });
});
