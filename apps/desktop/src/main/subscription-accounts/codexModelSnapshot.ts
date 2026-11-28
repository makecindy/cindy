// Only the last verified membership for this Cindy owner, account slot and ChatGPT workspace
// may be restored. The native models_cache.json has no account identity.
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from '../utils/replaceFile.js';
import { mapCodexModelsToCatalog } from '../maker-host/codexModelMapping.js';
import type { CatalogModel } from '@cindy/model-providers';

function snapshotPath(slot: string): string {
  return ownerScopedUserDataPath('model-discovery', `codex-pool-${slot}.json`);
}

export async function saveCodexModelSnapshot(
  slot: string, accountKey: string, models: CatalogModel[], confirmedAt: number, isCurrent: () => boolean,
): Promise<boolean> {
  const file = snapshotPath(slot);
  // Persist only normalized display/selection fields, never the opaque CLI response.
  const entries = models.map(model => ({
    slug: model.id, display_name: model.discoveredMetadata?.name, description: model.description,
    visibility: 'list', supported_in_api: true, priority: model.sortOrder,
    context_window: model.contextWindowVerified ? model.contextWindow : undefined,
    max_context_window: model.contextWindowMax,
    input_modalities: model.supportsImageInput === undefined ? undefined : model.supportsImageInput ? ['text', 'image'] : ['text'],
    // An omitted list allows registry fallback; an explicit empty list overrides it.
    supported_reasoning_levels: model.discoveredMetadata?.efforts?.map(effort => ({ effort })),
    default_reasoning_level: model.discoveredMetadata?.defaultEffort,
    additional_speed_tiers: model.supportsFastMode === undefined && !model.supportsUltrafastMode ? undefined : [
      ...(model.supportsFastMode ? ['priority'] : []),
      ...(model.supportsUltrafastMode ? ['ultrafast'] : []),
    ],
  }));
  await mkdir(path.dirname(file), { recursive: true });
  const staging = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(staging, JSON.stringify({ accountKey, confirmedAt, entries }), { mode: 0o600, flag: 'wx' });
    if (!isCurrent()) return false;
    await replaceFile(staging, file);
    return true;
  } finally {
    await rm(staging, { force: true }).catch(() => {});
  }
}

export async function clearCodexModelSnapshot(slot: string): Promise<void> {
  await rm(snapshotPath(slot), { force: true });
}

export async function restoreCodexModelSnapshot(
  slot: string, accountKey: string,
): Promise<{ models: CatalogModel[]; confirmedAt: number } | undefined> {
  let raw: string;
  try { raw = await readFile(snapshotPath(slot), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const saved = JSON.parse(raw);
  if (saved?.accountKey !== accountKey || !Number.isSafeInteger(saved.confirmedAt) || saved.confirmedAt <= 0
    || !Array.isArray(saved.entries) || saved.entries.length > 1000) return;
  return { models: mapCodexModelsToCatalog({ models: saved.entries }), confirmedAt: saved.confirmedAt };
}

/**
 * The account a slot's saved list was confirmed for, for display while its account cannot be read
 * after a restart. A sign-out clears the file, so presence is last-known sign-in evidence only.
 */
export async function readSavedCodexModelAccount(slot: string): Promise<string | undefined> {
  let raw: string;
  try { raw = await readFile(snapshotPath(slot), 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const accountKey = JSON.parse(raw)?.accountKey;
  return typeof accountKey === 'string' && accountKey ? accountKey : undefined;
}
