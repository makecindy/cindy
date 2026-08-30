import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  models: [] as string[],
  ownerScope: 'local:owner-a:1',
  requestText: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
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

function runtimeDeps() {
  return {
    readModels: () => h.models,
    readOwnerScope: () => h.ownerScope,
    requestText: h.requestText,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.models = [];
  h.ownerScope = 'local:owner-a:1';
  h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
    const allowed = await (options.beforeDispatch as () => Promise<boolean>)();
    return allowed
      ? {
          ok: true,
          text: '通用任务命名',
          providerId: 'xd',
          model: 'gpt-5.4-mini',
          transport: 'litellm-chat-completions',
        }
      : { ok: false, reason: 'all_candidates_failed', attempts: [] };
  });
});

describe('auxiliary task-title routing', () => {
  it('uses the shared utility chain in automatic mode', async () => {
    await expect(generateTitleWithAuxiliaryModel(REQUEST, {}, runtimeDeps())).resolves.toBe(
      '通用任务命名',
    );

    expect(h.requestText).toHaveBeenCalledWith(
      REQUEST.prompt,
      expect.objectContaining({
        disableReasoning: true,
        reasoningEffort: 'minimal',
        responseInstructions: expect.stringContaining('Output only the short conversation title'),
      }),
    );
  });

  it('fails closed instead of falling back when the chain is exhausted', async () => {
    h.requestText.mockResolvedValue({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [],
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST, {}, runtimeDeps())).resolves.toBeNull();
    await expect(generateTitleWithAuxiliaryModelResult(REQUEST, {}, runtimeDeps())).resolves.toEqual({
      status: 'failed',
    });
  });

  it('cancels dispatch when the selected setting changes during credential work', async () => {
    h.models = ['codex-gpt-5.4-mini'];
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      h.models = [];
      const allowed = await (options.beforeDispatch as () => Promise<boolean>)();
      return allowed
        ? {
            ok: true,
            text: '不应采用',
            providerId: 'xd',
            model: 'gpt-5.4-mini',
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST, {}, runtimeDeps())).resolves.toBeNull();
  });

  it('cancels dispatch when the owner scope changes even if the model list is unchanged', async () => {
    h.models = ['codex-gpt-5.4-mini'];
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      h.ownerScope = 'cloud:owner-b:2';
      const allowed = await (options.beforeDispatch as () => Promise<boolean>)();
      return allowed
        ? {
            ok: true,
            text: '不应采用',
            providerId: 'xd',
            model: 'gpt-5.4-mini',
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST, {}, runtimeDeps())).resolves.toBeNull();
  });

  it('rechecks the owner scope after an async model read', async () => {
    h.models = ['codex-gpt-5.4-mini'];
    let readCount = 0;
    const readModels = vi.fn(async () => {
      readCount += 1;
      if (readCount === 2) h.ownerScope = 'cloud:owner-b:2';
      return h.models;
    });
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      const allowed = await (options.beforeDispatch as () => Promise<boolean>)();
      return allowed
        ? {
            ok: true,
            text: '不应采用',
            providerId: 'xd',
            model: 'gpt-5.4-mini',
            transport: 'litellm-chat-completions',
          }
        : { ok: false, reason: 'all_candidates_failed', attempts: [] };
    });

    await expect(generateTitleWithAuxiliaryModel(REQUEST, {}, {
      ...runtimeDeps(),
      readModels,
    })).resolves.toBeNull();
  });
});
