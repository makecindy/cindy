import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { parse as parseToml } from 'smol-toml';

export const DEFAULT_CODEX_AUTOMATIONS_ROOT = path.join(os.homedir(), '.codex', 'automations');
const MAX_CODEX_AUTOMATION_FILE_BYTES = 1_000_000;

export interface CodexAutomationTarget {
  type: string;
  projectId?: string;
}

export interface CodexAutomationDetail {
  id: string;
  version?: number;
  kind?: string;
  name: string;
  prompt: string;
  status: string;
  rrule: string;
  model?: string;
  reasoningEffort?: string;
  executionEnvironment?: string;
  target?: CodexAutomationTarget;
  cwds: string[];
  createdAt?: number;
  updatedAt?: number;
  sourcePath: string;
  diagnostics: string[];
}

export interface CodexAutomationReader {
  list(): Promise<CodexAutomationDetail[]>;
  get(id: string): Promise<CodexAutomationDetail | null>;
}

export interface CodexAutomationReaderOptions {
  rootDir?: string;
}

type RawRecord = Record<string, unknown>;

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringField(raw: RawRecord, key: string, fallback: string, diagnostics: string[]): string {
  const value = raw[key];
  if (typeof value === 'string') {
    if (value.length <= 200_000) return value;
    diagnostics.push(`${key} exceeds maximum length of 200000 characters`);
  } else if (value !== undefined) {
    diagnostics.push(`${key} must be a string`);
  }
  return fallback;
}

function optionalStringField(
  raw: RawRecord,
  key: string,
  diagnostics: string[],
): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    if (value.length <= 1_000) return value;
    diagnostics.push(`${key} exceeds maximum length of 1000 characters`);
  } else {
    diagnostics.push(`${key} must be a string`);
  }
  return undefined;
}

function optionalNumberField(
  raw: RawRecord,
  key: string,
  diagnostics: string[],
): number | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  diagnostics.push(`${key} must be a finite number`);
  return undefined;
}

function parseTarget(raw: RawRecord, diagnostics: string[]): CodexAutomationTarget | undefined {
  const value = raw.target;
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.type !== 'string') {
    diagnostics.push('target must be an object with a string type');
    return undefined;
  }
  const projectId = value.project_id;
  if (projectId !== undefined && typeof projectId !== 'string') {
    diagnostics.push('target.project_id must be a string');
  }
  return {
    type: value.type,
    ...(typeof projectId === 'string' ? { projectId } : {}),
  };
}

function parseCwds(raw: RawRecord, diagnostics: string[]): string[] {
  const value = raw.cwds;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    diagnostics.push('cwds must be an array of strings');
    return [];
  }
  return value.filter((item): item is string => item.length <= 32_000);
}

function recurrenceDiagnostics(rrule: string): string[] {
  const diagnostics: string[] = [];
  const interval = /(?:^|;)INTERVAL=(\d+)/i.exec(rrule)?.[1];
  if (interval && Number(interval) > 1) {
    diagnostics.push(
      `RRULE INTERVAL=${interval} cannot be represented exactly by Cindy cron; manual adjustment required`,
    );
  }
  if (!/(?:^|;)BYHOUR=\d+/i.test(rrule) || !/(?:^|;)BYMINUTE=\d+/i.test(rrule)) {
    diagnostics.push('RRULE is missing a fixed hour/minute and needs manual adjustment');
  }
  return diagnostics;
}

const SAFE_FILESYSTEM_ERROR_CODES = new Set([
  'EACCES',
  'EISDIR',
  'ELOOP',
  'EMFILE',
  'ENFILE',
  'ENOENT',
  'ENOTDIR',
  'EPERM',
]);

function filesystemErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && SAFE_FILESYSTEM_ERROR_CODES.has(code) ? code : 'UNKNOWN';
}

function filesystemDiagnostic(action: 'read' | 'list', error: unknown): string {
  if (action === 'list') return `cannot list Codex automations: ${filesystemErrorCode(error)}`;
  return `cannot read automation.toml: ${filesystemErrorCode(error)}`;
}

function fallbackItem(id: string, sourcePath: string, diagnostic: string): CodexAutomationDetail {
  return {
    id,
    name: id,
    prompt: '',
    status: 'UNKNOWN',
    rrule: '',
    cwds: [],
    sourcePath,
    diagnostics: [diagnostic],
  };
}

function parseAutomation(
  idFromDirectory: string,
  sourcePath: string,
  rawText: string,
): CodexAutomationDetail {
  let raw: unknown;
  try {
    raw = parseToml(rawText);
  } catch (error) {
    return fallbackItem(
      idFromDirectory,
      sourcePath,
      `cannot parse automation.toml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const diagnostics: string[] = [];
  if (!isRecord(raw)) {
    return fallbackItem(idFromDirectory, sourcePath, 'automation.toml must contain a table');
  }

  const rawId = raw.id;
  const id = idFromDirectory;
  if (typeof rawId !== 'string') diagnostics.push('id must be a string');
  if (typeof rawId === 'string' && rawId !== idFromDirectory) {
    diagnostics.push('id does not match its automation directory');
  }

  const version = raw.version;
  if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version))) {
    diagnostics.push('version must be an integer');
  }

  const rrule = stringField(raw, 'rrule', '', diagnostics);
  const detail: CodexAutomationDetail = {
    id,
    ...(typeof version === 'number' && Number.isInteger(version) ? { version } : {}),
    kind: optionalStringField(raw, 'kind', diagnostics),
    name: stringField(raw, 'name', idFromDirectory, diagnostics),
    prompt: stringField(raw, 'prompt', '', diagnostics),
    status: stringField(raw, 'status', 'UNKNOWN', diagnostics),
    rrule,
    model: optionalStringField(raw, 'model', diagnostics),
    reasoningEffort: optionalStringField(raw, 'reasoning_effort', diagnostics),
    executionEnvironment: optionalStringField(raw, 'execution_environment', diagnostics),
    target: parseTarget(raw, diagnostics),
    cwds: parseCwds(raw, diagnostics),
    createdAt: optionalNumberField(raw, 'created_at', diagnostics),
    updatedAt: optionalNumberField(raw, 'updated_at', diagnostics),
    sourcePath,
    diagnostics: [...diagnostics, ...recurrenceDiagnostics(rrule)],
  };
  return detail;
}

async function readAutomationFile(rootDir: string, id: string): Promise<CodexAutomationDetail> {
  const sourcePath = path.join(rootDir, id, 'automation.toml');
  try {
    const stats = await fs.lstat(sourcePath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return fallbackItem(id, sourcePath, 'automation.toml must be a regular file');
    }
    if (stats.size > MAX_CODEX_AUTOMATION_FILE_BYTES) {
      return fallbackItem(
        id,
        sourcePath,
        `automation.toml exceeds ${MAX_CODEX_AUTOMATION_FILE_BYTES} bytes`,
      );
    }
    const rawText = await fs.readFile(sourcePath, 'utf8');
    return parseAutomation(id, sourcePath, rawText);
  } catch (error) {
    return fallbackItem(id, sourcePath, filesystemDiagnostic('read', error));
  }
}

export function createCodexAutomationReader(
  options: CodexAutomationReaderOptions = {},
): CodexAutomationReader {
  const rootDir = path.resolve(options.rootDir ?? DEFAULT_CODEX_AUTOMATIONS_ROOT);

  return {
    async list(): Promise<CodexAutomationDetail[]> {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(rootDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw new Error(filesystemDiagnostic('list', error));
      }
      const items = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => readAutomationFile(rootDir, entry.name)),
      );
      items.sort((a, b) => a.id.localeCompare(b.id));
      const byId = new Map<string, CodexAutomationDetail[]>();
      for (const item of items) {
        const same = byId.get(item.id) ?? [];
        same.push(item);
        byId.set(item.id, same);
      }
      for (const duplicates of byId.values()) {
        if (duplicates.length < 2) continue;
        for (const item of duplicates) {
          item.diagnostics.push('duplicate automation id detected');
        }
      }
      return items;
    },
    async get(id: string): Promise<CodexAutomationDetail | null> {
      if (!id || id === '.' || id.includes('..') || path.basename(id) !== id) return null;
      const automationDir = path.join(rootDir, id);
      try {
        const directoryStats = await fs.lstat(automationDir);
        if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(filesystemDiagnostic('read', error));
      }
      const sourcePath = path.join(rootDir, id, 'automation.toml');
      try {
        await fs.access(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw new Error(filesystemDiagnostic('read', error));
      }
      return readAutomationFile(rootDir, id);
    },
  };
}
