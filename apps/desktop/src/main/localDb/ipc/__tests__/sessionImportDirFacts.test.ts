import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createGitRepoProbe } from '../sessionImportDirFacts.js';

describe('createGitRepoProbe', () => {
  it('stats each unique directory once and reports only git repositories', async () => {
    const statExists = vi.fn(async (target: string) => target === path.join('/w/repo', '.git'));
    const probe = createGitRepoProbe(statExists);
    expect(await probe(['/w/repo', '/w/plain', '/w/repo', ''])).toEqual(['/w/repo']);
    expect(await probe(['/w/plain', '/w/repo'])).toEqual(['/w/repo']);
    expect(statExists).toHaveBeenCalledTimes(2);
    expect(statExists.mock.calls.map(([target]) => target)).toEqual([path.join('/w/repo', '.git'), path.join('/w/plain', '.git')]);
  });

  it('checks a directory again after five minutes, so a newly created or removed repo is noticed', async () => {
    let now = 0;
    let isRepo = false;
    const statExists = vi.fn(async () => isRepo);
    const probe = createGitRepoProbe(statExists, () => now);
    expect(await probe(['/w/app'])).toEqual([]);
    isRepo = true;
    now = 4 * 60_000;
    expect(await probe(['/w/app'])).toEqual([]);
    now = 5 * 60_000;
    expect(await probe(['/w/app'])).toEqual(['/w/app']);
    expect(statExists).toHaveBeenCalledTimes(2);
  });
});
