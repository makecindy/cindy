import { createRequire } from 'node:module';

interface SemverApi {
  compare(left: string, right: string): number;
  valid(version: string): string | null;
}

const semver = createRequire(import.meta.url)('semver') as SemverApi;

export type AppUpdateVersionRelation = 'newer' | 'same' | 'older' | 'invalid';

/**
 * App updates are forward-only. Versions must be valid SemVer values; malformed
 * versions fail closed instead of being coerced into an installable target.
 */
export function compareAppUpdateVersions(
  targetVersion: unknown,
  currentVersion: unknown,
): AppUpdateVersionRelation {
  if (typeof targetVersion !== 'string' || typeof currentVersion !== 'string') {
    return 'invalid';
  }

  const target = semver.valid(targetVersion);
  const current = semver.valid(currentVersion);
  if (!target || !current) return 'invalid';

  const comparison = semver.compare(target, current);
  if (comparison > 0) return 'newer';
  if (comparison < 0) return 'older';
  return 'same';
}
