import fs from 'node:fs';
import path from 'node:path';
import { CINDY_BUILT_IN_SKILL_NAMES } from '../../shared/cindyBuiltInSkills';
const ACTIVE_BUNDLE_LINK = '.active';
const VERSIONS_DIRECTORY = '.versions';
function normalizeForCompare(value: string): string {
  const withoutWindowsNamespace = process.platform === 'win32'
    ? value.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')
    : value;
  const resolved = path.resolve(withoutWindowsNamespace);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realPathOrNormalized(value: string): string {
  try { return normalizeForCompare(fs.realpathSync.native(value)); }
  catch { return normalizeForCompare(value); }
}
export function validActiveBundle(value: unknown): value is string {
  return typeof value === 'string' && /^v[1-9][0-9]*-[a-f0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
export function builtInSkillsRoot(userDataDir: string): string {
  return path.join(userDataDir, 'system-skills');
}

/** Profile-independent storage shared by Global, China, dev, and isolated profiles. */
export function sharedBuiltInSkillsRoot(appDataDir: string): string {
  return path.join(appDataDir, 'Cindy', 'shared-system-skills');
}

/** Keep enable/disable intent stable while immutable built-in bundle revisions change. */
export function canonicalBuiltInSkillActivationPath(
  source: string,
  userDataDir: string,
  appDataDir?: string,
): string {
  const name = path.basename(source);
  if (!(CINDY_BUILT_IN_SKILL_NAMES as readonly string[]).includes(name)) return source;
  const bundleRoot = path.dirname(source);
  const managedRoots = [
    builtInSkillsRoot(userDataDir),
    ...(appDataDir ? [sharedBuiltInSkillsRoot(appDataDir)] : []),
  ];
  if (
    path.basename(bundleRoot) === ACTIVE_BUNDLE_LINK
    && managedRoots.some((root) => realPathOrNormalized(path.dirname(bundleRoot)) === realPathOrNormalized(root))
  ) {
    return path.join(path.dirname(bundleRoot), name);
  }
  const versionsRoot = path.dirname(bundleRoot);
  const stableRoot = path.dirname(versionsRoot);
  if (
    path.basename(versionsRoot) !== VERSIONS_DIRECTORY ||
    !validActiveBundle(path.basename(bundleRoot)) ||
    !managedRoots.some((root) => realPathOrNormalized(stableRoot) === realPathOrNormalized(root))
  ) return source;
  return path.join(stableRoot, name);
}
