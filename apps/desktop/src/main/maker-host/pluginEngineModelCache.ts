/**
 * Last model list each plugin engine offered (docs/plans/acp-plugin-bridge.md), so the model picker
 * shows it before the engine starts again — including after a restart. Engines report their models
 * only once a task runs on them; Cindy never opens a session just to ask.
 *
 * Kept per account in `owners/<account>/plugin-engine-models.json`: model ids, names, descriptions,
 * groups and reasoning levels only (no messages, accounts or credentials), at most 32 engines × 200
 * models. IDs keep their complete protocol value up to the same limit as the published model
 * directory. Atomic writes; an unreadable file reads as empty and is replaced by the next report.
 *
 * An engine knows the reasoning levels of its selected model only and marks the others unknown, so
 * a model keeps the levels last seen for it until a report actually knows them again.
 */
import { GHOST_HARNESS_MODEL_ID_MAX, GHOST_HARNESS_MODELS_MAX } from '@cindy/plugin-protocol';
import { getDataOwnerLifetime, ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { PLUGIN_ENGINE_EFFORTS, type PluginEngineEffort, type PluginEngineReportedModelDetails } from '../../shared/pluginEngines.js';

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
const MAX_TEXT = 200;
// The built-in model catalogue reaches 3.5M tokens. Allow that scale, not arbitrary sizes.
const MAX_REPORTED_CONTEXT_WINDOW = 4_000_000;

const harnessModels = new Map<string, CachedPluginEngineModel[]>();
/** The account file the in-memory list was read from; another account reads its own file. */
let harnessModelsFile: string | null = null;
const listeners = new Set<() => void>();
const detailsListeners = new Set<() => void>();
const liveDetails = new Map<string, Map<symbol, PluginEngineReportedModelDetails>>();
const handoffWindows = new Map<string, Map<string, number>>();
let reportedModelsOwner = -1;

function ensureReportedModelsOwner(owner = getDataOwnerLifetime()): void {
  if (owner !== reportedModelsOwner) {
    liveDetails.clear();
    handoffWindows.clear();
    reportedModelsOwner = owner;
  }
}

/** Keep the last valid window even after the endpoint closes; never publish it to a catalogue. */
export function observePluginEngineContextWindow(providerId: string) {
  const owner = getDataOwnerLifetime();
  return (modelId: string, size: number): void => {
    if (getDataOwnerLifetime() !== owner || !modelId || modelId.length > GHOST_HARNESS_MODEL_ID_MAX
      || !Number.isSafeInteger(size) || size <= 0 || size > MAX_REPORTED_CONTEXT_WINDOW) return;
    ensureReportedModelsOwner(owner);
    const models = handoffWindows.get(providerId) ?? new Map<string, number>();
    if (models.get(modelId) === size) return;
    // Bound this cache to the same scale as the model list, retaining recent updates.
    models.delete(modelId);
    models.set(modelId, size);
    if (models.size > GHOST_HARNESS_MODELS_MAX) models.delete(models.keys().next().value!);
    handoffWindows.delete(providerId);
    handoffWindows.set(providerId, models);
    if (handoffWindows.size > MAX_HARNESSES) handoffWindows.delete(handoffWindows.keys().next().value!);
  };
}

export function getPluginEngineHandoffWindow(providerId: string, modelId: string): number | null {
  ensureReportedModelsOwner();
  return handoffWindows.get(providerId)?.get(modelId) ?? null;
}

/** One observer per running endpoint. No credentials, disk cache or remote reads. */
export function observePluginEngineModelDetails(providerId: string) {
  const owner = getDataOwnerLifetime();
  const session = Symbol();
  return (details: PluginEngineReportedModelDetails | undefined): void => {
    if (getDataOwnerLifetime() !== owner) return;
    if (details && details.modelId.length > GHOST_HARNESS_MODEL_ID_MAX) details = undefined;
    ensureReportedModelsOwner(owner);
    const reports = liveDetails.get(providerId);
    if (details) {
      const next = reports ?? new Map();
      // The most recent report for each model wins, with older live sessions as fallback.
      next.delete(session);
      next.set(session, details);
      liveDetails.set(providerId, next);
    } else {
      if (!reports?.delete(session)) return;
      if (!reports.size) liveDetails.delete(providerId);
    }
    for (const listener of [...detailsListeners]) listener();
  };
}

export function onReportedPluginEngineModelDetailsChanged(listener: () => void): () => void {
  detailsListeners.add(listener);
  return () => detailsListeners.delete(listener);
}

export function getReportedPluginEngineModelDetails(providerId: string): PluginEngineReportedModelDetails[] {
  ensureReportedModelsOwner();
  const reports = liveDetails.get(providerId);
  if (!reports) return [];
  const byModel = new Map<string, PluginEngineReportedModelDetails>();
  for (const report of reports.values()) byModel.set(report.modelId, report);
  return [...byModel.values()];
}

function boundedText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.slice(0, MAX_TEXT) : undefined;
}

function toCachedModels(raw: unknown): CachedPluginEngineModel[] {
  if (!Array.isArray(raw)) return [];
  const models: CachedPluginEngineModel[] = [];
  for (const item of raw.slice(0, GHOST_HARNESS_MODELS_MAX)) {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const { id } = record;
    if (typeof id !== 'string' || id.length > GHOST_HARNESS_MODEL_ID_MAX || !id.trim()) continue;
    const description = boundedText(record.description);
    const group = boundedText(record.group);
    const efforts = Array.isArray(record.efforts)
      ? PLUGIN_ENGINE_EFFORTS.filter((level) => (record.efforts as unknown[]).includes(level))
      : [];
    models.push({
      id,
      displayName: boundedText(record.displayName) ?? id.slice(0, MAX_TEXT),
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
  liveDetails.clear();
  handoffWindows.clear();
  reportedModelsOwner = -1;
  detailsListeners.clear();
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
