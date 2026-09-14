import { app, BrowserWindow } from 'electron';
import { createId } from '@paralleldrive/cuid2';
import { createTwoFilesPatch, formatPatch, parsePatch, reversePatch } from 'diff';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import type { AgentEvent, TurnDiffEventData } from '@cindy/maker-core';
import type {
  PersistedTurnChangeSetV1,
  TurnChangeAction,
  TurnChangeActionResult,
  TurnChangeFileSummary,
  TurnChangeIncompleteReason,
  TurnChangeProvider,
  TurnChangeSetDetail,
  TurnChangeSetState,
  TurnChangeSetSummary,
  TurnChangeSetUpdatedPayload,
  TurnChangeWorkspaceState,
} from '../../shared/turnChangeSet.js';
import { TURN_CHANGE_SET_MAX_DIFF_BYTES } from '../../shared/turnChangeSet.js';
import type { FileDiff } from '../../shared/gitReviewWire.js';
import { parseGitDiffs } from '../git-review/diffParser.js';
import { GitRunError, runGit } from '../git-review/gitRunner.js';
import { getDbClient } from '../localDb/client/current.js';
import { createLogger } from '../logger.js';
import { detectSensitivePath } from '../security/sensitivePath.js';
import * as broadcastTap from '../device-link/broadcast-tap.js';
import { MAKER_PUSH } from '../maker-ipc/channels.js';
import { atomicWriteFileSync } from '../utils/atomicWriteFile.js';
import {
  turnChangeSetSessionDirectory,
  turnChangeSetStorageRoot,
} from './storagePaths';

const log = createLogger('turn-change-set');
const MAX_LIST_ROWS = 100;
const MAX_DETAIL_IDS = 16;
const MAX_CAPTURED_FILES = 200;
const MAX_SUMMARY_FILES = 50;
const MAX_CAPTURE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURE_TOTAL_BYTES = 12 * 1024 * 1024;
// Bounds the whole copy-on-write cycle, including both preimages and after-images.
const MAX_CAPTURE_IO_BYTES = 24 * 1024 * 1024;
const MAX_DETAIL_STORAGE_BYTES = 16 * 1024 * 1024;
const MAX_SESSION_DETAIL_BYTES = 32 * 1024 * 1024;
const MAX_STORED_SESSION_DIRS = 32;
const INDEX_FILE = 'index.json';
const ACTION_STATE_FILE = 'action-state.json';

interface CapturedFile {
  absolutePath: string;
  relativePath: string;
  beforeExists: boolean;
  beforeText: string;
  beforeMode: number | null;
}

interface PendingTurnChangeSet {
  id: string;
  ownerScope: broadcastTap.DataOwnerBroadcastScope;
  provider: TurnChangeProvider;
  providerTurnId: string | null;
  cwd: string;
  createdAt: number;
  anchorClientId: string | null;
  nativeDiff: string | null | undefined;
  nativeFiles: TurnChangeFileSummary[];
  capturedFiles: Map<string, CapturedFile>;
  captureTasks: Map<string, Promise<void>>;
  capturedBytes: number;
  incompleteReasons: Set<TurnChangeIncompleteReason>;
}

interface TurnChangeIndexV3 {
  version: 3;
  entries: TurnChangeSetSummary[];
  detailBytes: Record<string, number>;
}

interface TurnChangeActionStateV1 {
  version: 1;
  states: Record<string, { workspaceState: TurnChangeWorkspaceState; updatedAt: number }>;
}

const PROVIDERS = new Set<TurnChangeProvider>(['codex', 'claude-code', 'pi']);
const STATES = new Set<TurnChangeSetState>(['complete', 'partial']);
const WORKSPACE_STATES = new Set<TurnChangeWorkspaceState>(['applied', 'undone']);
const INCOMPLETE_REASONS = new Set<TurnChangeIncompleteReason>([
  'opaque-tool',
  'outside-workspace',
  'remote-session',
  'file-too-large',
  'binary-file',
  'sensitive-file',
  'read-failed',
  'diff-too-large',
  'provider-diff-conflict',
  'turn-failed',
  'concurrent-workspace',
]);
const FILE_STATUSES = new Set<FileDiff['status']>([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'unknown',
]);

export interface KnownFileWriteCapture {
  sessionId: string;
  provider: TurnChangeProvider;
  cwd: string;
  targetPath: string;
  remote?: boolean;
}

export interface OpaqueTurnChangeCapture {
  sessionId: string;
  provider: TurnChangeProvider;
  cwd: string;
  remote?: boolean;
}

export interface BeginTurnChangeSetInput {
  sessionId: string;
  anchorClientId: string;
  provider: TurnChangeProvider;
  cwd: string;
  remote?: boolean;
}

const pendingBySession = new Map<string, PendingTurnChangeSet>();
const sessionWriteChains = new Map<string, Promise<unknown>>();
const workspaceActionChains = new Map<string, Promise<unknown>>();
const workspaceSealChains = new Map<string, Promise<void>>();
const beginEpochBySession = new Map<string, number>();
const pendingWorkspaceBySession = new Map<string, string>();
const pendingWorkspaceCounts = new Map<string, number>();
const retainedSessionDirs = new Map<string, number>();
const activeActionPromises = new Set<Promise<unknown>>();
const legacyReversibleCapabilityByDetailPath = new Map<string, boolean>();
let storageWriteChain = Promise.resolve();

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertSafeSegment(value: string, label: string): void {
  if (
    !value
    || value.length > 256
    || value.includes('/')
    || value.includes('\\')
    || value.includes('..')
    || value.includes('\0')
    || value.includes(':')
  ) {
    throw new Error(`Invalid ${label}`);
  }
}

function storageRoot(): string {
  return turnChangeSetStorageRoot(app.getPath('userData'));
}

function sessionDir(sessionId: string): string {
  return turnChangeSetSessionDirectory(app.getPath('userData'), sessionId);
}

function detailPath(sessionId: string, id: string): string {
  assertSafeSegment(id, 'turn change-set id');
  return path.join(sessionDir(sessionId), `${id}.json`);
}

function normalizedStatus(diff: FileDiff): FileDiff['status'] {
  if (diff.status !== 'unknown') return diff.status;
  return diff.hunks.length > 0 || diff.isBinary ? 'modified' : 'unknown';
}

function parseDiffs(idPrefix: string, unifiedDiff: string): FileDiff[] {
  return parseGitDiffs(unifiedDiff, { source: 'turn', idPrefix })
    .map((diff) => ({ ...diff, status: normalizedStatus(diff) }));
}

function summarizeDiffs(diffs: FileDiff[]): TurnChangeFileSummary[] {
  return diffs.map((diff) => ({
    id: diff.id,
    path: diff.path,
    oldPath: diff.oldPath,
    status: diff.status,
    additions: diff.additions,
    deletions: diff.deletions,
  }));
}

function filterSensitiveDiffBlocks(
  pending: PendingTurnChangeSet,
  unifiedDiff: string,
): string {
  const blocks = unifiedDiff.split(/(?=^diff --git )/m).filter(Boolean);
  if (blocks.length === 0) return unifiedDiff;
  const safeBlocks: string[] = [];
  for (const block of blocks) {
    const files = parseDiffs(pending.id, block);
    // Diff payloads are persisted in the sidecar before any Undo/Reapply
    // validation runs.  Fail closed here so malformed or out-of-workspace
    // paths can never be written to userData or exposed by the review UI.
    if (
      files.length !== 1
      || files.some((file) => (
        !file.path
        || !safeRelativeTarget(pending.cwd, file.path)
        || (file.oldPath !== null && (!file.oldPath || !safeRelativeTarget(pending.cwd, file.oldPath)))
      ))
    ) {
      addIncompleteReason(pending, 'outside-workspace');
      continue;
    }
    const isSensitive = files.some((file) =>
      detectSensitivePath(file.path, { allowEnvTemplates: true })
      || (file.oldPath && detectSensitivePath(file.oldPath, { allowEnvTemplates: true })),
    );
    if (isSensitive) {
      addIncompleteReason(pending, 'sensitive-file');
    } else {
      safeBlocks.push(block);
    }
  }
  return safeBlocks.join('');
}

function isReversiblePatch(value: PersistedTurnChangeSetV1): boolean {
  if (
    value.reversibleFormat !== 'exact-text-v1'
    || value.unifiedDiff.length === 0
    || value.files.length === 0
  ) {
    return false;
  }
  // An after-image read while another turn overlapped in the same workspace may
  // contain the other turn's writes; applying it in either direction could undo
  // work this turn never did. Keep overlapped captures review-only.
  if (value.incompleteReasons.includes('concurrent-workspace')) return false;
  if (/^(?:GIT binary patch|Binary files .* differ)$/m.test(value.unifiedDiff)) return false;
  if (/^(?:old mode|new mode)\s+/m.test(value.unifiedDiff)) return false;
  if (/\b160000\b/.test(value.unifiedDiff)) return false;
  const fileModes = [...value.unifiedDiff.matchAll(/^(?:new file mode|deleted file mode)\s+(\d+)$/gm)];
  // Reformatting add/delete patches makes them work outside Git repositories, but
  // does not carry executable-bit metadata. Keep those records review-only.
  if (fileModes.some((match) => match[1] !== '100644')) return false;

  const diffs = parseDiffs(value.id, value.unifiedDiff);
  if (diffs.length !== value.files.length) return false;
  return diffs.every((diff) => {
    if (!['added', 'modified', 'deleted', 'renamed'].includes(diff.status)) return false;
    if (!safeRelativeTarget(value.cwd, diff.path)) return false;
    if (diff.oldPath && !safeRelativeTarget(value.cwd, diff.oldPath)) return false;
    if (diff.status === 'renamed' && !diff.oldPath) return false;
    if (diff.status === 'modified' && diff.hunks.length === 0) return false;
    // A zero-context insertion/deletion inside an existing file cannot prove
    // that its location stayed attached to the same surrounding content after
    // unrelated line shifts. Whole-file add/delete remains safe because Git
    // validates the file's existence or complete contents.
    if (
      (diff.status === 'modified' || diff.status === 'renamed')
      && diff.hunks.some((hunk) => hunk.oldLines === 0 || hunk.newLines === 0)
    ) return false;
    if ((diff.status === 'added' || diff.status === 'deleted') && diff.hunks.length === 0) {
      return false;
    }
    return true;
  });
}

function toSummary(
  value: PersistedTurnChangeSetV1,
  workspaceState: TurnChangeWorkspaceState = 'applied',
): TurnChangeSetSummary {
  return {
    id: value.id,
    sessionId: value.sessionId,
    anchorClientId: value.anchorClientId,
    provider: value.provider,
    providerTurnId: value.providerTurnId,
    cwd: value.cwd,
    state: value.state,
    workspaceState,
    isReversible: isReversiblePatch(value),
    incompleteReasons: value.incompleteReasons,
    createdAt: value.createdAt,
    completedAt: value.completedAt,
    files: value.files.slice(0, MAX_SUMMARY_FILES),
    fileCount: value.files.length,
    additions: value.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: value.files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFileSummary(value: unknown): value is TurnChangeFileSummary {
  if (!value || typeof value !== 'object') return false;
  const file = value as Partial<TurnChangeFileSummary>;
  return typeof file.id === 'string'
    && typeof file.path === 'string'
    && (file.oldPath === null || typeof file.oldPath === 'string')
    && FILE_STATUSES.has(file.status as FileDiff['status'])
    && isFiniteNonNegative(file.additions)
    && isFiniteNonNegative(file.deletions);
}

function isSummary(value: unknown, sessionId: string): value is TurnChangeSetSummary {
  if (!value || typeof value !== 'object') return false;
  const summary = value as Partial<TurnChangeSetSummary>;
  return typeof summary.id === 'string'
    && summary.sessionId === sessionId
    && typeof summary.anchorClientId === 'string'
    && PROVIDERS.has(summary.provider as TurnChangeProvider)
    && (summary.providerTurnId === null || typeof summary.providerTurnId === 'string')
    && typeof summary.cwd === 'string'
    && STATES.has(summary.state as TurnChangeSetState)
    && (summary.workspaceState === undefined
      || WORKSPACE_STATES.has(summary.workspaceState as TurnChangeWorkspaceState))
    && (summary.isReversible === undefined || typeof summary.isReversible === 'boolean')
    && Array.isArray(summary.incompleteReasons)
    && summary.incompleteReasons.every((reason) => INCOMPLETE_REASONS.has(reason))
    && isFiniteNonNegative(summary.createdAt)
    && isFiniteNonNegative(summary.completedAt)
    && Array.isArray(summary.files)
    && summary.files.every(isFileSummary)
    && isFiniteNonNegative(summary.fileCount)
    && Number.isSafeInteger(summary.fileCount)
    && summary.fileCount >= summary.files.length
    && summary.files.length <= MAX_SUMMARY_FILES
    && isFiniteNonNegative(summary.additions)
    && isFiniteNonNegative(summary.deletions);
}

function parsePersisted(raw: string): PersistedTurnChangeSetV1 | null {
  try {
    const value = JSON.parse(raw) as Partial<PersistedTurnChangeSetV1>;
    if (
      value.version !== 1
      || typeof value.id !== 'string'
      || typeof value.sessionId !== 'string'
      || typeof value.anchorClientId !== 'string'
      || !PROVIDERS.has(value.provider as TurnChangeProvider)
      || (value.providerTurnId !== null && typeof value.providerTurnId !== 'string')
      || typeof value.cwd !== 'string'
      || !STATES.has(value.state as TurnChangeSetState)
      || !Array.isArray(value.incompleteReasons)
      || !value.incompleteReasons.every((reason) => INCOMPLETE_REASONS.has(reason))
      || !isFiniteNonNegative(value.createdAt)
      || !isFiniteNonNegative(value.completedAt)
      || typeof value.unifiedDiff !== 'string'
      || (value.reversibleFormat !== undefined && value.reversibleFormat !== 'exact-text-v1')
      || !Array.isArray(value.files)
      || !value.files.every(isFileSummary)
    ) return null;
    return value as PersistedTurnChangeSetV1;
  } catch {
    return null;
  }
}

async function readActionState(sessionId: string): Promise<TurnChangeActionStateV1> {
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), ACTION_STATE_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<TurnChangeActionStateV1>;
    if (parsed.version !== 1 || !parsed.states || typeof parsed.states !== 'object') {
      return { version: 1, states: {} };
    }
    const states: TurnChangeActionStateV1['states'] = {};
    for (const [id, entry] of Object.entries(parsed.states).slice(-MAX_LIST_ROWS)) {
      if (
        !id
        || id.length > 256
        || !entry
        || typeof entry !== 'object'
        || !WORKSPACE_STATES.has(entry.workspaceState)
        || !isFiniteNonNegative(entry.updatedAt)
      ) continue;
      states[id] = {
        workspaceState: entry.workspaceState,
        updatedAt: entry.updatedAt,
      };
    }
    return { version: 1, states };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('turn change-set action state read failed', { sessionId, error });
    }
    return { version: 1, states: {} };
  }
}

function writeActionStateFile(sessionId: string, state: TurnChangeActionStateV1): void {
  atomicWriteFileSync(
    path.join(sessionDir(sessionId), ACTION_STATE_FILE),
    `${JSON.stringify(state)}\n`,
  );
}

async function persistWorkspaceState(
  sessionId: string,
  id: string,
  workspaceState: TurnChangeWorkspaceState,
): Promise<void> {
  await enqueueStorageWrite(async () => {
    const current = await readActionState(sessionId);
    current.states[id] = { workspaceState, updatedAt: Date.now() };
    writeActionStateFile(sessionId, current);
  });
}

async function pruneActionState(
  sessionId: string,
  retainedIds: ReadonlySet<string>,
): Promise<void> {
  const current = await readActionState(sessionId);
  const states = Object.fromEntries(
    Object.entries(current.states).filter(([id]) => retainedIds.has(id)),
  );
  if (Object.keys(states).length === Object.keys(current.states).length) return;
  if (Object.keys(states).length === 0) {
    await fs.rm(path.join(sessionDir(sessionId), ACTION_STATE_FILE), { force: true });
    return;
  }
  writeActionStateFile(sessionId, { version: 1, states });
}

async function readIndexState(sessionId: string): Promise<TurnChangeIndexV3> {
  try {
    const raw = await fs.readFile(path.join(sessionDir(sessionId), INDEX_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Omit<TurnChangeIndexV3, 'version'>> & {
      version?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3)
      || !Array.isArray(parsed.entries)
    ) {
      return { version: 3, entries: [], detailBytes: {} };
    }
    const sourceVersion = parsed.version;
    const reversibleIndex = sourceVersion >= 2;
    let entries = parsed.entries
      .filter((entry) => isSummary(entry, sessionId))
      .map((entry) => ({
        ...entry,
        workspaceState: WORKSPACE_STATES.has(entry.workspaceState)
          ? entry.workspaceState
          : 'applied' as const,
        isReversible: reversibleIndex && typeof entry.isReversible === 'boolean'
          ? entry.isReversible
          : false,
      }))
      .slice(-MAX_LIST_ROWS);
    const rawDetailBytes = parsed.detailBytes && typeof parsed.detailBytes === 'object'
      ? parsed.detailBytes
      : {};
    const detailBytes: Record<string, number> = {};
    for (const entry of entries) {
      const bytes = rawDetailBytes[entry.id];
      if (isFiniteNonNegative(bytes) && Number.isSafeInteger(bytes)) {
        detailBytes[entry.id] = bytes;
        continue;
      }
      const stat = await fs.stat(detailPath(sessionId, entry.id)).catch(() => null);
      if (stat?.isFile()) detailBytes[entry.id] = stat.size;
    }

    if (sourceVersion < 3) {
      entries = await Promise.all(entries.map(async (entry) => {
        const needsCapabilityUpgrade = sourceVersion === 1 || entry.state === 'partial';
        if (!needsCapabilityUpgrade) return entry;
        const currentDetailPath = detailPath(sessionId, entry.id);
        let isReversible = legacyReversibleCapabilityByDetailPath.get(currentDetailPath);
        if (isReversible === undefined) {
          const rawDetail = await fs.readFile(currentDetailPath, 'utf8').catch(() => null);
          const detail = rawDetail === null ? null : parsePersisted(rawDetail);
          isReversible = detail ? isReversiblePatch(detail) : false;
          // A transient read failure must remain retryable. Otherwise the next normal
          // persist could write a false capability into v3 permanently.
          if (rawDetail !== null) {
            legacyReversibleCapabilityByDetailPath.set(currentDetailPath, isReversible);
          }
        }
        return { ...entry, isReversible };
      }));
    }
    return { version: 3, entries, detailBytes };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('turn change-set index read failed', { sessionId, error });
    }
    return { version: 3, entries: [], detailBytes: {} };
  }
}

async function readIndex(sessionId: string): Promise<TurnChangeSetSummary[]> {
  const [index, actionState] = await Promise.all([
    readIndexState(sessionId),
    readActionState(sessionId),
  ]);
  return index.entries.map((entry) => ({
    ...entry,
    workspaceState: actionState.states[entry.id]?.workspaceState ?? 'applied',
  }));
}

function enqueueSessionWrite<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionWriteChains.get(sessionId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation).finally(() => {
    if (sessionWriteChains.get(sessionId) === current) sessionWriteChains.delete(sessionId);
  });
  sessionWriteChains.set(sessionId, current);
  return current;
}

export function normalizeTurnChangeSetWorkspaceKey(cwd: string): string {
  const lexical = path.resolve(cwd);
  let resolved = lexical;
  try {
    resolved = realpathSync.native(lexical);
  } catch {
    // A removed workspace cannot be mutated; retain the stable lexical key so
    // concurrent failure paths still serialize with one another.
  }
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

function registerPendingWorkspace(sessionId: string, cwd: string): void {
  if (pendingWorkspaceBySession.has(sessionId)) return;
  const key = normalizeTurnChangeSetWorkspaceKey(cwd);
  pendingWorkspaceBySession.set(sessionId, key);
  pendingWorkspaceCounts.set(key, (pendingWorkspaceCounts.get(key) ?? 0) + 1);
}

function unregisterPendingWorkspace(sessionId: string): void {
  const key = pendingWorkspaceBySession.get(sessionId);
  if (!key) return;
  pendingWorkspaceBySession.delete(sessionId);
  const next = (pendingWorkspaceCounts.get(key) ?? 1) - 1;
  if (next <= 0) pendingWorkspaceCounts.delete(key);
  else pendingWorkspaceCounts.set(key, next);
}

function cancelPendingBegin(sessionId: string): void {
  beginEpochBySession.set(sessionId, (beginEpochBySession.get(sessionId) ?? 0) + 1);
}

/**
 * Tracks in-flight after-image persistence per workspace. The next dispatch in the
 * same directory waits for prior snapshots to seal before its turn may mutate files.
 * This wait is bounded capture I/O — never the duration of a running turn.
 */
function registerWorkspaceSeal(cwd: string, operation: Promise<unknown>): void {
  const key = normalizeTurnChangeSetWorkspaceKey(cwd);
  const settled = operation.then(() => undefined, () => undefined);
  const previous = workspaceSealChains.get(key) ?? Promise.resolve();
  const current = previous.then(() => settled).finally(() => {
    if (workspaceSealChains.get(key) === current) workspaceSealChains.delete(key);
  });
  workspaceSealChains.set(key, current);
}

async function waitForWorkspaceSeals(cwd: string): Promise<void> {
  const key = normalizeTurnChangeSetWorkspaceKey(cwd);
  for (;;) {
    const current = workspaceSealChains.get(key);
    if (!current) return;
    await current.catch(() => undefined);
    if (workspaceSealChains.get(key) === current) return;
  }
}

/**
 * Optimistic concurrency for one shared workdir: overlapping turns are never
 * serialized (a turn has no bounded duration). Instead every capture that overlaps
 * another session's active capture is marked — the record stays reviewable, but an
 * after-image read during overlap may contain the other turn's writes, so both
 * sides become review-only (see isReversiblePatch).
 */
function markConcurrentWorkspaceCapture(sessionId: string): void {
  const key = pendingWorkspaceBySession.get(sessionId);
  const own = pendingBySession.get(sessionId);
  if (!key || !own) return;
  let overlapped = false;
  for (const [otherSessionId, otherKey] of pendingWorkspaceBySession) {
    if (otherSessionId === sessionId || otherKey !== key) continue;
    const other = pendingBySession.get(otherSessionId);
    if (!other) continue;
    addIncompleteReason(other, 'concurrent-workspace');
    overlapped = true;
  }
  if (overlapped) addIncompleteReason(own, 'concurrent-workspace');
}

async function waitForWorkspaceActions(cwd: string): Promise<void> {
  const key = normalizeTurnChangeSetWorkspaceKey(cwd);
  for (;;) {
    const current = workspaceActionChains.get(key);
    if (!current) return;
    await current.catch(() => undefined);
    if (workspaceActionChains.get(key) === current) return;
  }
}

async function enqueueWorkspaceAction<T>(
  cwd: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = normalizeTurnChangeSetWorkspaceKey(cwd);
  if ((pendingWorkspaceCounts.get(key) ?? 0) > 0) {
    throw new TurnChangeSetActionError('busy', 'The workspace is still producing file changes.');
  }
  const previous = workspaceActionChains.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation).finally(() => {
    if (workspaceActionChains.get(key) === current) workspaceActionChains.delete(key);
  });
  workspaceActionChains.set(key, current);
  return current;
}

function retainSessionDir(sessionId: string): () => void {
  retainedSessionDirs.set(sessionId, (retainedSessionDirs.get(sessionId) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (retainedSessionDirs.get(sessionId) ?? 1) - 1;
    if (next <= 0) retainedSessionDirs.delete(sessionId);
    else retainedSessionDirs.set(sessionId, next);
  };
}

function trackAction<T>(promise: Promise<T>): Promise<T> {
  activeActionPromises.add(promise);
  void promise.finally(() => activeActionPromises.delete(promise)).catch(() => undefined);
  return promise;
}

/** Drains destructive workspace actions before an account owner is torn down. */
export async function waitForTurnChangeSetActions(): Promise<void> {
  while (activeActionPromises.size > 0) {
    await Promise.allSettled([...activeActionPromises]);
  }
}

/** Drains queued sidecar persistence before the Desktop process exits. */
export async function waitForTurnChangeSetPersistence(): Promise<void> {
  while (sessionWriteChains.size > 0) {
    await Promise.allSettled([...sessionWriteChains.values()]);
  }
  await storageWriteChain.catch(() => undefined);
}

function enqueueStorageWrite(operation: () => Promise<void>): Promise<void> {
  const current = storageWriteChain.catch(() => undefined).then(operation);
  storageWriteChain = current.catch(() => undefined);
  return current;
}

async function pruneStoredSessionDirs(currentSessionId: string): Promise<void> {
  const root = storageRoot();
  const dirents = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = await Promise.all(
    dirents
      .filter((entry) =>
        entry.isDirectory()
        && entry.name !== currentSessionId
        && !retainedSessionDirs.has(entry.name))
      .map(async (entry) => {
        const dir = path.join(root, entry.name);
        const stat = await fs.lstat(dir).catch(() => null);
        if (!stat || stat.isSymbolicLink()) return null;
        const indexStat = await fs.stat(path.join(dir, INDEX_FILE)).catch(() => stat);
        return { dir, updatedAt: indexStat.mtimeMs };
      }),
  );
  const removable = candidates
    .filter((entry): entry is { dir: string; updatedAt: number } => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(Math.max(0, MAX_STORED_SESSION_DIRS - 1));
  await Promise.all(removable.map((entry) => {
    const sessionId = path.basename(entry.dir);
    return retainedSessionDirs.has(sessionId)
      ? Promise.resolve()
      : fs.rm(entry.dir, { recursive: true, force: true });
  }));
}

async function persistValue(value: PersistedTurnChangeSetV1): Promise<void> {
  await enqueueStorageWrite(async () => {
    const dir = sessionDir(value.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const detailContents = `${JSON.stringify(value)}\n`;
    const currentDetailBytes = byteLength(detailContents);
    if (currentDetailBytes > MAX_DETAIL_STORAGE_BYTES) {
      throw new Error('Turn change-set detail exceeds storage limit');
    }
    // Detail ids are immutable and unique. Write them asynchronously before publishing the
    // bounded index so a multi-megabyte patch never blocks Electron's main thread.
    const currentDetailPath = detailPath(value.sessionId, value.id);
    await fs.writeFile(currentDetailPath, detailContents, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    let indexPublished = false;
    try {
      const previous = await readIndexState(value.sessionId);
      const combined = [
        ...previous.entries.filter((entry) => entry.id !== value.id),
        toSummary(value),
      ];
      const detailBytes = { ...previous.detailBytes, [value.id]: currentDetailBytes };
      const nextReversed: TurnChangeSetSummary[] = [];
      let retainedBytes = 0;
      for (const entry of combined.slice(-MAX_LIST_ROWS).reverse()) {
        const bytes = detailBytes[entry.id] ?? 0;
        if (retainedBytes + bytes > MAX_SESSION_DETAIL_BYTES) continue;
        retainedBytes += bytes;
        nextReversed.push(entry);
      }
      const next = nextReversed.reverse();
      const retainedIds = new Set(next.map((entry) => entry.id));
      const nextDetailBytes = Object.fromEntries(
        next.map((entry) => [entry.id, detailBytes[entry.id] ?? 0]),
      );
      atomicWriteFileSync(
        path.join(dir, INDEX_FILE),
        `${JSON.stringify({ version: 3, entries: next, detailBytes: nextDetailBytes } satisfies TurnChangeIndexV3)}\n`,
      );
      indexPublished = true;
      const storedFiles = await fs.readdir(dir).catch(() => []);
      await Promise.all(storedFiles.map((name) => {
        if (name === INDEX_FILE || name === ACTION_STATE_FILE || !name.endsWith('.json')) {
          return Promise.resolve();
        }
        const id = name.slice(0, -'.json'.length);
        return retainedIds.has(id)
          ? Promise.resolve()
          : fs.rm(path.join(dir, name), { force: true });
      }));
      await pruneActionState(value.sessionId, retainedIds);
      await pruneStoredSessionDirs(value.sessionId);
    } catch (error) {
      if (!indexPublished) await fs.rm(currentDetailPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}

function broadcastUpdated(
  payload: TurnChangeSetUpdatedPayload,
  ownerScope = broadcastTap.captureDataOwnerBroadcastScope(),
): void {
  if (!broadcastTap.isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.TURN_CHANGE_SET_UPDATED, payload, ownerScope.ownerStamp);
    } catch (error) {
      log.warn('renderer turn change-set broadcast failed', { error });
    }
  }
}

function ensurePending(
  sessionId: string,
  provider: TurnChangeProvider,
  cwd: string,
): PendingTurnChangeSet {
  const current = pendingBySession.get(sessionId);
  if (current) return current;
  const pending: PendingTurnChangeSet = {
    id: createId(),
    ownerScope: broadcastTap.captureDataOwnerBroadcastScope(),
    provider,
    providerTurnId: null,
    cwd,
    createdAt: Date.now(),
    anchorClientId: null,
    nativeDiff: undefined,
    nativeFiles: [],
    capturedFiles: new Map(),
    captureTasks: new Map(),
    capturedBytes: 0,
    incompleteReasons: new Set(),
  };
  pendingBySession.set(sessionId, pending);
  registerPendingWorkspace(sessionId, cwd);
  return pending;
}

/** Establishes the Cindy product-turn identity before vendor dispatch. */
export async function beginTurnChangeSet(input: BeginTurnChangeSetInput): Promise<void> {
  if (input.remote) {
    clearPendingTurnChangeSets(input.sessionId);
    return;
  }
  const existing = pendingBySession.get(input.sessionId);
  if (existing) {
    if (existing.anchorClientId === input.anchorClientId) return;
    log.warn('replacing unfinished turn change-set at dispatch boundary', {
      sessionId: input.sessionId,
      previousAnchorClientId: existing.anchorClientId,
      anchorClientId: input.anchorClientId,
    });
    pendingBySession.delete(input.sessionId);
    unregisterPendingWorkspace(input.sessionId);
  }
  const epoch = beginEpochBySession.get(input.sessionId) ?? 0;
  // Bounded waits only: prior after-image seals and user-triggered undo/reapply in
  // this workspace. Dispatch never waits for another session's running turn — an
  // overlapping turn degrades both captures instead (markConcurrentWorkspaceCapture).
  await waitForWorkspaceSeals(input.cwd);
  await waitForWorkspaceActions(input.cwd);
  if ((beginEpochBySession.get(input.sessionId) ?? 0) !== epoch) return;
  const raced = pendingBySession.get(input.sessionId);
  if (raced && raced.anchorClientId !== null && raced.anchorClientId !== input.anchorClientId) {
    pendingBySession.delete(input.sessionId);
    unregisterPendingWorkspace(input.sessionId);
  }
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  pending.anchorClientId = input.anchorClientId;
  markConcurrentWorkspaceCapture(input.sessionId);
}

function addIncompleteReason(
  pending: PendingTurnChangeSet,
  reason: TurnChangeIncompleteReason,
): void {
  pending.incompleteReasons.add(reason);
}

function safeRelativeTarget(cwd: string, targetPath: string): { absolutePath: string; relativePath: string } | null {
  if (!cwd || !targetPath) return null;
  const root = path.resolve(cwd);
  const absolutePath = path.resolve(root, targetPath);
  const relativePath = path.relative(root, absolutePath);
  if (
    relativePath === ''
    || relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) return null;
  return { absolutePath, relativePath: relativePath.split(path.sep).join('/') };
}

function captureFileKey(absolutePath: string): string {
  return process.platform === 'win32'
    ? absolutePath.toLocaleLowerCase('en-US')
    : absolutePath;
}

function isInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function isRealTargetInsideWorkspace(cwd: string, absolutePath: string): Promise<boolean> {
  const realRoot = await fs.realpath(path.resolve(cwd)).catch(() => null);
  if (!realRoot) return false;
  const realTarget = await fs.realpath(absolutePath).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') return null;
    let ancestor = path.dirname(absolutePath);
    for (;;) {
      try {
        return await fs.realpath(ancestor);
      } catch (ancestorError) {
        if ((ancestorError as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
      }
    }
  });
  return realTarget !== null && isInsideRoot(realRoot, realTarget);
}

async function readTextFileForCapture(
  absolutePath: string,
  remainingBytes = MAX_CAPTURE_FILE_BYTES,
): Promise<{ exists: boolean; text: string; mode: number | null } | TurnChangeIncompleteReason> {
  try {
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) return 'read-failed';
    if (stat.size > MAX_CAPTURE_FILE_BYTES) return 'file-too-large';
    if (stat.size > remainingBytes) return 'diff-too-large';
    const data = await fs.readFile(absolutePath);
    try {
      return {
        exists: true,
        text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data),
        mode: stat.mode,
      };
    } catch {
      return 'binary-file';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, text: '', mode: null };
    }
    return 'read-failed';
  }
}

/** Low-I/O copy-on-write capture for tools whose target path is known before execution. */
export async function captureKnownFileBefore(input: KnownFileWriteCapture): Promise<void> {
  if (input.remote) return;
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  const target = safeRelativeTarget(input.cwd, input.targetPath);
  if (!target) {
    // Literal out-of-workspace targets are deliberately skipped without recording
    // a reason because the workspace tree was never touched. The realpath escape
    // check below still records 'outside-workspace' when a workspace path resolves
    // beyond that tree, which is worth flagging.
    return;
  }
  if (detectSensitivePath(target.relativePath, { allowEnvTemplates: true })) {
    addIncompleteReason(pending, 'sensitive-file');
    return;
  }
  const captureKey = captureFileKey(target.absolutePath);
  if (pending.capturedFiles.has(captureKey)) return;
  const inFlight = pending.captureTasks.get(captureKey);
  if (inFlight) return inFlight;
  const captureTask = (async () => {
    if (!await isRealTargetInsideWorkspace(input.cwd, target.absolutePath)) {
      addIncompleteReason(pending, 'outside-workspace');
      return;
    }
    if (pending.capturedFiles.size >= MAX_CAPTURED_FILES) {
      addIncompleteReason(pending, 'diff-too-large');
      return;
    }
    const before = await readTextFileForCapture(target.absolutePath);
    if (typeof before === 'string') {
      addIncompleteReason(pending, before);
      return;
    }
    const captureBytes = byteLength(before.text);
    if (pending.capturedBytes + captureBytes > MAX_CAPTURE_TOTAL_BYTES) {
      addIncompleteReason(pending, 'diff-too-large');
      return;
    }
    pending.capturedFiles.set(captureKey, {
      ...target,
      beforeExists: before.exists,
      beforeText: before.text,
      beforeMode: before.mode,
    });
    pending.capturedBytes += captureBytes;
  })().finally(() => pending.captureTasks.delete(captureKey));
  pending.captureTasks.set(captureKey, captureTask);
  return captureTask;
}

/** Marks an executed tool whose filesystem writes cannot be determined ahead of time. */
export function noteOpaqueTurnChange(input: OpaqueTurnChangeCapture): void {
  if (input.remote) return;
  const pending = ensurePending(input.sessionId, input.provider, input.cwd);
  addIncompleteReason(pending, 'opaque-tool');
}

export function noteTurnDiffEvent(sessionId: string, event: AgentEvent, remote = false): void {
  if (remote) return;
  if (event.type !== 'turn_diff' || event.source !== 'codex') return;
  const data = event.data as Partial<TurnDiffEventData> | null;
  if (!data || typeof data.turnId !== 'string' || typeof data.diff !== 'string' || typeof data.cwd !== 'string') {
    return;
  }
  const pending = ensurePending(sessionId, 'codex', data.cwd);
  if (pending.providerTurnId && pending.providerTurnId !== data.turnId) return;
  pending.providerTurnId = data.turnId;
  if (data.isComplete === false) addIncompleteReason(pending, 'provider-diff-conflict');
  else pending.incompleteReasons.delete('provider-diff-conflict');
  pending.incompleteReasons.delete('sensitive-file');
  pending.incompleteReasons.delete('diff-too-large');
  const safeDiff = filterSensitiveDiffBlocks(pending, data.diff);
  if (byteLength(safeDiff) > TURN_CHANGE_SET_MAX_DIFF_BYTES) {
    pending.nativeDiff = null;
    // Without the immutable detail payload, showing file rows would imply that they
    // can be reviewed exactly. Keep only an explicit partial-coverage card instead.
    pending.nativeFiles = [];
    addIncompleteReason(pending, 'diff-too-large');
    return;
  }
  pending.nativeDiff = safeDiff;
  pending.nativeFiles = [];
}

function gitFileMode(mode: number | null): '100644' | '100755' {
  return mode !== null && (mode & 0o111) !== 0 ? '100755' : '100644';
}

function createCapturedFilePatch(
  file: CapturedFile,
  afterExists: boolean,
  afterText: string,
  afterMode: number | null,
): string {
  const oldName = file.beforeExists ? `a/${file.relativePath}` : '/dev/null';
  const newName = afterExists ? `b/${file.relativePath}` : '/dev/null';
  const mode = !file.beforeExists && afterExists
    ? `new file mode ${gitFileMode(afterMode)}\n`
    : file.beforeExists && !afterExists
      ? `deleted file mode ${gitFileMode(file.beforeMode)}\n`
      : file.beforeExists && afterExists && gitFileMode(file.beforeMode) !== gitFileMode(afterMode)
        ? `old mode ${gitFileMode(file.beforeMode)}\nnew mode ${gitFileMode(afterMode)}\n`
        : '';
  return [
    `diff --git a/${file.relativePath} b/${file.relativePath}\n`,
    mode,
    createTwoFilesPatch(oldName, newName, file.beforeText, afterText, '', '', { context: 3 }),
  ].join('');
}

async function buildCapturedPatch(pending: PendingTurnChangeSet): Promise<string> {
  let unifiedDiff = '';
  let afterImageBytes = 0;
  for (const file of pending.capturedFiles.values()) {
    if (!await isRealTargetInsideWorkspace(pending.cwd, file.absolutePath)) {
      addIncompleteReason(pending, 'outside-workspace');
      continue;
    }
    const remainingBytes = MAX_CAPTURE_IO_BYTES - pending.capturedBytes - afterImageBytes;
    if (remainingBytes <= 0) {
      addIncompleteReason(pending, 'diff-too-large');
      break;
    }
    const after = await readTextFileForCapture(file.absolutePath, remainingBytes);
    if (typeof after === 'string') {
      addIncompleteReason(pending, after);
      continue;
    }
    afterImageBytes += byteLength(after.text);
    if (file.beforeExists === after.exists && file.beforeText === after.text) continue;
    const nextPatch = createCapturedFilePatch(file, after.exists, after.text, after.mode);
    if (byteLength(unifiedDiff) + byteLength(nextPatch) > TURN_CHANGE_SET_MAX_DIFF_BYTES) {
      addIncompleteReason(pending, 'diff-too-large');
      break;
    }
    unifiedDiff += nextPatch;
  }
  return unifiedDiff;
}

async function persistPending(
  sessionId: string,
  pending: PendingTurnChangeSet,
  terminalState: TurnChangeSetState,
): Promise<void> {
  await Promise.all(pending.captureTasks.values());
  if (terminalState === 'partial') addIncompleteReason(pending, 'turn-failed');
  // Remote workspaces are deliberately unsupported in this phase. Do not retain a
  // patch that no local renderer is allowed to review.
  if (pending.incompleteReasons.has('remote-session')) return;
  const unifiedDiff = pending.nativeDiff !== undefined
    ? (pending.nativeDiff ?? '')
    : await buildCapturedPatch(pending);
  const diffs = unifiedDiff ? parseDiffs(pending.id, unifiedDiff) : [];
  const files = diffs.length > 0 ? summarizeDiffs(diffs) : pending.nativeFiles;
  // An opaque tool with no known paths is still important turn metadata. Persist a
  // zero-file partial entry so the UI never silently represents it as fully tracked.
  // 'turn-failed' and 'concurrent-workspace' alone are not such evidence: a turn
  // that failed or merely overlapped another session without any capture activity
  // (no tools, no files) has nothing to record, so persisting an empty partial card
  // would claim untracked changes that never existed.
  if (
    files.length === 0
    && [...pending.incompleteReasons].every(
      (reason) => reason === 'turn-failed' || reason === 'concurrent-workspace',
    )
  ) return;
  const anchorClientId = pending.anchorClientId;
  if (!anchorClientId) {
    log.warn('turn change-set has no visible user anchor', { sessionId, id: pending.id });
    return;
  }
  const incompleteReasons = [...pending.incompleteReasons];
  let value: PersistedTurnChangeSetV1 = {
    version: 1,
    reversibleFormat: 'exact-text-v1',
    id: pending.id,
    sessionId,
    anchorClientId,
    provider: pending.provider,
    providerTurnId: pending.providerTurnId,
    cwd: pending.cwd,
    state: terminalState === 'complete' && incompleteReasons.length === 0 ? 'complete' : 'partial',
    incompleteReasons,
    createdAt: pending.createdAt,
    completedAt: Date.now(),
    unifiedDiff,
    files,
  };
  if (byteLength(`${JSON.stringify(value)}\n`) > MAX_DETAIL_STORAGE_BYTES) {
    const fallbackReasons = new Set(value.incompleteReasons);
    fallbackReasons.add('diff-too-large');
    value = {
      ...value,
      state: 'partial',
      incompleteReasons: [...fallbackReasons],
      unifiedDiff: '',
      files: [],
    };
  }
  await persistValue(value);
  broadcastUpdated({ sessionId, summary: toSummary(value) }, pending.ownerScope);
}

export function finalizeTurnChangeSet(
  sessionId: string,
  _providerTurnId: string | null,
  terminalState: TurnChangeSetState,
): Promise<void> {
  const pending = pendingBySession.get(sessionId);
  if (!pending) return Promise.resolve();
  pendingBySession.delete(sessionId);
  const write = enqueueSessionWrite(sessionId, () => persistPending(sessionId, pending, terminalState))
    .catch((error) => log.warn('turn change-set persist failed', { sessionId, error }))
    .finally(() => {
      unregisterPendingWorkspace(sessionId);
    });
  // The next dispatch in this workspace must not let its turn mutate files while
  // this after-image is still being read (registered synchronously on purpose).
  registerWorkspaceSeal(pending.cwd, write);
  return write;
}

/** Prevents the next product turn from mutating files before the prior after-image is sealed. */
export async function waitForTurnChangeSetSeal(sessionId: string): Promise<void> {
  await (sessionWriteChains.get(sessionId) ?? Promise.resolve());
}

export type TurnChangeSetActionErrorKind =
  | 'not-found'
  | 'busy'
  | 'wrong-state'
  | 'git-missing'
  | 'unsupported'
  | 'conflict'
  | 'apply-failed';

export class TurnChangeSetActionError extends Error {
  constructor(readonly kind: TurnChangeSetActionErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = 'TurnChangeSetActionError';
    if (cause !== undefined) this.cause = cause;
  }
}

async function loadLocalSessionWorkspace(sessionId: string): Promise<string> {
  const rows = await getDbClient().query<{ workingDir: string; remoteHostId: string | null }>(
    `SELECT working_dir AS workingDir, remote_host_id AS remoteHostId
       FROM sessions WHERE id = ? LIMIT 1`,
    [sessionId],
  );
  const session = rows[0];
  if (!session) {
    throw new TurnChangeSetActionError('not-found', 'The owning task was not found.');
  }
  if (session.remoteHostId) {
    throw new TurnChangeSetActionError('unsupported', 'Remote workspace restore is not available.');
  }
  return session.workingDir;
}

function assertTurnChangeSetWorkspace(value: PersistedTurnChangeSetV1, workingDir: string): void {
  const expected = path.resolve(workingDir);
  const recorded = path.resolve(value.cwd);
  const matches = process.platform === 'win32'
    ? expected.toLocaleLowerCase('en-US') === recorded.toLocaleLowerCase('en-US')
    : expected === recorded;
  if (!matches) {
    throw new TurnChangeSetActionError(
      'unsupported',
      'The task workspace no longer matches the recorded patch.',
    );
  }
}

function assertOwnerScopeCurrent(scope: broadcastTap.DataOwnerBroadcastScope): void {
  if (!broadcastTap.isDataOwnerBroadcastScopeCurrent(scope)) {
    throw new TurnChangeSetActionError('busy', 'The active account is changing.');
  }
}

async function validatePatchTargets(value: PersistedTurnChangeSetV1): Promise<void> {
  const diffs = parseDiffs(value.id, value.unifiedDiff);
  if (diffs.length !== value.files.length) {
    throw new TurnChangeSetActionError('unsupported', 'The recorded patch is incomplete.');
  }
  const seen = new Set<string>();
  for (const diff of diffs) {
    const currentDiffPaths = new Set<string>();
    for (const relativePath of [diff.oldPath, diff.path]) {
      if (!relativePath) continue;
      const target = safeRelativeTarget(value.cwd, relativePath);
      if (!target || !await isRealTargetInsideWorkspace(value.cwd, target.absolutePath)) {
        throw new TurnChangeSetActionError('unsupported', 'The recorded patch contains an unsafe path.');
      }
      const normalized = process.platform === 'win32'
        ? target.absolutePath.toLocaleLowerCase('en-US')
        : target.absolutePath;
      if (currentDiffPaths.has(normalized)) continue;
      if (seen.has(normalized)) {
        throw new TurnChangeSetActionError('unsupported', 'The recorded patch contains overlapping paths.');
      }
      currentDiffPaths.add(normalized);
      seen.add(normalized);
    }
  }
}

function patchApplyArgs(revert: boolean, check: boolean): string[] {
  // The patch already records its line endings. Global autocrlf must not rewrite
  // a non-Git workspace (or make check/apply disagree with the captured bytes).
  const args = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', 'apply'];
  if (revert) args.push('-R');
  if (check) args.push('--check');
  args.push('--binary', '--whitespace=nowarn', '-');
  return args;
}

function isGitMissingError(error: unknown): boolean {
  return error instanceof GitRunError
    && error.exitCode === null
    && (error.cause as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function usesPortableTextPatch(value: PersistedTurnChangeSetV1): boolean {
  const diffs = parseDiffs(value.id, value.unifiedDiff);
  return diffs.length > 0
    && diffs.every((diff) => ['added', 'modified', 'deleted'].includes(diff.status));
}

function directionalPatch(
  value: PersistedTurnChangeSetV1,
  revert: boolean,
): { patch: string; useReverseFlag: boolean } {
  if (!usesPortableTextPatch(value)) {
    // Rename metadata is not represented by `diff`'s StructuredPatch type.
    // Preserve the vendor patch verbatim and let Git reverse it as one unit.
    return { patch: value.unifiedDiff, useReverseFlag: revert };
  }
  const patches = parsePatch(value.unifiedDiff);
  if (patches.length !== value.files.length || patches.some((patch) => patch.hunks.length === 0)) {
    throw new TurnChangeSetActionError('unsupported', 'The recorded text patch is malformed.');
  }
  return {
    patch: formatPatch(revert ? reversePatch(patches) : patches),
    useReverseFlag: false,
  };
}

async function canApplyRecordedPatch(
  value: PersistedTurnChangeSetV1,
  revert: boolean,
): Promise<boolean> {
  const directed = directionalPatch(value, revert);
  try {
    await runGit(patchApplyArgs(directed.useReverseFlag, true), {
      cwd: value.cwd,
      stdin: directed.patch,
      timeoutMs: 30_000,
    });
    return true;
  } catch (error) {
    if (isGitMissingError(error)) {
      throw new TurnChangeSetActionError(
        'git-missing',
        'Git is not installed or is not available on PATH.',
        error,
      );
    }
    if (error instanceof GitRunError && error.exitCode !== null) return false;
    throw new TurnChangeSetActionError(
      'unsupported',
      'Git is required to apply the recorded patch.',
      error,
    );
  }
}

async function applyRecordedPatch(
  value: PersistedTurnChangeSetV1,
  revert: boolean,
): Promise<void> {
  const directed = directionalPatch(value, revert);
  try {
    await runGit(patchApplyArgs(directed.useReverseFlag, false), {
      cwd: value.cwd,
      stdin: directed.patch,
      timeoutMs: 30_000,
    });
  } catch (error) {
    if (isGitMissingError(error)) {
      throw new TurnChangeSetActionError(
        'git-missing',
        'Git is not installed or is not available on PATH.',
        error,
      );
    }
    if (error instanceof GitRunError && error.exitCode !== null) {
      throw new TurnChangeSetActionError(
        'conflict',
        'The workspace changed before the patch could be applied.',
        error,
      );
    }
    throw new TurnChangeSetActionError(
      'apply-failed',
      'The recorded patch could not be applied.',
      error,
    );
  }
}

/** Applies the immutable turn patch without mutating chat history or Git's index. */
export function applyTurnChangeSetAction(
  sessionId: string,
  id: string,
  action: TurnChangeAction,
  ownerScope = broadcastTap.captureDataOwnerBroadcastScope(),
): Promise<TurnChangeActionResult> {
  const releaseSessionDir = retainSessionDir(sessionId);
  const operation = (async () => {
    try {
      // If pruning was already in flight when the lease was acquired, let that
      // storage operation settle before reading the immutable detail.
      await storageWriteChain.catch(() => undefined);
      return await enqueueSessionWrite(sessionId, async () => {
        assertOwnerScopeCurrent(ownerScope);
        const workingDir = await loadLocalSessionWorkspace(sessionId);
        return enqueueWorkspaceAction(workingDir, async () => {
          assertOwnerScopeCurrent(ownerScope);
          if (pendingBySession.has(sessionId)) {
            throw new TurnChangeSetActionError('busy', 'The task is still producing file changes.');
          }
          const summaries = await listTurnChangeSets(sessionId);
          const currentSummary = summaries.find((summary) => summary.id === id);
          if (!currentSummary) {
            throw new TurnChangeSetActionError('not-found', 'The recorded turn change set was not found.');
          }
          const expectedState: TurnChangeWorkspaceState = action === 'undo' ? 'applied' : 'undone';
          const nextState: TurnChangeWorkspaceState = action === 'undo' ? 'undone' : 'applied';
          if (currentSummary.workspaceState !== expectedState) {
            throw new TurnChangeSetActionError('wrong-state', 'The recorded patch state has changed.');
          }

          const value = parsePersisted(await fs.readFile(detailPath(sessionId, id), 'utf8'));
          if (!value || value.id !== id || value.sessionId !== sessionId) {
            throw new TurnChangeSetActionError('not-found', 'The recorded turn change set was not found.');
          }
          if (!isReversiblePatch(value)) {
            throw new TurnChangeSetActionError(
              'unsupported',
              'This turn was not captured as a reversible text patch.',
            );
          }
          assertTurnChangeSetWorkspace(value, workingDir);
          await validatePatchTargets(value);

          const revert = action === 'undo';
          const canApply = await canApplyRecordedPatch(value, revert);
          assertOwnerScopeCurrent(ownerScope);
          if (!canApply) {
            // A workspace mutation may have succeeded immediately before a state-file write failed.
            // Heal that narrow crash window when the opposite direction proves the target state.
            const targetAlreadyApplied = await canApplyRecordedPatch(value, !revert);
            assertOwnerScopeCurrent(ownerScope);
            if (!targetAlreadyApplied) {
              throw new TurnChangeSetActionError(
                'conflict',
                'The workspace no longer matches the recorded patch.',
              );
            }
            await persistWorkspaceState(sessionId, id, nextState);
            const summary = toSummary(value, nextState);
            broadcastUpdated({ sessionId, summary }, ownerScope);
            return { action, changed: false, summary };
          }

          await applyRecordedPatch(value, revert);
          await persistWorkspaceState(sessionId, id, nextState);
          const summary = toSummary(value, nextState);
          broadcastUpdated({ sessionId, summary }, ownerScope);
          return { action, changed: true, summary };
        });
      });
    } finally {
      releaseSessionDir();
    }
  })();
  return trackAction(operation);
}

export function clearPendingTurnChangeSets(sessionId: string): void {
  pendingBySession.delete(sessionId);
  unregisterPendingWorkspace(sessionId);
  cancelPendingBegin(sessionId);
}

async function validAnchorIds(sessionId: string, summaries: readonly TurnChangeSetSummary[]): Promise<Set<string>> {
  if (summaries.length === 0) return new Set();
  const sessionRows = await getDbClient().query<{ id: string }>(
    'SELECT id FROM sessions WHERE id = ? LIMIT 1',
    [sessionId],
  );
  if (sessionRows.length === 0) return new Set();
  const ids = [...new Set(summaries.map((summary) => summary.anchorClientId))];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = await getDbClient().query<{ clientId: string }>(
    `SELECT client_id AS clientId FROM messages
      WHERE session_id = ? AND role = 'user' AND rewind_at IS NULL
        AND client_id IN (${placeholders})`,
    [sessionId, ...ids],
  );
  return new Set(rows.map((row) => row.clientId));
}

/**
 * A zero-file entry whose incomplete reasons are at most 'turn-failed' carries no
 * change information (see persistPending). Earlier builds persisted such entries for
 * every failed turn; hide them on read so legacy sidecars self-heal without a
 * migration. The reasons-empty shape is deliberately included: no build has ever
 * persisted it (the write guard drops it), and if a corrupted sidecar produced one
 * it would render an equally information-free "+0 -0" card, so it is hidden too.
 */
function isEmptyFailedTurnEntry(summary: TurnChangeSetSummary): boolean {
  return summary.fileCount === 0
    && summary.incompleteReasons.every((reason) => reason === 'turn-failed');
}

export async function listTurnChangeSets(sessionId: string): Promise<TurnChangeSetSummary[]> {
  const summaries = await readIndex(sessionId);
  const anchors = await validAnchorIds(sessionId, summaries);
  return summaries.filter((summary) =>
    anchors.has(summary.anchorClientId) && !isEmptyFailedTurnEntry(summary));
}

export async function getTurnChangeSets(
  sessionId: string,
  ids: string[],
): Promise<TurnChangeSetDetail[]> {
  if (ids.length === 0) return [];
  if (ids.length > MAX_DETAIL_IDS) throw new Error('Too many turn change sets requested');
  const summaries = await listTurnChangeSets(sessionId);
  const allowed = new Map(summaries.map((summary) => [summary.id, summary]));
  const details: TurnChangeSetDetail[] = [];
  for (const id of ids) {
    const summary = allowed.get(id);
    if (!summary) continue;
    try {
      const value = parsePersisted(await fs.readFile(detailPath(sessionId, id), 'utf8'));
      if (!value || value.id !== id || value.sessionId !== sessionId) continue;
      const detailSummary = toSummary(value, summary.workspaceState);
      const detailIdentity = { ...detailSummary, workspaceState: 'applied' as const, isReversible: false };
      const summaryIdentity = { ...summary, workspaceState: 'applied' as const, isReversible: false };
      if (!isDeepStrictEqual(detailIdentity, summaryIdentity)) continue;
      details.push({ ...detailSummary, diffs: parseDiffs(value.id, value.unifiedDiff) });
    } catch (error) {
      log.warn('turn change-set detail read failed', { sessionId, id, error });
    }
  }
  return details;
}

export async function removeTurnChangeSetsForSession(sessionId: string): Promise<void> {
  pendingBySession.delete(sessionId);
  unregisterPendingWorkspace(sessionId);
  cancelPendingBegin(sessionId);
  await enqueueSessionWrite(sessionId, async () => {
    await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
  });
}

export const TURN_CHANGE_SET_DETAIL_ID_LIMIT = MAX_DETAIL_IDS;
