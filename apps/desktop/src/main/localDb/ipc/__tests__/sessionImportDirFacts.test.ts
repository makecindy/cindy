import { describe, expect, it, vi } from 'vitest';

import { createGitRepoProbe } from '../sessionImportDirFacts.js';

describe('createGitRepoProbe', () => {
  it('stats each unique directory once and reports only git repositories', async () => {
    const statExists = vi.fn(async (target: string) => target.startsWith('/w/repo'));
    const probe = createGitRepoProbe(statExists);
    expect(await probe(['/w/repo', '/w/plain', '/w/repo', ''])).toEqual(['/w/repo']);
    expect(await probe(['/w/plain', '/w/repo'])).toEqual(['/w/repo']);
    expect(statExists).toHaveBeenCalledTimes(2);
    expect(statExists.mock.calls.map(([target]) => target.replace(/\\/g, '/'))).toEqual(['/w/repo/.git', '/w/plain/.git']);
  });
});
