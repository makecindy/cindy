import { describe, expect, it } from 'vitest';

import { projectKeyComparisonKey } from '../projectKeys';

describe('projectKeyComparisonKey', () => {
  it('case-folds local Windows drive paths after normalizing separators', () => {
    expect(projectKeyComparisonKey('local:C:\\Repo\\Cindy\\')).toBe('local:c:/repo/cindy');
    expect(projectKeyComparisonKey('local:c:/repo/cindy')).toBe('local:c:/repo/cindy');
  });

  it('case-folds local Windows UNC paths', () => {
    expect(projectKeyComparisonKey('local:\\\\Server\\Share\\Repo\\')).toBe(
      'local://server/share/repo',
    );
    expect(projectKeyComparisonKey('local://server/share/repo')).toBe(
      'local://server/share/repo',
    );
  });

  it('preserves case for local POSIX and remote/device project keys', () => {
    expect(projectKeyComparisonKey('local:/Users/Lee/Repo')).toBe('local:/Users/Lee/Repo');
    expect(projectKeyComparisonKey('remote:host-a:C:/Repo/Cindy')).toBe(
      'remote:host-a:C:/Repo/Cindy',
    );
    expect(projectKeyComparisonKey('device:device-a:C:/Repo/Cindy')).toBe(
      'device:device-a:C:/Repo/Cindy',
    );
  });
});
