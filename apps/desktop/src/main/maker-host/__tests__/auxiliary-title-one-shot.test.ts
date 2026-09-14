import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  models: [] as string[],
  ownerScope: 'local:owner-a:1',
  requestText: vi.fn(),
  oneShot: vi.fn(),
  chainSource: 'auto' as 'auto' | 'custom' | 'env',
  sessionBoundaryPending: false,
  oneShotRouteDisabled: false,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

vi.mock('../index.js', () => ({
  getMaker: () => ({ oneShot: h.oneShot }),
}));

vi.mock('../model-route-guard-live.js', () => ({
  isAgentOneShotRouteDisabled: vi.fn(async () => h.oneShotRouteDisabled),
}));

vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => h.ownerScope,
  isAppSessionBoundaryPending: () => h.sessionBoundaryPending,
}));

vi.mock('../../utility-model/resolveAuxiliaryModelChain.js', () => ({
  getEffectiveAuxiliaryModelChain: () => ({ source: h.chainSource, refs: [] }),
  getEffectiveAuxiliaryModelChainSnapshot: () => JSON.stringify({ source: h.chainSource, refs: [] }),
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

const CODEX_REQUEST = {
  ...REQUEST,
  agentKind: 'codex' as const,
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
  h.chainSource = 'auto';
  h.sessionBoundaryPending = false;
  h.oneShotRouteDisabled = false;
  h.oneShot.mockResolvedValue('会话 Agent 命名');
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

  it('falls back to the same session agent when the automatic chain is exhausted', async () => {
    h.requestText.mockResolvedValue({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [],
    });

    await expect(generateTitleWithAuxiliaryModel(CODEX_REQUEST, {}, runtimeDeps())).resolves.toBe(
      '会话 Agent 命名',
    );
    expect(h.oneShot).toHaveBeenCalledWith(
      'codex',
      CODEX_REQUEST.prompt,
      expect.objectContaining({
        maxTokens: 32,
        responseInstructions: expect.stringContaining('Output only the short conversation title'),
      }),
    );
  });

  it('rechecks the disabled route while the session-agent fallback is starting', async () => {
    h.requestText.mockResolvedValue({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [],
    });
    h.oneShot.mockImplementation(async (_agentKind, _prompt, options) => {
      h.oneShotRouteDisabled = true;
      const allowed = await (options.beforeDispatch as () => Promise<boolean>)();
      if (!allowed) throw new Error('disabled during startup');
      return '不应采用';
    });

    await expect(generateTitleWithAuxiliaryModel(CODEX_REQUEST, {}, runtimeDeps())).resolves.toBeNull();
  });

  it('keeps an explicit custom chain fail-closed when it is exhausted', async () => {
    h.chainSource = 'custom';
    h.requestText.mockResolvedValue({
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [],
    });

    await expect(generateTitleWithAuxiliaryModel(CODEX_REQUEST, {}, runtimeDeps())).resolves.toBeNull();
    expect(h.oneShot).not.toHaveBeenCalled();
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

  it('fails closed while the app session boundary is pending', async () => {
    h.models = ['codex-gpt-5.4-mini'];
    h.requestText.mockImplementation(async (_prompt: string, options: Record<string, unknown>) => {
      h.sessionBoundaryPending = true;
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
    expect(h.oneShot).not.toHaveBeenCalled();
  });
});
