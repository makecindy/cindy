import { describe, expect, it } from 'vitest';

import { projectKeyComparisonKey } from '../projectKeys';

describe('projectKeyComparisonKey', () => {
  it('case-folds local Windows drive paths after normalizing separators', () => {
    expect(projectKeyComparisonKey('local:C:\\Repo\\Cindy\\', 'win32')).toBe(
      'local:c:/repo/cindy',
    );
    expect(projectKeyComparisonKey('local:c:/repo/cindy', 'win32')).toBe(
      'local:c:/repo/cindy',
    );
  });

  it('case-folds local Windows UNC paths', () => {
    expect(projectKeyComparisonKey('local:\\\\Server\\Share\\Repo\\', 'win32')).toBe(
      'local://server/share/repo',
    );
    expect(projectKeyComparisonKey('local://server/share/repo', 'win32')).toBe(
      'local://server/share/repo',
    );
  });

  it('preserves case for POSIX double-slash and drive-shaped local paths', () => {
    expect(projectKeyComparisonKey('local://mnt/Repo', 'linux')).toBe(
      'local://mnt/Repo',
    );
    expect(projectKeyComparisonKey('local://mnt/repo', 'linux')).toBe(
      'local://mnt/repo',
    );
    expect(projectKeyComparisonKey('local://mnt/Repo', 'darwin')).toBe(
      'local://mnt/Repo',
    );
    expect(projectKeyComparisonKey('local:C:/Repo/Cindy', 'linux')).toBe(
      'local:C:/Repo/Cindy',
    );
  });

  it('preserves case for local POSIX and remote/device project keys', () => {
    expect(projectKeyComparisonKey('local:/Users/Lee/Repo', 'darwin')).toBe(
      'local:/Users/Lee/Repo',
    );
    expect(projectKeyComparisonKey('remote:host-a:C:/Repo/Cindy', 'win32')).toBe(
      'remote:host-a:C:/Repo/Cindy',
    );
    expect(projectKeyComparisonKey('device:device-a:C:/Repo/Cindy', 'win32')).toBe(
      'device:device-a:C:/Repo/Cindy',
    );
  });
});
