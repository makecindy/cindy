import { describe, expect, it } from 'vitest';
import { parseSourceGitProgress } from '../sourceGit.js';

describe('Cindy Make Git progress', () => {
  it('parses Git progress without exposing the raw line', () => {
    expect(parseSourceGitProgress('remote: Receiving objects:  42% (123/456)')).toEqual({
      stage: 'receiving',
      percent: 42,
    });
    expect(parseSourceGitProgress('Resolving deltas: 100% (9/9)')).toEqual({
      stage: 'resolving',
      percent: 100,
    });
  });

  it('ignores ordinary output and invalid percentages', () => {
    expect(parseSourceGitProgress('remote: Total 9 (delta 1)')).toBeUndefined();
    expect(parseSourceGitProgress('Receiving objects: 101%')).toBeUndefined();
  });
});
