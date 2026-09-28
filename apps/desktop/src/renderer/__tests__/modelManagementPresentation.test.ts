import { describe, expect, it } from 'vitest';
import {
  compareModelNames,
  groupModelsForManagement,
  modelBrand,
  sortModelsForManagement,
} from '../components/settings/modelManagementPresentation';

describe('model management presentation', () => {
  it('keeps new models and variants with their manufacturer without registry groups', () => {
    const models = [
      { id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'qwen/qwen3.7-max', name: 'Qwen3.7 Max' },
      { id: 'deepseek/deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision Exp' },
      { id: 'qwen/qwen3.10-flash', name: 'Qwen 3.10 Flash' },
      { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash' },
    ];
    const original = models.map((m) => m.id);
    const groups = groupModelsForManagement(models, 'brand', () => 'chat');
    expect(groups.map((g) => g.brand?.label)).toEqual(['DeepSeek', 'Qwen']);
    expect(groups[0]?.models).toHaveLength(2);
    expect(groups[1]?.models.map((m) => m.id)).toEqual([
      'qwen/qwen3.10-flash',
      'qwen/qwen3.8-flash',
      'qwen/qwen3.7-max',
    ]);
    expect(models.map((m) => m.id)).toEqual(original);
  });

  it('sorts unweighted newer model numbers before old curated positions', () => {
    const models = [
      { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', sortOrder: 1 },
      { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ];
    expect([...models].sort(compareModelNames)[0]?.id).toBe('google/gemini-3.8-flash');
  });

  it('keeps separate routing identities even when their display names match', () => {
    const models = [
      { id: 'x-ai/grok-4.6', name: 'Grok 4.6' },
      { id: 'x-ai-grok/grok-4.6', name: 'Grok 4.6' },
      { id: 'x-ai/grok-4.5', name: 'Grok 4.5' },
    ];
    const groups = groupModelsForManagement(models, 'brand', () => 'chat');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.models).toHaveLength(3);
    expect(new Set(groups[0]?.models.map((model) => model.id))).toEqual(
      new Set(models.map((model) => model.id)),
    );
  });

  it('keeps media purposes separate from manufacturers and model-name browsing', () => {
    const models = [
      { id: 'openai/gpt-image-2', name: 'GPT Image 2' },
      { id: 'openai/gpt-6', name: 'GPT 6' },
    ];
    const kindOf = (m: (typeof models)[number]) =>
      m.id.includes('image') ? ('image' as const) : ('chat' as const);
    expect(
      groupModelsForManagement(models, 'brand', kindOf).map((g) => [g.key, g.brand?.label]),
    ).toEqual([
      ['chat:openai', 'OpenAI'],
      ['image', undefined],
    ]);
    expect(groupModelsForManagement(models, 'model', kindOf).map((g) => g.key)).toEqual([
      'chat',
      'image',
    ]);
  });

  it('places future models without dropping data or changing existing route identities', () => {
    const old = { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash' };
    const incoming = [
      old,
      {
        id: 'new-labs/alpha-2',
        name: 'Alpha 2',
        icon: 'future-icon',
        modalities: { input: ['text', 'image'], output: ['text'] },
        extensionData: { preview: true },
      },
      { id: 'qwen/qwen4-flash-new-variant', name: 'Qwen4 Flash New Variant' },
      { id: 'bare-new-model', name: 'Unidentified Model' },
    ];
    const snapshot = structuredClone(incoming);
    const groups = groupModelsForManagement(incoming, 'brand', () => 'chat');
    expect(
      groups
        .flatMap((g) => g.models)
        .map((m) => m.id)
        .sort(),
    ).toEqual(incoming.map((m) => m.id).sort());
    expect(groups.find((g) => g.brand?.key === 'qwen')?.models.map((m) => m.id)).toEqual([
      'qwen/qwen4-flash-new-variant',
      old.id,
    ]);
    expect(groups.find((g) => g.brand?.key === 'namespace:new-labs')?.models[0]).toBe(incoming[1]);
    expect(groups.find((g) => g.key === 'chat')?.models[0]?.id).toBe('bare-new-model');
    expect(incoming).toEqual(snapshot);
  });

  it('uses neutral namespace labels for unfamiliar vendors and never invents capabilities', () => {
    expect(modelBrand({ id: 'new-labs/model-9' })).toEqual({
      key: 'namespace:new-labs',
      label: 'new-labs',
    });
    expect(modelBrand({ id: 'constructor/model-9' })).toEqual({
      key: 'namespace:constructor',
      label: 'constructor',
    });
    expect(modelBrand({ id: 'unidentified' })).toBeUndefined();
    expect(modelBrand({ id: 'tencent/hy4-preview' })?.label).toBe('Tencent');
  });
});

describe('sortModelsForManagement', () => {
  it('来源给出完整顺序时与选择器一致(按 sortOrder)', () => {
    const models = [
      { id: 'gpt-5.6', name: 'GPT-5.6', sortOrder: 2 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra', sortOrder: 0 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol', sortOrder: 1 },
    ];
    expect(sortModelsForManagement(models).map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-6-sol',
      'gpt-5.6',
    ]);
  });

  it('只有部分条目带 sortOrder 时退回按名称/版本排序', () => {
    const models = [
      { id: 'google/gemini-3.5-flash', name: 'Gemini 3.5 Flash', sortOrder: 1 },
      { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
    ];
    expect(sortModelsForManagement(models)[0]?.id).toBe('google/gemini-3.8-flash');
  });
});
