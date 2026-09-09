import { describe, expect, it } from 'vitest';
import { isModelVisible } from '@cindy/model-providers';
import { selectDefaultModels } from '../model-default-selection.js';

const model = (id: string, extra = {}) => ({ id, mode: 'chat', ...extra });

describe('small provider model defaults', () => {
  it('accepts sparse metadata and the Responses chat mode without removing any model', () => {
    const models = [{ id: 'new-bare-model' }, { id: 'gpt-6-astra', mode: 'responses' },
      { id: 'google/gemini-3.8-flash' }, { id: 'google/gemini-3.7-flash' }];
    const before = structuredClone(models);
    expect([...selectDefaultModels(models, 'xd')]).toEqual([
      'new-bare-model', 'gpt-6-astra', 'google/gemini-3.8-flash',
    ]);
    expect(models).toEqual(before);
  });

  it('selects reviewed DS4 vision and HY4 routes only with live Gateway capabilities', () => {
    const text = { input: ['text'], output: ['text'] };
    const vision = { input: ['text', 'image'], output: ['text'] };
    const models = [
      model('deepseek/deepseek-v4-pro', { modalities: text }),
      model('deepseek/deepseek-v4-flash', { modalities: text }),
      model('deepseek/deepseek-v4-flash-vision-exp', { modalities: vision }),
      model('tencent/hy3', { modalities: text }),
      model('tencent/hy4-preview', { modalities: text }),
    ];
    expect([...selectDefaultModels(models, 'xd')]).toEqual([
      'deepseek/deepseek-v4-flash-vision-exp', 'tencent/hy4-preview',
    ]);
    // Identical IDs from direct/custom providers do not inherit Gateway recommendations.
    for (const provider of [undefined, 'deepseek', 'openrouter']) {
      expect([...selectDefaultModels(models, provider)]).toEqual(['deepseek/deepseek-v4-pro', 'tencent/hy3']);
    }
    const missingEvidence = models.map(({ id, mode }) => ({ id, mode }));
    expect([...selectDefaultModels(missingEvidence, 'xd')]).toEqual(['deepseek/deepseek-v4-pro', 'tencent/hy3']);
    const changed = models.map(model => ({ ...model, modalities: text }));
    expect([...selectDefaultModels(changed, 'xd')]).toEqual(['deepseek/deepseek-v4-pro', 'tencent/hy4-preview']);
    const unavailable = models.map(model => model.id.endsWith('exp') || model.id.endsWith('preview')
      ? { ...model, availability: 'requires_payment' } : model);
    expect([...selectDefaultModels(unavailable, 'xd')]).toEqual(['deepseek/deepseek-v4-pro', 'tencent/hy3']);
    const disabled = models.map(model => ({ ...model, defaultEnabled: false }));
    expect([...selectDefaultModels(disabled, 'xd')]).toEqual([]);
  });

  it('keeps only the latest Gemini, even when older generations have larger discounts', () => {
    const models = [
      model('google/gemini-3.5-flash', { costDiscount: 0.9 }),
      model('google/gemini-3.8-flash'),
      model('google/gemini-3.7-flash'),
    ];
    expect([...selectDefaultModels(models)]).toEqual(['google/gemini-3.8-flash']);
    expect([...selectDefaultModels([...models, model('google/gemini-4-flash')])]).toEqual([
      'google/gemini-4-flash',
    ]);
  });

  it('automatically enables a newly delivered GPT flagship and retains Sol, Terra and Luna independently', () => {
    const models = [
      model('openai/gpt-5.6-sol'),
      model('openai/gpt-5.6-terra'),
      model('openai/gpt-5.6-luna'),
      model('openai/gpt-6-astra'),
    ];
    expect([...selectDefaultModels(models)]).toEqual(['openai/gpt-6-astra', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']);
    const updated = [...models, model('openai/gpt-7-astra')];
    expect([...selectDefaultModels(updated)]).toEqual(['openai/gpt-7-astra', 'openai/gpt-5.6-sol', 'openai/gpt-5.6-terra', 'openai/gpt-5.6-luna']);
    expect(isModelVisible(true, false)).toBe(true); // Explicitly selected older models remain visible.
    expect(isModelVisible(false, true)).toBe(false); // Explicitly hidden new models stay hidden.
  });

  it('keeps Spark, long-context variants and unapproved Claude families opt-in', () => {
    expect([...selectDefaultModels([
      model('gpt-5.3-codex-spark'), model('gpt-5.4-mini'), model('gpt-5.4-nano'),
      model('gpt-5.6-sol[1m]'), model('claude-mythos-5'), model('gpt-6-astra'),
    ])]).toEqual(['gpt-6-astra']);
    expect([...selectDefaultModels([
      model('claude-fable-5-1', { availability: 'requires_payment' }),
      model('claude-fable-5'), model('claude-opus-5'), model('claude-opus-4-8'),
      model('claude-sonnet-5'), model('claude-haiku-4-5'),
    ])]).toEqual(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  it('prefers the larger discount among equivalent routes without merging or removing them', () => {
    const models = [
      model('openai/gpt-6-astra', { costDiscount: 0.4 }),
      model('codex/gpt-6-astra', { costDiscount: 0.85 }),
      model('x-ai/grok-4.6'),
      model('x-ai-grok/grok-4.6', { costDiscount: 0.9 }),
    ];
    const before = structuredClone(models);
    expect([...selectDefaultModels(models)]).toEqual(['codex/gpt-6-astra', 'x-ai-grok/grok-4.6']);
    expect(models).toEqual(before);
    expect([...selectDefaultModels([...models].reverse())].sort()).toEqual(
      [...selectDefaultModels(models)].sort(),
    );
  });

  it('keeps all four Claude families, treating dates and parameter sizes as variants', () => {
    const models = [
      model('anthropic/claude-opus-4-8'),
      model('anthropic/claude-opus-5'),
      model('anthropic-claude/claude-fable-5-1'),
      model('claude-sonnet-5'),
      model('claude-haiku-4-5-20251001'),
      model('qwen/qwen3.8-27b'),
      model('qwen/qwen3.8-max'),
    ];
    expect([...selectDefaultModels(models)]).toEqual([
      'anthropic-claude/claude-fable-5-1',
      'anthropic/claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-4-5-20251001',
      'qwen/qwen3.8-max',
    ]);
  });

  it('keeps experiments, paid locks, upstream-disabled models and media out of everyday defaults', () => {
    const models = [
      model('google/gemini-4-preview'),
      model('google/gemini-5', { availability: 'requires_payment' }),
      model('google/gemini-6', { defaultEnabled: false }),
      model('google/gemini-3.8-flash'),
      model('deepseek/deepseek-v4-flash-vision-exp'),
      model('openai/gpt-5.6-sol[1m]'),
      model('openai/gpt-image-2', { mode: 'image' }),
      model('meta/muse-spark-1.3'),
    ];
    expect([...selectDefaultModels(models)]).toEqual([
      'google/gemini-3.8-flash',
      'meta/muse-spark-1.3',
    ]);
  });

  it('honors a server-selected everyday model and works with subscription wire aliases', () => {
    expect([
      ...selectDefaultModels([
        model('z-ai/glm-5.3'),
        model('z-ai/glm-5.3-flash', { newSessionDefault: ['pi'] }),
      ]),
    ]).toEqual(['z-ai/glm-5.3-flash']);
    expect([
      ...selectDefaultModels([
        model('chatgpt/gpt-6-astra'),
        model('chatgpt/gpt-5.6-sol'),
        model('chatgpt/gpt-5.6-luna'),
      ]),
    ]).toEqual(['chatgpt/gpt-6-astra', 'chatgpt/gpt-5.6-sol', 'chatgpt/gpt-5.6-luna']);
  });
});
