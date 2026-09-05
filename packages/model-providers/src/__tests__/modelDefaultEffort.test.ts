import { describe, expect, it } from 'vitest';
import registry from '../../catalog/model-registry.json';
import { modelDefaultEffort, defaultEffortForCapabilities } from '../effortResolution.js';

describe('model-level default effort', () => {
  it('ignores conflicting harness defaults when the model declares its own', () => {
    expect(modelDefaultEffort({ defaultEffort: 'medium', perAgent: {
      codex: { defaultEffort: 'high' }, pi: { defaultEffort: 'xhigh' },
    } })).toBe('medium');
    expect(modelDefaultEffort({ defaultEffort: null, perAgent: {
      codex: { defaultEffort: 'high' },
    } })).toBeNull();
  });
  it('promotes a consistent legacy value once for every harness', () => {
    expect(modelDefaultEffort({ perAgent: { codex: { defaultEffort: 'medium' } } }))
      .toBe('medium');
    expect(modelDefaultEffort({ perAgent: {
      codex: { defaultEffort: 'high' }, 'claude-code': { defaultEffort: 'high' },
    } })).toBe('high');
  });
  it('resolves legacy conflicts conservatively without depending on the harness order', () => {
    expect(modelDefaultEffort({})).toBeUndefined();
    expect(modelDefaultEffort({ perAgent: {
      codex: { defaultEffort: 'high' }, 'claude-code': { defaultEffort: 'medium' },
    } })).toBe('medium');
    expect(modelDefaultEffort({ perAgent: {
      'claude-code': { defaultEffort: 'medium' }, codex: { defaultEffort: 'high' },
    } })).toBe('medium');
  });
});


describe('medium-first defaults', () => {
  it('uses actual capabilities independent of discovery order', () => {
    expect(defaultEffortForCapabilities(['max', 'low', 'medium'])).toBe('medium');
    expect(defaultEffortForCapabilities(['minimal', 'high', 'max'])).toBe('high');
    expect(defaultEffortForCapabilities(['low'])).toBe('low');
    expect(defaultEffortForCapabilities([])).toBeNull();
  });
  it('keeps the maintained table consistent across harnesses without fabricating medium', () => {
    for (const model of registry.models) {
      if (!model.efforts?.length) continue;
      expect(model.defaultEffort, model.id).toBe(defaultEffortForCapabilities(model.efforts));
      for (const override of Object.values(model.perAgent ?? {})) {
        expect(override, model.id).not.toHaveProperty('defaultEffort');
      }
    }
  });
});
