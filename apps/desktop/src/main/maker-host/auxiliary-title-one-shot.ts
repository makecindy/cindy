import {createAuxiliaryTextRequest} from '@cindy/app-runtime/auxiliaryText';
/**
 * Session-title routing through the shared auxiliary-model chain.
 *
 * Automatic and custom chains both go through `requestUtilityText`. Automatic
 * routing may fall back to the owning session agent when the auxiliary chain
 * is unavailable; an explicit custom/env chain remains fail-closed.
 */

import type { AgentKind } from '@cindy/maker-core';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import type {requestUtilityText} from '../utility-model/oneShotCandidates.js';
import {
  getEffectiveAuxiliaryModelChain,
  getEffectiveAuxiliaryModelChainSnapshot,
} from '../utility-model/resolveAuxiliaryModelChain.js';
import { getMaker } from './index.js';
import type { TitleOneShotDeps, TitleOneShotResult } from './title-one-shot.js';
import { validateTitleOutput } from './title-output-validation.js';

const log = createLogger('maker-host/auxiliary-title-one-shot');

const AUXILIARY_TITLE_TIMEOUT_MS = 12_000;
// Allow multi-byte Chinese / emoji titles within the shared character limit.
const AUXILIARY_TITLE_MAX_TOKENS = AUTO_TITLE_MAX_CHARS * 4;
const AUXILIARY_TITLE_OUTPUT_MAX_CHARS = 256;
const AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

interface AuxiliaryTitleRuntimeDeps {
  readModels: () => string[] | Promise<string[]>;
  readOwnerScope: () => string | Promise<string>;
  requestText: (
    prompt: string,
    opts: Parameters<typeof requestUtilityText>[2],
  ) => ReturnType<typeof requestUtilityText>;
}

const DEFAULT_DEPS: AuxiliaryTitleRuntimeDeps = {
  readModels: () => readAuxiliaryModelSettings().models,
  readOwnerScope: () => activeOwnerScopeKey(),
  requestText: async (prompt, opts) => (await import('../utility-model/oneShotCandidates.js')).requestUtilityText(getMaker(), prompt, opts),
};

type TitleRequest = {
  sessionId: string;
  agentKind: AgentKind;
  prompt: string;
  signal?: AbortSignal;
};

export type {AuxiliaryTextRequest,AuxiliaryTextResult} from '@cindy/app-runtime/auxiliaryText';
export const requestAuxiliaryText=createAuxiliaryTextRequest({
 ...DEFAULT_DEPS,isAppSessionBoundaryPending,getEffectiveAuxiliaryModelChain,getEffectiveAuxiliaryModelChainSnapshot,isAgentOneShotRouteDisabled,getMaker,logger:log,
});

async function generateAuxiliaryTitle(
  args: TitleRequest,
  deps: AuxiliaryTitleRuntimeDeps,
): Promise<TitleOneShotResult> {
  const result = await requestAuxiliaryText({
    agentKind: args.agentKind,
    prompt: args.prompt,
    maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
    timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
    responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
    signal: args.signal,
  }, deps);
  if (!result.ok) {
    log.warn('auxiliary title model failed', { reason: result.reason });
    return { status: 'failed' };
  }
  const title = normalizeAuxiliaryTitle(result.text);
  return title ? { status: 'ok', title } : { status: 'failed' };
}

function normalizeAuxiliaryTitle(text: string): string | null {
  // Validate the complete response before the historical 40-character visual
  // truncation, matching title-one-shot's persisted-content boundary.
  const normalized = validateTitleOutput(text, AUXILIARY_TITLE_OUTPUT_MAX_CHARS);
  return normalized
    ? Array.from(normalized).slice(0, AUTO_TITLE_MAX_CHARS).join('')
    : null;
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
