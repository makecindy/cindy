import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  selection: null as null | {
    pin: string;
    providerId: string;
    agentKind: 'codex' | 'claude-code';
    model: string;
  },
  requestText: vi.fn(),
  generateLegacy: vi.fn(),
  generateLegacyResult: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../../utility-model/auxiliary-model-settings-store.js', () => ({
  readAuxiliaryModelSelection: () => h.selection,
}));

vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestExplicitUtilityText: (...args: unknown[]) => h.requestText(...args),
}));

vi.mock('../title-one-shot.js', () => ({
  generateTitleViaProvider: (...args: unknown[]) => h.generateLegacy(...args),
  generateTitleViaProviderResult: (...args: unknown[]) => h.generateLegacyResult(...args),
}));

import {
  generateTitleWithAuxiliaryModel,
  generateTitleWithAuxiliaryModelResult,
} from '../auxiliary-title-one-shot.js';

const REQUEST = {
  sessionId: 'task-1',
  agentKind: 'pi' as const,
  prompt: '给这项工作起名',
};

const SELECTION = {
  pin: 'cat:openrouter:codex:openai/gpt-5-mini',
  providerId: 'openrouter',
  agentKind: 'codex' as const,
  model: 'openai/gpt-5-mini',
};

beforeEach(() => {
  vi.clearAllMocks();
  h.selection = null;
  h.generateLegacy.mockResolvedValue('旧自动路由标题');
  h.generateLegacyResult.mockResolvedValue({ status: 'ok', title: '旧自动路由标题' });
});

describe('auxiliary task-title routing', () => {
  it('preserves the historical route in automatic mode for every task agent', async () => {
    await expect(generateTitleWithAuxiliaryModel(REQUEST)).resolves.toBe('旧自动路由标题');

    expect(h.generateLegacy).toHaveBeenCalledWith(REQUEST, {});
    expect(h.requestText).not.toHaveBeenCalled();
  });

  it('uses one exact configured catalog route independently of the task agent', async () => {
    h.selection = { ...SELECTION };
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      const allowed = await (
        options.beforeDispatch as (route: typeof SELECTION) => Promise<boolean>
      )(SELECTION);
      return allowed
        ? {
            ok: true,
            text: '通用任务命名',
            providerId: SELECTION.providerId,
            model: SELECTION.model,
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST)).resolves.toBe('通用任务命名');
    expect(h.requestText).toHaveBeenCalledWith(
      REQUEST.prompt,
      expect.objectContaining({
        providerId: 'openrouter',
        agentKind: 'codex',
        model: 'openai/gpt-5-mini',
        disableReasoning: true,
        reasoningEffort: 'minimal',
        responseInstructions: expect.stringContaining('Output only the short conversation title'),
      }),
    );
    expect(h.generateLegacy).not.toHaveBeenCalled();
  });

  it('fails closed instead of falling back when the configured model fails', async () => {
    h.selection = { ...SELECTION };
    h.requestText.mockResolvedValue({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [],
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST)).resolves.toBeNull();
    await expect(generateTitleWithAuxiliaryModelResult(REQUEST)).resolves.toEqual({
      status: 'failed',
    });
    expect(h.generateLegacy).not.toHaveBeenCalled();
    expect(h.generateLegacyResult).not.toHaveBeenCalled();
  });

  it('cancels dispatch when the selected setting changes during credential work', async () => {
    h.selection = { ...SELECTION };
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      h.selection = null;
      const allowed = await (
        options.beforeDispatch as (route: typeof SELECTION) => Promise<boolean>
      )(SELECTION);
      return allowed
        ? {
            ok: true,
            text: '不应采用',
            providerId: SELECTION.providerId,
            model: SELECTION.model,
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST)).resolves.toBeNull();
    expect(h.generateLegacy).not.toHaveBeenCalled();
  });
});
