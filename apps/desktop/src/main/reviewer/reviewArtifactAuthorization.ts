import { createHash } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import path from 'node:path';

import { reviewFileLinkLayoutIsSafe } from '@cindy/maker-core';

import { sameFileIdentity, samePathAndHandleFileIdentity } from '../utils/fileIdentity.js';

export interface ReviewArtifactAuthorizationAttachment {
  name: string;
  path?: string;
  url?: string;
  category?: 'image' | 'pdf' | 'text' | 'office' | 'file';
  mimeType?: string;
  originalName?: string;
  base64?: string;
}

export interface ResolvedReviewArtifactPath {
  absPath: string;
  managed: boolean;
}

export interface ReviewArtifactConfirmationItem {
  kind: 'external-path' | 'inline';
  label: string;
  path?: string;
}

export interface ReviewArtifactPathIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface ReviewExplicitArtifactGrant {
  paths: string[];
  pathIdentities: ReadonlyMap<string, ReviewArtifactPathIdentity>;
  inlineAttachmentKeys: string[];
  /** Main-owned immutable copies used after the user grants path access. */
  snapshotPaths?: ReadonlyMap<string, string>;
  /** Workspace directories remain live but are still constrained read-only. */
  liveDirectoryPaths?: readonly string[];
}

export class ReviewArtifactAuthorizationError extends Error {}

export function reviewArtifactPathIdentity(stat: BigIntStats): ReviewArtifactPathIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mode: stat.mode,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
  };
}

export function reviewArtifactPathIdentityMatches(
  expected: ReviewArtifactPathIdentity,
  actual: BigIntStats,
): boolean {
  return (
    sameFileIdentity(expected, actual) &&
    expected.size === actual.size &&
    expected.mode === actual.mode &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.ctimeNs === actual.ctimeNs
  );
}

/**
 * 路径 stat 与已打开句柄 stat 的比对必须用这个，不能用上面 path-vs-path 的
 * 弱变体：句柄 stat 在 Windows 上带真实卷序列号，路径 stat 常年 dev=0，两边
 * dev 不对等时弱变体会退化成只认 ino——NTFS FileId 只在卷内唯一，跨卷可能
 * 撞号。`reviewArtifactPathIdentityMatches` 留给两边同源（都是路径 stat 或
 * 都是句柄 stat）的比对。
 */
export function reviewArtifactHandleIdentityMatches(
  expected: ReviewArtifactPathIdentity,
  actual: BigIntStats,
): boolean {
  return (
    samePathAndHandleFileIdentity(expected, actual) &&
    expected.size === actual.size &&
    expected.mode === actual.mode &&
    expected.mtimeNs === actual.mtimeNs &&
    expected.ctimeNs === actual.ctimeNs
  );
}

export function reviewInlineAttachmentGrantKey(
  attachment: ReviewArtifactAuthorizationAttachment,
): string {
  const payloadDigest = createHash('sha256')
    .update(attachment.base64 ?? '', 'utf8')
    .digest('hex');
  return createHash('sha256')
    .update(
      JSON.stringify({
        label: attachment.originalName || attachment.name,
        category: attachment.category ?? null,
        mimeType: attachment.mimeType ?? null,
        payloadDigest,
      }),
      'utf8',
    )
    .digest('hex');
}

function stripMatchingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function isPathWithinReviewWorkspace(workingDir: string, candidate: string): boolean {
  const relative = path.relative(workingDir, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Reuses the workspace read boundary for explicitly selected files. Only the
 * exact pnpm mirror layout inside the canonical source workspace is allowed;
 * external or additional hard links remain denied.
 */
export async function reviewArtifactFileLinkLayoutIsSafe(
  artifactPath: string,
  canonicalWorkingDir: string | null,
  stat: BigIntStats,
): Promise<boolean> {
  if (stat.nlink <= 1) return true;
  return Boolean(
    canonicalWorkingDir &&
    isPathWithinReviewWorkspace(canonicalWorkingDir, artifactPath) &&
    (await reviewFileLinkLayoutIsSafe(artifactPath, canonicalWorkingDir, stat)),
  );
}

/**
 * Turns renderer-supplied paths into a one-run Main-owned grant. Workspace
 * paths and Cindy-managed media need no extra click; external files and
 * renderer-only inline bytes require an explicit native confirmation.
 */
export async function authorizeReviewExplicitArtifacts(input: {
  workingDir: string;
  focus?: string;
  attachments: ReviewArtifactAuthorizationAttachment[];
  resolvePath: (rawPath: string, workingDir: string) => Promise<ResolvedReviewArtifactPath | null>;
  confirm: (items: ReviewArtifactConfirmationItem[]) => Promise<boolean>;
}): Promise<ReviewExplicitArtifactGrant> {
  const canonicalWorkingDir = await fs.realpath(input.workingDir).catch(() => null);
  const grantedPaths = new Set<string>();
  const pathIdentities = new Map<string, ReviewArtifactPathIdentity>();
  const confirmationItems: ReviewArtifactConfirmationItem[] = [];
  const confirmationKeys = new Set<string>();

  const addResolved = async (rawPath: string, label: string): Promise<boolean> => {
    const resolved = await input.resolvePath(rawPath, input.workingDir);
    if (!resolved) return false;
    const stat = await fs.lstat(resolved.absPath, { bigint: true }).catch(() => null);
    if (!stat || stat.isSymbolicLink()) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed while permission was being prepared',
      );
    }
    if (
      stat.isFile() &&
      !(await reviewArtifactFileLinkLayoutIsSafe(resolved.absPath, canonicalWorkingDir, stat))
    ) {
      throw new ReviewArtifactAuthorizationError('Review refused a multiply linked artifact file');
    }
    const existingIdentity = pathIdentities.get(resolved.absPath);
    if (existingIdentity && !reviewArtifactPathIdentityMatches(existingIdentity, stat)) {
      throw new ReviewArtifactAuthorizationError(
        'A review artifact changed while permission was being prepared',
      );
    }
    grantedPaths.add(resolved.absPath);
    pathIdentities.set(resolved.absPath, reviewArtifactPathIdentity(stat));
    if (
      !resolved.managed &&
      (!canonicalWorkingDir ||
        !isPathWithinReviewWorkspace(canonicalWorkingDir, resolved.absPath)) &&
      !confirmationKeys.has(`path:${resolved.absPath}`)
    ) {
      confirmationKeys.add(`path:${resolved.absPath}`);
      confirmationItems.push({
        kind: 'external-path',
        label,
        path: resolved.absPath,
      });
    }
    return true;
  };

  const focusCandidate = input.focus ? stripMatchingQuotes(input.focus) : '';
  if (focusCandidate && !focusCandidate.includes('\n')) {
    await addResolved(focusCandidate, path.basename(focusCandidate) || focusCandidate);
  }

  const inlineAttachmentKeys = new Set<string>();
  for (const attachment of input.attachments) {
    const label = attachment.originalName || attachment.name;
    let resolved = false;
    for (const rawPath of new Set([attachment.url, attachment.path].filter(Boolean) as string[])) {
      resolved = await addResolved(rawPath, label);
      if (resolved) break;
    }
    if (!resolved && attachment.base64) {
      const grantKey = reviewInlineAttachmentGrantKey(attachment);
      inlineAttachmentKeys.add(grantKey);
      if (!confirmationKeys.has(`inline:${grantKey}`)) {
        confirmationKeys.add(`inline:${grantKey}`);
        confirmationItems.push({ kind: 'inline', label });
      }
    }
  }

  if (confirmationItems.length > 0 && !(await input.confirm(confirmationItems))) {
    throw new ReviewArtifactAuthorizationError('Review of external artifacts was cancelled');
  }

  return {
    paths: [...grantedPaths],
    pathIdentities,
    inlineAttachmentKeys: [...inlineAttachmentKeys],
  };
}

export function assertReviewExplicitPathGranted(
  resolvedPath: string,
  grant: ReviewExplicitArtifactGrant,
): string {
  if (!grant.paths.includes(resolvedPath)) {
    throw new ReviewArtifactAuthorizationError(
      'A review artifact changed after permission was granted',
    );
  }
  if (!grant.snapshotPaths) return resolvedPath;
  const snapshotPath = grant.snapshotPaths.get(resolvedPath);
  if (snapshotPath) return snapshotPath;
  if (grant.liveDirectoryPaths?.includes(resolvedPath)) return resolvedPath;
  throw new ReviewArtifactAuthorizationError(
    'A review artifact has no private snapshot for this run',
  );
}

export function assertReviewInlineAttachmentGranted(
  attachment: ReviewArtifactAuthorizationAttachment,
  grant: ReviewExplicitArtifactGrant,
): string {
  const key = reviewInlineAttachmentGrantKey(attachment);
  if (!grant.inlineAttachmentKeys.includes(key)) {
    throw new ReviewArtifactAuthorizationError(
      'Inline review attachment changed after permission was granted',
    );
  }
  return key;
}
