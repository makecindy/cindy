import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { UserMessage } from "../../types/common.js";
import { isReviewSensitiveCredentialPath } from "./sensitive-credential-paths.js";

export interface ReviewReadGrant {
  realPath: string;
  directory: boolean;
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
  const relative = path.relative(grant.realPath, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
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
      throw new Error("Review refused a multiply linked local file");
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
  if (
    !stat ||
    (!stat.isDirectory() && !stat.isFile()) ||
    (stat.isFile() && stat.nlink > 1)
  ) {
    return null;
  }
  return grants.some((grant) => pathIsWithinReviewGrant(realPath, grant))
    ? realPath
    : null;
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
