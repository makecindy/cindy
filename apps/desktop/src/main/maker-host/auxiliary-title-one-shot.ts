/**
 * Session-title routing through the shared auxiliary-model chain.
 *
 * Automatic and custom chains both go through `requestUtilityText`. Automatic
 * routing may fall back to the owning session agent when the auxiliary chain
 * is unavailable; an explicit custom/env chain remains fail-closed.
 */

import type { AgentKind } from '@cindy/maker-core';

import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import { isAgentOneShotRouteDisabled } from './model-route-guard-live.js';
import { readAuxiliaryModelSettings } from '../utility-model/auxiliary-model-settings-store.js';
import {
  agentSupportsOneShot,
  requestUtilityText,
} from '../utility-model/oneShotCandidates.js';
import {
  getEffectiveAuxiliaryModelChain,
  getEffectiveAuxiliaryModelChainSnapshot,
} from '../utility-model/resolveAuxiliaryModelChain.js';
import { getMaker } from './index.js';
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
  readOwnerScope: () => string | Promise<string>;
  requestText: (
    prompt: string,
    opts: Parameters<typeof requestUtilityText>[2],
  ) => ReturnType<typeof requestUtilityText>;
}

const DEFAULT_DEPS: AuxiliaryTitleRuntimeDeps = {
  readModels: () => readAuxiliaryModelSettings().models,
  readOwnerScope: () => activeOwnerScopeKey(),
  requestText: (prompt, opts) => requestUtilityText(getMaker(), prompt, opts),
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
  const ownerScope = await deps.readOwnerScope();
  const models = [...await deps.readModels()];
  const snapshot = JSON.stringify(models);
  const auxiliaryChain = getEffectiveAuxiliaryModelChain();
  const auxiliaryChainSnapshot = getEffectiveAuxiliaryModelChainSnapshot();
  const beforeDispatch = async () => {
    if (isAppSessionBoundaryPending()) return false;
    if ((await deps.readOwnerScope()) !== ownerScope) return false;
    if (getEffectiveAuxiliaryModelChainSnapshot() !== auxiliaryChainSnapshot) return false;
    const currentModels = JSON.stringify(await deps.readModels());
    return !isAppSessionBoundaryPending()
      && (await deps.readOwnerScope()) === ownerScope
      && getEffectiveAuxiliaryModelChainSnapshot() === auxiliaryChainSnapshot
      && currentModels === snapshot;
  };
  const beforeSessionAgentDispatch = async () =>
    !(await isAgentOneShotRouteDisabled(args.agentKind)) && await beforeDispatch();
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
    beforeDispatch,
  });
  if (!result.ok) {
    // A signed-out user still has the current session agent available. Only
    // the automatic chain may use that same-agent fallback; custom and env
    // chains are explicit routing decisions and must remain fail-closed.
    const canFallbackToSessionAgent = auxiliaryChain.source === 'auto'
      && agentSupportsOneShot(args.agentKind)
      && await beforeSessionAgentDispatch();
    if (canFallbackToSessionAgent) {
      try {
        const fallbackText = await getMaker().oneShot(args.agentKind, args.prompt, {
          maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
          timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
          signal: args.signal,
          responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
          beforeDispatch: beforeSessionAgentDispatch,
        });
        const fallbackTitle = normalizeAuxiliaryTitle(fallbackText);
        if (fallbackTitle) return { status: 'ok', title: fallbackTitle };
      } catch (error) {
        log.warn('auxiliary title session agent fallback failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    log.warn('auxiliary title model failed', {
      reason: result.reason,
    });
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
    ? Array.from(normalized).slice(0, AUXILIARY_TITLE_VISUAL_MAX_CHARS).join('')
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
