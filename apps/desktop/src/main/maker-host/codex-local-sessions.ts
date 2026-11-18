/** Desktop compatibility entry; Node Host imports the common factory. */
import { desktopCodexLocalSessions } from './codexLocalSessions.desktop.js';
import type { SqlRow, CodexThreadSummary, CodexThreadStateDump, ImportSharedCodexThreadParams, ImportSharedCodexThreadResult, CodexHistoryOversizedClass, CodexSessionIndexEntry } from './codexLocalSessionsCore.js';
export type { SqlScalar, SqlRow, CodexThreadSummary, CodexThreadStateDump, ImportSharedCodexThreadParams, ImportSharedCodexThreadResult, CodexHistoryOversizedClass } from './codexLocalSessionsCore.js';

export function readCodexThreadStorageForArchive(threadId: string): {
  historyHome: string; sqliteHome: string; rolloutPath: string;
} | undefined {
  return desktopCodexLocalSessions.readCodexThreadStorageForArchive(threadId);
}

export async function readCodexThreadStorageForArchiveAsync(threadId: string): Promise<{
  historyHome: string; sqliteHome: string; rolloutPath: string;
} | undefined> {
  return desktopCodexLocalSessions.readCodexThreadStorageForArchiveAsync(threadId);
}

export async function prepareExternalCodexSessionForResume(threadId: string): Promise<string | undefined> {
  return desktopCodexLocalSessions.prepareExternalCodexSessionForResume(threadId);
}

export function normalizeCodexWindowsPath(value: string): string {
  return desktopCodexLocalSessions.normalizeCodexWindowsPath(value);
}

export async function prepareCodexRolloutForResume(
  threadId: string, rolloutPath: string, sqliteHome: string, verifyExternalSource = false,
): Promise<string> {
  return desktopCodexLocalSessions.prepareCodexRolloutForResume(threadId, rolloutPath, sqliteHome, verifyExternalSource);
}

export function repairCodexRolloutPath(threadId: string, rolloutPath: string, sqliteHome: string): string {
  return desktopCodexLocalSessions.repairCodexRolloutPath(threadId, rolloutPath, sqliteHome);
}

export async function dumpCodexThreadStateRows(
  threadId: string,
  storage?: { sqliteHome: string; rolloutPath?: string },
): Promise<CodexThreadStateDump> {
  return desktopCodexLocalSessions.dumpCodexThreadStateRows(threadId, storage);
}

export function reserveCodexForkCleanup(
  threadId: string,
  sourceThreadId: string,
): (() => Promise<void>) | null {
  return desktopCodexLocalSessions.reserveCodexForkCleanup(threadId, sourceThreadId);
}

export async function importSharedCodexThread(
  params: ImportSharedCodexThreadParams,
): Promise<ImportSharedCodexThreadResult> {
  return desktopCodexLocalSessions.importSharedCodexThread(params);
}

export async function removeSharedCodexThread(
  threadId: string,
  written: ImportSharedCodexThreadResult,
): Promise<void> {
  return desktopCodexLocalSessions.removeSharedCodexThread(threadId, written);
}

export function readRawThreadRow(dbPath: string, threadId: string): SqlRow | null {
  return desktopCodexLocalSessions.readRawThreadRow(dbPath, threadId);
}

export async function classifyCodexHistoryOversized(
  threadId: string,
  storage?: { rolloutPath?: string },
): Promise<CodexHistoryOversizedClass> {
  return desktopCodexLocalSessions.classifyCodexHistoryOversized(threadId, storage);
}

export function findLatestStateDb(home: string): string | null {
  return desktopCodexLocalSessions.findLatestStateDb(home);
}

export function getDesktopCodexHome(): string {
  return desktopCodexLocalSessions.getDesktopCodexHome();
}

export function readSessionIndex(home: string): Map<string, CodexSessionIndexEntry> {
  return desktopCodexLocalSessions.readSessionIndex(home);
}

export function readProjectlessThreadIds(home: string): Set<string> {
  return desktopCodexLocalSessions.readProjectlessThreadIds(home);
}

export function discoverExternalCodexHomesSync(): string[] {
  return desktopCodexLocalSessions.discoverExternalCodexHomesSync();
}

export function threadRejectionReason(row: SqlRow): 'thread-source' | 'internal-source' | null {
  return desktopCodexLocalSessions.threadRejectionReason(row);
}

export function normalizeThreadRow(
  home: string,
  dbPath: string | null,
  row: SqlRow,
  projectlessThreadIds: ReadonlySet<string>,
  index?: ReadonlyMap<string, CodexSessionIndexEntry>,
): CodexThreadSummary | null {
  return desktopCodexLocalSessions.normalizeThreadRow(home, dbPath, row, projectlessThreadIds, index);
}
