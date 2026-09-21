import path from 'node:path';
import fs from 'node:fs';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import type {
  CindyMakeHistoryRecord,
  MakeFeatureReceipt,
  MakeHistoryCompletion,
  MakeHistoryVersion,
} from '../../shared/cindyMakeHistory.js';
import type { CindyMakePersonalBuildState } from '../../shared/cindyMakeSession.js';
import { parseCindyMakeBuildError, parseCindyMakeBuildLogs } from '../../shared/cindyMakeSession.js';

const ID = /^[a-zA-Z0-9-]{1,128}$/;
const HASH = /^[a-f0-9]{40,64}$/i;
/** Pending source recovery is retained until both Git and history agree again. */
export interface MakeBuildRollbackEntry {
  runId: string;
  receipt: MakeFeatureReceipt;
  previousTaskTree?: string;
}
export function validFeatureReceipt(value: MakeFeatureReceipt): boolean {
  return (
    !!value &&
    ID.test(value.id) &&
    ['integrate', 'revert', 'reapply'].includes(value.action) &&
    Number.isFinite(value.at) &&
    [value.baselineCommit, value.commit, value.beforeTree, value.tree, value.taskTree].every(
      (hash) => typeof hash === 'string' && HASH.test(hash),
    )
  );
}
/** A path captured for one owner. Synchronous read/modify/write prevents lost local updates. */
export class CindyMakeHistoryStore {
  constructor(readonly directory: string) {}
  private file(runId: string): string {
    if (!ID.test(runId)) throw new Error('Invalid Cindy Make history identity');
    return path.join(this.directory, 'records', runId + '.json');
  }
  private assertDirectories(): void {
    for (const directory of [this.directory, path.join(this.directory, 'records')]) {
      try {
        const info = fs.lstatSync(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Invalid history directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  read(runId: string): CindyMakeHistoryRecord | undefined {
    const file = this.file(runId);
    this.assertDirectories();
    for (const candidate of [file, file + '.bak']) {
      try {
        const info = fs.lstatSync(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid history file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const raw = readAtomicFileSync(file);
    if (raw === null) return;
    const value = JSON.parse(raw) as CindyMakeHistoryRecord;
    if (
      value.schema !== 1 ||
      value.runId !== runId ||
      !ID.test(value.sessionId) ||
      typeof value.title !== 'string' ||
      typeof value.request !== 'string' ||
      !Number.isFinite(value.createdAt) ||
      !Number.isFinite(value.updatedAt) ||
      (value.hiddenAt !== undefined && !Number.isFinite(value.hiddenAt)) ||
      !Array.isArray(value.completions) ||
      !Array.isArray(value.receipts) ||
      !value.receipts.every(validFeatureReceipt) ||
      !Array.isArray(value.versions)
    )
      throw new Error('Invalid Cindy Make history');
    return value;
  }
  list(): CindyMakeHistoryRecord[] {
    this.assertDirectories();
    const records = path.join(this.directory, 'records');
    let names: string[];
    try {
      names = fs.readdirSync(records);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const ids = new Set(
      names
        .filter((name) => /\.json(?:\.bak)?$/.test(name))
        .map((name) => name.replace(/\.json(?:\.bak)?$/, ''))
        .filter((id) => ID.test(id)),
    );
    return [...ids]
      .map((id) => this.read(id))
      .filter((record): record is CindyMakeHistoryRecord => record !== undefined)
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  save(record: CindyMakeHistoryRecord): void {
    const file = this.file(record.runId);
    this.assertDirectories();
    atomicWriteFileSync(file, JSON.stringify(record));
  }
  readBuild(): CindyMakePersonalBuildState | undefined {
    this.assertDirectories();
    const file = path.join(this.directory, 'build-state.json');
    for (const candidate of [file, file + '.bak']) {
      try {
        const info = fs.lstatSync(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid build state');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const raw = readAtomicFileSync(file);
    if (raw === null) return;
    const value = JSON.parse(raw);
    if (
      !value ||
      !['waiting', 'checking', 'merging', 'packaging', 'publishing', 'ready', 'failed'].includes(
        value.status,
      )
    )
      throw new Error('Invalid build state');
    const logs = parseCindyMakeBuildLogs(value.logs);
    // The renderer needs status and version identity, never arbitrary fields read from disk.
    return {
      status: value.status,
      ...(value.status === 'waiting' &&
      ['environment', 'original'].includes(value.preparationStep)
        ? { preparationStep: value.preparationStep }
        : {}),
      ...(value.stopping === true ? { stopping: true } : {}),
      ...(Number.isFinite(value.startedAt) && value.startedAt > 0
        ? { startedAt: value.startedAt }
        : {}),
      ...(value.status === 'checking' &&
      ['dependencies', 'tests', 'types'].includes(value.checkStep)
        ? { checkStep: value.checkStep }
        : {}),
      ...(logs ? { logs } : {}),
      ...(typeof value.buildId === 'string' && ID.test(value.buildId)
        ? { buildId: value.buildId }
        : {}),
      ...(typeof value.artifactDirectory === 'string' &&
      path.basename(value.artifactDirectory) === value.artifactDirectory
        ? { artifactDirectory: value.artifactDirectory }
        : {}),
      ...(typeof value.artifactName === 'string' &&
      path.basename(value.artifactName) === value.artifactName
        ? { artifactName: value.artifactName }
        : {}),
      ...(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256)
        ? { sha256: value.sha256 }
        : {}),
      ...(typeof value.commit === 'string' && HASH.test(value.commit)
        ? { commit: value.commit }
        : {}),
      ...(typeof value.versionId === 'string' && /^[a-f0-9-]{36}$/.test(value.versionId)
        ? { versionId: value.versionId }
        : {}),
      ...(typeof value.generatedAt === 'number' && Number.isFinite(value.generatedAt)
        ? { generatedAt: value.generatedAt }
        : {}),
      ...(value.status === 'failed' ? { error: parseCindyMakeBuildError(value.error) } : {}),
    };
  }
  saveBuild(state: CindyMakePersonalBuildState): void {
    this.assertDirectories();
    atomicWriteFileSync(path.join(this.directory, 'build-state.json'), JSON.stringify(state));
  }
  seed(
    record: Omit<CindyMakeHistoryRecord, 'schema' | 'completions' | 'receipts' | 'versions'>,
  ): void {
    const previous = this.read(record.runId);
    if (previous && previous.sessionId !== record.sessionId)
      throw new Error('History identity changed');
    const next = previous
      ? {
          ...previous,
          title: record.title,
          request: record.request,
          createdAt: Math.min(record.createdAt, previous.createdAt),
          updatedAt: Math.max(record.updatedAt, previous.updatedAt),
          endedAt: previous.endedAt ?? record.endedAt,
        }
      : { ...record, schema: 1 as const, completions: [], receipts: [], versions: [] };
    if (JSON.stringify(previous) !== JSON.stringify(next)) this.save(next);
  }
  completion(runId: string, completion: MakeHistoryCompletion): void {
    const record = this.read(runId);
    if (!record) return;
    const index = record.completions.findIndex((item) => item.id === completion.id);
    const previous = record.completions[index];
    if (previous && previous.commit === completion.commit)
      completion = {
        ...completion,
        tree: completion.tree ?? previous.tree,
        baseTree: completion.baseTree ?? previous.baseTree,
        personal: completion.personal ?? previous.personal,
        test: completion.test ?? previous.test,
        lastAction: completion.lastAction ?? previous.lastAction,
        prompt: completion.prompt ?? previous.prompt,
      };
    if (index < 0) record.completions.push(completion);
    else if (JSON.stringify(record.completions[index]) === JSON.stringify(completion)) return;
    else record.completions[index] = completion;
    record.completions.sort((a, b) => a.reportedAt - b.reportedAt);
    record.updatedAt = Math.max(record.updatedAt, completion.reportedAt);
    this.save(record);
  }
  receipt(runId: string, receipt: MakeFeatureReceipt): void {
    const record = this.read(runId);
    if (!record || !validFeatureReceipt(receipt)) throw new Error('Invalid integration receipt');
    if (record.receipts.some((entry) => entry.id === receipt.id)) return;
    record.receipts.push(receipt);
    record.updatedAt = Math.max(record.updatedAt, receipt.at);
    this.save(record);
  }
  readBuildRollback(): MakeBuildRollbackEntry[] {
    this.assertDirectories();
    const file = path.join(this.directory, 'build-rollback.json');
    for (const candidate of [file, file + '.bak']) {
      try {
        const info = fs.lstatSync(candidate);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid build rollback file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const raw = readAtomicFileSync(file);
    if (raw === null) return [];
    const entries = JSON.parse(raw) as MakeBuildRollbackEntry[];
    if (
      !Array.isArray(entries) ||
      !entries.every(
        (entry) =>
          !!entry &&
          typeof entry.runId === 'string' &&
          ID.test(entry.runId) &&
          validFeatureReceipt(entry.receipt) &&
          (entry.previousTaskTree === undefined || HASH.test(entry.previousTaskTree)),
      )
    )
      throw new Error('Invalid build rollback');
    return entries;
  }
  saveBuildRollback(entries: MakeBuildRollbackEntry[]): void {
    this.assertDirectories();
    atomicWriteFileSync(path.join(this.directory, 'build-rollback.json'), JSON.stringify(entries));
  }
  rollbackReceipt(runId: string, receiptId: string): void {
    const record = this.read(runId);
    if (!record || !record.receipts.some((entry) => entry.id === receiptId)) return;
    if (
      record.receipts.at(-1)?.id !== receiptId ||
      record.versions.some((version) => version.operationId === receiptId)
    )
      throw new Error('Integration changed during build rollback');
    record.receipts.pop();
    this.save(record);
  }
  verifyCompletionFacts(
    runId: string,
    id: string,
    commit: string,
    facts: { tree?: string; baseTree?: string },
  ): MakeHistoryCompletion | undefined {
    const record = this.read(runId);
    const completion = record?.completions.find(
      (entry) => entry.id === id && entry.commit === commit,
    );
    if (
      !record ||
      !completion ||
      Object.values(facts).some((value) => value !== undefined && !HASH.test(value))
    )
      return;
    for (const key of ['tree', 'baseTree'] as const)
      if (!completion[key] && facts[key]) completion[key] = facts[key];
    this.save(record);
    return completion;
  }
  version(runId: string, version: MakeHistoryVersion): void {
    const record = this.read(runId);
    if (
      !record ||
      record.versions.some(
        (entry) =>
          entry.operationId === version.operationId &&
          entry.commit === version.commit &&
          entry.versionId === version.versionId,
      )
    )
      return;
    record.versions.push(version);
    this.save(record);
  }
  end(runId: string, at = Date.now()): void {
    const record = this.read(runId);
    if (record && !record.endedAt) this.save({ ...record, endedAt: at, updatedAt: at });
  }
  hide(runId: string, at = Date.now()): void {
    const record = this.read(runId);
    if (record && !record.hiddenAt) this.save({ ...record, hiddenAt: at, updatedAt: at });
  }
}
