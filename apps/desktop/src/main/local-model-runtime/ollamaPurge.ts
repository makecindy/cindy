import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const UNLINK_RETRIES = 5;
const UNLINK_RETRY_MS = 80;

export function resolveOllamaModelsDir(
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = os.homedir,
): string {
  const override = env.OLLAMA_MODELS?.trim();
  if (override) return override;
  return path.join(homedir(), '.ollama', 'models');
}

export function blobFileName(digest: string): string {
  return digest.replace(/^sha256:/, 'sha256-');
}

/** Ollama 半截文件是 `sha256-xxx.tmp`，有时也会写成 `-partial`。 */
export function blobBaseName(file: string): string {
  if (!file.startsWith('sha256-')) return '';
  return file.replace(/-partial(?:\.[^.]+)?$/, '').replace(/\.[^.]+$/, '');
}

export function isIncompleteBlobName(file: string): boolean {
  return file.endsWith('.tmp') || file.includes('-partial');
}

async function incompleteBlobSnapshot(
  modelsDir: string,
  digestBases?: ReadonlySet<string>,
): Promise<string> {
  const blobsDir = path.join(modelsDir, 'blobs');
  let entries: string[] = [];
  try {
    entries = (await readdir(blobsDir)).filter((file) => {
      if (!isIncompleteBlobName(file)) return false;
      if (!digestBases) return true;
      return digestBases.has(blobBaseName(file));
    }).sort();
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const file of entries) {
    try {
      const info = await stat(path.join(blobsDir, file));
      parts.push(`${file}:${info.size}:${info.mtimeMs}`);
    } catch {
      parts.push(`${file}:missing`);
    }
  }
  return parts.join('|');
}

/** Ollama 取消 HTTP 后还会在后台把当前层写完，等 .tmp 不再长大再删。 */
export async function waitForIncompleteBlobsToSettle(opts: {
  modelsDir: string;
  digests?: readonly string[];
  timeoutMs?: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3_000;
  const intervalMs = opts.intervalMs ?? 150;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const digestBases = opts.digests
    ? new Set(opts.digests.map(blobFileName).filter((value) => value.startsWith('sha256-')))
    : undefined;
  const deadline = now() + timeoutMs;
  let last = '';
  let stable = 0;
  while (now() <= deadline) {
    const snapshot = await incompleteBlobSnapshot(opts.modelsDir, digestBases);
    if (snapshot === last) {
      stable += 1;
      if (stable >= 2) return;
    } else {
      last = snapshot;
      stable = 0;
    }
    await sleep(intervalMs);
  }
}

function collectDigestsFromManifest(value: unknown, into: Set<string>): void {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.digest === 'string' && record.digest.startsWith('sha256:')) {
    into.add(blobFileName(record.digest));
  }
  if (record.config) collectDigestsFromManifest(record.config, into);
  if (Array.isArray(record.layers)) {
    for (const layer of record.layers) collectDigestsFromManifest(layer, into);
  }
}

export async function collectReferencedBlobNames(modelsDir: string): Promise<Set<string>> {
  const used = new Set<string>();
  const manifestsDir = path.join(modelsDir, 'manifests');
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(next);
      else if (entry.isFile()) files.push(next);
    }
  }
  await walk(manifestsDir);
  for (const file of files) {
    try {
      collectDigestsFromManifest(JSON.parse(await readFile(file, 'utf8')), used);
    } catch {
      /* skip unreadable / non-json */
    }
  }
  return used;
}

export function manifestRelPathForModel(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const colon = trimmed.lastIndexOf(':');
  const repo = colon >= 0 ? trimmed.slice(0, colon) : trimmed;
  const tag = colon >= 0 ? trimmed.slice(colon + 1) : 'latest';
  if (!repo || !tag) return null;
  const parts = repo.split('/').filter(Boolean);
  if (parts[0] === 'hf.co' && parts.length === 3) {
    return path.join('manifests', 'hf.co', parts[1]!, parts[2]!, tag);
  }
  if (parts.length === 2) {
    return path.join('manifests', 'registry.ollama.ai', parts[0]!, parts[1]!, tag);
  }
  if (parts.length === 1) {
    return path.join('manifests', 'registry.ollama.ai', 'library', parts[0]!, tag);
  }
  return null;
}

function isRetryableUnlink(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = String((error as { code?: unknown }).code);
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

async function unlinkRetry(filePath: string): Promise<boolean> {
  for (let attempt = 0; attempt < UNLINK_RETRIES; attempt += 1) {
    try {
      await unlink(filePath);
      return true;
    } catch (error) {
      if (!isRetryableUnlink(error) || attempt === UNLINK_RETRIES - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, UNLINK_RETRY_MS * (attempt + 1)));
    }
  }
  return false;
}

export async function purgeCancelledOllamaPull(opts: {
  modelsDir: string;
  name: string;
  digests: readonly string[];
  deleteAllIncomplete?: boolean;
  pruneUnreferenced?: boolean;
  deleteManifest?: boolean;
  keepDigests?: readonly string[];
  touchedSinceMs?: number;
}): Promise<{ deleted: string[] }> {
  const deleted: string[] = [];
  const names = new Set(opts.digests.map(blobFileName).filter((value) => value.startsWith('sha256-')));
  const manifestRel = manifestRelPathForModel(opts.name);
  if (manifestRel) {
    const manifestPath = path.join(opts.modelsDir, manifestRel);
    try {
      collectDigestsFromManifest(JSON.parse(await readFile(manifestPath, 'utf8')), names);
    } catch {
      /* no complete manifest yet */
    }
    if (opts.deleteManifest !== false && (await unlinkRetry(manifestPath))) {
      deleted.push(manifestPath);
    }
  }
  const used = await collectReferencedBlobNames(opts.modelsDir);
  const blobsDir = path.join(opts.modelsDir, 'blobs');
  let blobEntries: string[] = [];
  try {
    blobEntries = await readdir(blobsDir);
  } catch {
    return { deleted };
  }
  const keep = new Set(
    (opts.keepDigests ?? []).map(blobFileName).filter((value) => value.startsWith('sha256-')),
  );
  for (const file of blobEntries) {
    const base = blobBaseName(file);
    if (!base || used.has(base) || keep.has(base)) continue;
    const incomplete = isIncompleteBlobName(file);
    let recent = false;
    if (opts.touchedSinceMs != null && !incomplete) {
      try {
        const info = await stat(path.join(blobsDir, file));
        recent = info.mtimeMs >= opts.touchedSinceMs;
      } catch {
        recent = false;
      }
    }
    const shouldDelete =
      names.has(base) ||
      (opts.deleteAllIncomplete === true && incomplete) ||
      opts.pruneUnreferenced === true ||
      recent;
    if (!shouldDelete) continue;
    if (await unlinkRetry(path.join(blobsDir, file))) deleted.push(file);
  }
  return { deleted };
}
