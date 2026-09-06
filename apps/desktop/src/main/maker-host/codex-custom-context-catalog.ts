import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
// Unmodified Apache-2.0 OpenAI Codex rust-v0.153.0 models-manager/prompt.md.
// This is the native unknown-model prompt, never a GPT-specific template.
import nativeFallbackPrompt from './codex-native-fallback-prompt.md?raw';

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

export interface CodexModelCatalog {
  models: Array<Record<string, unknown> & { slug: string }>;
  [key: string]: unknown;
}

/** Same longest-prefix / single provider namespace lookup as Codex ModelsManager. */
export function findCodexCatalogModel(catalog: CodexModelCatalog, modelId: string) {
  const find = (id: string) => catalog.models.filter((m) => id.startsWith(m.slug))
    .sort((a, b) => b.slug.length - a.slug.length)[0];
  return find(modelId) ?? (/^[a-zA-Z0-9_-]+\/[^/]+$/.test(modelId)
    ? find(modelId.slice(modelId.indexOf('/') + 1)) : undefined);
}

// Codex 0.153 removes retired update_plan guidance from its own instructions.
// A model_catalog_json is caller-owned, so preserve that native normalization here.
function nativeInstructions(text: string): string {
  return text.replace(/^## (Planning|`update_plan`|Plan tool|Plan Mode vs update_plan tool)\r?\n[\s\S]*?(?=^#{1,2} |$(?![\s\S]))/gm,
    (section, title: string) => title !== 'Planning' || /^(You have access to an `update_plan` tool|When `update_plan` is available, follow this section)/m.test(section) ? '' : section)
    .replace(/^Progress visibility:\r?\nIf update_plan is available[^\n]*\n(?:\s*\n)?/gm, '')
    .replace(/^- (?:Use the plan tool |If you create a checklist or task list,)[^\n]*\n(?:[ \t]+[^\n]*\n)*/gm, '');
}

function normalizeNativeCatalog(catalog: CodexModelCatalog): CodexModelCatalog {
  return { ...catalog, models: catalog.models.map((model) => {
    const messages = isRecord(model.model_messages) ? model.model_messages : null;
    return { ...model,
      ...(typeof model.base_instructions === 'string' ? { base_instructions: nativeInstructions(model.base_instructions) } : {}),
      ...(messages && typeof messages.instructions_template === 'string'
        ? { model_messages: { ...messages, instructions_template: nativeInstructions(messages.instructions_template) } } : {}),
    };
  }) };
}

/** Mirrors the CLI's model_info_from_slug defaults, preserving prompt/tool behavior. */
export function nativeCodexFallbackModel(slug: string, instructions = nativeFallbackPrompt) {
  return {
    slug, display_name: slug, description: null, supported_reasoning_levels: [],
    shell_type: 'unified_exec', visibility: 'none', supported_in_api: true, priority: 99,
    base_instructions: nativeInstructions(instructions),
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, supports_reasoning_summary_parameter: true,
    default_reasoning_summary: 'auto', support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10_000 },
    context_window: 272_000, max_context_window: 272_000,
    effective_context_window_percent: 95, experimental_supported_tools: [],
  };
}

/** Respect a configured native catalog, then current native discovery, then the binary. */
export async function readNativeCodexCatalog(binaryPath: string, codexHome: string, scanChunkBytes?: number): Promise<CodexModelCatalog> {
  let config: Record<string, unknown> = {};
  try { config = parseToml(await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (typeof config.profile === 'string') {
    config = { ...config, ...parseToml(await fs.readFile(path.join(codexHome, `${config.profile}.config.toml`), 'utf8')) };
  }
  if (typeof config.model_catalog_json === 'string') {
    return parseCodexModelCatalog(await fs.readFile(path.resolve(codexHome, config.model_catalog_json), 'utf8'));
  }
  try { return normalizeNativeCatalog(parseCodexModelCatalog(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'))); }
  catch { return normalizeNativeCatalog(await readBundledCatalog(binaryPath, scanChunkBytes)); }
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
  const selected = findCodexCatalogModel(catalog, modelId) ?? nativeCodexFallbackModel(modelId);
  // Add an exact alias so changing one route cannot change its subscription sibling.
  const model = { ...selected, slug: modelId,
    max_context_window: Math.max(Number(selected.max_context_window) || 0, window) };
  return {
    ...catalog,
    models: catalog.models.some((entry) => entry.slug === modelId)
      ? catalog.models.map((entry) => entry.slug === modelId ? model : entry)
      : [...catalog.models, model],
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
  const stat = await fs.stat(binaryPath);
  const cacheKey = `${path.resolve(binaryPath)}:${stat.size}:${stat.mtimeMs}`;
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
  const bundled = await readNativeCodexCatalog(params.binaryPath, params.codexHome, params.scanChunkBytes);
  let base = params.baseCatalog === undefined
    ? bundled
    : normalizeNativeCatalog(parseCodexModelCatalog(JSON.stringify(params.baseCatalog)));
  if (!base.models.some((model) => model.slug === params.modelId)) {
    const native = findCodexCatalogModel(bundled, params.modelId);
    if (native) base = { ...base, models: [...base.models, { ...native, slug: params.modelId }] };
    else {
      // A runtime upgrade must not silently replace an unknown model's native prompt.
      const binary = await fs.readFile(params.binaryPath);
      // Git checkout and native CLI builds can use different line endings.
      // Verify both byte-exact variants regardless of this checkout's format.
      const unixPrompt = nativeFallbackPrompt.replace(/\r\n/g, '\n');
      const windowsPrompt = unixPrompt.replace(/\n/g, '\r\n');
      const instructions = binary.includes(Buffer.from(unixPrompt)) ? unixPrompt
        : binary.includes(Buffer.from(windowsPrompt)) ? windowsPrompt : null;
      if (instructions === null) {
        throw new Error('Codex native fallback metadata changed; update the bundled compatibility descriptor');
      }
      base = { ...base, models: [...base.models, nativeCodexFallbackModel(params.modelId, instructions)] };
    }
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
