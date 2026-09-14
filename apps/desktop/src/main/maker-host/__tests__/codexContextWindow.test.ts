import { describe, expect, it } from 'vitest';
import { resolveCodexContextWindowInfo } from '../codex-context-window';
const sol = { context_window: 272_000, max_context_window: 872_000, effective_context_window_percent: 95 };
describe('native Codex context facts', () => {
  it('keeps total, usable capacity and compaction distinct', () => {
    expect(resolveCodexContextWindowInfo(sol, {}, 258_400)).toEqual({
      contextWindow: 272_000, usableContextWindow: 258_400, autoCompactTokenLimit: 244_800,
      modelMaxContextWindow: 872_000, source: 'runtime', fallbackModel: false,
    });
  });
  it('clips CLI overrides to the native maximum and supports earlier compaction', () => {
    expect(resolveCodexContextWindowInfo(sol, { model_context_window: 1_000_000, model_auto_compact_token_limit: 400_000 }))
      .toMatchObject({ contextWindow: 872_000, usableContextWindow: 828_400, autoCompactTokenLimit: 400_000 });
  });
  it('preserves the running thread when defaults change', () => {
    expect(resolveCodexContextWindowInfo(sol, { model_context_window: 500_000 }, 258_400))
      .toMatchObject({ contextWindow: 272_000, usableContextWindow: 258_400 });
  });
  it('uses the model headroom instead of always dividing by 95%', () => {
    expect(resolveCodexContextWindowInfo({ ...sol, context_window: 128_000, effective_context_window_percent: 100 }, {}, 128_000))
      .toMatchObject({ contextWindow: 128_000, usableContextWindow: 128_000 });
  });
  it('does not treat GLM configured 500K as native support', () => {
    expect(resolveCodexContextWindowInfo(undefined, { model_context_window: 500_000 }))
      .toMatchObject({ contextWindow: 272_000, fallbackModel: true });
  });
  it('honors an installed native catalog for a third-party model', () => {
    expect(resolveCodexContextWindowInfo({ context_window: 500_000, max_context_window: 500_000 }, {}))
      .toMatchObject({ contextWindow: 500_000, usableContextWindow: 475_000, fallbackModel: false });
  });
  it('does not invent capacity from invalid native metadata', () => {
    expect(resolveCodexContextWindowInfo({ context_window: 0 }, {})).toBeNull();
    expect(resolveCodexContextWindowInfo({ ...sol, effective_context_window_percent: 0 }, {}, 258_400)).toBeNull();
  });
});
