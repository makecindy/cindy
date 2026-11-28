import type { AgentKind, Maker } from '@cindy/maker-core';
import { AUTO_TITLE_MAX_CHARS } from '@cindy/maker-shared/session-title';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import type { TitleOneShotResult } from './title-one-shot.js';
import { validateTitleOutput } from './title-output-validation.js';
import type { createOneShotCandidates } from '../utility-model/oneShotCandidatesCore.js';

const log = createLogger('maker-host/auxiliary-title-one-shot');

const AUXILIARY_TITLE_TIMEOUT_MS = 12_000;
const AUXILIARY_TITLE_MAX_TOKENS = AUTO_TITLE_MAX_CHARS * 4;
const AUXILIARY_TITLE_OUTPUT_MAX_CHARS = 256;
const AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

type UtilityTextRequester = ReturnType<typeof createOneShotCandidates>['requestUtilityText'];

export interface AuxiliaryTitleRuntimeDeps {
  readModels: () => string[] | Promise<string[]>;
  readOwnerScope: () => string | Promise<string>;
  requestText: (
    prompt: string,
    opts: Parameters<UtilityTextRequester>[2],
  ) => ReturnType<UtilityTextRequester>;
}

export interface AuxiliaryTitleCorePorts extends AuxiliaryTitleRuntimeDeps {
  getEffectiveAuxiliaryModelChain: () => { source: string };
  getEffectiveAuxiliaryModelChainSnapshot: () => string;
  agentSupportsOneShot: (agentKind: AgentKind) => boolean;
  isAgentOneShotRouteDisabled: (agentKind: AgentKind, model?: string) => Promise<boolean>;
  getMaker: () => Pick<Maker, 'oneShot'>;
  isDispatchAllowed?: () => boolean;
}

export type TitleRequest = {
  sessionId: string;
  agentKind: AgentKind | null;
  prompt: string;
  signal?: AbortSignal;
};

export interface AuxiliaryTextRequest {
  source?: string;
  automaticTitle?: boolean;
  sessionId?: string;
  agentKind: AgentKind | null;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
  responseInstructions: string;
  signal?: AbortSignal;
  sessionAgentFallback?: boolean;
}

export type AuxiliaryTextResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

function normalizeAuxiliaryTitle(text: string): string | null {
  const normalized = validateTitleOutput(text, AUXILIARY_TITLE_OUTPUT_MAX_CHARS);
  return normalized
    ? Array.from(normalized).slice(0, AUTO_TITLE_MAX_CHARS).join('')
    : null;
}

export function createAuxiliaryTitleOneShotCore(ports: AuxiliaryTitleCorePorts) {
  const isAllowed = () => ports.isDispatchAllowed?.() !== false;

  async function requestAuxiliaryText(
    args: AuxiliaryTextRequest,
    runtimeOverrides?: Partial<AuxiliaryTitleRuntimeDeps>,
  ): Promise<AuxiliaryTextResult> {
    const deps: AuxiliaryTitleRuntimeDeps = runtimeOverrides
      ? {
          readModels: runtimeOverrides.readModels ?? ports.readModels,
          readOwnerScope: runtimeOverrides.readOwnerScope ?? ports.readOwnerScope,
          requestText: runtimeOverrides.requestText ?? ports.requestText,
        }
      : ports;
    if (!isAllowed()) return { ok: false, reason: 'dispatch-blocked' };
    const ownerScope = await deps.readOwnerScope();
    const models = [...(await deps.readModels())];
    const snapshot = JSON.stringify(models);
    const auxiliaryChain = ports.getEffectiveAuxiliaryModelChain();
    const auxiliaryChainSnapshot = ports.getEffectiveAuxiliaryModelChainSnapshot();
    const beforeDispatch = async () => {
      if (!isAllowed() || isAppSessionBoundaryPending()) return false;
      if ((await deps.readOwnerScope()) !== ownerScope) return false;
      if (ports.getEffectiveAuxiliaryModelChainSnapshot() !== auxiliaryChainSnapshot) return false;
      const currentModels = JSON.stringify(await deps.readModels());
      return (
        isAllowed() &&
        !isAppSessionBoundaryPending() &&
        (await deps.readOwnerScope()) === ownerScope &&
        ports.getEffectiveAuxiliaryModelChainSnapshot() === auxiliaryChainSnapshot &&
        currentModels === snapshot
      );
    };
    const sessionAgent = args.agentKind;
    const beforeSessionAgentDispatch = async (route?: { model?: string }) =>
      !!sessionAgent &&
      !(await ports.isAgentOneShotRouteDisabled(sessionAgent, route?.model)) &&
      (await beforeDispatch());
    const result = await deps.requestText(args.prompt, {
      source: args.source,
      automaticTitle: args.automaticTitle,
      sessionId: args.sessionId,
      maxTokens: args.maxTokens,
      timeoutMs: args.timeoutMs,
      disableReasoning: true,
      reasoningEffort: 'minimal',
      responseInstructions: args.responseInstructions,
      signal: args.signal,
      beforeDispatch,
    });
    if (result.ok) return { ok: true, text: result.text };
    const canFallbackToSessionAgent =
      args.sessionAgentFallback !== false &&
      auxiliaryChain.source === 'auto' &&
      !!sessionAgent &&
      ports.agentSupportsOneShot(sessionAgent) &&
      (await beforeSessionAgentDispatch());
    if (canFallbackToSessionAgent && sessionAgent) {
      try {
        const fallbackText = await ports.getMaker().oneShot(sessionAgent, args.prompt, {
          source: args.source,
          sessionId: args.sessionId,
          maxTokens: args.maxTokens,
          timeoutMs: args.timeoutMs,
          signal: args.signal,
          responseInstructions: args.responseInstructions,
          beforeDispatch: beforeSessionAgentDispatch,
        });
        if (fallbackText.trim()) return { ok: true, text: fallbackText };
      } catch (error) {
        log.warn('auxiliary text session agent fallback failed', {
          errorName: error instanceof Error ? error.name : typeof error,
          reason: (error as { reason?: unknown } | null)?.reason,
        });
      }
    }
    return { ok: false, reason: result.reason };
  }

  async function generateAuxiliaryTitle(
    args: TitleRequest,
    runtimeOverrides: Partial<AuxiliaryTitleRuntimeDeps> | undefined,
    automaticTitle: boolean,
  ): Promise<TitleOneShotResult> {
    const result = await requestAuxiliaryText(
      {
        source: 'title',
        sessionId: args.sessionId,
        automaticTitle,
        agentKind: args.agentKind,
        prompt: args.prompt,
        maxTokens: AUXILIARY_TITLE_MAX_TOKENS,
        timeoutMs: AUXILIARY_TITLE_TIMEOUT_MS,
        responseInstructions: AUXILIARY_TITLE_RESPONSE_INSTRUCTIONS,
        signal: args.signal,
      },
      runtimeOverrides,
    );
    if (!result.ok) {
      log.warn('auxiliary title model failed', { reason: result.reason });
      return { status: 'failed' };
    }
    const title = normalizeAuxiliaryTitle(result.text);
    return title ? { status: 'ok', title } : { status: 'failed' };
  }

  return {
    requestAuxiliaryText,
    async generateTitleWithAuxiliaryModel(
      args: TitleRequest,
      runtimeOverrides?: Partial<AuxiliaryTitleRuntimeDeps>,
    ): Promise<string | null> {
      const result = await generateAuxiliaryTitle(args, runtimeOverrides, true);
      return result.status === 'ok' ? result.title : null;
    },
    generateTitleWithAuxiliaryModelResult(
      args: TitleRequest,
      runtimeOverrides?: Partial<AuxiliaryTitleRuntimeDeps>,
    ): Promise<TitleOneShotResult> {
      return generateAuxiliaryTitle(args, runtimeOverrides, false);
    },
  };
}
