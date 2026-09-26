import { describe, expect, it } from 'vitest';
import { llamaCppModelPreset } from '../llamaCpp.js';

describe('managed local context presets', () => {
  const model = { id: 'flash', repo: 'bartowski/Qwen3.8-Flash-Next-GGUF', file: 'a.gguf', size: 1 };
  it('keeps the native default until an explicit extension is selected', () => {
    expect(llamaCppModelPreset(model, {})).toEqual(['[flash]', 'ctx-size = 262144']);
    expect(llamaCppModelPreset(model, { 'pi:cindy-local-llamacpp:other': 1_000_000 })).toHaveLength(
      2,
    );
    expect(llamaCppModelPreset(model, { 'pi:another-provider:flash': 1_000_000 })).toHaveLength(2);
    expect(llamaCppModelPreset(model, { 'pi:cindy-local-llamacpp:flash': 65536 })).toHaveLength(2);
  });
  it('honors the largest harness budget and configures the verified expansion together', () => {
    expect(
      llamaCppModelPreset(model, {
        'pi:cindy-local-llamacpp:flash': 262144,
        'codex:cindy-local-llamacpp:flash': 1_000_000,
      }),
    ).toEqual([
      '[flash]',
      'ctx-size = 1000000',
      'rope-scaling = yarn',
      'rope-scale = 4',
      'yarn-orig-ctx = 262144',
    ]);
    expect(() =>
      llamaCppModelPreset(model, { 'pi:cindy-local-llamacpp:flash': 1_048_576 }),
    ).toThrow('INVALID_MODEL_CONTEXT');
  });
  it('does not borrow Flash-Next scaling for an unrelated GGUF', () => {
    expect(
      llamaCppModelPreset(
        { ...model, repo: 'another/model' },
        { 'pi:cindy-local-llamacpp:flash': 65536 },
      ),
    ).toEqual(['[flash]', 'ctx-size = 65536']);
  });
});
