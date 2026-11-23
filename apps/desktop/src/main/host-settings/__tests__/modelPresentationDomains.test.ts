import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteModelFavorite } from '@cindy/device-link';

// The app window's stores, reached only through the app's preferences and favorites operations.
const window = vi.hoisted(() => ({
  visibility: {} as Record<string, boolean>,
  engines: {} as Record<string, 'cc' | 'codex' | 'pi'>,
  favorites: [] as RemoteModelFavorite[],
  uid: 0,
  answers: true,
  visibilityCalls: [] as unknown[],
}));
vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' } }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }) }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({
  waitForModelVisibilityMirror: async () => { if (!window.answers) throw new Error('not ready'); },
  getModelVisibilityMirrorSnapshot: () => ({ ...window.visibility }),
}));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [{ id: 'xd', models: { codex: [{ id: 'hidden', defaultEnabled: false }, { id: 'shown' }] } }] }),
}));
vi.mock('../../app-settings/preferences.js', () => ({
  manageAppPreferences: async (operation: string, _patch: unknown, visibility?: { target: { providerId: string; agent: string; modelId: string }; visible: boolean | null; defaultEnabled?: boolean },
    { modelEngine: engine }: { modelEngine?: { providerId: string; modelId: string; agent: 'cc' | 'codex' | 'pi' | null } } = {}) => {
    if (!window.answers) throw new Error('PREFERENCE_WINDOW_NOT_READY');
    if (operation === 'model-visibility') {
      window.visibilityCalls.push(visibility);
      const key = `${visibility!.target.agent}:${visibility!.target.providerId}:${visibility!.target.modelId}`;
      if (visibility!.visible === null) delete window.visibility[key]; else window.visibility[key] = visibility!.visible;
      return { value: {}, modelVisibility: { visible: window.visibility[key] ?? visibility!.defaultEnabled !== false, customized: key in window.visibility } };
    }
    if (engine) {
      const key = `${engine.providerId}:${engine.modelId}`;
      if (engine.agent === null) delete window.engines[key]; else window.engines[key] = engine.agent;
    }
    return { value: {}, modelEngines: { ...window.engines } };
  },
}));
vi.mock('../../maker-ipc/modelFavoritesSync.js', () => ({
  requestModelFavorites: async (mutation?: { kind: string; item?: Omit<RemoteModelFavorite, 'uid'>; expected?: RemoteModelFavorite }) => {
    if (!window.answers) throw new Error('Favorites host not ready');
    if (mutation?.kind === 'add') window.favorites.push({ ...mutation.item!, uid: `fav-${++window.uid}` });
    if (mutation?.kind === 'remove') window.favorites = window.favorites.filter(item => item.uid !== mutation.expected!.uid);
    return window.favorites.map(item => ({ ...item }));
  },
}));
import { commitModelPresentationDomain, modelVisibilityRevision, readModelPresentationDomain } from '../modelPresentationDomains.js';

const current = () => {};
beforeEach(() => {
  window.visibility = { 'codex:xd:hidden': true };
  window.engines = { 'xd:shown': 'pi' };
  window.favorites = [{ uid: 'fav-0', providerId: 'xd', modelId: 'shown', agent: 'codex', effort: 'low', fast: 'ultrafast' }];
  window.uid = 0; window.answers = true; window.visibilityCalls = [];
});

describe('model visibility, engines and favorites through the app', () => {
  it('reads each axis from the window under the cloud field names', async () => {
    expect(await readModelPresentationDomain('modelVisibility')).toMatchObject({ status: 'ready',
      value: { entries: [{ harness: 'codex', providerId: 'xd', modelId: 'hidden', enabled: true }] }, customizedKeys: ['entries'] });
    expect(await readModelPresentationDomain('modelEngines')).toMatchObject({ value: { entries: [{ harness: 'pi', providerId: 'xd', modelId: 'shown' }] } });
    expect(await readModelPresentationDomain('modelFavorites')).toMatchObject({ value: { entries: [{ harness: 'codex', effort: 'low', fast: true }] } });
  });

  it('makes visibility match the list, resetting what the list drops', async () => {
    await commitModelPresentationDomain('modelVisibility', { set: { entries: [{ harness: 'codex', providerId: 'xd', modelId: 'shown', enabled: false }] }, clear: [] }, current);
    expect(window.visibility).toEqual({ 'codex:xd:shown': false });
    expect(window.visibilityCalls).toContainEqual({ target: { providerId: 'xd', agent: 'codex', modelId: 'hidden' }, visible: null, defaultEnabled: false });
    await commitModelPresentationDomain('modelVisibility', { set: {}, clear: ['entries'] }, current);
    expect(window.visibility).toEqual({});
  });

  it('sets and clears engines one model at a time', async () => {
    await commitModelPresentationDomain('modelEngines', { set: { entries: [{ harness: 'claude-code', providerId: 'xd', modelId: 'hidden' }] }, clear: [] }, current);
    expect(window.engines).toEqual({ 'xd:hidden': 'cc' });
  });

  it('keeps a favorite and its exact speed tier when the list round-trips it', async () => {
    const kept = { harness: 'codex', providerId: 'xd', modelId: 'shown', effort: 'low', fast: true };
    await commitModelPresentationDomain('modelFavorites', { set: { entries: [kept, { harness: 'pi', providerId: 'xd', modelId: 'hidden', effort: null, fast: false }] }, clear: [] }, current);
    expect(window.favorites).toEqual([
      { uid: 'fav-0', providerId: 'xd', modelId: 'shown', agent: 'codex', effort: 'low', fast: 'ultrafast' },
      { uid: 'fav-1', providerId: 'xd', modelId: 'hidden', agent: 'pi' },
    ]);
    await commitModelPresentationDomain('modelFavorites', { set: { entries: [{ ...kept, fast: false }] }, clear: [] }, current);
    expect(window.favorites).toEqual([{ uid: 'fav-2', providerId: 'xd', modelId: 'shown', agent: 'codex', effort: 'low' }]);
  });

  it('leaves the groups unreadable and the revision unknown while the window does not answer', async () => {
    window.answers = false;
    expect(await readModelPresentationDomain('modelFavorites')).toEqual({ status: 'unreadable', revision: null });
    expect(await modelVisibilityRevision()).toBeNull();
  });

  it('changes the visibility revision only when the window choices change', async () => {
    const first = await modelVisibilityRevision();
    expect(await modelVisibilityRevision()).toBe(first);
    window.visibility['codex:xd:shown'] = false;
    expect(await modelVisibilityRevision()).not.toBe(first);
  });
});
