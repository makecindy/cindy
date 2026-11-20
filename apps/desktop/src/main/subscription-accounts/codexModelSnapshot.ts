// Only the last verified membership for this Cindy owner, account slot and ChatGPT workspace
// may be restored. The native models_cache.json has no account identity.
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { mapCodexModelsToCatalog } from '../maker-host/codexModelMapping.js';
import type { CatalogModel } from '@cindy/model-providers';

function snapshotPath(slot: string): string {
  return ownerScopedUserDataPath('model-discovery', `codex-pool-${slot}.json`);
}

export function saveCodexModelSnapshot(slot: string, accountKey: string, models: CatalogModel[], confirmedAt: number): void {
  // Persist only normalized display/selection fields, never the opaque CLI response.
  const entries = models.map(model => ({
    slug: model.id, display_name: model.name, description: model.description,
    visibility: 'list', supported_in_api: true, priority: model.sortOrder,
    context_window: model.contextWindowVerified ? model.contextWindow : undefined,
    max_context_window: model.contextWindowMax,
    input_modalities: model.supportsImageInput === undefined ? undefined : model.supportsImageInput ? ['text', 'image'] : ['text'],
    supported_reasoning_levels: model.efforts.map(effort => ({ effort })),
    default_reasoning_level: model.defaultEffort,
    additional_speed_tiers: model.supportsFastMode === undefined && !model.supportsUltrafastMode ? undefined : [
      ...(model.supportsFastMode ? ['priority'] : []),
      ...(model.supportsUltrafastMode ? ['ultrafast'] : []),
    ],
  }));
  atomicWriteFileSync(snapshotPath(slot), JSON.stringify({ accountKey, confirmedAt, entries }));
}

export function clearCodexModelSnapshot(slot: string): void {
  const file = snapshotPath(slot);
  if (readAtomicFileSync(file)) atomicWriteFileSync(file, 'null');
}

export function restoreCodexModelSnapshot(slot: string, accountKey: string): { models: CatalogModel[]; confirmedAt: number } | undefined {
  const raw = readAtomicFileSync(snapshotPath(slot));
  if (!raw) return;
  const saved = JSON.parse(raw);
  if (saved?.accountKey !== accountKey || !Number.isSafeInteger(saved.confirmedAt) || saved.confirmedAt <= 0
    || !Array.isArray(saved.entries) || saved.entries.length > 1000) return;
  return { models: mapCodexModelsToCatalog({ models: saved.entries }), confirmedAt: saved.confirmedAt };
}
