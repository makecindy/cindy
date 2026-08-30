/**
 * Session-title routing through the shared auxiliary-model chain.
 *
 * Automatic and custom chains both go through `requestUtilityText`. Callers
 * retain their existing heuristic/manual-error fallback semantics.
 */

import type { AgentKind } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import type { requestUtilityText } from '../utility-model/oneShotCandidates.js';
import type { TitleOneShotDeps, TitleOneShotResult } from './title-one-shot.js';
import { validateTitleOutput } from './title-output-validation.js';

const log = createLogger('maker-host/auxiliary-title-one-shot');

const AUXILIARY_TITLE_TIMEOUT_MS = 12_000;
const AUXILIARY_TITLE_MAX_TOKENS = 32;
const AUXILIARY_TITLE_OUTPUT_MAX_CHARS = 256;
const AUXILIARY_TITLE_VISUAL_MAX_CHARS = 40;
const AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

interface AuxiliaryTitleRuntimeDeps {
  readModels: () => string[] | Promise<string[]>;
  requestText: (
    prompt: string,
    opts: Parameters<typeof requestUtilityText>[2],
  ) => ReturnType<typeof requestUtilityText>;
}

const DEFAULT_DEPS: AuxiliaryTitleRuntimeDeps = {
  // The settings store resolves owner-scoped Electron paths. Load it only when
  // title generation actually runs, not while title IPC modules are registered.
  readModels: async () => {
    const { readAuxiliaryModelSettings } = await import(
      '../utility-model/auxiliary-model-settings-store.js'
    );
    return readAuxiliaryModelSettings().models;
  },
  // Keep the heavyweight utility-model/provider runtime out of title.ts's
  // startup import graph. It also lets lightweight title IPC tests provide
  // their existing Electron mocks without loading app-bound runtime config.
  requestText: async (prompt, opts) => {
    const [{ requestUtilityText: requestText }, { getMaker }] = await Promise.all([
      import('../utility-model/oneShotCandidates.js'),
      import('./index.js'),
    ]);
    return requestText(getMaker(), prompt, opts);
  },
};

type TitleRequest = {
  sessionId: string;
  agentKind: AgentKind;
  prompt: string;
  signal?: AbortSignal;
};

async function generateAuxiliaryTitle(
  args: TitleRequest,
  deps: AuxiliaryTitleRuntimeDeps,
): Promise<TitleOneShotResult> {
  const models = [...await deps.readModels()];
  const snapshot = JSON.stringify(models);
  const result = await deps.requestText(args.prompt, {
    maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
    timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
    // Short title budgets cannot afford provider-default thinking. Messages /
    // chat routes receive their native disable flag; Responses routes use the
    // lowest supported effort because that protocol has no off value.
    disableReasoning: true,
    reasoningEffort: 'minimal',
    responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
    signal: args.signal,
    // Settings may change while OAuth refresh/credential discovery awaits.
    beforeDispatch: async () => JSON.stringify(await deps.readModels()) === snapshot,
  });
  if (!result.ok) {
    log.warn('auxiliary title model failed', {
      reason: result.reason,
    });
    return { status: 'failed' };
  }

  // Validate the complete response before the historical 40-character visual
  // truncation, matching title-one-shot's persisted-content boundary.
  const normalized = validateTitleOutput(result.text, AUXILIARY_TITLE_OUTPUT_MAX_CHARS);
  const title = normalized
    ? Array.from(normalized).slice(0, AUXILIARY_TITLE_VISUAL_MAX_CHARS).join('')
    : null;
  return title ? { status: 'ok', title } : { status: 'failed' };
}

export async function generateTitleWithAuxiliaryModel(
  args: TitleRequest,
  _legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  const result = await generateAuxiliaryTitle(args, deps);
  return result.status === 'ok' ? result.title : null;
}

export async function generateTitleWithAuxiliaryModelResult(
  args: TitleRequest,
  _legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<TitleOneShotResult> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  return generateAuxiliaryTitle(args, deps);
}
