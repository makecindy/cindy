import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

import { writeFileAtomicIfUnchanged } from './codex-global-plugins.js';

const BUNDLED_CATALOG_MARKERS = [
  Buffer.from('{\n  "models": [', 'utf8'),
  Buffer.from('{\r\n  "models": [', 'utf8'),
];
const MAX_CATALOG_MARKER_BYTES = Math.max(
  ...BUNDLED_CATALOG_MARKERS.map((marker) => marker.length),
);
const DEFAULT_SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_CATALOG_BYTES = 16 * 1024 * 1024;
const bundledCatalogByBinary = new Map<string, Promise<CodexModelCatalog>>();

interface CodexModelCatalog {
  models: Array<Record<string, unknown> & { slug: string }>;
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCodexModelCatalog(text: string): CodexModelCatalog {
  const parsed = JSON.parse(text) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error('embedded Codex model catalog must contain a non-empty models array');
  }
  const models = parsed.models.map((model, index) => {
    if (!isRecord(model) || typeof model.slug !== 'string' || model.slug.length === 0) {
      throw new Error(`embedded Codex model catalog has an invalid model at index ${index}`);
    }
    return model as Record<string, unknown> & { slug: string };
  });
  return { ...parsed, models };
}

async function findCatalogMarkerOffsets(
  file: FileHandle,
  size: number,
  chunkBytes: number,
): Promise<number[]> {
  const offsets: number[] = [];
  let carry = Buffer.alloc(0);
  let position = 0;
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const window = Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
    const windowStart = position - carry.length;
    for (const marker of BUNDLED_CATALOG_MARKERS) {
      let searchFrom = 0;
      while (searchFrom < window.length) {
        const index = window.indexOf(marker, searchFrom);
        if (index < 0) break;
        offsets.push(windowStart + index);
        searchFrom = index + marker.length;
      }
    }
    const carryStart = Math.max(0, window.length - MAX_CATALOG_MARKER_BYTES + 1);
    carry = Buffer.from(window.subarray(carryStart));
    position += bytesRead;
  }
  return offsets.sort((left, right) => left - right);
}

async function readJsonObjectAt(
  file: FileHandle,
  size: number,
  start: number,
  chunkBytes: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let capturedBytes = 0;
  let position = start;
  let depth = 0;
  let inString = false;
  let escaped = false;

  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(chunkBytes, size - position));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    const data = buffer.subarray(0, bytesRead);
    for (let index = 0; index < data.length; index++) {
      const byte = data[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (byte === 0x5c) {
          escaped = true;
        } else if (byte === 0x22) {
          inString = false;
        }
        continue;
      }
      if (byte === 0x22) {
        inString = true;
      } else if (byte === 0x7b) {
        depth += 1;
      } else if (byte === 0x7d) {
        depth -= 1;
        if (depth === 0) {
          const finalChunk = data.subarray(0, index + 1);
          chunks.push(finalChunk);
          capturedBytes += finalChunk.length;
          if (capturedBytes > MAX_CATALOG_BYTES) {
            throw new Error('embedded Codex model catalog exceeds the safety limit');
          }
          return Buffer.concat(chunks, capturedBytes).toString('utf8');
        }
      }
    }
    chunks.push(data);
    capturedBytes += data.length;
    if (capturedBytes > MAX_CATALOG_BYTES) {
      throw new Error('embedded Codex model catalog exceeds the safety limit');
    }
    position += bytesRead;
  }
  throw new Error('embedded Codex model catalog JSON is incomplete');
}

export async function extractBundledCodexModelCatalog(
  binaryPath: string,
  options: { scanChunkBytes?: number } = {},
): Promise<CodexModelCatalog> {
  const chunkBytes = Math.max(64, Math.floor(options.scanChunkBytes ?? DEFAULT_SCAN_CHUNK_BYTES));
  const file = await fs.open(binaryPath, 'r');
  try {
    const { size } = await file.stat();
    const offsets = await findCatalogMarkerOffsets(file, size, chunkBytes);
    let lastError: unknown;
    for (const offset of offsets) {
      try {
        return parseCodexModelCatalog(await readJsonObjectAt(file, size, offset, chunkBytes));
      } catch (error) {
        lastError = error;
      }
    }
    throw new Error(
      lastError instanceof Error
        ? `failed to extract embedded Codex model catalog: ${lastError.message}`
        : 'current Codex binary does not contain an embedded model catalog',
    );
  } finally {
    await file.close();
  }
}

export function patchCodexModelMaxContextWindow(
  catalog: CodexModelCatalog,
  modelId: string,
  contextWindow: number,
): CodexModelCatalog {
  const window = Math.floor(contextWindow);
  if (!modelId || !Number.isFinite(window) || window <= 0) {
    throw new Error('custom Codex context catalog requires a model and positive context window');
  }
  const matches = catalog.models.filter((model) => model.slug === modelId);
  if (matches.length !== 1) {
    throw new Error(
      `current Codex binary catalog must contain exactly one model named ${JSON.stringify(modelId)}`,
    );
  }
  return {
    ...catalog,
    models: catalog.models.map((model) => {
      if (model.slug !== modelId) return model;
      const currentMax = model.max_context_window;
      const maxContextWindow = typeof currentMax === 'number' && Number.isFinite(currentMax)
        ? Math.max(Math.floor(currentMax), window)
        : window;
      return { ...model, max_context_window: maxContextWindow };
    }),
  };
}

export function buildCodexModelCatalogSpawnArgs(catalogPath: string): string[] {
  if (!path.isAbsolute(catalogPath)) {
    throw new Error('Codex model catalog path must be absolute');
  }
  return ['-c', `model_catalog_json=${JSON.stringify(catalogPath)}`];
}

async function readBundledCatalog(
  binaryPath: string,
  scanChunkBytes?: number,
): Promise<CodexModelCatalog> {
  const cacheKey = path.resolve(binaryPath);
  let bundledPromise = bundledCatalogByBinary.get(cacheKey);
  if (!bundledPromise || scanChunkBytes !== undefined) {
    bundledPromise = extractBundledCodexModelCatalog(binaryPath, { scanChunkBytes });
    if (scanChunkBytes === undefined) bundledCatalogByBinary.set(cacheKey, bundledPromise);
  }
  try {
    return await bundledPromise;
  } catch (error) {
    if (bundledCatalogByBinary.get(cacheKey) === bundledPromise) {
      bundledCatalogByBinary.delete(cacheKey);
    }
    throw error;
  }
}

/**
 * 只有静态目录里已有的真实 slug 才能安全抬高上限。未知 slug 会由 Codex 构造带专用
 * base instructions 的 fallback metadata；克隆任意内置条目会静默改变模型行为。
 */
export async function bundledCodexCatalogHasModel(
  binaryPath: string,
  modelId: string,
  options: { scanChunkBytes?: number } = {},
): Promise<boolean> {
  if (!modelId) return false;
  const bundled = await readBundledCatalog(binaryPath, options.scanChunkBytes);
  return bundled.models.some((model) => model.slug === modelId);
}

async function persistCatalog(codexHome: string, content: string): Promise<string> {
  if (!path.isAbsolute(codexHome)) {
    throw new Error('Codex home must be absolute');
  }
  const digest = createHash('sha256').update(content).digest('hex');
  const directory = path.join(codexHome, 'cindy-runtime', 'model-catalogs');
  const file = path.join(directory, `catalog-${digest}.json`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);

  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing && existing !== content) {
    throw new Error(`Codex model catalog hash collision or corruption: ${file}`);
  }
  if (!existing) {
    try {
      const written = await writeFileAtomicIfUnchanged(file, content, '');
      if (!written) {
        const concurrent = await fs.readFile(file, 'utf8');
        if (concurrent !== content) {
          throw new Error(`Codex model catalog changed during creation: ${file}`);
        }
      }
    } catch (error) {
      // Windows rename does not replace an existing destination. Two sessions can
      // race while creating the same hash-named catalog; the loser is successful
      // when the winner published the exact same immutable content.
      let concurrent: string;
      try {
        concurrent = await fs.readFile(file, 'utf8');
      } catch {
        throw error;
      }
      if (concurrent !== content) {
        throw error;
      }
    }
  }
  if (process.platform !== 'win32') await fs.chmod(file, 0o600);
  return file;
}

export async function prepareCodexCustomContextCatalog(params: {
  binaryPath: string;
  codexHome: string;
  modelId: string;
  contextWindow: number;
  scanChunkBytes?: number;
  /** In-memory smart Subagent catalog to preserve in the one-session custom-context Host. */
  baseCatalog?: unknown;
}): Promise<{ catalogPath: string; extraArgs: string[] }> {
  const bundled = await readBundledCatalog(params.binaryPath, params.scanChunkBytes);
  let base = params.baseCatalog === undefined
    ? bundled
    : parseCodexModelCatalog(JSON.stringify(params.baseCatalog));
  if (!base.models.some((model) => model.slug === params.modelId)) {
    const bundledMatches = bundled.models.filter((model) => model.slug === params.modelId);
    if (bundledMatches.length !== 1) {
      throw new Error(
        `current Codex binary catalog must contain exactly one model named ${JSON.stringify(params.modelId)}`,
      );
    }
    base = { ...base, models: [...base.models, bundledMatches[0]!] };
  }
  const patched = patchCodexModelMaxContextWindow(
    base,
    params.modelId,
    params.contextWindow,
  );
  const content = `${JSON.stringify(patched)}\n`;
  const catalogPath = await persistCatalog(params.codexHome, content);
  return {
    catalogPath,
    extraArgs: buildCodexModelCatalogSpawnArgs(catalogPath),
  };
}
