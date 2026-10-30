import { describe, expect, it } from 'vitest';
import { isModelVisible } from '@cindy/model-providers';
import { selectDefaultModels } from '../model-default-selection.js';

describe('discovered model defaults', () => {
  it.each([undefined, 'xd', 'openai', 'openrouter'])('keeps new families and variants visible for %s', provider => {
    const models = ['gpt-6-astra', 'gpt-7-astra', 'gpt-7-new-variant', 'claude-mythos-5',
      'google/gemini-4-preview', 'deepseek/deepseek-v4-flash-vision-exp', 'private-new-model',
      'gpt-6-sol[1m]'].map(id => ({ id, defaultEnabled: true }));
    const before = structuredClone(models);
    expect([...selectDefaultModels(models, provider)]).toEqual(models.map(model => model.id));
    expect(models).toEqual(before);
  });

  it('retains explicit off, paid locks and media boundaries', () => {
    const models = [
      { id: 'off', defaultEnabled: false },
      { id: 'locked', availability: 'requires_payment' },
      { id: 'image', mode: 'image_generation' },
      { id: 'new', mode: 'responses' },
      { id: 'sparse' },
    ];
    expect([...selectDefaultModels(models)]).toEqual(['new', 'sparse']);
    expect(isModelVisible(false, true)).toBe(false);
    expect(isModelVisible(true, false)).toBe(true);
  });

  it('does not turn a preferred default, discount or alias into a visibility filter', () => {
    const models = [
      { id: 'z-ai/glm-5.3' },
      { id: 'z-ai/glm-5.3-flash', newSessionDefault: ['pi'] },
      { id: 'openai/gpt-6-astra', costDiscount: 0.4 },
      { id: 'codex/gpt-6-astra', costDiscount: 0.85 },
    ];
    expect([...selectDefaultModels(models)]).toEqual(models.map(model => model.id));
  });
});
