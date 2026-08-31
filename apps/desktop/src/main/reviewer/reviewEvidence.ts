import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { isReviewSensitiveCredentialPath } from '@cindy/maker-core';
import { and, desc, eq, inArray, isNull, lt, ne, notLike, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current.js';
import { visibleMessageTextForConversationSearch } from '../localDb/conversationSearch.pure.js';
import { messages } from '../localDb/schema.js';
import * as imageCacheStore from '../imageCacheStore.js';
import * as cindyChatAttachments from '../cindy-media/chatAttachments.js';
import * as cindyMediaBlobStore from '../cindy-media/blobStore.js';
import { readReviewBranchDiff, readReviewData } from '../git-review/ipc.js';
import { getTurnChangeSets, listTurnChangeSets } from '../turn-change-set/store.js';
import type { TurnChangeSetDetail } from '../../shared/turnChangeSet.js';
import { readReviewRunFromAgentMeta } from '../../shared/reviewRun.js';
import type {
  ReviewArtifactLabel,
  ReviewBranchEvidence,
  ReviewContextMessage,
  ReviewWorkspaceEvidence,
} from './reviewPrompt.js';
import {
  sanitizeReviewChangeSet,
  sanitizeReviewDiffBucket,
  sanitizeReviewStatusFiles,
} from './reviewEvidenceSafety.js';
import {
  classifyReviewArtifact,
  extractReviewArtifactContent,
  type ReviewArtifactExcerpt,
  type ReviewArtifactWarning,
} from './reviewArtifactContent.js';
import {
  assertReviewInlineAttachmentGranted,
  assertReviewExplicitPathGranted,
  type ResolvedReviewArtifactPath,
  type ReviewExplicitArtifactGrant,
} from './reviewArtifactAuthorization.js';
import {
  fingerprintReviewCappedWorkspaceFiles,
  ReviewCappedWorkspaceChangedError,
} from './reviewCappedWorkspaceFingerprint.js';
import { readStagedIndexIdentity } from '../git-review/indexIdentityReader.js';
import { readReviewSubmoduleIdentity } from './reviewSubmoduleIdentity.js';

export interface ReviewAttachmentInput {
  name: string;
  path?: string;
  url?: string;
  category?: 'image' | 'pdf' | 'text' | 'office' | 'file';
  mimeType?: string;
  originalName?: string;
  base64?: string;
}

export interface ReviewAttachmentBlock {
  [key: string]: unknown;
  type: 'image' | 'file';
  path?: string;
  base64?: string;
  mimeType?: string;
  originalName?: string;
}

export interface LoadedReviewEvidence {
  context: ReviewContextMessage[];
  contextFingerprint: string;
  workspace: ReviewWorkspaceEvidence | null;
  workspaceFingerprint: string | null;
  branch: ReviewBranchEvidence | null;
  branchUnavailableReason?: string;
  changeSet: TurnChangeSetDetail | null;
  artifacts: ReviewArtifactLabel[];
  artifactExcerpts: ReviewArtifactExcerpt[];
  artifactWarnings: ReviewArtifactWarning[];
  attachmentBlocks: ReviewAttachmentBlock[];
  readRoots: string[];
  reviewReadPaths: string[];
  focusPath: string | null;
  artifactsOmitted: boolean;
}

const MAX_CONTEXT_ROWS = 20;
const CONTEXT_QUERY_PAGE_SIZE = 64;
// A single invocation accepts at most 20 explicit attachments plus one focus
// path. Keep a small margin for task-history artifacts before declaring the
// evidence list partial.
const MAX_ARTIFACTS = 24;
const MAX_ARTIFACT_EXCERPT_CHARS = 24_000;
const MAX_TOTAL_ARTIFACT_EXCERPT_CHARS = 72_000;
const MAX_EXTRACTED_PDFS = 4;

function mapReviewWorkspace(
  reviewData: Awaited<ReturnType<typeof readReviewData>>,
): ReviewWorkspaceEvidence {
  const sanitized = sanitizeReviewDiffBucket(reviewData.diffs);
  return {
    dirty: reviewData.summary.dirty,
    totalFiles: reviewData.summary.totalFiles,
    stagedFiles: reviewData.summary.stagedFiles,
    unstagedFiles: reviewData.summary.unstagedFiles,
    untrackedFiles: reviewData.summary.untrackedFiles,
    disabledReason: reviewData.summary.disabledReason,
    diffs: sanitized.value,
    sensitiveFilesOmitted: sanitized.omittedSensitiveFiles,
  };
}

/**
 * The branch's own commits, read only when the tree is clean.
 *
 * With uncommitted work present that work is the review target. Once it is
 * committed the tree goes clean and the last turn is no longer a faithful
 * stand-in for the branch — reviewing it would silently cover one turn while
 * appearing to cover the whole branch.
 */
async function loadReviewBranchEvidence(
  sessionId: string,
  readBranchDiff: typeof readReviewBranchDiff,
): Promise<{ branch: ReviewBranchEvidence | null; unavailableReason?: string }> {
  let data: Awaited<ReturnType<typeof readReviewBranchDiff>>;
  try {
    data = await readBranchDiff(sessionId, null);
  } catch (error) {
    return { branch: null, unavailableReason: error instanceof Error ? error.message : '读取失败' };
  }
  if (!data.baseRef || !data.mergeBaseOid) {
    return { branch: null, unavailableReason: data.warning?.code ?? '未找到基线分支' };
  }
  // Nobody picks the base here — unlike the Git review pane, this runs
  // unattended. With no recognized default present, the picker just takes the
  // first remaining candidate in sort order, which can be an unrelated sibling
  // (`some-feature`, `origin/foo`); presenting that comparison as "the branch's
  // work" is worse than presenting nothing.
  //
  // So require a base that identifies itself rather than one that merely sorted
  // first: the repository's default branch, or the branch's own upstream. The
  // default flag comes from the branch reader because `init.defaultBranch` can
  // name anything — recognizing defaults by name here would reject a repository
  // that calls its default `stable`.
  const chosen = data.candidates.find((candidate) => candidate.refName === data.baseRef);
  const baseIdentifiesItself =
    !chosen ||
    chosen.isDefaultBranch === true ||
    chosen.kind === 'remote-default' ||
    chosen.kind === 'upstream';
  if (!baseIdentifiesItself) {
    return { branch: null, unavailableReason: 'ambiguous-base' };
  }
  const sanitized = sanitizeReviewDiffBucket({
    staged: data.diffs,
    unstaged: [],
    capped: { staged: data.capped, unstaged: null },
  });
  const diffs = sanitized.value.staged;
  const capped = sanitized.value.capped?.staged ?? null;
  // Count what the branch changed, not what survived redaction. `capped.stats`
  // is already a pre-redaction total, so deriving the uncapped count from the
  // sanitized list would make the two paths disagree — and a branch whose
  // every changed path is sensitive would report zero, which
  // `resolveTargetKind` reads as "no changes" and downgrades the run to a
  // `task` review even though the branch is the selected evidence. The count
  // is coverage metadata; the content stays excluded either way, and the
  // prompt states how many were withheld via `sensitiveFilesOmitted`.
  const fileCount = capped ? capped.stats.fileCount : data.diffs.length;
  if (fileCount === 0) {
    // A guard like `too-many-files` also yields zero entries, but it means the
    // branch changed too much to load — not that it changed nothing. Falling
    // through silently would present one turn as the branch review.
    if (data.warning) return { branch: null, unavailableReason: data.warning.code };
    // Nothing of its own to review; fall through to the last turn.
    return { branch: null };
  }
  return {
    branch: {
      baseRef: data.baseRef,
      baseOid: data.baseOid,
      mergeBaseOid: data.mergeBaseOid,
      fileCount,
      diffs,
      capped,
      sensitiveFilesOmitted: sanitized.omittedSensitiveFiles,
      ...(data.warning ? { unavailableReason: data.warning.code } : {}),
    },
  };
}

interface ReviewWorkspaceSnapshot {
  workspace: ReviewWorkspaceEvidence;
  fingerprint: string | null;
  hasCappedDiff: boolean;
}

interface ReviewWorkspaceSnapshotDeps {
  readReviewData: typeof readReviewData;
  fingerprintCappedWorkspaceFiles: typeof fingerprintReviewCappedWorkspaceFiles;
  readStagedIndexIdentity: typeof readStagedIndexIdentity;
  readSubmoduleIdentity: typeof readReviewSubmoduleIdentity;
}

const defaultReviewWorkspaceSnapshotDeps: ReviewWorkspaceSnapshotDeps = {
  readReviewData,
  fingerprintCappedWorkspaceFiles: fingerprintReviewCappedWorkspaceFiles,
  readStagedIndexIdentity,
  readSubmoduleIdentity: readReviewSubmoduleIdentity,
};

/**
 * Dirty paths whose Git evidence does not carry their content.
 *
 * A capped bucket replaces patches with summaries, and a binary, submodule or
 * over-limit file is recorded with an empty patch and no blob oids — only path,
 * kind and size. Swapping such a file for different bytes of the same size
 * leaves the Git digest identical, so the reviewer could read the old bytes and
 * still pass both freshness gates. These paths need a content hash of their own.
 */
function workspacePathsWithoutContent(workspace: ReviewWorkspaceEvidence): string[] {
  const capped = [workspace.diffs.capped?.staged, workspace.diffs.capped?.unstaged].flatMap(
    (bucket) =>
      bucket
        ? bucket.files
            // capped bucket 同样排除 submodule(理由同下方非 capped 分支):
            // gitlink 是目录,喂给普通文件指纹器会直接抛错,含 capped 子仓的
            // 大型 dirty workspace 整个 Review 起不来;其身份由
            // submoduleEvidencePaths()(已含 capped bucket)路由到 submodule
            // reader 绑定(Codex review #2515)。
            .filter((file) => !file.isSubmodule)
            .flatMap((file) => [file.path, file.oldPath].filter(Boolean) as string[])
        : [],
  );
  const contentless = [...workspace.diffs.staged, ...workspace.diffs.unstaged]
    // Submodules are excluded on purpose: a gitlink is a directory, and the
    // content fingerprinter only accepts regular files, so passing one would
    // abort evidence loading outright — an initialized submodule anywhere in
    // the workspace would make Review refuse to run at all. Do not "fix" the
    // binding gap by feeding the directory back in, which is that crash.
    //
    // Their identity is bound elsewhere: submoduleEvidencePaths() routes every
    // submodule evidence entry to the submodule-aware reader (#2463), which
    // binds the gitlink oids, the inner HEAD, the inner staged index identity
    // and a bounded content hash of inner dirty regular files — the identity
    // read this file-path digest cannot express.
    .filter((diff) => !diff.rawPatch && !diff.isSubmodule)
    .flatMap((diff) => [diff.path, diff.oldPath].filter(Boolean) as string[]);
  return [...new Set([...capped, ...contentless])];
}

/**
 * Sanitized staged evidence paths whose index identity must be bound (#2460).
 *
 * The content fingerprint above hashes worktree bytes only; staged content
 * lives in the Git index. When a path carries both a staged and an unstaged
 * contentless diff, swapping the index blob for another one of the same size
 * while restoring the worktree bytes leaves status, empty-patch metadata and
 * the worktree hash all unchanged — both freshness gates would keep accepting
 * a conclusion drawn from the stale staged bytes. Binding the index object
 * identity `(path, mode, stage, oid)` closes that without reading blob bytes.
 *
 * Collected from the sanitized staged evidence (plain staged diffs plus the
 * capped staged bucket), so sensitive-path filtering has already been applied.
 */
function stagedEvidencePaths(workspace: ReviewWorkspaceEvidence): string[] {
  const capped = (workspace.diffs.capped?.staged?.files ?? []).flatMap(
    (file) => [file.path, file.oldPath].filter(Boolean) as string[],
  );
  const staged = workspace.diffs.staged.flatMap(
    (diff) => [diff.path, diff.oldPath].filter(Boolean) as string[],
  );
  return [...new Set([...staged, ...capped])];
}

/**
 * Sanitized evidence paths that are submodules and need an identity manifest
 * (#2463). The file fingerprinter cannot bind them (a gitlink is a directory)
 * and porcelain keeps only a dirty boolean, so a submodule-aware reader binds
 * the gitlink oids, the inner HEAD and the inner dirty file identities.
 */
function submoduleEvidencePaths(
  workspace: ReviewWorkspaceEvidence,
  sanitizedStatusFiles: readonly { path: string; isSubmodule: boolean }[],
): string[] {
  const capped = [workspace.diffs.capped?.staged, workspace.diffs.capped?.unstaged].flatMap(
    (bucket) => (bucket ? bucket.files.filter((file) => file.isSubmodule).map((file) => file.path) : []),
  );
  const diffs = [...workspace.diffs.staged, ...workspace.diffs.unstaged]
    .filter((diff) => diff.isSubmodule)
    .map((diff) => diff.path);
  // Diffs alone can miss a dirty submodule: one whose only change is untracked
  // inner content has no numstat entry, so with ignoreWhitespace enabled the
  // summary builder drops it as a whitespace-only modification — and when the
  // unstaged bucket is capped there is no detailed diff to catch it either.
  // Status still lists it, so bind from the sanitized status records as well
  // (Codex review #2515).
  const status = sanitizedStatusFiles
    .filter((file) => file.isSubmodule)
    .map((file) => file.path);
  return [...new Set([...diffs, ...capped, ...status])];
}

async function buildReviewWorkspaceSnapshot(
  reviewData: Awaited<ReturnType<typeof readReviewData>>,
  deps: Pick<
    ReviewWorkspaceSnapshotDeps,
    'fingerprintCappedWorkspaceFiles' | 'readStagedIndexIdentity' | 'readSubmoduleIdentity'
  >,
): Promise<ReviewWorkspaceSnapshot> {
  const workspace = mapReviewWorkspace(reviewData);
  const contentlessPaths = workspacePathsWithoutContent(workspace);
  const cappedContentFingerprint =
    contentlessPaths.length > 0 && reviewData.scope.repoRoot
      ? await deps.fingerprintCappedWorkspaceFiles(reviewData.scope.repoRoot, contentlessPaths)
      : null;
  const stagedPaths = stagedEvidencePaths(workspace);
  // Identity only — no byte reads. A read failure propagates and aborts the
  // snapshot (fail closed), same as any other Git evidence read failure.
  const stagedIndexIdentity =
    stagedPaths.length > 0 && reviewData.scope.repoRoot
      ? await deps.readStagedIndexIdentity(reviewData.scope.repoRoot, stagedPaths)
      : null;
  const submodulePaths = submoduleEvidencePaths(
    workspace,
    sanitizeReviewStatusFiles(reviewData.status?.files ?? []),
  );
  // SSH 远程工作区:submodule 身份读取含本机 fs 探测(lstat/realpath/readdir)。
  // repoRoot 在远端时,本机 ENOENT 会被误判成 'uninitialized' 放行过期结论;
  // 本机碰巧存在同路径目录时,还会把本机字节和远端 git 状态绑在一起。git 命令
  // 经 GitExecutionBackend 走远程,fs 探测不走——在读到任何本机状态之前显式
  // fail closed(拒绝发布而非放行),与其它 Git 证据读取失败同一收口。完整远程
  // 支持需经 remote-file-service 通道,见 PR 描述的远程适配结论。
  if (submodulePaths.length > 0 && reviewData.scope.source === 'remote') {
    throw new Error(
      'Review submodule identity is not supported over SSH remote workspaces; refusing to bind local filesystem state (fail closed).',
    );
  }
  const submoduleIdentity =
    submodulePaths.length > 0 && reviewData.scope.repoRoot
      ? await deps.readSubmoduleIdentity(reviewData.scope.repoRoot, submodulePaths)
      : null;
  // Whichever files needed their own content hash also need the stability
  // re-read below: both are answering "did these bytes hold still?". Inner
  // submodule file hashes (#2463) join the same window.
  const hasCappedDiff = contentlessPaths.length > 0 || submoduleIdentity?.hashedContent === true;
  return {
    workspace,
    // A clean tree is not proof that the reviewer saw the same code: changing
    // branches or committing during Review can leave the tree clean at both
    // ends. Include the Git identity and porcelain status as well as patches.
    // Explicit artifacts receive their own bounded content fingerprint at the
    // review runner boundary; this identity covers only sanitized Git evidence.
    fingerprint: reviewData.scope.repoRoot
      ? createHash('sha256')
          .update(
            JSON.stringify({
              repoRoot: reviewData.scope.repoRoot,
              worktreePath: reviewData.scope.worktreePath,
              workingDir: reviewData.scope.workingDir,
              branch: reviewData.scope.branch,
              headOid: reviewData.scope.headOid,
              isDetached: reviewData.scope.isDetached,
              isUnborn: reviewData.scope.isUnborn,
              statusFiles: sanitizeReviewStatusFiles(reviewData.status?.files ?? []),
              inProgress: reviewData.status?.inProgress ?? [],
              summary: reviewData.summary,
              workspace,
              cappedContentFingerprint,
              stagedIndexIdentity,
              submoduleIdentity: submoduleIdentity?.identities ?? null,
            }),
          )
          .digest('hex')
      : null,
    hasCappedDiff,
  };
}

export async function readReviewWorkspaceSnapshot(
  sourceSessionId: string,
  depsInput: Partial<ReviewWorkspaceSnapshotDeps> = {},
): Promise<{ workspace: ReviewWorkspaceEvidence; fingerprint: string | null } | null> {
  const deps = { ...defaultReviewWorkspaceSnapshotDeps, ...depsInput };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    // A normal non-Git task is represented by ReviewData with a disabled scope.
    // An exception means Git evidence could not be read and must abort Review;
    // turning it into null would incorrectly publish a completed, evidence-free
    // result for a task that may in fact be a Git workspace.
    const reviewData = await deps.readReviewData(sourceSessionId);
    try {
      const current = await buildReviewWorkspaceSnapshot(reviewData, deps);
      if (!current.hasCappedDiff) return current;

      // A capped summary and its full-content digest must describe one stable
      // workspace window. Require a second matching snapshot; a transient edit
      // during either full-file hash restarts the whole Git + content read.
      const confirmationData = await deps.readReviewData(sourceSessionId);
      const confirmation = await buildReviewWorkspaceSnapshot(confirmationData, deps);
      if (!confirmation.hasCappedDiff) return confirmation;
      if (confirmation.fingerprint === current.fingerprint) return confirmation;
    } catch (error) {
      if (!(error instanceof ReviewCappedWorkspaceChangedError) || attempt === 2) throw error;
    }
  }
  throw new ReviewCappedWorkspaceChangedError(
    'The capped Review workspace kept changing while its content baseline was prepared',
  );
}

/** Re-read the Git evidence and compare it with the snapshot used to build the prompt. */
export async function reviewWorkspaceFingerprintIsCurrent(
  sourceSessionId: string,
  expectedFingerprint: string | null,
  depsInput: Partial<ReviewWorkspaceSnapshotDeps> = {},
): Promise<boolean> {
  if (!expectedFingerprint) return true;
  const current = await readReviewWorkspaceSnapshot(sourceSessionId, depsInput);
  return current?.fingerprint === expectedFingerprint;
}

/**
 * Whether the branch is still being compared against the same point.
 *
 * The workspace fingerprint covers the source HEAD, not the base: fetching or
 * moving the base branch advances the merge base and changes what the branch
 * diff means, while HEAD stays put. Without this a review could publish
 * findings drawn from a comparison that no longer exists.
 */
export async function reviewBranchBaselineIsCurrent(
  sourceSessionId: string,
  branch: ReviewBranchEvidence | null,
  readBranchDiff: typeof readReviewBranchDiff = readReviewBranchDiff,
): Promise<boolean> {
  if (!branch) return true;
  try {
    const current = await readBranchDiff(sourceSessionId, branch.baseRef);
    // The patch runs from the merge base to the source HEAD, so only those two
    // define the evidence. The base tip is deliberately not compared: fetching
    // commits onto the base after this branch diverged moves it without moving
    // the merge base, and failing the review there would discard a result whose
    // content is byte-for-byte the same. HEAD is covered by the workspace
    // fingerprint.
    return current.baseRef === branch.baseRef && current.mergeBaseOid === branch.mergeBaseOid;
  } catch {
    // An unreadable baseline cannot be proven unchanged.
    return false;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    const trimmed = parsed.trim();
    if (!trimmed.startsWith('{')) return null;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

function hasReviewRunMeta(raw: unknown): boolean {
  return readReviewRunFromAgentMeta(raw) !== null;
}

type ReviewVisibleRow = {
  role: 'user' | 'assistant';
  content: string;
  agentMeta: string | null;
  createdAt: number;
  id: string;
};

async function readReviewVisibleRows(sourceSessionId: string): Promise<ReviewVisibleRow[]> {
  const db = getDbClient().drizzle;
  const rows: ReviewVisibleRow[] = [];
  let cursor: { createdAt: number; id: string } | null = null;

  while (rows.length < MAX_CONTEXT_ROWS) {
    const page = (await db
      .select({
        role: messages.role,
        content: messages.content,
        agentMeta: messages.agentMeta,
        createdAt: messages.createdAt,
        id: messages.id,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sourceSessionId),
          inArray(messages.role, ['user', 'assistant']),
          isNull(messages.rewindAt),
          ne(messages.content, ''),
          // Exclude Review status cards in SQL so they cannot consume query
          // pages. The JS parser below remains the fail-closed authority.
          or(isNull(messages.agentMeta), notLike(messages.agentMeta, '%"reviewRun"%')),
          cursor
            ? or(
                lt(messages.createdAt, cursor.createdAt),
                and(eq(messages.createdAt, cursor.createdAt), lt(messages.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(CONTEXT_QUERY_PAGE_SIZE)) as ReviewVisibleRow[];
    if (page.length === 0) break;

    const last: ReviewVisibleRow = page[page.length - 1]!;
    cursor = { createdAt: last.createdAt, id: last.id };
    for (const row of page) {
      const visibleRow = row;
      if (hasReviewRunMeta(visibleRow.agentMeta)) continue;
      const hasVisibleText =
        visibleMessageTextForConversationSearch(visibleRow.role, visibleRow.content).length > 0;
      const hasHistoricalArtifact = historicalAttachmentsFromRows([visibleRow]).length > 0;
      if (!hasVisibleText && !hasHistoricalArtifact) continue;
      rows.push(visibleRow);
      if (rows.length === MAX_CONTEXT_ROWS) break;
    }
    if (page.length < CONTEXT_QUERY_PAGE_SIZE) break;
  }

  return rows.reverse();
}

function fingerprintReviewContextRows(rows: readonly ReviewVisibleRow[]): string {
  const visibleMessages = rows.flatMap((row) => {
    const text = visibleMessageTextForConversationSearch(row.role, row.content);
    return text
      ? [
          {
            id: row.id,
            createdAt: row.createdAt,
            role: row.role,
            text,
          },
        ]
      : [];
  });
  const historicalArtifacts = historicalAttachmentsFromRows(rows).map((attachment) => ({
    name: attachment.name,
    path: attachment.path,
    url: attachment.url,
    category: attachment.category,
    mimeType: attachment.mimeType,
    originalName: attachment.originalName,
  }));
  return createHash('sha256')
    .update(JSON.stringify({ visibleMessages, historicalArtifacts }))
    .digest('hex');
}

/**
 * Fingerprint the bounded visible text and historical artifact references
 * supplied to a reviewer. Hidden row fields and Review status cards are
 * deliberately absent, so lifecycle updates cannot invalidate their own run
 * while genuine task activity does.
 */
export async function readReviewContextFingerprint(sourceSessionId: string): Promise<string> {
  return fingerprintReviewContextRows(await readReviewVisibleRows(sourceSessionId));
}

function persistedFileRefs(content: unknown): Array<{ path: string; name?: string }> {
  const record = parseJsonRecord(content);
  if (!record || !Array.isArray(record.files)) return [];
  const refs: Array<{ path: string; name?: string }> = [];
  for (const item of record.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const ref = item as Record<string, unknown>;
    if (typeof ref.path !== 'string' || !ref.path) continue;
    refs.push({
      path: ref.path,
      ...(typeof ref.name === 'string' && ref.name ? { name: ref.name } : {}),
    });
  }
  return refs;
}

function historicalAttachmentsFromRows(rows: readonly ReviewVisibleRow[]): ReviewAttachmentInput[] {
  const attachments: ReviewAttachmentInput[] = [];
  for (const row of rows) {
    for (const url of imageCacheStore.collectSessionImageUrls(row.content)) {
      attachments.push({ name: path.basename(url) || 'image', url, category: 'image' });
    }
    for (const url of cindyChatAttachments.collectCindyMediaUrls(row.content)) {
      attachments.push({ name: path.basename(url) || 'attachment', url });
    }
    for (const ref of persistedFileRefs(row.content)) {
      attachments.push({
        name: ref.name || path.basename(ref.path) || 'attachment',
        path: ref.path,
      });
    }
  }
  return attachments;
}

/**
 * Main uses the same bounded history snapshot for native authorization before
 * loading any historical local path into reviewer evidence. A second read in
 * loadReviewEvidence is intentional: newly appearing paths then fail the exact
 * one-run grant instead of being silently included.
 */
export async function listReviewHistoricalAttachments(
  sourceSessionId: string,
): Promise<ReviewAttachmentInput[]> {
  return historicalAttachmentsFromRows(await readReviewVisibleRows(sourceSessionId));
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

export class SensitiveReviewPathError extends Error {}

export async function resolveReviewArtifactPath(
  rawPath: string,
  workingDir: string,
): Promise<(ResolvedReviewArtifactPath & { mimeType?: string }) | null> {
  try {
    let candidate: { absPath: string; mimeType?: string; managed: boolean };
    if (rawPath.startsWith('xdt-image://')) {
      const resolved = imageCacheStore.resolveSafe(rawPath);
      candidate = { absPath: resolved.absPath, mimeType: resolved.mimeType, managed: true };
    } else if (rawPath.startsWith('cindy-media://')) {
      const resolved = cindyMediaBlobStore.resolveSafe(rawPath);
      candidate = { absPath: resolved.absPath, mimeType: resolved.mimeType, managed: true };
    } else {
      if (rawPath.startsWith('clipboard://')) return null;
      candidate = {
        absPath: path.isAbsolute(rawPath)
          ? path.normalize(rawPath)
          : path.resolve(workingDir, rawPath),
        managed: false,
      };
    }
    const realPath = await fs.realpath(candidate.absPath);
    if (
      isReviewSensitiveCredentialPath(rawPath) ||
      isReviewSensitiveCredentialPath(candidate.absPath) ||
      isReviewSensitiveCredentialPath(realPath)
    ) {
      throw new SensitiveReviewPathError('Review refused a credential or key path');
    }
    await fs.stat(realPath);
    return {
      absPath: realPath,
      managed: candidate.managed,
      ...(candidate.mimeType ? { mimeType: candidate.mimeType } : {}),
    };
  } catch (error) {
    if (error instanceof SensitiveReviewPathError) throw error;
    return null;
  }
}

export async function loadReviewEvidence(input: {
  sourceSessionId: string;
  workingDir: string;
  focus?: string;
  attachments: ReviewAttachmentInput[];
  explicitArtifactGrant: ReviewExplicitArtifactGrant;
}): Promise<LoadedReviewEvidence> {
  const visibleRows = await readReviewVisibleRows(input.sourceSessionId);
  const context: ReviewContextMessage[] = visibleRows
    .map((row) => ({
      role: row.role as 'user' | 'assistant',
      text: visibleMessageTextForConversationSearch(row.role, row.content),
    }))
    .filter((message) => message.text.length > 0);

  const summaries = await listTurnChangeSets(input.sourceSessionId);
  const latestSummary =
    summaries.length > 0 ? [...summaries].sort((a, b) => b.completedAt - a.completedAt)[0] : null;
  const rawChangeSet = latestSummary
    ? ((await getTurnChangeSets(input.sourceSessionId, [latestSummary.id]))[0] ?? null)
    : null;
  const changeSet = sanitizeReviewChangeSet(rawChangeSet).value;
  const workspaceSnapshot = await readReviewWorkspaceSnapshot(input.sourceSessionId);
  const workspace = workspaceSnapshot?.workspace ?? null;
  // Only when there is no uncommitted work: that work, when present, is what
  // the user is asking about, and reading the branch as well would bury it.
  const branchEvidence =
    workspace && !workspace.dirty && !workspace.disabledReason
      ? await loadReviewBranchEvidence(input.sourceSessionId, readReviewBranchDiff)
      : { branch: null };

  const artifacts: ReviewArtifactLabel[] = [];
  const artifactExcerpts: ReviewArtifactExcerpt[] = [];
  const artifactWarnings: ReviewArtifactWarning[] = [];
  const attachmentBlocks: ReviewAttachmentBlock[] = [];
  const readRoots = new Set<string>();
  const reviewReadPaths = new Set<string>();
  const seen = new Set<string>();
  let focusPath: string | null = null;
  let artifactsOmitted = false;
  let artifactExcerptChars = 0;
  let extractedPdfCount = 0;

  const addExtractedContent = async (params: {
    label: string;
    category?: ReviewAttachmentInput['category'];
    mimeType?: string;
    filePath?: string;
    data?: Uint8Array;
  }): Promise<void> => {
    const artifactKind = classifyReviewArtifact(params);
    if (artifactKind === 'pdf') {
      if (extractedPdfCount >= MAX_EXTRACTED_PDFS) {
        artifactWarnings.push({
          label: params.label,
          message: `本轮最多本地解析 ${MAX_EXTRACTED_PDFS} 份 PDF；此文件只保留给当前 reviewer harness 尝试读取。`,
        });
        return;
      }
      extractedPdfCount += 1;
    }
    const remaining = Math.max(0, MAX_TOTAL_ARTIFACT_EXCERPT_CHARS - artifactExcerptChars);
    const result = await extractReviewArtifactContent({
      ...params,
      maxChars: Math.min(MAX_ARTIFACT_EXCERPT_CHARS, remaining),
    });
    if (result.excerpt) {
      artifactExcerpts.push(result.excerpt);
      artifactExcerptChars += result.excerpt.content.length;
    }
    artifactWarnings.push(...result.warnings);
  };

  const addResolvedPath = async (params: {
    rawPath: string;
    label?: string;
    category?: ReviewAttachmentInput['category'];
    mimeType?: string;
    fromFocus?: boolean;
    explicit?: boolean;
  }): Promise<boolean> => {
    if (artifacts.length >= MAX_ARTIFACTS) {
      artifactsOmitted = true;
      return false;
    }
    const resolved = await resolveReviewArtifactPath(params.rawPath, input.workingDir);
    if (!resolved) return false;
    const evidencePath = params.explicit
      ? assertReviewExplicitPathGranted(resolved.absPath, input.explicitArtifactGrant)
      : resolved.absPath;
    if (seen.has(resolved.absPath)) return true;
    seen.add(resolved.absPath);
    const stat = await fs.stat(evidencePath).catch(() => null);
    if (!stat) return false;
    if (stat.isDirectory()) {
      readRoots.add(evidencePath);
      reviewReadPaths.add(evidencePath);
      artifacts.push({ kind: 'directory', label: params.label || path.basename(resolved.absPath) });
      if (params.fromFocus) focusPath = resolved.absPath;
      return true;
    }
    if (!stat.isFile()) return false;
    const mimeType = params.mimeType || resolved.mimeType;
    const isImage =
      classifyReviewArtifact({
        label: params.label || path.basename(resolved.absPath),
        category: params.category,
        mimeType,
        filePath: evidencePath,
      }) === 'image';
    readRoots.add(path.dirname(evidencePath));
    reviewReadPaths.add(evidencePath);
    attachmentBlocks.push({
      type: isImage ? 'image' : 'file',
      path: evidencePath,
      ...(mimeType ? { mimeType } : {}),
      originalName: params.label || path.basename(resolved.absPath),
    });
    artifacts.push({
      kind: isImage ? 'image' : 'file',
      label: params.label || path.basename(resolved.absPath),
    });
    if (!isImage) {
      await addExtractedContent({
        label: params.label || path.basename(resolved.absPath),
        category: params.category,
        mimeType,
        filePath: evidencePath,
      });
    }
    if (params.fromFocus) focusPath = resolved.absPath;
    return true;
  };

  const focusCandidate = input.focus ? stripMatchingQuotes(input.focus) : '';
  if (focusCandidate && !focusCandidate.includes('\n')) {
    await addResolvedPath({ rawPath: focusCandidate, fromFocus: true, explicit: true });
  }

  for (const attachment of input.attachments) {
    if (artifacts.length >= MAX_ARTIFACTS) {
      artifactsOmitted = true;
      break;
    }
    const attachmentLabel = attachment.originalName || attachment.name;
    if (attachmentLabel && isReviewSensitiveCredentialPath(attachmentLabel)) {
      throw new SensitiveReviewPathError('Review refused a credential or key attachment');
    }
    let resolvedAttachment = false;
    for (const rawPath of new Set([attachment.url, attachment.path].filter(Boolean) as string[])) {
      resolvedAttachment = await addResolvedPath({
        rawPath,
        label: attachment.originalName || attachment.name,
        category: attachment.category,
        mimeType: attachment.mimeType,
        explicit: true,
      });
      if (resolvedAttachment) break;
    }
    if (resolvedAttachment) continue;
    if (attachment.base64) {
      const inlineGrantKey = assertReviewInlineAttachmentGranted(
        attachment,
        input.explicitArtifactGrant,
      );
      if (seen.has(`base64:${inlineGrantKey}`)) continue;
      seen.add(`base64:${inlineGrantKey}`);
      const isImage = attachment.category === 'image';
      attachmentBlocks.push({
        type: isImage ? 'image' : 'file',
        base64: attachment.base64,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName || attachment.name,
      });
      artifacts.push({
        kind: isImage ? 'image' : 'file',
        label: attachment.originalName || attachment.name,
      });
      if (!isImage) {
        const estimatedBytes = Math.floor((attachment.base64.length * 3) / 4);
        if (estimatedBytes > 20 * 1024 * 1024) {
          artifactWarnings.push({
            label: attachmentLabel,
            message: '内嵌成果超过 20 MB，本地 reviewer 未解析正文。',
          });
        } else {
          await addExtractedContent({
            label: attachmentLabel,
            category: attachment.category,
            mimeType: attachment.mimeType,
            data: Buffer.from(attachment.base64, 'base64'),
          });
        }
      }
    }
  }

  for (const attachment of historicalAttachmentsFromRows(visibleRows)) {
    if (artifacts.length >= MAX_ARTIFACTS) {
      artifactsOmitted = true;
      break;
    }
    const rawPath = attachment.url || attachment.path;
    if (!rawPath) continue;
    await addResolvedPath({
      rawPath,
      label: attachment.originalName || attachment.name,
      category: attachment.category,
      mimeType: attachment.mimeType,
      explicit: true,
    });
  }

  return {
    context,
    contextFingerprint: fingerprintReviewContextRows(visibleRows),
    workspace,
    workspaceFingerprint: workspaceSnapshot?.fingerprint ?? null,
    branch: branchEvidence.branch,
    ...(branchEvidence.unavailableReason
      ? { branchUnavailableReason: branchEvidence.unavailableReason }
      : {}),
    changeSet,
    artifacts,
    artifactExcerpts,
    artifactWarnings,
    attachmentBlocks,
    readRoots: [...readRoots],
    reviewReadPaths: [...reviewReadPaths],
    focusPath,
    artifactsOmitted,
  };
}
