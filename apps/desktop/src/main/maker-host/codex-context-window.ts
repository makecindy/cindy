import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { CodexContextWindowInfo } from '@cindy/maker-core';
import { extractBundledCodexModelCatalog, findCodexCatalogModel, patchCodexModelMaxContextWindow, type CodexModelCatalog } from './codex-custom-context-catalog.js';

type RecordValue = Record<string, unknown>;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const record = (value: unknown): RecordValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};

/** Native Codex metadata only: never consult Cindy's provider/model catalog. */
export function resolveCodexContextWindowInfo(
  model: RecordValue | undefined,
  config: RecordValue,
  reportedUsableWindow?: number | null,
): CodexContextWindowInfo | null {
  // Codex 0.153's model_info_from_slug uses these values for unknown model ids.
  const native = model ?? { context_window: 272_000, max_context_window: 272_000, effective_context_window_percent: 95 };
  const percentage = native.effective_context_window_percent ?? 95;
  if (!positive(percentage) || percentage > 100) return null;
  const maximum = positive(native.max_context_window) ? native.max_context_window : null;
  const defaultWindow = positive(native.context_window) ? native.context_window : maximum;
  const configuredWindow = positive(config.model_context_window)
    ? Math.min(config.model_context_window, maximum ?? Infinity)
    : defaultWindow;
  if (!configuredWindow) return null;
  // A running thread may have applied different config from the current defaults.
  // Reconstruct its total using the native model's headroom, never a fixed UI /0.95.
  const contextWindow = positive(reportedUsableWindow)
    ? Math.floor(configuredWindow * percentage / 100) === reportedUsableWindow
      ? configuredWindow
      : Math.round(reportedUsableWindow * 100 / percentage)
    : configuredWindow;
  const configuredCompact = positive(config.model_auto_compact_token_limit)
    ? config.model_auto_compact_token_limit
    : positive(native.auto_compact_token_limit) ? native.auto_compact_token_limit : null;
  return {
    contextWindow,
    usableContextWindow: positive(reportedUsableWindow)
      ? reportedUsableWindow : Math.floor(contextWindow * percentage / 100),
    autoCompactTokenLimit: Math.min(configuredCompact ?? Infinity, Math.floor(contextWindow * 0.9)),
    modelMaxContextWindow: maximum,
    source: positive(reportedUsableWindow) ? 'runtime' : 'config',
    fallbackModel: model === undefined,
  };
}

const bundled = new Map<string, ReturnType<typeof extractBundledCodexModelCatalog>>();
/** Reads only the managed CLI's configuration/metadata; does not start a process or write config. */
export async function readCodexContextWindowInfo(options: {
  codexHome: string;
  binaryPath?: string;
  modelId: string;
  config?: RecordValue;
  reportedUsableWindow?: number | null;
  contextWindowOverride?: number | null;
}): Promise<CodexContextWindowInfo | null> {
  try {
    let config = options.config;
    if (!config) {
      let text: string;
      try { text = await fs.readFile(path.join(options.codexHome, 'config.toml'), 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        text = '';
      }
      config = record(parseToml(text));
      if (typeof config.profile === 'string') {
        config = { ...config, ...record(parseToml(await fs.readFile(path.join(options.codexHome, `${config.profile}.config.toml`), 'utf8'))) };
      }
    }
    let catalog: RecordValue;
    if (typeof config.model_catalog_json === 'string') {
      const catalogPath = path.isAbsolute(config.model_catalog_json)
        ? config.model_catalog_json : path.resolve(options.codexHome, config.model_catalog_json);
      catalog = record(JSON.parse(await fs.readFile(catalogPath, 'utf8')));
    } else {
      try {
        catalog = record(JSON.parse(await fs.readFile(path.join(options.codexHome, 'models_cache.json'), 'utf8')));
      } catch {
        if (!options.binaryPath) return null;
        const stat = await fs.stat(options.binaryPath);
        const cacheKey = `${options.binaryPath}:${stat.size}:${stat.mtimeMs}`;
        let pending = bundled.get(cacheKey);
        if (!pending) {
          pending = extractBundledCodexModelCatalog(options.binaryPath);
          bundled.set(cacheKey, pending);
          pending.catch(() => bundled.delete(cacheKey));
        }
        catalog = await pending;
      }
    }
    if (!Array.isArray(catalog.models)) return null;
    if (positive(options.contextWindowOverride)) {
      catalog = patchCodexModelMaxContextWindow(catalog as CodexModelCatalog, options.modelId, options.contextWindowOverride);
      config = { ...config, model_context_window: options.contextWindowOverride,
        model_auto_compact_token_limit: Math.floor(options.contextWindowOverride * 0.9) };
    }
    const model = findCodexCatalogModel(catalog as CodexModelCatalog, options.modelId);
    return resolveCodexContextWindowInfo(model, config, options.reportedUsableWindow);
  } catch {
    // No fabricated value when a configured native catalog cannot be read.
    return null;
  }
}
