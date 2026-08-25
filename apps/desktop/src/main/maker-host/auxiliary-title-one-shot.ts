/**
 * Session-title routing with an optional global catalog pin.
 *
 * Automatic mode delegates byte-for-byte to the existing session/provider
 * title path. An explicit selection is a single exact route and fails closed;
 * callers retain their existing heuristic/manual-error fallback semantics.
 */

import type { AgentKind } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import type { AuxiliaryModelSelection } from '../utility-model/auxiliary-model-settings-store.js';
import type {
  requestExplicitUtilityText,
  UtilityTextDispatchRoute,
} from '../utility-model/oneShotCandidates.js';
import type {
  generateTitleViaProvider,
  generateTitleViaProviderResult,
  TitleOneShotDeps,
  TitleOneShotResult,
} from './title-one-shot.js';
import { validateTitleOutput } from './title-output-validation.js';

const log = createLogger('maker-host/auxiliary-title-one-shot');

const AUXILIARY_TITLE_TIMEOUT_MS = 12_000;
const AUXILIARY_TITLE_MAX_TOKENS = 32;
const AUXILIARY_TITLE_OUTPUT_MAX_CHARS = 256;
const AUXILIARY_TITLE_VISUAL_MAX_CHARS = 40;
const AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

interface AuxiliaryTitleRuntimeDeps {
  readSelection: (
    key: 'sessionTitleModel',
  ) => AuxiliaryModelSelection | null | Promise<AuxiliaryModelSelection | null>;
  requestText: typeof requestExplicitUtilityText;
  generateLegacy: typeof generateTitleViaProvider;
  generateLegacyResult: typeof generateTitleViaProviderResult;
}

const DEFAULT_DEPS: AuxiliaryTitleRuntimeDeps = {
  // The settings store resolves owner-scoped Electron paths. Load it only when
  // title generation actually runs, not while title IPC modules are registered.
  readSelection: async (key) => {
    const { readAuxiliaryModelSelection } = await import(
      '../utility-model/auxiliary-model-settings-store.js'
    );
    return readAuxiliaryModelSelection(key);
  },
  // Keep the heavyweight utility-model/provider runtime out of title.ts's
  // startup import graph. It also lets lightweight title IPC tests provide
  // their existing Electron mocks without loading app-bound runtime config.
  requestText: async (prompt, opts) => {
    const { requestExplicitUtilityText: requestText } = await import(
      '../utility-model/oneShotCandidates.js'
    );
    return requestText(prompt, opts);
  },
  generateLegacy: async (args, deps) => {
    const { generateTitleViaProvider: generate } = await import('./title-one-shot.js');
    return generate(args, deps);
  },
  generateLegacyResult: async (args, deps) => {
    const { generateTitleViaProviderResult: generate } = await import('./title-one-shot.js');
    return generate(args, deps);
  },
};

type TitleRequest = {
  sessionId: string;
  agentKind: AgentKind;
  prompt: string;
  signal?: AbortSignal;
};

function selectionMatchesRoute(
  selection: AuxiliaryModelSelection,
  route: UtilityTextDispatchRoute,
): boolean {
  return (
    selection.providerId === route.providerId &&
    selection.agentKind === route.agentKind &&
    selection.model === route.model
  );
}

async function generateExplicitTitle(
  args: TitleRequest,
  selection: AuxiliaryModelSelection,
  deps: AuxiliaryTitleRuntimeDeps,
): Promise<TitleOneShotResult> {
  const result = await deps.requestText(args.prompt, {
    providerId: selection.providerId,
    agentKind: selection.agentKind,
    model: selection.model,
    maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
    timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
    // Short title budgets cannot afford provider-default thinking. Messages /
    // chat routes receive their native disable flag; Responses routes use the
    // lowest supported effort because that protocol has no off value.
    disableReasoning: true,
    reasoningEffort: 'minimal',
    responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
    signal: args.signal,
    // Settings may change while OAuth refresh/credential discovery awaits. The
    // paid request is dispatched only if the same exact pin is still active.
    beforeDispatch: async (route) => {
      const current = await deps.readSelection('sessionTitleModel');
      return current?.pin === selection.pin && selectionMatchesRoute(current, route);
    },
  });
  if (!result.ok) {
    log.warn('explicit auxiliary title model failed', {
      providerId: selection.providerId,
      model: selection.model,
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
  legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<string | null> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  const selection = await deps.readSelection('sessionTitleModel');
  if (!selection) return deps.generateLegacy(args, legacyDeps);
  const result = await generateExplicitTitle(args, selection, deps);
  return result.status === 'ok' ? result.title : null;
}

export async function generateTitleWithAuxiliaryModelResult(
  args: TitleRequest,
  legacyDeps: TitleOneShotDeps = {},
  runtimeDeps: Partial<AuxiliaryTitleRuntimeDeps> = {},
): Promise<TitleOneShotResult> {
  const deps = { ...DEFAULT_DEPS, ...runtimeDeps };
  const selection = await deps.readSelection('sessionTitleModel');
  if (!selection) return deps.generateLegacyResult(args, legacyDeps);
  return generateExplicitTitle(args, selection, deps);
}
