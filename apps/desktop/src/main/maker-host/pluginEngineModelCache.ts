/**
 * Last model list each plugin engine offered (docs/plans/acp-plugin-bridge.md), so the model picker
 * shows it before the engine starts again — including after a restart. Engines report their models
 * only once a task runs on them; Cindy never opens a session just to ask.
 *
 * Kept per account in `owners/<account>/plugin-engine-models.json`: model ids, names, descriptions,
 * groups and reasoning levels only (no messages, accounts or credentials), at most 32 engines × 200
 * models. Atomic writes; an unreadable file reads as empty and is replaced by the next report.
 *
 * An engine knows the reasoning levels of its selected model only and marks the others unknown, so
 * a model keeps the levels last seen for it until a report actually knows them again.
 */
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { PLUGIN_ENGINE_EFFORTS, type PluginEngineEffort } from '../../shared/pluginEngines.js';

/** What the picker shows of a model an engine offered; nothing else is kept. */
export interface CachedPluginEngineModel {
  id: string;
  displayName: string;
  description?: string;
  group?: string;
  /** Levels last seen for this model, low → high. */
  efforts?: PluginEngineEffort[];
}

const MODELS_FILE = 'plugin-engine-models.json';
const MAX_HARNESSES = 32;
const MAX_MODELS_PER_HARNESS = 200;
const MAX_TEXT = 200;

const harnessModels = new Map<string, CachedPluginEngineModel[]>();
/** The account file the in-memory list was read from; another account reads its own file. */
let harnessModelsFile: string | null = null;
const listeners = new Set<() => void>();

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, MAX_TEXT) : undefined;
}

function toCachedModels(raw: unknown): CachedPluginEngineModel[] {
  if (!Array.isArray(raw)) return [];
  const models: CachedPluginEngineModel[] = [];
  for (const item of raw.slice(0, MAX_MODELS_PER_HARNESS)) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const id = boundedText(record.id);
    if (!id) continue;
    const description = boundedText(record.description);
    const group = boundedText(record.group);
    const efforts = Array.isArray(record.efforts)
      ? PLUGIN_ENGINE_EFFORTS.filter((level) => (record.efforts as unknown[]).includes(level))
      : [];
    models.push({
      id,
      displayName: boundedText(record.displayName) ?? id,
      ...(description ? { description } : {}),
      ...(group ? { group } : {}),
      ...(efforts.length ? { efforts } : {}),
    });
  }
  return models;
}

function load(): void {
  const file = ownerScopedUserDataPath(MODELS_FILE);
  if (harnessModelsFile === file) return;
  harnessModelsFile = file;
  harnessModels.clear();
  try {
    const text = readAtomicFileSync(file);
    const parsed = text ? (JSON.parse(text) as { harnesses?: unknown }) : null;
    const entries = parsed?.harnesses && typeof parsed.harnesses === 'object' ? Object.entries(parsed.harnesses) : [];
    for (const [key, models] of entries.slice(0, MAX_HARNESSES)) {
      const list = toCachedModels(models);
      if (list.length) harnessModels.set(key, list);
    }
  } catch {
    // Unreadable or malformed: start empty; the next engine report writes a fresh list.
    harnessModels.clear();
  }
}

function save(): void {
  if (!harnessModelsFile) return;
  try {
    const harnesses = Object.fromEntries([...harnessModels].slice(-MAX_HARNESSES));
    atomicWriteFileSync(harnessModelsFile, JSON.stringify({ version: 1, harnesses }));
  } catch {
    // Display cache only: a failed write just means the default entry after a restart.
  }
}

export function getCachedPluginHarnessModels(key: string): CachedPluginEngineModel[] {
  load();
  return harnessModels.get(key) ?? [];
}

/** Tests only: forget the in-memory list and listeners, as a restart would. */
export function resetPluginHarnessModelCacheForTests(): void {
  harnessModels.clear();
  harnessModelsFile = null;
  listeners.clear();
}

export function onPluginHarnessModelsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Models whose levels the report marks unknown keep the levels last seen for them. */
function withLastSeenEfforts(
  next: CachedPluginEngineModel[],
  offered: unknown,
  previous: readonly CachedPluginEngineModel[] | undefined,
): CachedPluginEngineModel[] {
  if (!previous?.length || !Array.isArray(offered)) return next;
  const unknown = new Set(offered.flatMap((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    return record.effortsUnknown === true && typeof record.id === 'string' ? [record.id] : [];
  }));
  return next.map((model) => {
    if (!unknown.has(model.id)) return model;
    const efforts = previous.find((seen) => seen.id === model.id)?.efforts;
    return efforts?.length ? { ...model, efforts: [...efforts] } : model;
  });
}

/** Records the models an engine just offered; notifies and writes only when the list changed. */
export function rememberPluginHarnessModels(key: string, offered: unknown): void {
  load();
  const previous = harnessModels.get(key);
  const next = withLastSeenEfforts(toCachedModels(offered), offered, previous);
  if (JSON.stringify(previous ?? []) === JSON.stringify(next)) return;
  if (next.length) harnessModels.set(key, next);
  else harnessModels.delete(key);
  save();
  for (const listener of listeners) {
    try { listener(); } catch { /* listener errors stay local */ }
  }
}
