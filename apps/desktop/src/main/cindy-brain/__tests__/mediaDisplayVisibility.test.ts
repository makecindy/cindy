import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ providers: [] as any[], overrides: new Map<string, boolean>(), ready: true }));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: state.providers }) }));
vi.mock('../../maker-host/model-visibility-mirror.js', () => ({ getModelVisibilityOverride: (agent: string) => {
  if (!state.ready) throw new Error('not ready');
  return state.overrides.get(agent);
} }));
import { isCatalogMediaModelVisible } from '../mediaDisplayVisibility.js';

// Unit: a hidden chat copy previously hid a different runtime's media route.
describe('media connection visibility', () => {
  beforeEach(() => { state.overrides.clear(); state.ready = true; state.providers = [{ id: 'relay', agents: ['codex', 'pi'], imageModels: [{ id: 'image', sourceAgent: 'pi' }] }]; });
  it('uses the media connection instead of the first chat runtime', () => {
    state.overrides.set('codex', false);
    expect(isCatalogMediaModelVisible('relay', 'image')).toBe(true);
    state.overrides.set('pi', false);
    expect(isCatalogMediaModelVisible('relay', 'image')).toBe(false);
  });
  it('checks an explicitly selected connection independently', () => {
    state.overrides.set('pi', false);
    expect(isCatalogMediaModelVisible('relay', 'image', undefined, 'codex')).toBe(true);
    expect(isCatalogMediaModelVisible('relay', 'image', undefined, 'pi')).toBe(false);
  });
  it('keeps defaults and an unavailable owner mirror closed', () => {
    expect(isCatalogMediaModelVisible('relay', 'image', false)).toBe(false);
    state.ready = false;
    expect(isCatalogMediaModelVisible('relay', 'image')).toBe(false);
  });
  it('keeps another declared media route visible when the preferred runtime is hidden', () => {
    state.providers[0].imageModels[0].sourceAgents = ['pi', 'codex'];
    state.providers[0].models = { pi: [{ id: 'image', defaultEnabled: false }], codex: [{ id: 'image', defaultEnabled: true }] };
    state.overrides.set('pi', false);
    expect(isCatalogMediaModelVisible('relay', 'image')).toBe(true);
    expect(isCatalogMediaModelVisible('relay', 'image', undefined, 'pi')).toBe(false);
  });
});
