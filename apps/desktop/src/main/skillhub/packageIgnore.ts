/**
 * SkillHub package exclusion rules.
 *
 * Keep this list narrow: hidden files can be legitimate skill fixtures or
 * protocol examples. Only exclude paths that are clearly unsafe or generated
 * noise for a published skill package.
 */

import { detectSensitivePath } from '../security/sensitivePath';

const EXCLUDED_DIR_SEGMENTS = new Set(['node_modules', '__macosx', '.venv', '.hg', '.svn']);
const EXCLUDED_BASENAMES = new Set([
  '.terraformrc',
  'terraform.rc',
  'credentials.tfrc.json',
]);

const EXCLUDED_RELATIVE_PATH_RE =
  /(^|\/)\.m2\/settings(?:-security)?\.xml$/;

// Reserved by scanner's atomic writes/renames. A locked backup can outlive a
// successful transaction, but must never enter browsing, hashing or publishing.
const RENAME_BACKUP_BASENAME_RE =
  /^skill\.md\.xdt-rename-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function normalizePackagePath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Returns true when a POSIX-ish relative path must be excluded from SkillHub
 * package content, folderHash, and publish snapshots.
 */
export function isIgnoredSkillPackagePath(relativePath: string): boolean {
  const normalized = normalizePackagePath(relativePath);
  if (!normalized || normalized === '.') return false;
  if (detectSensitivePath(normalized, {
    allowEnvTemplates: false,
    excludeCredentialConfigDirs: true,
  })) return true;

  const lower = normalized.toLowerCase();
  if (EXCLUDED_RELATIVE_PATH_RE.test(lower)) return true;

  const lowerParts = lower.split('/').filter(Boolean);
  if (lowerParts.some((part) => EXCLUDED_DIR_SEGMENTS.has(part))) return true;

  const basename = lowerParts[lowerParts.length - 1] ?? '';
  if (basename.endsWith('.xdt-tmp') || RENAME_BACKUP_BASENAME_RE.test(basename)) return true;
  if (EXCLUDED_BASENAMES.has(basename)) return true;
  if (basename === '.ds_store') return true;
  if (basename.startsWith('._')) return true;

  return false;
}
