import { promises as fs, type Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { UserMessage } from "../../types/common.js";
import { isReviewSensitiveCredentialPath } from "./sensitive-credential-paths.js";

export interface ReviewReadGrant {
  realPath: string;
  directory: boolean;
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function ancestorsWithin(start: string, root: string): string[] {
  const boundary = path.resolve(root);
  const ancestors: string[] = [];
  let current = path.resolve(start);
  while (isPathWithin(boundary, current)) {
    ancestors.push(current);
    if (current === boundary) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors;
}

function statsReferToSameFile(left: Stats, right: Stats): boolean {
  return left.ino !== 0 && left.dev === right.dev && left.ino === right.ino;
}

const PACKAGE_MANIFEST_MAX_BYTES = 256 * 1024;

function normalizeDeclaredPackageName(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 214 ||
    value !== value.trim()
  ) {
    return null;
  }
  const component = "[a-z0-9][a-z0-9._-]*";
  const pattern = value.startsWith("@")
    ? new RegExp(`^@${component}/${component}$`, "i")
    : new RegExp(`^${component}$`, "i");
  return pattern.test(value) ? value : null;
}

async function readDeclaredPackageName(
  packageRoot: string,
  confinementRoot: string,
): Promise<string | null> {
  const manifestPath = path.join(packageRoot, "package.json");
  if (!isPathWithin(confinementRoot, manifestPath)) return null;
  const manifestLstat = await fs.lstat(manifestPath).catch(() => null);
  if (
    !manifestLstat ||
    manifestLstat.isSymbolicLink() ||
    !manifestLstat.isFile() ||
    manifestLstat.size > PACKAGE_MANIFEST_MAX_BYTES
  ) {
    return null;
  }
  const realManifest = await fs.realpath(manifestPath).catch(() => null);
  if (!realManifest || !isPathWithin(confinementRoot, realManifest)) return null;
  const manifestStat = await fs.stat(realManifest).catch(() => null);
  if (
    !manifestStat ||
    !manifestStat.isFile() ||
    manifestStat.size > PACKAGE_MANIFEST_MAX_BYTES
  ) {
    return null;
  }
  const raw = await fs.readFile(realManifest, "utf8").catch(() => null);
  if (raw == null || Buffer.byteLength(raw, "utf8") > PACKAGE_MANIFEST_MAX_BYTES) {
    return null;
  }
  try {
    return normalizeDeclaredPackageName(
      (JSON.parse(raw) as { name?: unknown }).name,
    );
  } catch {
    return null;
  }
}

/**
 * pnpm mirrors local file packages into node_modules with hard links. A file
 * with exactly one denied mirror inside the same granted workspace cannot be
 * an alias for an outside inode: both filesystem links are accounted for.
 */
export async function reviewFileLinkLayoutIsSafe(
  realPath: string,
  confinementRoot: string,
  stat: Stats,
): Promise<boolean> {
  if (!stat.isFile()) return stat.isDirectory();
  if (stat.nlink <= 1) return true;
  if (stat.nlink !== 2 || !isPathWithin(confinementRoot, realPath)) {
    return false;
  }

  const candidates = new Set<string>();
  for (const packageRoot of ancestorsWithin(
    path.dirname(realPath),
    confinementRoot,
  )) {
    const packageBase = path.basename(packageRoot);
    if (
      !packageBase ||
      packageBase === path.sep ||
      packageBase === "node_modules"
    )
      continue;
    const packageNames = [packageBase];
    const declaredPackageName = await readDeclaredPackageName(
      packageRoot,
      confinementRoot,
    );
    if (declaredPackageName) packageNames.push(declaredPackageName);
    const scope = path.basename(path.dirname(packageRoot));
    if (scope.startsWith("@") && scope.length > 1)
      packageNames.push(path.join(scope, packageBase));
    const relativePath = path.relative(packageRoot, realPath);
    if (
      !relativePath ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }
    for (const dependencyRoot of ancestorsWithin(
      path.dirname(packageRoot),
      confinementRoot,
    )) {
      for (const packageName of packageNames) {
        candidates.add(
          path.join(dependencyRoot, "node_modules", packageName, relativePath),
        );
      }
    }
  }

  for (const candidate of candidates) {
    if (!isReviewSensitiveCredentialPath(candidate)) continue;
    const candidateStat = await fs.lstat(candidate).catch(() => null);
    if (
      !candidateStat ||
      candidateStat.isSymbolicLink() ||
      !candidateStat.isFile() ||
      candidateStat.nlink !== 2 ||
      !statsReferToSameFile(stat, candidateStat)
    ) {
      continue;
    }
    const realCandidate = await fs.realpath(candidate).catch(() => null);
    if (
      realCandidate &&
      path.resolve(realCandidate) !== path.resolve(realPath) &&
      isPathWithin(confinementRoot, realCandidate) &&
      isReviewSensitiveCredentialPath(realCandidate)
    ) {
      return true;
    }
  }
  return false;
}

function normalizeReviewPath(
  rawPath: string,
  workingDir: string,
): string | null {
  const value = rawPath.trim();
  if (!value) return null;
  // Check native absolute paths before the URL-scheme guard: on Windows,
  // `C:\\work\\file.ts` begins with a colon-bearing drive prefix.
  if (path.isAbsolute(value)) return path.normalize(value);
  if (/^file:/i.test(value)) {
    try {
      return fileURLToPath(value);
    } catch {
      return null;
    }
  }
  // Review evidence is local-only. Refuse URL-like values instead of allowing
  // path.resolve() to turn them into misleading local paths.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return null;
  return path.resolve(workingDir, value);
}

export function pathIsWithinReviewGrant(
  candidate: string,
  grant: ReviewReadGrant,
): boolean {
  if (!grant.directory) return candidate === grant.realPath;
  return isPathWithin(grant.realPath, candidate);
}

export async function buildReviewReadGrants(
  workingDir: string,
  extraPaths: readonly string[],
): Promise<ReviewReadGrant[]> {
  const grants: ReviewReadGrant[] = [];
  for (const rawPath of new Set([workingDir, ...extraPaths])) {
    const candidate = normalizeReviewPath(rawPath, workingDir);
    if (
      !candidate ||
      isReviewSensitiveCredentialPath(rawPath) ||
      isReviewSensitiveCredentialPath(candidate)
    ) {
      throw new Error("Review refused a sensitive or invalid local path");
    }
    const realPath = await fs.realpath(candidate);
    if (isReviewSensitiveCredentialPath(realPath)) {
      throw new Error("Review refused a sensitive local path");
    }
    const stat = await fs.stat(realPath);
    if (!stat.isDirectory() && !stat.isFile()) {
      throw new Error("Review paths must refer to files or directories");
    }
    if (stat.isFile() && stat.nlink > 1) {
      let safeWithinDirectoryGrant = false;
      for (const grant of grants) {
        if (
          grant.directory &&
          pathIsWithinReviewGrant(realPath, grant) &&
          (await reviewFileLinkLayoutIsSafe(realPath, grant.realPath, stat))
        ) {
          safeWithinDirectoryGrant = true;
          break;
        }
      }
      if (!safeWithinDirectoryGrant) {
        throw new Error("Review refused a multiply linked local file");
      }
    }
    if (!grants.some((grant) => grant.realPath === realPath)) {
      grants.push({ realPath, directory: stat.isDirectory() });
    }
  }
  return grants;
}

export async function resolveReviewReadPath(
  rawPath: string,
  workingDir: string,
  grants: readonly ReviewReadGrant[],
): Promise<string | null> {
  const candidate = normalizeReviewPath(rawPath, workingDir);
  if (
    !candidate ||
    isReviewSensitiveCredentialPath(rawPath) ||
    isReviewSensitiveCredentialPath(candidate)
  ) {
    return null;
  }
  let realPath: string;
  try {
    realPath = await fs.realpath(candidate);
  } catch {
    return null;
  }
  if (isReviewSensitiveCredentialPath(realPath)) return null;
  const stat = await fs.stat(realPath).catch(() => null);
  if (!stat || (!stat.isDirectory() && !stat.isFile())) {
    return null;
  }
  const matchingGrants = grants.filter((grant) =>
    pathIsWithinReviewGrant(realPath, grant),
  );
  if (matchingGrants.length === 0) return null;
  if (stat.isFile() && stat.nlink > 1) {
    for (const grant of matchingGrants) {
      if (
        grant.directory &&
        (await reviewFileLinkLayoutIsSafe(realPath, grant.realPath, stat))
      ) {
        return realPath;
      }
    }
    return null;
  }
  return realPath;
}

/**
 * Validate every direct attachment before a harness converts, resizes or
 * base64-encodes it. Tool permission hooks run too late for those operations.
 */
export async function assertReviewMessageContentPaths(
  content: UserMessage["content"],
  workingDir: string,
  grants: readonly ReviewReadGrant[],
): Promise<void> {
  if (typeof content === "string") return;
  for (const block of content) {
    if (
      block.type !== "image" &&
      block.type !== "file" &&
      block.type !== "mention"
    )
      continue;
    const resolved = await resolveReviewReadPath(
      block.path,
      workingDir,
      grants,
    );
    if (!resolved) {
      throw new Error(
        "Review refused an attachment outside its approved read scope",
      );
    }
    // Downstream converters must receive the canonical path that was checked,
    // not a symlink which could be swapped after validation.
    block.path = resolved;
  }
}
