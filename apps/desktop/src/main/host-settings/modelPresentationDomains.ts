import { createHmac, randomBytes } from 'node:crypto';
import type { AgentKind } from '@cindy/model-providers';
import type { RemoteModelFavorite } from '@cindy/device-link';
import { manageAppPreferences } from '../app-settings/preferences.js';
import { requestModelFavorites } from '../maker-ipc/modelFavoritesSync.js';
import { getModelVisibilityMirrorSnapshot, waitForModelVisibilityMirror } from '../maker-host/model-visibility-mirror.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import type { HostSettingState } from '../../shared/hostSettings.js';
import { additionalSettingsSchema, type SettingsEditableValue } from '../../shared/settingsEditableCatalog.js';
import { HostSettingsError } from './operations.js';

/**
 * Model visibility, engines and favorites stay in the app window's
 * stores. Visibility is read from Main's mirror and changed through the preferences
 * section's model-visibility operation; engines through its model-engine operation; favorites
 * through the same favorites requests other devices use. There is no second copy on the Host.
 */
const DOMAINS = ['modelVisibility', 'modelEngines', 'modelFavorites'] as const;
export type ModelPresentationDomain = typeof DOMAINS[number];
export const isModelPresentationDomain = (domain: string): domain is ModelPresentationDomain =>
  (DOMAINS as readonly string[]).includes(domain);

type Values = Record<string, SettingsEditableValue>;
type State = HostSettingState<Values>;
type Harness = 'claude-code' | 'codex' | 'pi';
type Engine = 'cc' | 'codex' | 'pi';
type Entry = { harness: Harness; providerId: string; modelId: string; enabled?: boolean; effort?: string | null; fast?: boolean };
const revisionKey = randomBytes(32);
const harnessOf = (agent: Engine): Harness => agent === 'cc' ? 'claude-code' : agent;
const engineOf = (harness: Harness): Engine => harness === 'claude-code' ? 'cc' : harness;
const visibilityKey = (harness: string, providerId: string, modelId: string) => `${harness}:${providerId}:${modelId}`;
const engineKey = (providerId: string, modelId: string) => `${providerId}:${modelId}`;

function parseTarget(key: string, withHarness: boolean) {
  const parts = key.split(':');
  const harness = withHarness ? parts.shift() : undefined;
  const providerId = parts.shift(), modelId = parts.join(':');
  if (!providerId || !modelId || withHarness && !['claude-code', 'codex', 'pi'].includes(harness!)) return null;
  return { ...(withHarness ? { harness: harness as Harness } : {}), providerId, modelId };
}
const favoriteEntry = (item: RemoteModelFavorite) => ({ harness: harnessOf(item.agent), providerId: item.providerId,
  modelId: item.modelId, effort: item.effort ?? null, fast: item.fast === true || item.fast === 'ultrafast' });

async function readValues(domain: ModelPresentationDomain): Promise<{ value: Values; favorites?: RemoteModelFavorite[] }> {
  if (domain === 'modelVisibility') {
    await waitForModelVisibilityMirror();
    const entries = Object.entries(getModelVisibilityMirrorSnapshot()).flatMap(([key, enabled]) => {
      const target = parseTarget(key, true);
      return target ? [{ ...target, enabled }] : [];
    });
    return { value: { entries } as Values };
  }
  if (domain === 'modelEngines') {
    const engines = (await manageAppPreferences('model-engine')).modelEngines ?? {};
    const entries = Object.entries(engines).flatMap(([key, agent]) => {
      const target = parseTarget(key, false);
      return target ? [{ ...target, harness: harnessOf(agent) }] : [];
    });
    return { value: { entries } as Values };
  }
  const favorites = await requestModelFavorites();
  return { value: { entries: favorites.map(favoriteEntry) } as Values, favorites };
}

/** Reads through the app window and Main mirror. A window that does not answer leaves the group unreadable. */
export async function readModelPresentationDomain(domain: ModelPresentationDomain): Promise<State> {
  let value: Values;
  try { value = (await readValues(domain)).value; }
  catch { return { status: 'unreadable', revision: null }; }
  additionalSettingsSchema(domain).parse(value);
  const customized = (value.entries as unknown[]).length > 0;
  return { status: 'ready', revision: createHmac('sha256', revisionKey).update(JSON.stringify([domain, value])).digest('base64url'),
    value, defaults: { entries: [] }, customizedKeys: customized ? ['entries'] : [], isCustomized: customized };
}

/** CAS token over the window's explicit visibility choices, as Main's mirror holds them. */
export async function modelVisibilityRevision(): Promise<string | null> {
  try { await waitForModelVisibilityMirror(); } catch { return null; }
  const entries = Object.entries(getModelVisibilityMirrorSnapshot()).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHmac('sha256', revisionKey).update(JSON.stringify(['visibility', entries])).digest('base64url');
}

function defaultEnabled(harness: Harness, providerId: string, modelId: string): boolean | undefined {
  return getActiveCatalog().providers.find(provider => provider.id === providerId)?.models[harness as AgentKind]
    ?.find(model => model.id === modelId)?.defaultEnabled;
}

/** One model's visibility through the app; `null` follows the catalog default again. */
export async function setModelVisibility(target: { harness: Harness; providerId: string; modelId: string }, visible: boolean | null): Promise<void> {
  const receipt = await manageAppPreferences('model-visibility', undefined, { target: { providerId: target.providerId, agent: target.harness,
    modelId: target.modelId }, visible, defaultEnabled: defaultEnabled(target.harness, target.providerId, target.modelId) });
  if (!receipt.modelVisibility || (visible !== null && receipt.modelVisibility.visible !== visible)) throw new HostSettingsError('SAVE_FAILED');
}

const sameFavorite = (item: RemoteModelFavorite, entry: Entry) => item.providerId === entry.providerId && item.modelId === entry.modelId
  && item.agent === engineOf(entry.harness) && (item.effort ?? null) === (entry.effort ?? null) && (item.fast !== undefined) === (entry.fast === true);

/**
 * The whole list for a domain, applied one change at a time, then read back. Each change moves what
 * `assertCurrent` may watch (the visibility mirror, engines, favourites), so it is checked once,
 * before the first change; between changes only `assertOwner` is.
 */
export async function commitModelPresentationDomain(domain: ModelPresentationDomain, change: { set: Values; clear: string[] },
  assertCurrent: () => void, assertOwner: () => void = assertCurrent): Promise<State & { status: 'ready' }> {
  const desired = (change.clear.includes('entries') ? [] : change.set.entries ?? []) as Entry[];
  const current = await readValues(domain);
  assertCurrent();
  if (domain === 'modelVisibility') {
    const wanted = new Map(desired.map(entry => [visibilityKey(entry.harness, entry.providerId, entry.modelId), entry]));
    for (const entry of current.value.entries as Entry[]) {
      if (!wanted.has(visibilityKey(entry.harness, entry.providerId, entry.modelId))) { await setModelVisibility(entry, null); assertOwner(); }
    }
    const before = new Map((current.value.entries as Entry[]).map(entry => [visibilityKey(entry.harness, entry.providerId, entry.modelId), entry.enabled]));
    for (const [key, entry] of wanted) {
      if (before.get(key) !== entry.enabled) { await setModelVisibility(entry, entry.enabled === true); assertOwner(); }
    }
  } else if (domain === 'modelEngines') {
    const wanted = new Map(desired.map(entry => [engineKey(entry.providerId, entry.modelId), entry]));
    const before = new Map((current.value.entries as Entry[]).map(entry => [engineKey(entry.providerId, entry.modelId), entry]));
    const save = async (providerId: string, modelId: string, agent: Engine | null) => {
      const engines = (await manageAppPreferences('model-engine', undefined, undefined, { modelEngine: { providerId, modelId, agent } })).modelEngines ?? {};
      if ((engines[engineKey(providerId, modelId)] ?? null) !== agent) throw new HostSettingsError('SAVE_FAILED');
      assertOwner();
    };
    for (const [key, entry] of before) if (!wanted.has(key)) await save(entry.providerId, entry.modelId, null);
    for (const [key, entry] of wanted) if (before.get(key)?.harness !== entry.harness) await save(entry.providerId, entry.modelId, engineOf(entry.harness));
  } else {
    let favorites = current.favorites!;
    for (const item of favorites) {
      if (!desired.some(entry => sameFavorite(item, entry))) { favorites = await requestModelFavorites({ kind: 'remove', expected: item }); assertOwner(); }
    }
    for (const entry of desired) {
      if (favorites.some(item => sameFavorite(item, entry))) continue;
      favorites = await requestModelFavorites({ kind: 'add', item: { providerId: entry.providerId, modelId: entry.modelId, agent: engineOf(entry.harness),
        ...(entry.effort ? { effort: entry.effort } : {}), ...(entry.fast ? { fast: true as const } : {}) } });
      assertOwner();
    }
  }
  const after = await readModelPresentationDomain(domain);
  if (after.status !== 'ready') throw new HostSettingsError('UNREADABLE');
  return after;
}
