import { createRequire } from 'node:module';

interface SemverApi {
  compare(left: string, right: string): number;
  valid(version: string): string | null;
}

const semver = createRequire(import.meta.url)('semver') as SemverApi;

export type AppUpdateVersionRelation = 'newer' | 'same' | 'older' | 'invalid';

/** Normalize a strict app-update SemVer value, or fail closed for malformed input. */
export function parseAppUpdateVersion(version: unknown): string | null {
  return typeof version === 'string' ? semver.valid(version) : null;
}

/**
 * App updates are forward-only. Versions must be valid SemVer values; malformed
 * versions fail closed instead of being coerced into an installable target.
 */
export function compareAppUpdateVersions(
  targetVersion: unknown,
  currentVersion: unknown,
): AppUpdateVersionRelation {
  const target = parseAppUpdateVersion(targetVersion);
  const current = parseAppUpdateVersion(currentVersion);
  if (!target || !current) return 'invalid';

  const comparison = semver.compare(target, current);
  if (comparison > 0) return 'newer';
  if (comparison < 0) return 'older';
  return 'same';
}
