import { promises as fs } from 'node:fs';

import { findClaudeSessionJsonl, resolveClaudeProjectsRoot } from './claude-projects-fs.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonObject = Record<string, unknown>;

export interface RepairForkedClaudeJsonlOptions {
  sessionId: string;
  workingDir?: string;
  projectsRoot?: string;
}

export interface RepairForkedClaudeJsonlResult {
  filePath: string;
  changed: boolean;
  backupPath?: string;
  uuidMap: Map<string, string>;
  lineCount: number;
  initialContextTokens: number;
  compactBoundaryCount: number;
  remappedCompactRefCount: number;
  unresolvedCompactRefCount: number;
  invalidPreservedSegmentRefCount: number;
  clearedInvalidPreservedSegmentRefCount: number;
  compactMetadataRepairs: CompactMetadataRepair[];
}

export interface CompactMetadataRepair {
  boundaryUuid?: string;
  invalidRefs: Array<{ field: string; ref: string }>;
  removedPreservedSegment: boolean;
  removedPreservedMessages: boolean;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function remapUuidStrings(
  value: unknown,
  uuidMap: Map<string, string>,
): { value: unknown; changed: boolean; remapped: number; unresolved: number } {
  if (typeof value === 'string') {
    const mapped = uuidMap.get(value);
    if (mapped) return { value: mapped, changed: true, remapped: 1, unresolved: 0 };
    return {
      value,
      changed: false,
      remapped: 0,
      unresolved: UUID_RE.test(value) ? 1 : 0,
    };
  }

  if (Array.isArray(value)) {
    let changed = false;
    let remapped = 0;
    let unresolved = 0;
    const next = value.map((item) => {
      const result = remapUuidStrings(item, uuidMap);
      changed ||= result.changed;
      remapped += result.remapped;
      unresolved += result.unresolved;
      return result.value;
    });
    return { value: changed ? next : value, changed, remapped, unresolved };
  }

  if (isRecord(value)) {
    let changed = false;
    let remapped = 0;
    let unresolved = 0;
    const next: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const result = remapUuidStrings(item, uuidMap);
      changed ||= result.changed;
      remapped += result.remapped;
      unresolved += result.unresolved;
      next[key] = result.value;
    }
    return { value: changed ? next : value, changed, remapped, unresolved };
  }

  return { value, changed: false, remapped: 0, unresolved: 0 };
}

function invalidPreservedSegmentRefs(
  entry: JsonObject,
  newUuids: Set<string>,
): Array<{ field: string; ref: string }> {
  const metadata = entry.compactMetadata;
  if (!isRecord(metadata)) return [];
  const segment = metadata.preservedSegment;
  if (!isRecord(segment)) return [];

  const invalidRefs: Array<{ field: string; ref: string }> = [];
  for (const field of ['headUuid', 'anchorUuid', 'tailUuid']) {
    const ref = segment[field];
    if (typeof ref === 'string' && !newUuids.has(ref)) {
      invalidRefs.push({ field, ref });
    }
  }
  return invalidRefs;
}

function countInvalidPreservedSegmentRefs(entry: JsonObject, newUuids: Set<string>): number {
  return invalidPreservedSegmentRefs(entry, newUuids).length;
}

function clearInvalidCompactBoundaryMetadata(
  entry: JsonObject,
  newUuids: Set<string>,
): { entry: JsonObject; repair?: CompactMetadataRepair } {
  if (entry.type !== 'system' || entry.subtype !== 'compact_boundary' || !isRecord(entry.compactMetadata)) {
    return { entry };
  }

  const invalidRefs = invalidPreservedSegmentRefs(entry, newUuids);
  if (invalidRefs.length === 0) return { entry };

  const metadata = entry.compactMetadata;
  const removedPreservedSegment = Object.prototype.hasOwnProperty.call(metadata, 'preservedSegment');
  const removedPreservedMessages = Object.prototype.hasOwnProperty.call(metadata, 'preservedMessages');
  const nextMetadata: JsonObject = { ...metadata };
  delete nextMetadata.preservedSegment;
  delete nextMetadata.preservedMessages;

  return {
    entry: { ...entry, compactMetadata: nextMetadata },
    repair: {
      boundaryUuid: typeof entry.uuid === 'string' ? entry.uuid : undefined,
      invalidRefs,
      removedPreservedSegment,
      removedPreservedMessages,
    },
  };
}

function collectUuidMap(entries: JsonObject[]): Map<string, string> {
  const uuidMap = new Map<string, string>();
  for (const entry of entries) {
    const uuid = entry.uuid;
    const forkedFrom = entry.forkedFrom;
    const oldUuid = isRecord(forkedFrom) ? forkedFrom.messageUuid : undefined;
    if (typeof uuid === 'string' && typeof oldUuid === 'string') {
      uuidMap.set(oldUuid, uuid);
    }
  }
  return uuidMap;
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function compactPostTokens(entry: JsonObject): number | undefined {
  if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') return undefined;
  const metadata = isRecord(entry.compactMetadata)
    ? entry.compactMetadata
    : isRecord(entry.compact_metadata)
      ? entry.compact_metadata
      : undefined;
  if (!metadata) return undefined;
  return finitePositiveNumber(metadata.postTokens) ?? finitePositiveNumber(metadata.post_tokens);
}

function isCompactBoundary(entry: JsonObject): boolean {
  return entry.type === 'system' && entry.subtype === 'compact_boundary';
}

function usageContextTokens(entry: JsonObject): number | undefined {
  const message = isRecord(entry.message) ? entry.message : undefined;
  const usage = isRecord(message?.usage)
    ? message.usage
    : isRecord(entry.usage)
      ? entry.usage
      : undefined;
  if (!usage) return undefined;

  const input = finitePositiveNumber(usage.input_tokens) ?? finitePositiveNumber(usage.inputTokens) ?? 0;
  const cacheRead =
    finitePositiveNumber(usage.cache_read_input_tokens) ??
    finitePositiveNumber(usage.cacheReadInputTokens) ??
    0;
  const cacheCreate =
    finitePositiveNumber(usage.cache_creation_input_tokens) ??
    finitePositiveNumber(usage.cacheCreationInputTokens) ??
    0;
  const total = input + cacheRead + cacheCreate;
  return total > 0 ? total : undefined;
}

function estimateInitialContextTokens(entries: JsonObject[]): number {
  let contextTokens = 0;
  for (const entry of entries) {
    if (isCompactBoundary(entry)) {
      contextTokens = compactPostTokens(entry) ?? 0;
      continue;
    }
    const usageTokens = usageContextTokens(entry);
    if (usageTokens !== undefined) {
      contextTokens = usageTokens;
    }
  }
  return contextTokens;
}

function parseJsonlLine(line: string, index: number): JsonObject {
  try {
    return JSON.parse(line) as JsonObject;
  } catch {
    const preview = line.slice(0, 120);
    throw new Error(`Fork JSONL parse error at line ${index + 1}: ${preview}`);
  }
}

export function repairForkedClaudeJsonlText(text: string): Omit<RepairForkedClaudeJsonlResult, 'filePath'> & {
  text: string;
} {
  const hadTrailingNewline = text.endsWith('\n');
  const rawLines = text.split('\n');
  if (hadTrailingNewline) rawLines.pop();

  const entries = rawLines.map(parseJsonlLine);
  const uuidMap = collectUuidMap(entries);
  const newUuids = new Set(
    entries.map((entry) => entry.uuid).filter((uuid): uuid is string => typeof uuid === 'string'),
  );

  let changed = false;
  let compactBoundaryCount = 0;
  let remappedCompactRefCount = 0;
  let unresolvedCompactRefCount = 0;
  let clearedInvalidPreservedSegmentRefCount = 0;
  const compactMetadataRepairs: CompactMetadataRepair[] = [];
  const changedLineIndexes = new Set<number>();

  const nextEntries = entries.map((entry, index) => {
    if (entry.type !== 'system' || entry.subtype !== 'compact_boundary') {
      return entry;
    }

    compactBoundaryCount += 1;
    let nextEntry = entry;
    let lineChanged = false;
    if (isRecord(entry.compactMetadata)) {
      const result = remapUuidStrings(entry.compactMetadata, uuidMap);
      remappedCompactRefCount += result.remapped;
      unresolvedCompactRefCount += result.unresolved;
      if (result.changed) {
        changed = true;
        lineChanged = true;
        nextEntry = { ...entry, compactMetadata: result.value };
      }
    }

    const cleaned = clearInvalidCompactBoundaryMetadata(nextEntry, newUuids);
    if (cleaned.repair) {
      changed = true;
      lineChanged = true;
      clearedInvalidPreservedSegmentRefCount += cleaned.repair.invalidRefs.length;
      compactMetadataRepairs.push(cleaned.repair);
    }
    if (lineChanged) changedLineIndexes.add(index);
    return cleaned.entry;
  });

  let invalidPreservedSegmentRefCount = 0;
  for (const entry of nextEntries) {
    invalidPreservedSegmentRefCount += countInvalidPreservedSegmentRefs(entry, newUuids);
  }

  const nextText = changed
    ? `${nextEntries
      .map((entry, index) => (changedLineIndexes.has(index) ? JSON.stringify(entry) : rawLines[index]))
      .join('\n')}${hadTrailingNewline ? '\n' : ''}`
    : text;

  return {
    text: nextText,
    changed,
    uuidMap,
    lineCount: entries.length,
    initialContextTokens: estimateInitialContextTokens(nextEntries),
    compactBoundaryCount,
    remappedCompactRefCount,
    unresolvedCompactRefCount,
    invalidPreservedSegmentRefCount,
    clearedInvalidPreservedSegmentRefCount,
    compactMetadataRepairs,
  };
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '');
}

async function createJsonlBackup(filePath: string, original: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const suffix = `${backupTimestamp()}${attempt === 0 ? '' : `-${attempt}`}`;
    const backupPath = `${filePath}.bak.${suffix}`;
    try {
      await fs.writeFile(backupPath, original, { encoding: 'utf8', flag: 'wx' });
      return backupPath;
    } catch (error) {
      if (isRecord(error) && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new Error(`Unable to create unique Claude JSONL backup for ${filePath}`);
}

export async function repairForkedClaudeSessionJsonl(
  options: RepairForkedClaudeJsonlOptions,
): Promise<RepairForkedClaudeJsonlResult> {
  const projectsRoot = options.projectsRoot ?? resolveClaudeProjectsRoot();
  const filePath = await findClaudeSessionJsonl(options.sessionId, options.workingDir, projectsRoot);
  if (!filePath) {
    throw new Error(`Claude session JSONL ${options.sessionId} not found under ${projectsRoot}`);
  }
  const original = await fs.readFile(filePath, 'utf8');
  const repaired = repairForkedClaudeJsonlText(original);
  let backupPath: string | undefined;

  if (repaired.changed) {
    backupPath = await createJsonlBackup(filePath, original);
    await fs.writeFile(filePath, repaired.text, 'utf8');
  }

  return {
    filePath,
    changed: repaired.changed,
    ...(backupPath ? { backupPath } : {}),
    uuidMap: repaired.uuidMap,
    lineCount: repaired.lineCount,
    initialContextTokens: repaired.initialContextTokens,
    compactBoundaryCount: repaired.compactBoundaryCount,
    remappedCompactRefCount: repaired.remappedCompactRefCount,
    unresolvedCompactRefCount: repaired.unresolvedCompactRefCount,
    invalidPreservedSegmentRefCount: repaired.invalidPreservedSegmentRefCount,
    clearedInvalidPreservedSegmentRefCount: repaired.clearedInvalidPreservedSegmentRefCount,
    compactMetadataRepairs: repaired.compactMetadataRepairs,
  };
}
