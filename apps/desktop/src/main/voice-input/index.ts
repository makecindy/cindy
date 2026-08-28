import { app, ipcMain, shell, systemPreferences } from 'electron';
import fs from 'node:fs/promises';

import {
  DictationDictionaryAdvisor,
  DictationRefiner,
  VoiceInputController,
  VoiceTimelineLogger,
  getDictationDictionaryAdviceSkipReason,
  type DictationDictionaryAdviceInput,
  type DictationDictionaryAdviceResult,
  type EditableRange,
  type SpeechSegment,
  type AsrProvider,
  type AudioTrace,
  type DictationRefinementContext,
  type TextModelClient,
  type VoiceInputRendererEvent,
  type VoiceTimelineEvent,
} from '@cindy/voice-input-core';
import { createLogger } from '../logger.js';
import {
  isProviderModelRouteDisabled,
  isUtilityRouteDisabled,
  isUtilityRoutePaymentRequired,
} from '../utility-model/oneShotCandidates.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import {
  desktopCodexAuthAdapter,
  readOwnerScopedXdGatewayKey,
} from '../maker-host/auth-adapters.js';
import { getActiveAppSession } from '../appSessionState.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import {
  CodexResponsesTextModelClient,
  prewarmCodexResponsesEndpoint,
} from './CodexResponsesTextModelClient.js';
import { ElevenLabsScribeProvider } from './ElevenLabsScribeProvider.js';
import { FallbackAsrProvider } from './FallbackAsrProvider.js';
import {
  FallbackTextModelClient,
  type FallbackTextModelAttempt,
} from './FallbackTextModelClient.js';
import {
  LiteLlmTranscriptionProvider,
  transcribeLiteLlmAudioFile,
} from './LiteLlmTranscriptionProvider.js';
import {
  LiteLlmTextModelClient,
  makeRefinerPromptCacheKey,
  prewarmLiteLlmRefinerEndpoint,
} from './LiteLlmTextModelClient.js';
import {
  invalidatePrewarmedRealtimeAsrWebSocketSession,
  RealtimeAsrWebSocketProvider,
  prewarmRealtimeAsrWebSocketSession,
  type RealtimeAsrWebSocketProviderOptions,
} from './RealtimeAsrWebSocketProvider.js';
import { VolcengineSaucAsrProvider } from './VolcengineSaucAsrProvider.js';
import {
  CINDY_MANAGED_REFINER_PROVIDER,
  CindyVoiceRunContext,
  isCindyVoiceServiceReady,
} from './CindyVoiceSessionClient.js';
import { orderVoiceInputProvidersByHealth } from './VoiceInputProviderHealth.js';
import {
  collectRefinerPrewarmTransports,
  orderVoiceInputRefinerChainForRuntime,
} from './VoiceInputRefinerRouting.js';
import {
  getMicrophoneSettingsUrl,
  isExplicitMicrophonePermissionDenied,
  resolveMicrophonePermissionSnapshot,
  type VoiceInputMicrophonePermissionCache,
} from './permissions.js';
import { systemAudioMuteGuard } from './SystemAudioMuteGuard.js';
import {
  awaitGlobalOverlayPasteContext,
  getVoiceInputAccessibilityPermissionSnapshot,
  getVoiceInputInputMonitoringPermissionCachedSnapshot,
  isGlobalVoiceInputOverlaySender,
  refreshVoiceInputInputMonitoringPermissionSnapshot,
  registerActiveInlineVoiceInputWebContents,
  showVoiceInputDictionaryToast,
  takeOverlayDictionaryToastAnchor,
  unregisterActiveInlineVoiceInputWebContents,
} from './global.js';
import {
  registerVoiceInputDataStoreIpc,
  voiceInputDataStore,
} from './VoiceInputDataStore.js';
import {
  toDictionaryLearningCandidateState,
  toDictionaryLearningEntryState,
} from '../../shared/voiceInputData.js';
import {
  buildLiteLlmRealtimeWebSocketUrl,
  getVoiceInputAsrProfile,
  getVoiceInputAsrProfiles,
  isRealtimeAsrProvider,
  liteLlmRealtimeHeaders,
  resolveVoiceInputProviderKindAlias,
  type VoiceInputAsrProfile,
  type VoiceInputProviderKind,
} from './voiceInputAsrConfig.js';
import {
  getVoiceInputModelSelection,
  getVoiceInputModelSelectionConfigPath,
  effectiveVoiceInputServiceMode,
  reloadVoiceInputModelSelection,
  setVoiceInputModelSelection,
  validateVoiceInputCustomAsrConfig,
  voiceInputAsrChainForServiceMode,
  voiceInputModelSelectionSignature,
  type VoiceInputCustomAsrConfig,
  type VoiceInputModelSelection,
  type VoiceInputModelSelectionPatch,
  type VoiceInputServiceMode,
} from './VoiceInputModelSelection.js';
import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  getVoiceInputRefinerProfile,
  getVoiceInputRefinerProfiles,
  resolveVoiceInputRefinerProviderKindAlias,
  type VoiceInputRefinerProfile,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';
import {
  canReuseVoiceInputCustomAsrCredential,
  MAX_CUSTOM_ASR_API_KEY_CHARS,
  resolveVoiceInputCustomAsrWebsocketUrl,
} from '../../shared/voiceInputCustomAsr.js';
import {
  persistVoiceInputSelectionWithCustomAsrSecret,
  type CustomAsrSecretUpdate,
} from './voiceInputCustomAsrPersistence.js';
import {
  VOICE_INPUT_TEST_CONNECTION_CHANNEL,
  type VoiceInputConnectionTestResult,
} from '../../shared/voiceInputConnectionTest.js';
import { runSerializedVoiceInputConnectionTest } from './voiceInputConnectionTest.js';

const log = createLogger('voice-input');
let customAsrCredentialRevision = 0;

// The built-in realtime voice path is a Cindy service, not a hidden BYOK
// consumer. A voice-server outage must never spend the user's general model
// credential as an implicit ASR or refiner fallback. The only way user
// credentials are spent is the explicit BYOK service mode below.
const CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE =
  '语音服务暂时不可用，请稍后重试。';

/**
 * ASR candidates that are allowed to use the managed voice-server data plane.
 * Direct Codex / ElevenLabs profiles are deliberately excluded from this set:
 * they require credentials owned by the user and must never become an
 * implicit fallback when a managed ASR provider fails.
 */
function isManagedVoiceAsrProfile(profile: VoiceInputAsrProfile): boolean {
  return profile.id.startsWith('litellm-') && profile.mode !== 'batch-http';
}

/**
 * True when the user explicitly switched voice dictation to their own
 * credentials (settings "服务来源" → 自定义). In this mode the pre-managed
 * direct-dial paths are restored (gateway key / Codex login / ElevenLabs env)
 * and the managed Cindy voice service is never contacted — the two modes must
 * not fall back into each other in either direction.
 */
function isVoiceInputByokMode(): boolean {
  const selection = readActiveVoiceInputModelSelection('service-mode');
  return effectiveVoiceInputServiceMode(
    selection.serviceMode,
    getAppCapabilities().canUseCindyAccountServices,
  ) === 'byok';
}

type StartResult =
  | { ok: true; runId: string }
  | { ok: false; error: string; authErrorReason?: string };

type VoiceInputActionResult =
  | { ok: true }
  | { ok: false; error: string };

export type VoiceInputAudioFileTranscriptionInput = {
  bytes: Buffer | Uint8Array;
  mimeType?: string;
  fileName?: string;
  sourceLanguage?: string;
};

export type VoiceInputAudioFileTranscriptionResult = {
  text: string;
  provider: VoiceInputProviderKind;
  model: string;
};

type ActiveVoiceInput = {
  controller: VoiceInputController;
  provider: AsrProvider;
  sourceLanguage?: string;
  refinementEnabled?: boolean;
};

type VoiceInputReadiness = {
  ok: boolean;
  serviceMode: VoiceInputServiceMode;
  provider: VoiceInputProviderKind;
  providerModel: string;
  auth: 'api-key' | 'codex';
  settingsTab: 'api-keys' | 'connections' | 'providers';
  error?: string;
  authErrorReason?: string;
  failureReason?: 'custom-asr-config-missing' | 'custom-asr-key-missing' | 'codex-realtime-unsupported';
};

type VoiceInputRefinerReadiness = {
  ok: boolean;
  provider: VoiceInputRefinerProviderKind;
  model: string;
  auth: 'api-key' | 'codex';
  settingsTab: 'api-keys' | 'connections' | 'providers';
  error?: string;
  authErrorReason?: string;
};

type VoiceInputRefinerChainRuntimeResolution = {
  refinerChainProfiles: VoiceInputRefinerProfile[];
  refinerReadinessList: VoiceInputRefinerReadiness[];
  readyRefinerProfiles: VoiceInputRefinerProfile[];
};

type VoiceInputModelSelectionIpcResult = {
  selection: VoiceInputModelSelection;
  asrProfiles: Array<{
    id: VoiceInputProviderKind;
    model: string;
    mode: VoiceInputAsrProfile['mode'];
    auth: VoiceInputAsrProfile['auth'];
  }>;
  refinerProfiles: Array<{
    id: VoiceInputRefinerProviderKind;
    model: string;
    transport: VoiceInputRefinerProfile['transport'];
    auth: VoiceInputRefinerProfile['auth'];
  }>;
  readiness: VoiceInputReadiness;
  customAsrApiKeyConfigured: boolean;
};

type VoiceInputSystemPermissions = {
  microphone: VoiceInputMicrophonePermissionCache;
  inputMonitoring: VoiceInputMicrophonePermissionCache;
  accessibility: VoiceInputMicrophonePermissionCache;
};

type StartPayload = {
  sourceLanguage?: string;
  refinementEnabled?: boolean;
  refinementContext?: DictationRefinementContext;
  refinementCacheScope?: string;
};

type AudioPayload = {
  pcm16k: ArrayBuffer;
  trace?: AudioTrace;
};

type BenchmarkFixtureAudioResult =
  | { ok: true; path: string; wav: ArrayBuffer }
  | { ok: false };

export type DictionaryAdviceIpcResult =
  | { ok: true; actions: DictationDictionaryAdviceResult['actions']; elapsedMs: number; ignoreReason?: string | null }
  | { ok: false; error: string };

const activeByWebContentsId = new Map<number, ActiveVoiceInput>();
let appRestoreRegistered = false;
let cachedMicrophonePermission: VoiceInputMicrophonePermissionCache | null = null;
let rendererVerifiedMicrophonePermission = false;
let cachedVoiceInputReadiness: VoiceInputReadiness | null = null;
let readinessRefreshPromise: Promise<VoiceInputReadiness> | null = null;
let lastModelSelectionSignature = '';
let modelSelectionGeneration = 0;
const MAX_REFINEMENT_SIDE_CONTEXT_CHARS = 1_200;
const MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS = 500;
const MAX_USER_REFINEMENT_INSTRUCTIONS_CHARS = 1_000;
const MAX_USER_DICTIONARY_CHARS = 4_000;
const MAX_DICTIONARY_ALIAS_HINT_CHARS = 120;
const MAX_DICTIONARY_ALIAS_HINTS = 1_000;
const MAX_DICTIONARY_ALIAS_HINT_ALIASES = 8;
const VOICE_INPUT_REFINEMENT_CACHE_SCOPE = 'voice-input-refinement';
// Refinement is a user-waiting path. Both refiner clients implement this as an
// IDLE watchdog (re-armed on every stream chunk), so a long refinement that
// keeps emitting tokens never times out — only a stalled connection does.
// Combined with FallbackTextModelClient's 2-attempt cap the worst case before
// falling back to the already-displayed raw ASR text is ~8s. BYOK only.
const VOICE_INPUT_REFINER_IDLE_TIMEOUT_MS = 4_000;
// Managed mode sends a single request and voice-server runs the model
// failover internally (up to ~3 candidates x 3.5s first-byte budget before
// its first chunk arrives), so the client-side watchdog must cover the whole
// server-side chain, not one attempt.
const VOICE_INPUT_MANAGED_REFINER_IDLE_TIMEOUT_MS = 12_000;
// Dev builds keep full dictionary-learning text/reason logs so we can inspect
// why a user correction did or did not become a dictionary entry. Packaged
// builds must not log user dictation text by default.
const DICTIONARY_LEARNING_TEXT_DEBUG = !app.isPackaged;

export async function adviseAndRecordVoiceInputDictionaryLearning(
  payload: DictationDictionaryAdviceInput | undefined,
  options: {
    senderId?: number | string;
    sourceLabel?: string;
    /**
     * 该请求是否真的来自全局浮窗的 renderer。只有 main 依据 `event.sender` 反查得出
     * 的结论才算，不能用 payload.source —— 那是 renderer 自报的，别的 renderer 拿
     * 共享的 adviseDictionaryLearning 桥填个 'external_overlay' 就能消费掉浮窗锚点，
     * 让真正的浮窗请求失去锚点、自己拿到浮窗的位置。
     */
    fromOverlaySender?: boolean;
  } = {},
): Promise<DictionaryAdviceIpcResult> {
  if (!payload?.beforeText || !payload.afterText) {
    return { ok: true, actions: [], elapsedMs: 0 };
  }

  const sourceLabel = options.sourceLabel ?? payload.source ?? 'in_app';
  // 锚点资格只认 main 侧由 event.sender 反查出的 fromOverlaySender，不认 payload.source
  // 这个 renderer 自报字段。锚点必须在任何 await 之前取：此刻的呈现代次才代表这次请求
  // 的来源会话，绑定后无论 advisor 何时返回都只认自己那份；等 advisor 返回后再取，
  // 并发请求会互相抢。跳过分支同样取走，让过期锚点尽早出队。
  const toastAnchor = options.fromOverlaySender === true
    ? takeOverlayDictionaryToastAnchor()
    : null;
  const skipReason = getDictationDictionaryAdviceSkipReason(payload);
  if (skipReason) {
    log.debug('dictionary learning advice skipped', {
      source: sourceLabel,
      reason: skipReason,
      rawTranscriptChars: payload.rawTranscriptText?.length ?? 0,
      beforeChars: payload.beforeText.length,
      afterChars: payload.afterText.length,
      debugText: DICTIONARY_LEARNING_TEXT_DEBUG
        ? {
            rawTranscriptText: payload.rawTranscriptText,
            beforeText: payload.beforeText,
            afterText: payload.afterText,
          }
        : undefined,
    });
    return {
      ok: true,
      actions: [],
      elapsedMs: 0,
      ignoreReason: DICTIONARY_LEARNING_TEXT_DEBUG ? skipReason : null,
    };
  }

  // Same fallback chain as dictation refinement: the advisor is a background
  // task, but a primary refiner outage should degrade to a backup model
  // instead of silently dropping dictionary learning.
  const {
    refinerReadinessList: advisorReadinessList,
    readyRefinerProfiles: readyAdvisorProfiles,
  } = await resolveVoiceInputRefinerChainForRuntime();
  const advisorHeadProfile = readyAdvisorProfiles[0];
  if (!advisorHeadProfile) {
    return {
      ok: false,
      error: advisorReadinessList[0]?.error ?? 'Dictionary learning advisor requires a configured refiner.',
    };
  }

  try {
    const senderId = options.senderId ?? 'device-link';
    const advisorAttempts: FallbackTextModelAttempt[] = readyAdvisorProfiles.map((profile) => ({
      profileId: profile.id as VoiceInputRefinerProviderKind,
      model: profile.model,
      client: createVoiceInputTextModelClient(profile),
      promptCacheScope: `dictionaryLearning:${profile.id}:${senderId}`,
    }));
    const advisor = new DictationDictionaryAdvisor({
      client: new FallbackTextModelClient(advisorAttempts),
      model: advisorHeadProfile.model,
      promptCacheScope: `dictionaryLearning:${advisorHeadProfile.id}:${senderId}`,
      debug: DICTIONARY_LEARNING_TEXT_DEBUG,
    });
    const settings = voiceInputDataStore.getSettings();
    const adviceInput: DictationDictionaryAdviceInput = {
      ...payload,
      existingEntries: toDictionaryLearningEntryState(settings.dictionaryEntries),
      existingCandidates: toDictionaryLearningCandidateState(settings.dictionaryCandidates),
    };
    const result = await advisor.advise(adviceInput);
    const recordResult = voiceInputDataStore.recordDictionaryLearningActions(result.actions);
    if (recordResult.newAutomaticEntries.length > 0) {
      showVoiceInputDictionaryToast(
        recordResult.newAutomaticEntries.map((entry) => ({
          entryId: entry.id,
          term: entry.text,
        })),
        // 锚点在本函数入口、任何 await 之前就绑定好了（见 toastAnchor），这里只是
        // 把它交给 toast：并发的 advisor 请求各认自己那次会话的现场，先返回的不会
        // 消费掉别人的。应用内听写不带锚点，走默认位置。
        { anchor: toastAnchor },
      );
    }
    log.debug('dictionary learning advice', {
      source: sourceLabel,
      rawTranscriptChars: payload.rawTranscriptText?.length ?? 0,
      beforeChars: payload.beforeText.length,
      afterChars: payload.afterText.length,
      actions: result.actions.map((action) => ({
        action: action.action,
        term: action.term,
        aliases: action.aliases,
        type: action.type,
        confidence: action.confidence,
        reason: action.reason,
      })),
      refinerProvider: advisorHeadProfile.id,
      refinerModel: advisorHeadProfile.model,
      refinerChain: readyAdvisorProfiles.map((profile) => profile.id),
      ignoreReason: result.ignoreReason,
      elapsedMs: Math.round(result.elapsedMs),
      debugText: DICTIONARY_LEARNING_TEXT_DEBUG
        ? {
            rawTranscriptText: payload.rawTranscriptText,
            beforeText: payload.beforeText,
            afterText: payload.afterText,
          }
        : undefined,
    });
    return {
      ok: true,
      actions: result.actions,
      elapsedMs: Math.round(result.elapsedMs),
      ignoreReason: result.ignoreReason,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('dictionary learning advice failed', {
      source: sourceLabel,
      rawTranscriptChars: payload.rawTranscriptText?.length ?? 0,
      beforeChars: payload.beforeText.length,
      afterChars: payload.afterText.length,
      error: message,
    });
    return { ok: false, error: message };
  }
}

function resolveBenchmarkFixtureAudioPath(): string | null {
  if (app.isPackaged) return null;
  const value = process.env.XDT_VOICE_INPUT_BENCHMARK_AUDIO?.trim();
  return value ? value : null;
}

async function readBenchmarkFixtureAudio(): Promise<BenchmarkFixtureAudioResult> {
  const audioPath = resolveBenchmarkFixtureAudioPath();
  if (!audioPath) return { ok: false };
  const buffer = await fs.readFile(audioPath);
  return {
    ok: true,
    path: audioPath,
    wav: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  };
}

function summarizeTimelineEventForLog(event: VoiceTimelineEvent): Record<string, unknown> {
  const summary: Record<string, unknown> = { ...event };
  for (const key of ['text', 'basedOnText', 'refinedText'] as const) {
    const value = summary[key];
    if (typeof value === 'string') {
      summary[`${key}Chars`] = value.length;
      delete summary[key];
    }
  }
  return summary;
}

// 'auto' must mean "let the ASR provider auto-detect", not "fall back to the
// system locale". Forcing the system locale onto the provider's language hint
// hurts code-switching users (zh+en mixed dictation gets mis-recognized when
// the hint is locked to zh-CN). Refinement still wants a concrete language for
// prompt context — keep that resolution separate from the ASR hint.
function resolveAsrLanguageHint(explicit?: string): string | undefined {
  const override = explicit?.trim();
  if (!override || override.toLowerCase() === 'auto') return undefined;
  return override;
}

function resolveRefineSourceLanguage(explicit?: string): string {
  const override = explicit?.trim();
  if (override && override.toLowerCase() !== 'auto') return override;

  const preferred = app.getPreferredSystemLanguages().find((language) => language.trim().length > 0)?.trim();
  if (preferred) return preferred;

  return app.getLocale() || app.getSystemLocale() || 'auto';
}

function normalizeRefinementContext(
  context: DictationRefinementContext | undefined,
  sourceLanguage: string,
): DictationRefinementContext {
  const contextSourceLanguage = context?.sourceLanguage?.trim();
  const effectiveSourceLanguage =
    contextSourceLanguage && contextSourceLanguage.toLowerCase() !== 'auto'
      ? contextSourceLanguage
      : sourceLanguage;

  // Preserve this key order through main before DictationRefiner rebuilds the
  // final request. Keep stable user settings before voice history, and keep
  // cursor-local / per-request fields after that.
  return {
    uiLanguage: truncateText(context?.uiLanguage ?? app.getLocale(), 32),
    sourceLanguage: truncateText(effectiveSourceLanguage, 32),
    userRefinementInstructions: truncateText(
      context?.userRefinementInstructions ?? '',
      MAX_USER_REFINEMENT_INSTRUCTIONS_CHARS,
    ),
    userDictionary: truncateMultilineText(context?.userDictionary ?? '', MAX_USER_DICTIONARY_CHARS),
    dictionaryAliasHints: normalizeDictionaryAliasHints(context?.dictionaryAliasHints),
    voiceInputHistory: normalizeMultilineText(context?.voiceInputHistory ?? ''),
    selectionBefore: takeTail(context?.selectionBefore ?? '', MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
    selectedText: truncateText(context?.selectedText ?? '', MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
    selectionAfter: takeHead(context?.selectionAfter ?? '', MAX_REFINEMENT_SIDE_CONTEXT_CHARS),
    replyToMessage: truncateText(
      context?.replyToMessage ?? '',
      MAX_REFINEMENT_REPLY_TO_MESSAGE_CHARS,
    ),
  };
}

// Fires off the overlay AX-context capture wait WITHOUT blocking the caller,
// and mutates `targetContext` in place when it resolves. Returning a promise
// lets callers optionally await for tests; production code fires-and-forgets
// because we don't want to delay ASR provider creation on the slow path.
//
// The previous implementation awaited up to 800ms here BEFORE the WS dial,
// regressing voice-input start latency in exchange for richer refine context.
// Now the dial proceeds immediately; on the rare race where refine fires
// before AX capture completes, the run falls back to history-only refinement
// — same as life before the feature.
function beginOverlayContextInjection(
  rendererContext: DictationRefinementContext | undefined,
  sender: Electron.WebContents,
  targetContext: DictationRefinementContext,
): Promise<void> | null {
  // Only inject for the global voice overlay. ChatInput on the main window
  // has its own selection state and must not pick up cached overlay context
  // (which can outlive an overlay close on the paste path).
  if (!isGlobalVoiceInputOverlaySender(sender)) return null;

  // If the overlay caller somehow already supplied selection fields, trust
  // them — leave room for future overrides from that side.
  const hasAnySelection = Boolean(
    rendererContext?.selectionBefore ||
    rendererContext?.selectedText ||
    rendererContext?.selectionAfter,
  );
  if (hasAnySelection) return null;

  return awaitGlobalOverlayPasteContext({ timeoutMs: 800 })
    .then((overlayContext) => {
      if (!overlayContext) return;
      // Apply the same length caps as normalizeRefinementContext does for
      // synchronous fields, so prompt sizing stays predictable regardless
      // of whether overlay capture won the race.
      targetContext.selectionBefore = takeTail(overlayContext.selectionBefore, MAX_REFINEMENT_SIDE_CONTEXT_CHARS);
      targetContext.selectedText = truncateText(overlayContext.selectedText, MAX_REFINEMENT_SIDE_CONTEXT_CHARS);
      targetContext.selectionAfter = takeHead(overlayContext.selectionAfter, MAX_REFINEMENT_SIDE_CONTEXT_CHARS);
    })
    .catch((error: unknown) => {
      log.debug('overlay AX context injection failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function summarizeRefinementContext(context: DictationRefinementContext): {
  userRefinementInstructionsChars: number;
  userDictionaryChars: number;
  dictionaryAliasHints: number;
  voiceInputHistoryChars: number;
  beforeChars: number;
  selectedChars: number;
  afterChars: number;
  replyToMessageChars: number;
  sourceLanguage?: string;
} {
  return {
    userRefinementInstructionsChars: context.userRefinementInstructions?.length ?? 0,
    userDictionaryChars: context.userDictionary?.length ?? 0,
    dictionaryAliasHints: context.dictionaryAliasHints?.length ?? 0,
    voiceInputHistoryChars: context.voiceInputHistory?.length ?? 0,
    beforeChars: context.selectionBefore?.length ?? 0,
    selectedChars: context.selectedText?.length ?? 0,
    afterChars: context.selectionAfter?.length ?? 0,
    replyToMessageChars: context.replyToMessage?.length ?? 0,
    sourceLanguage: context.sourceLanguage,
  };
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim();
}

function normalizeDictionaryAliasHints(
  hints: DictationRefinementContext['dictionaryAliasHints'],
): NonNullable<DictationRefinementContext['dictionaryAliasHints']> | undefined {
  if (!Array.isArray(hints)) return undefined;
  const normalized = hints
    .flatMap((hint) => {
      const term = truncateText(typeof hint?.term === 'string' ? hint.term : '', MAX_DICTIONARY_ALIAS_HINT_CHARS);
      if (!term) return [];
      const aliases = Array.isArray(hint.aliases)
        ? hint.aliases.flatMap((alias) => {
          const text = truncateText(
            typeof alias?.text === 'string' ? alias.text : '',
            MAX_DICTIONARY_ALIAS_HINT_CHARS,
          );
          if (!text) return [];
          return [{
            text,
            count: normalizePositiveInteger(alias.count),
          }];
        })
        : [];
      if (aliases.length === 0) return [];
      return [{
        term,
        frequency: normalizePositiveInteger(hint.frequency),
        aliases: aliases.slice(0, MAX_DICTIONARY_ALIAS_HINT_ALIASES),
      }];
    })
    .slice(0, MAX_DICTIONARY_ALIAS_HINTS);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePositiveInteger(value: unknown): number {
  return Math.max(1, Math.floor(typeof value === 'number' && Number.isFinite(value) ? value : 1));
}

function truncateMultilineText(text: string, maxChars: number): string {
  const normalized = normalizeMultilineText(text);
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars).trim();
}

function normalizeMultilineText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

function takeHead(text: string, maxChars: number): string {
  return truncateText(text, maxChars);
}

function takeTail(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(-maxChars).trim();
}

function readActiveVoiceInputModelSelection(reason: string): ReturnType<typeof getVoiceInputModelSelection> {
  const selection = getVoiceInputModelSelection();
  const signature = voiceInputModelSelectionSignature(selection);
  if (!lastModelSelectionSignature) {
    lastModelSelectionSignature = signature;
  } else if (signature !== lastModelSelectionSignature) {
    lastModelSelectionSignature = signature;
    resetVoiceInputModelSelectionCaches(reason, selection);
  }
  return selection;
}

function resolveVoiceInputProviderKind(): VoiceInputProviderKind {
  return readActiveVoiceInputModelSelection('resolve-asr-provider').asrProvider;
}

function resolveVoiceInputProviderModel(provider: VoiceInputProviderKind): string {
  return provider === 'custom-realtime-asr'
    ? (readActiveVoiceInputModelSelection('resolve-custom-asr-model').customAsr?.model
      ?? getVoiceInputAsrProfile(provider).model)
    : getVoiceInputAsrProfile(provider).model;
}

function voiceInputConnectionTestConfigurationKey(
  selection: VoiceInputModelSelection,
): string {
  return JSON.stringify({
    ownerIdentity: getActiveAppSession().dataOwnerId ?? 'local',
    serviceMode: selection.serviceMode,
    asrProvider: selection.asrProvider,
    asrProviderChain: selection.asrProviderChain,
    customAsr: selection.customAsr ?? null,
    customAsrCredentialRevision,
  });
}

// Configured ASR fallback chain (primary first), reordered so providers in
// sticky-failover cooldown sort behind healthy ones.
function resolveVoiceInputAsrChain(): VoiceInputProviderKind[] {
  const selection = readActiveVoiceInputModelSelection('resolve-asr-chain');
  // Managed Cindy voice keeps the product-owned provider failover chain.
  // BYOK must not infer that unrelated providers share credentials or routes:
  // unless the user explicitly configured a chain, dial only the selected
  // primary provider.
  const chain = voiceInputAsrChainForServiceMode({
    ...selection,
    serviceMode: isVoiceInputByokMode() ? 'byok' : 'cindy',
  });
  return orderVoiceInputProvidersByHealth('asr', chain);
}

function resolveVoiceInputRefinerProfile(): VoiceInputRefinerProfile {
  const selection = readActiveVoiceInputModelSelection('resolve-refiner-profile');
  const profile = getVoiceInputRefinerProfile(selection.refinerProvider);
  return selection.refinerModel ? { ...profile, model: selection.refinerModel } : profile;
}

// Configured refiner fallback chain as resolved profiles. Runtime routing
// applies credential-aware default ordering and cooldown separately. The custom
// refinerModel override only applies to the user-selected primary profile —
// backups keep their stock model.
function resolveVoiceInputRefinerChainProfiles(
  selection: VoiceInputModelSelection = readActiveVoiceInputModelSelection('resolve-refiner-chain'),
): VoiceInputRefinerProfile[] {
  return selection.refinerProviderChain.map((kind) => {
    const profile = getVoiceInputRefinerProfile(kind);
    return kind === selection.refinerProvider && selection.refinerModel
      ? { ...profile, model: selection.refinerModel }
      : profile;
  });
}

async function resolveVoiceInputRefinerChainForRuntime(
  useCindyVoiceService = false,
): Promise<VoiceInputRefinerChainRuntimeResolution> {
  const selection = readActiveVoiceInputModelSelection('resolve-refiner-chain-runtime');
  if (useCindyVoiceService) {
    // Managed mode delegates model choice and failover to voice-server, so
    // there is no client-side chain, no health ordering and no cooldown: a
    // single profile remains only as the local display/pricing label.
    const managedProfile = getVoiceInputRefinerProfile(DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND);
    const managedReadiness = await getVoiceInputRefinerReadiness(managedProfile, true);
    return {
      refinerChainProfiles: [managedProfile],
      refinerReadinessList: [managedReadiness],
      readyRefinerProfiles: managedReadiness.ok ? [managedProfile] : [],
    };
  }
  const configuredProfiles = resolveVoiceInputRefinerChainProfiles(selection);
  const configuredReadinessList = await Promise.all(
    configuredProfiles.map((profile) => getVoiceInputRefinerReadiness(profile, false)),
  );
  const profilesByProvider = new Map(
    configuredProfiles.map((profile) => [profile.id as VoiceInputRefinerProviderKind, profile]),
  );
  const readinessByProvider = new Map(
    configuredReadinessList.map((readiness) => [readiness.provider, readiness]),
  );
  const orderedProviders = orderVoiceInputRefinerChainForRuntime(selection, configuredReadinessList);
  const refinerChainProfiles: VoiceInputRefinerProfile[] = [];
  const refinerReadinessList: VoiceInputRefinerReadiness[] = [];
  for (const provider of orderedProviders) {
    const profile = profilesByProvider.get(provider);
    const readiness = readinessByProvider.get(provider);
    if (!profile || !readiness) continue;
    // 停用轴:BYOK 精修是直连的真实付费调用(CodexResponses / LiteLLM 客户端),
    // 与 utility 档位共享真实路由供应商 —— 被停用的档位从链中剔除,交给下一个
    // 候选(managed 模式在上方早返,由 voice-server 端裁决;PR #744 review 第十五轮)。
    if (isUtilityRouteDisabled(profile)) {
      log.info('refiner profile skipped: disabled in settings', {
        profileId: profile.id,
        model: profile.model,
      });
      continue;
    }
    // BYOK LiteLLM refinement calls XD directly, outside the Session rail.
    // Apply the same owner-scoped v5 paid entitlement used by utility one-shot
    // candidates before admitting the profile into the fallback chain.
    if (isUtilityRoutePaymentRequired(profile)) {
      log.info('refiner profile skipped: paid entitlement required', {
        profileId: profile.id,
        model: profile.model,
      });
      continue;
    }
    refinerChainProfiles.push(profile);
    refinerReadinessList.push(readiness);
  }
  return {
    refinerChainProfiles,
    refinerReadinessList,
    readyRefinerProfiles: refinerChainProfiles.filter((_, index) => refinerReadinessList[index].ok),
  };
}

function readEnvSecret(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function readElevenLabsApiKey(): string | null {
  return readEnvSecret('XDT_ELEVENLABS_API_KEY', 'ELEVENLABS_API_KEY');
}

function readElevenLabsBaseUrl(): string | undefined {
  return process.env.XDT_ELEVENLABS_BASE_URL?.trim() || process.env.ELEVENLABS_BASE_URL?.trim() || undefined;
}

function readLiteLlmProxyConfig(): { proxyApiKey: string | null; proxyBaseUrl: string } {
  return {
    // Local mode disables Cindy gateway capabilities, but BYOK voice still
    // needs the active owner's explicitly saved gateway key.
    proxyApiKey: readOwnerScopedXdGatewayKey(),
    // Voice input talks to XD LiteLLM endpoints directly, including WebSocket
    // passthrough routes. Do not reuse getClaudeEndpoint(): when Claude compat
    // mode is enabled it returns a local HTTP-only anthropic-compat proxy,
    // which cannot handle realtime ASR WebSockets.
    proxyBaseUrl: claudeUpstreamEndpoint().trim(),
  };
}

async function getVoiceInputRefinerReadiness(
  profile: VoiceInputRefinerProfile,
  useCindyVoiceService = false,
): Promise<VoiceInputRefinerReadiness> {
  if (useCindyVoiceService) {
    if (isCindyVoiceServiceReady()) {
      return {
        ok: true,
        provider: profile.id as VoiceInputRefinerProviderKind,
        model: profile.model,
        auth: profile.auth,
        settingsTab: profile.settingsTab,
      };
    }
    return {
      ok: false,
      provider: profile.id as VoiceInputRefinerProviderKind,
      model: profile.model,
      auth: profile.auth,
      settingsTab: profile.settingsTab,
      error: CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE,
    };
  }
  if (profile.auth === 'codex') {
    const codexAuthState = await desktopCodexAuthAdapter.getState();
    return {
      ok: codexAuthState.authenticated,
      provider: profile.id as VoiceInputRefinerProviderKind,
      model: profile.model,
      auth: 'codex',
      settingsTab: profile.settingsTab,
      error: codexAuthState.authenticated ? undefined : profile.missingCredentialMessage,
      authErrorReason: codexAuthState.authenticated ? undefined : codexAuthState.errorReason,
    };
  }

  const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
  const ok = Boolean(proxyApiKey && proxyBaseUrl);
  return {
    ok,
    provider: profile.id as VoiceInputRefinerProviderKind,
    model: profile.model,
    auth: 'api-key',
    settingsTab: profile.settingsTab,
    error: ok ? undefined : profile.missingCredentialMessage,
  };
}

/**
 * TextModelClient 的 live 可用性包装(BYOK):每次 requestJson(= 一次精修请求)
 * 前重查设置停用与 Cindy 账号付费权限；不可用即抛错，FallbackTextModelClient
 * 将其视为该档失败并自然落到下一档。
 */
function guardRefinerClientAgainstUnavailableRoute(
  profile: VoiceInputRefinerProfile,
  client: TextModelClient,
): TextModelClient {
  return {
    requestJson: (input) => {
      if (isUtilityRouteDisabled(profile)) {
        return Promise.reject(new Error('voice refiner route disabled in settings'));
      }
      // Refinement may start minutes after chain resolution. Re-read the live
      // owner-scoped catalog immediately before every direct XD request so a
      // newly denied paid model cannot be dispatched from a retained session.
      if (isUtilityRoutePaymentRequired(profile)) {
        return Promise.reject(new Error('voice refiner route requires paid entitlement'));
      }
      return client.requestJson(input);
    },
  };
}

function createVoiceInputTextModelClient(
  profile: VoiceInputRefinerProfile,
  options?: {
    onUsage?: (usage: {
      promptTokens?: number;
      completionTokens?: number;
      cachedTokens?: number;
      /** Upstream-reported model (managed failover may differ from the request). */
      servedModel?: string;
    }) => void;
    /** Idle watchdog per attempt; both clients re-arm it on every stream chunk. */
    timeoutMs?: number;
    voiceContext?: CindyVoiceRunContext;
  },
): TextModelClient {
  if (options?.voiceContext) {
    // Managed mode: voice-server owns model choice and failover, so the
    // target always carries the 'auto' marker regardless of the local
    // profile used for display/usage labeling.
    return new LiteLlmTextModelClient({
      requestTargetProvider: (targetOptions) => options.voiceContext!.createRefinerTarget(
        CINDY_MANAGED_REFINER_PROVIDER,
        targetOptions,
      ),
      onUsage: options.onUsage,
      timeoutMs: options.timeoutMs,
    });
  }
  if (profile.transport === 'codex-responses') {
    return new CodexResponsesTextModelClient({
      accessTokenProvider: () => desktopCodexAuthAdapter.getAccessToken(),
      accountIdProvider: () => desktopCodexAuthAdapter.getAccountId(),
      onUsage: options?.onUsage,
      timeoutMs: options?.timeoutMs,
      onAuthInvalidated: (reason) => {
        void desktopCodexAuthAdapter.invalidate(reason);
      },
    });
  }

  if (profile.transport === 'litellm-chat-completions') {
    const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
    if (!proxyApiKey || !proxyBaseUrl) throw new Error(profile.missingCredentialMessage);
    return new LiteLlmTextModelClient({
      proxyApiKey,
      baseUrl: proxyBaseUrl,
      onUsage: options?.onUsage,
      timeoutMs: options?.timeoutMs,
    });
  }

  throw new Error(`Unsupported voice input refiner transport ${profile.transport}`);
}

/**
 * Maps the model name reported by the gateway SSE stream back to a local
 * refiner provider id for usage/cost attribution. Kept local to the managed
 * voice path on purpose: the shared provider alias resolver also parses
 * user-facing configuration, where a bare model name must NOT silently pick a
 * credential plane. Profiles are matched by their model string, preferring
 * the LiteLLM flavor since managed refinement is served through the gateway.
 */
function resolveServedRefinerProviderForUsage(
  servedModel: string,
): VoiceInputRefinerProviderKind | null {
  const normalized = servedModel.trim().toLowerCase();
  if (!normalized) return null;
  const profiles = getVoiceInputRefinerProfiles();
  const match = profiles.find(
    (profile) => profile.transport === 'litellm-chat-completions' && profile.model.toLowerCase() === normalized,
  ) ?? profiles.find((profile) => profile.model.toLowerCase() === normalized);
  return match ? (match.id as VoiceInputRefinerProviderKind) : null;
}

/**
 * Managed-mode prompt cache warmup: sends a request sharing the exact prompt
 * prefix of the upcoming refinement (system prompt + context, empty
 * dictationText) to voice-server's warmup endpoint. Fire-and-forget — the
 * dictation flow must never wait on or fail because of warmup.
 */
function warmManagedRefinerPromptCache(
  voiceContext: CindyVoiceRunContext,
  refiner: DictationRefiner,
  cacheScope: string,
): void {
  try {
    const request = refiner.buildWarmupRequest();
    const promptCacheKey = makeRefinerPromptCacheKey({
      model: CINDY_MANAGED_REFINER_PROVIDER,
      schemaName: 'dictation_refinement',
      promptVersion: request.promptVersion,
      system: request.system,
      scope: cacheScope,
    });
    void voiceContext
      .warmRefiner({
        system: request.system,
        user: { schemaName: 'dictation_refinement', input: request.user },
        promptCacheKey,
      })
      .then(() => {
        log.debug('managed refiner prompt cache warmed', { promptCacheKey });
      })
      .catch((error) => {
        log.debug('managed refiner warmup failed (non-fatal)', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  } catch (error) {
    log.debug('managed refiner warmup skipped', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// In managed mode voice-server refinement sessions are created lazily
// together with ASR (metered on actual use), so prewarming must not open a
// direct user-credential transport. In explicit BYOK mode we warm every
// transport in the refiner chain, not just the head: the fallback attempt
// runs inside the same per-attempt idle watchdog as the primary, so a cold
// TLS handshake on the rescue path eats directly into its budget (see
// collectRefinerPrewarmTransports).
async function prewarmVoiceInputRefiner(profiles: readonly VoiceInputRefinerProfile[]): Promise<void> {
  if (!isVoiceInputByokMode()) return;
  const warmups: Array<Promise<void>> = [];
  for (const transport of collectRefinerPrewarmTransports(profiles)) {
    if (transport === 'codex-responses') {
      warmups.push(prewarmCodexResponsesEndpoint());
    } else if (transport === 'litellm-chat-completions') {
      const { proxyBaseUrl } = readLiteLlmProxyConfig();
      if (proxyBaseUrl) warmups.push(prewarmLiteLlmRefinerEndpoint(proxyBaseUrl));
    }
  }
  await Promise.all(warmups);
}

function buildRealtimeAsrProviderOptions(
  profile: VoiceInputAsrProfile,
  sourceLanguage: string | undefined,
  accessTokenProvider: () => Promise<string | null>,
  proxyBaseUrl?: string,
  connectionProvider?: () => Promise<{ websocketUrl: string; authorizationToken: string }>,
): RealtimeAsrWebSocketProviderOptions {
  if (profile.mode !== 'realtime-websocket' || !profile.realtime) {
    throw new Error(`Voice input provider ${profile.id} is not a realtime ASR provider.`);
  }
  const options: RealtimeAsrWebSocketProviderOptions = {
    accessTokenProvider,
    model: profile.model,
    sourceLanguage,
    pcmSampleRate: profile.realtime.pcmSampleRate,
    protocolProfile: profile.realtime.protocolProfile,
    providerKind: profile.id,
    missingCredentialMessage: profile.missingCredentialMessage,
    errorFallbackMessage: profile.errorFallbackMessage,
    connectionProvider,
  };
  if (profile.realtime.endpointPath && !connectionProvider) {
    if (!proxyBaseUrl) throw new Error(`Proxy base URL is required for voice input provider ${profile.id}.`);
    options.realtimeUrl = buildLiteLlmRealtimeWebSocketUrl(proxyBaseUrl, profile.realtime.endpointPath);
    options.extraHeaders = liteLlmRealtimeHeaders(profile);
  }
  return options;
}

function buildCustomRealtimeAsrProviderOptions(
  config: VoiceInputCustomAsrConfig,
  sourceLanguage: string | undefined,
): RealtimeAsrWebSocketProviderOptions {
  const profile = getVoiceInputAsrProfile('custom-realtime-asr');
  const openAiProtocol = config.protocol === 'openai-realtime';
  const apiKey = getProviderSecretStore().get('voice-asr');
  const ownerIdentity = getActiveAppSession().dataOwnerId ?? 'local';
  return {
    accessTokenProvider: () => Promise.resolve(apiKey),
    credentialCacheKey: apiKey
      ? `custom-asr-${ownerIdentity}-${customAsrCredentialRevision}`
      : '',
    model: config.model,
    realtimeUrl: resolveVoiceInputCustomAsrWebsocketUrl(config),
    sourceLanguage,
    pcmSampleRate: openAiProtocol ? 24_000 : 16_000,
    protocolProfile: openAiProtocol ? 'openai-transcription-manual' : 'qwen-asr-server-vad',
    providerKind: 'custom-realtime-asr',
    missingCredentialMessage: profile.missingCredentialMessage,
    errorFallbackMessage: profile.errorFallbackMessage,
    redactUpstreamErrors: true,
  };
}

/**
 * Best-effort warm-up for the configured voice-input provider.
 *
 * This is invoked from idempotent triggers (renderer mount, global shortcut
 * fire) so the slow disk/auth bits are amortized off the user-perceived
 * critical path. For realtime ASR providers this opens an idle,
 * language-aware transcription WebSocket in advance. The socket carries no
 * audio until a real voice-input run takes ownership, so the user's first
 * audio frame no longer waits behind credential lookup + TLS + session.update.
 *
 * Errors are swallowed: prewarm should never fail user flows.
 */
let inFlightPrewarm: Promise<void> | null = null;
let inFlightPrewarmKey = '';
let lastPrewarmAt = 0;
let lastPrewarmKey = '';
const PREWARM_THROTTLE_MS = 5_000;
const disableRealtimePreconnect = process.env.XDT_VOICE_INPUT_DISABLE_PRECONNECT === '1';

export async function prewarmVoiceInputProvider(options?: { sourceLanguage?: string; refinementEnabled?: boolean }): Promise<void> {
  const now = Date.now();
  // Resolve the effective chain head so refiner prewarm/cache keys follow the
  // same cooldown-aware route as the next dictation session.
  const provider = resolveVoiceInputAsrChain()[0] ?? resolveVoiceInputProviderKind();
  const profile = getVoiceInputAsrProfile(provider);
  const byokMode = isVoiceInputByokMode();
  if (!byokMode && !isManagedVoiceAsrProfile(profile)) {
    // In managed mode direct/user-key ASR profiles are not part of the voice
    // path and must not be prewarmed as if they were an eligible fallback.
    return;
  }
  const sourceLanguage = options?.sourceLanguage;
  const refinementEnabled = options?.refinementEnabled !== false;
  let refinerProfile = resolveVoiceInputRefinerProfile();
  // Warm every refiner transport in the chain, not just the head profile: the
  // rescue attempt after a head failure must not pay a cold TLS handshake
  // inside its idle watchdog. The head profile still drives the key below.
  let refinerPrewarmProfiles: readonly VoiceInputRefinerProfile[] = [refinerProfile];
  if (refinementEnabled) {
    try {
      const resolution = await resolveVoiceInputRefinerChainForRuntime(!byokMode);
      refinerProfile = resolution.readyRefinerProfiles[0]
        ?? resolution.refinerChainProfiles[0]
        ?? refinerProfile;
      if (resolution.refinerChainProfiles.length > 0) {
        refinerPrewarmProfiles = resolution.refinerChainProfiles;
      }
    } catch (error) {
      log.debug('refiner prewarm routing failed (non-fatal)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const asrLanguageHint = resolveAsrLanguageHint(sourceLanguage);
  const providerLanguageKey = `${provider}:${asrLanguageHint ?? 'auto'}`;
  const prewarmKey = `${providerLanguageKey}:refine-${refinementEnabled ? `${refinerProfile.id}:${refinerProfile.model}` : 'off'}`;
  const hasExplicitLanguage = sourceLanguage !== undefined;
  const providerPrefix = `${provider}:`;
  const lastProviderLanguageKey = lastPrewarmKey.split(':refine-')[0] ?? '';
  if (inFlightPrewarm && inFlightPrewarmKey === prewarmKey) return inFlightPrewarm;
  if (
    isRealtimeAsrProvider(provider) &&
    !hasExplicitLanguage &&
    lastProviderLanguageKey.startsWith(providerPrefix) &&
    lastProviderLanguageKey !== providerLanguageKey
  ) {
    return profile.auth === 'codex'
      ? desktopCodexAuthAdapter.getAccessToken().then(() => undefined)
      : Promise.resolve();
  }
  if (prewarmKey === lastPrewarmKey && now - lastPrewarmAt < PREWARM_THROTTLE_MS) return Promise.resolve();
  lastPrewarmAt = now;
  lastPrewarmKey = prewarmKey;

  const currentPrewarm = (async () => {
    try {
      // Refiner endpoint warmup runs in parallel with provider warmup when
      // refinement is enabled. If the user disables refinement, avoid touching
      // the LLM endpoint during prewarm; ASR warmup still proceeds normally.
      const refinerPrewarm = refinementEnabled
        ? prewarmVoiceInputRefiner(refinerPrewarmProfiles)
        : Promise.resolve();
      // In managed mode ASR sessions are ticketed by voice-server at actual
      // start; do not open a direct websocket during prewarm because that
      // would require a user credential and could accidentally become a
      // hidden fallback. In explicit BYOK mode restore the pre-managed
      // preconnect so the first audio frame does not wait behind TLS +
      // session.update.
      if (byokMode && profile.mode === 'realtime-websocket' && profile.realtime?.prewarmable && !disableRealtimePreconnect) {
        if (provider === 'custom-realtime-asr') {
          const customAsr = readActiveVoiceInputModelSelection('custom-asr-prewarm').customAsr;
          const customAsrKey = getProviderSecretStore().get('voice-asr');
          if (customAsr && customAsrKey) {
            await prewarmRealtimeAsrWebSocketSession(buildCustomRealtimeAsrProviderOptions(
              customAsr,
              asrLanguageHint,
            ));
          }
        } else if (profile.auth === 'codex') {
          const token = await desktopCodexAuthAdapter.getAccessToken();
          if (token) {
            await prewarmRealtimeAsrWebSocketSession(buildRealtimeAsrProviderOptions(
              profile,
              asrLanguageHint,
              () => Promise.resolve(token),
            ));
          }
        } else if (profile.realtime.endpointPath) {
          const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
          if (proxyApiKey && proxyBaseUrl) {
            await prewarmRealtimeAsrWebSocketSession(buildRealtimeAsrProviderOptions(
              profile,
              asrLanguageHint,
              () => Promise.resolve(proxyApiKey),
              proxyBaseUrl,
            ));
          }
        }
      }
      // BYOK notes: LiteLLM batch / ElevenLabs direct read env-var keys
      // synchronously — nothing to warm at their provider layer. Volcengine
      // SAUC must not keep a warm idle session (the gateway reaps sessions
      // that sent the initial request and then idle), so it relies on the
      // keydown-time parallel start path instead.
      await refinerPrewarm;
    } catch (error) {
      log.debug('prewarm failed (non-fatal)', {
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })().finally(() => {
    if (inFlightPrewarm === currentPrewarm) {
      inFlightPrewarm = null;
      inFlightPrewarmKey = '';
    }
  });
  inFlightPrewarm = currentPrewarm;
  inFlightPrewarmKey = prewarmKey;
  return inFlightPrewarm;
}

type AsrCredentialReadiness = {
  ok: boolean;
  error?: string;
  authErrorReason?: string;
  failureReason?: VoiceInputReadiness['failureReason'];
};

async function getAsrProfileCredentialReadiness(profile: VoiceInputAsrProfile): Promise<AsrCredentialReadiness> {
  if (!isVoiceInputByokMode()) {
    if (isManagedVoiceAsrProfile(profile)) {
      if (isCindyVoiceServiceReady()) return { ok: true };
      return { ok: false, error: CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE };
    }
    // In managed mode direct Codex / ElevenLabs / batch profiles are never
    // considered for inline voice input. Their credentials belong to the user
    // and must not be spent as an automatic fallback.
    return { ok: false, error: CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE };
  }

  // Explicit BYOK mode: the user opted into spending their own credentials.
  // Mirror the pre-managed-migration readiness checks per auth kind. The
  // managed voice service is deliberately not consulted here — no cross-mode
  // fallback in either direction.
  if (profile.id === 'custom-realtime-asr') {
    const customAsr = readActiveVoiceInputModelSelection('custom-asr-readiness').customAsr;
    if (!customAsr) {
      return {
        ok: false,
        error: profile.missingCredentialMessage,
        failureReason: 'custom-asr-config-missing',
      };
    }
    const hasCustomAsrKey = getProviderSecretStore().has('voice-asr');
    return {
      ok: hasCustomAsrKey,
      error: hasCustomAsrKey ? undefined : profile.missingCredentialMessage,
      failureReason: hasCustomAsrKey ? undefined : 'custom-asr-key-missing',
    };
  }
  if (profile.id === 'openai-realtime-whisper') {
    return {
      ok: false,
      error: 'Codex sign-in cannot be used as an OpenAI API Realtime credential.',
      failureReason: 'codex-realtime-unsupported',
    };
  }

  if (profile.auth === 'codex') {
    const codexAuthState = await desktopCodexAuthAdapter.getState();
    return {
      ok: codexAuthState.authenticated,
      error: codexAuthState.authenticated ? undefined : profile.missingCredentialMessage,
      authErrorReason: codexAuthState.authenticated ? undefined : codexAuthState.errorReason,
    };
  }

  if (profile.mode === 'elevenlabs-realtime') {
    const hasDirectElevenLabs = Boolean(readElevenLabsApiKey());
    return {
      ok: hasDirectElevenLabs,
      error: hasDirectElevenLabs ? undefined : profile.missingCredentialMessage,
    };
  }

  const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
  const hasProxy = Boolean(proxyApiKey && proxyBaseUrl);
  return {
    ok: hasProxy,
    error: hasProxy ? undefined : profile.missingCredentialMessage,
  };
}

function toVoiceInputReadiness(
  provider: VoiceInputProviderKind,
  profile: VoiceInputAsrProfile,
  credential: AsrCredentialReadiness,
  serviceMode: VoiceInputServiceMode,
): VoiceInputReadiness {
  return {
    ok: credential.ok,
    serviceMode,
    provider,
    providerModel: resolveVoiceInputProviderModel(provider),
    auth: profile.auth,
    settingsTab: profile.settingsTab,
    error: credential.error,
    authErrorReason: credential.authErrorReason,
    failureReason: credential.failureReason,
  };
}

// Chain-aware readiness: the reported provider is the first chain entry whose
// credentials are ready (cooldown-aware order), which is also the provider a
// new dictation will try first. When nothing on the chain is ready, report
// the user-selected primary's failure so settings deep-links stay accurate.
async function getVoiceInputReadiness(): Promise<VoiceInputReadiness> {
  const serviceMode: VoiceInputServiceMode = isVoiceInputByokMode() ? 'byok' : 'cindy';
  for (const kind of resolveVoiceInputAsrChain()) {
    const profile = getVoiceInputAsrProfile(kind);
    const credential = await getAsrProfileCredentialReadiness(profile);
    if (credential.ok) return toVoiceInputReadiness(kind, profile, credential, serviceMode);
  }
  const primary = resolveVoiceInputProviderKind();
  const primaryProfile = getVoiceInputAsrProfile(primary);
  return toVoiceInputReadiness(
    primary,
    primaryProfile,
    await getAsrProfileCredentialReadiness(primaryProfile),
    serviceMode,
  );
}

// The startable chain for one dictation session: credential-ready candidates
// in cooldown-aware priority order. FallbackAsrProvider walks this list at
// connect time.
/**
 * ASR 档位 → 真实路由供应商:litellm-* 走 XD 网关,openai-* / codex 凭证走 OpenAI;
 * ElevenLabs / 自定义端点不在供应商目录,不受停用轴约束(独立凭证独立计费)。
 */
function asrProfileRouteProviderId(profile: VoiceInputAsrProfile): string | null {
  if (profile.id.startsWith('litellm-')) return 'xd';
  if (profile.auth === 'codex' || profile.id.startsWith('openai-')) return 'openai';
  return null;
}

/**
 * ASR 档位在停用轴下是否不可发:按 (真实路由供应商, 档位模型) 双查 —— 供应商级
 * 停用或该音频模型条目被点名停用(如 XD 启用但停了 elevenlabs/scribe_v2)任一命中
 * 即真(PR #744 review 第二十五轮)。不在供应商目录的档位(ElevenLabs 直连 /
 * 自定义端点,routeProviderId=null)不受约束。
 */
function isAsrProfileRouteDisabled(profile: VoiceInputAsrProfile): boolean {
  const routeProviderId = asrProfileRouteProviderId(profile);
  return !!routeProviderId && isProviderModelRouteDisabled(routeProviderId, profile.model);
}

async function resolveStartableAsrChain(): Promise<VoiceInputProviderKind[]> {
  const byokMode = isVoiceInputByokMode();
  const startable: VoiceInputProviderKind[] = [];
  for (const kind of resolveVoiceInputAsrChain()) {
    const profile = getVoiceInputAsrProfile(kind);
    // Managed mode only dials voice-server-eligible profiles; explicit BYOK
    // mode may start any credential-ready profile from the configured chain.
    if (!byokMode && !isManagedVoiceAsrProfile(profile)) continue;
    // 停用轴(BYOK,PR #744 review 第十六/二十五轮):转写与精修同为独立付费路由 ——
    // 供应商级停用或该音频模型被点名停用的 ASR 档位不再进入可启动链。managed 模式
    // 路由与计费都在 voice-server,不查本机供应商停用。
    if (byokMode && isAsrProfileRouteDisabled(profile)) continue;
    const credential = await getAsrProfileCredentialReadiness(profile);
    if (credential.ok) startable.push(kind);
  }
  return startable;
}

function readMicrophonePermissionSnapshot(): VoiceInputMicrophonePermissionCache {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ok: true, status: 'granted' };
  }
  const status = systemPreferences.getMediaAccessStatus('microphone');
  if (rendererVerifiedMicrophonePermission && isExplicitMicrophonePermissionDenied(status)) {
    rendererVerifiedMicrophonePermission = false;
  }
  return resolveMicrophonePermissionSnapshot(
    status,
    rendererVerifiedMicrophonePermission,
    process.platform,
  );
}

function refreshMicrophonePermissionCache(): VoiceInputMicrophonePermissionCache {
  cachedMicrophonePermission = readMicrophonePermissionSnapshot();
  return cachedMicrophonePermission;
}

function getCachedMicrophonePermission(): VoiceInputMicrophonePermissionCache {
  return cachedMicrophonePermission ?? refreshMicrophonePermissionCache();
}

function getVoiceInputSystemPermissions(): VoiceInputSystemPermissions {
  return {
    microphone: getCachedMicrophonePermission(),
    inputMonitoring: getVoiceInputInputMonitoringPermissionCachedSnapshot(),
    accessibility: getVoiceInputAccessibilityPermissionSnapshot(),
  };
}

async function refreshVoiceInputSystemPermissions(): Promise<VoiceInputSystemPermissions> {
  refreshMicrophonePermissionCache();
  const inputMonitoring = await refreshVoiceInputInputMonitoringPermissionSnapshot();
  return {
    microphone: getCachedMicrophonePermission(),
    inputMonitoring,
    accessibility: getVoiceInputAccessibilityPermissionSnapshot(),
  };
}

async function refreshVoiceInputReadinessCache(reason: string): Promise<VoiceInputReadiness> {
  readActiveVoiceInputModelSelection(`readiness:${reason}`);
  if (readinessRefreshPromise) return readinessRefreshPromise;
  const generation = modelSelectionGeneration;
  readinessRefreshPromise = getVoiceInputReadiness()
    .then((readiness) => {
      if (generation === modelSelectionGeneration) {
        cachedVoiceInputReadiness = readiness;
      }
      log.debug('voice input readiness cache refreshed', {
        reason,
        ok: readiness.ok,
        provider: readiness.provider,
        auth: readiness.auth,
      });
      return readiness;
    })
    .finally(() => {
      readinessRefreshPromise = null;
    });
  return readinessRefreshPromise;
}

function resetVoiceInputModelSelectionCaches(
  reason: string,
  selection: ReturnType<typeof getVoiceInputModelSelection>,
): void {
  modelSelectionGeneration += 1;
  cachedVoiceInputReadiness = null;
  readinessRefreshPromise = null;
  inFlightPrewarm = null;
  inFlightPrewarmKey = '';
  lastPrewarmKey = '';
  lastPrewarmAt = 0;
  log.info('voice input model selection changed', {
    reason,
    path: selection.configPath,
    asrProvider: selection.asrProvider,
    refinerProvider: selection.refinerProvider,
    refinerModel: selection.refinerModel,
  });
}

function markVoiceInputModelSelectionApplied(
  reason: string,
  selection: VoiceInputModelSelection,
): void {
  lastModelSelectionSignature = voiceInputModelSelectionSignature(selection);
  resetVoiceInputModelSelectionCaches(reason, selection);
}

function voiceInputModelSelectionPatchFromIpc(payload: unknown): VoiceInputModelSelectionPatch {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throwIpcError('INVALID_PARAMS', 'model selection patch must be an object');
  }
  const source = payload as Record<string, unknown>;
  const patch: VoiceInputModelSelectionPatch = {};
  if (Object.prototype.hasOwnProperty.call(source, 'serviceMode')) {
    patch.serviceMode = resolveServiceModeFromIpc(source.serviceMode);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'asrProvider')) {
    patch.asrProvider = resolveAsrProviderFromIpc(source.asrProvider);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'customAsr')) {
    if (source.customAsr === null || source.customAsr === undefined) {
      patch.customAsr = null;
    } else {
      const validated = validateVoiceInputCustomAsrConfig(source.customAsr);
      if (!validated.ok) throwIpcError('INVALID_PARAMS', validated.error);
      patch.customAsr = validated.value;
    }
  }
  if (Object.prototype.hasOwnProperty.call(source, 'refinerProvider')) {
    patch.refinerProvider = resolveRefinerProviderFromIpc(source.refinerProvider);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'refinerModel')) {
    patch.refinerModel = normalizeRefinerModelFromIpc(source.refinerModel);
  }
  if (Object.prototype.hasOwnProperty.call(source, 'refinerProviderChain')) {
    patch.refinerProviderChain = resolveRefinerProviderChainFromIpc(source.refinerProviderChain);
  }
  return patch;
}

function customAsrSecretUpdateFromIpc(payload: unknown): CustomAsrSecretUpdate {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { action: 'none' };
  const source = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(source, 'customAsrApiKey')) return { action: 'none' };
  if (source.customAsrApiKey === null) return { action: 'clear' };
  if (typeof source.customAsrApiKey !== 'string') {
    throwIpcError('INVALID_PARAMS', 'customAsrApiKey must be a string or null');
  }
  const value = source.customAsrApiKey.trim();
  if (!value || value.length > MAX_CUSTOM_ASR_API_KEY_CHARS) {
    throwIpcError('INVALID_PARAMS', 'customAsrApiKey must contain 1 to 8192 characters');
  }
  return { action: 'set', value };
}

function assertCustomAsrCredentialScope(
  currentSelection: VoiceInputModelSelection,
  patch: VoiceInputModelSelectionPatch,
  secretUpdate: CustomAsrSecretUpdate,
): void {
  if (!Object.prototype.hasOwnProperty.call(patch, 'customAsr')) return;
  if (!patch.customAsr || secretUpdate.action !== 'none') return;
  if (!getProviderSecretStore().has('voice-asr')) return;

  if (!canReuseVoiceInputCustomAsrCredential(
    currentSelection.customAsr?.websocketUrl,
    patch.customAsr.websocketUrl,
  )) {
    throwIpcError(
      'INVALID_PARAMS',
      'customAsrApiKey must be set or cleared when the custom ASR endpoint origin changes',
    );
  }
}

function resolveRefinerProviderChainFromIpc(value: unknown): VoiceInputRefinerProviderKind[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throwIpcError('INVALID_PARAMS', 'refinerProviderChain must be an array of provider ids');
  }
  const resolved: VoiceInputRefinerProviderKind[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throwIpcError('INVALID_PARAMS', 'refinerProviderChain entries must be strings');
    }
    const normalized = entry.trim();
    if (!normalized) continue;
    const kind = resolveVoiceInputRefinerProviderKindAlias(normalized);
    if (!kind) throwIpcError('INVALID_PARAMS', `unknown voice input refiner provider: ${normalized}`);
    if (!resolved.includes(kind)) resolved.push(kind);
  }
  return resolved.length > 0 ? resolved : null;
}

function resolveServiceModeFromIpc(value: unknown): VoiceInputServiceMode | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'serviceMode must be a string');
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === 'cindy' || normalized === 'byok') return normalized;
  throwIpcError('INVALID_PARAMS', `unknown voice input service mode: ${normalized}`);
}

function resolveAsrProviderFromIpc(value: unknown): VoiceInputProviderKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'asrProvider must be a string');
  const normalized = value.trim();
  if (!normalized) return null;
  const resolved = resolveVoiceInputProviderKindAlias(normalized);
  if (!resolved) throwIpcError('INVALID_PARAMS', `unknown voice input ASR provider: ${normalized}`);
  return resolved;
}

function resolveRefinerProviderFromIpc(value: unknown): VoiceInputRefinerProviderKind | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'refinerProvider must be a string');
  const normalized = value.trim();
  if (!normalized) return null;
  const resolved = resolveVoiceInputRefinerProviderKindAlias(normalized);
  if (!resolved) throwIpcError('INVALID_PARAMS', `unknown voice input refiner provider: ${normalized}`);
  return resolved;
}

function normalizeRefinerModelFromIpc(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throwIpcError('INVALID_PARAMS', 'refinerModel must be a string');
  const normalized = value.trim();
  return normalized ? normalized : null;
}

async function buildVoiceInputModelSelectionIpcResult(
  reason: string,
): Promise<VoiceInputModelSelectionIpcResult> {
  const configuredSelection = readActiveVoiceInputModelSelection(`model-selection:${reason}`);
  const effectiveServiceMode = effectiveVoiceInputServiceMode(
    configuredSelection.serviceMode,
    getAppCapabilities().canUseCindyAccountServices,
  );
  const selection = effectiveServiceMode === configuredSelection.serviceMode
    ? configuredSelection
    : { ...configuredSelection, serviceMode: effectiveServiceMode };
  const readiness = await refreshVoiceInputReadinessCache(`model-selection:${reason}`);
  return {
    selection,
    asrProfiles: getVoiceInputAsrProfiles().map((profile) => ({
      id: profile.id as VoiceInputProviderKind,
      model: profile.model,
      mode: profile.mode,
      auth: profile.auth,
    })),
    refinerProfiles: getVoiceInputRefinerProfiles().map((profile) => ({
      id: profile.id as VoiceInputRefinerProviderKind,
      model: profile.model,
      transport: profile.transport,
      auth: profile.auth,
    })),
    readiness,
    customAsrApiKeyConfigured: getProviderSecretStore().has('voice-asr'),
  };
}

async function createVoiceInputProvider(
  provider: VoiceInputProviderKind,
  sourceLanguage: string | undefined,
  voiceContext?: CindyVoiceRunContext,
): Promise<AsrProvider> {
  const profile = getVoiceInputAsrProfile(provider);
  if (voiceContext && !isManagedVoiceAsrProfile(profile)) {
    throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
  }
  if (provider === 'custom-realtime-asr') {
    if (!isVoiceInputByokMode()) {
      throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
    }
    const customAsr = readActiveVoiceInputModelSelection('custom-asr-create').customAsr;
    if (!customAsr) throw new Error(profile.missingCredentialMessage);
    if (!getProviderSecretStore().has('voice-asr')) throw new Error(profile.missingCredentialMessage);
    return new RealtimeAsrWebSocketProvider(buildCustomRealtimeAsrProviderOptions(
      customAsr,
      sourceLanguage,
    ));
  }
  if (profile.mode === 'realtime-websocket') {
    const realtimeConfig = profile.realtime;
    if (!realtimeConfig) throw new Error(`Voice input provider ${provider} is missing realtime config.`);
    if (profile.auth === 'codex') {
      return new RealtimeAsrWebSocketProvider(buildRealtimeAsrProviderOptions(
        profile,
        sourceLanguage,
        () => desktopCodexAuthAdapter.getAccessToken(),
      ));
    }
    if (realtimeConfig.endpointPath) {
      if (voiceContext) {
        return new RealtimeAsrWebSocketProvider(buildRealtimeAsrProviderOptions(
          profile,
          sourceLanguage,
          () => Promise.resolve(null),
          undefined,
          () => voiceContext.createAsrConnection(provider),
        ));
      }
      if (!isVoiceInputByokMode()) {
        throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
      }
      const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
      if (!proxyApiKey || !proxyBaseUrl) throw new Error(profile.missingCredentialMessage);
      return new RealtimeAsrWebSocketProvider(buildRealtimeAsrProviderOptions(
        profile,
        sourceLanguage,
        () => Promise.resolve(proxyApiKey),
        proxyBaseUrl,
      ));
    }
    throw new Error(`Unsupported realtime ASR provider ${provider}.`);
  }

  if (profile.mode === 'provider-native-websocket') {
    const nativeConfig = profile.nativeWebSocket;
    if (!nativeConfig) throw new Error(`Voice input provider ${provider} is missing native WebSocket config.`);
    if (nativeConfig.protocolProfile === 'volcengine-sauc-duration') {
      if (voiceContext) {
        return new VolcengineSaucAsrProvider({
          connectionProvider: () => voiceContext.createAsrConnection(provider),
          resourceId: nativeConfig.resourceId,
          pcmSampleRate: nativeConfig.pcmSampleRate,
          sourceLanguage,
          missingCredentialMessage: profile.missingCredentialMessage,
          errorFallbackMessage: profile.errorFallbackMessage,
        });
      }
      if (!isVoiceInputByokMode()) {
        throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
      }
      const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
      if (!proxyApiKey || !proxyBaseUrl) throw new Error(profile.missingCredentialMessage);
      return new VolcengineSaucAsrProvider({
        proxyApiKey,
        baseUrl: proxyBaseUrl,
        endpointPath: nativeConfig.endpointPath,
        resourceId: nativeConfig.resourceId,
        pcmSampleRate: nativeConfig.pcmSampleRate,
        sourceLanguage,
        missingCredentialMessage: profile.missingCredentialMessage,
        errorFallbackMessage: profile.errorFallbackMessage,
      });
    }
    throw new Error(`Unsupported native ASR protocol ${nativeConfig.protocolProfile}.`);
  }

  if (profile.mode === 'batch-http') {
    if (!isVoiceInputByokMode()) {
      throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
    }
    const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
    if (!proxyApiKey || !proxyBaseUrl) throw new Error(profile.missingCredentialMessage);
    return new LiteLlmTranscriptionProvider({
      proxyApiKey,
      baseUrl: proxyBaseUrl,
      model: profile.model,
      sourceLanguage,
    });
  }

  if (profile.mode === 'elevenlabs-realtime') {
    if (!isVoiceInputByokMode()) {
      throw new Error(CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE);
    }
    const directApiKey = readElevenLabsApiKey();
    if (!directApiKey) throw new Error(profile.missingCredentialMessage);
    return new ElevenLabsScribeProvider({
      apiKey: directApiKey,
      baseUrl: readElevenLabsBaseUrl(),
      sourceLanguage,
    });
  }

  throw new Error(`Unsupported voice input ASR provider ${provider}.`);
}

/**
 * Batch transcription entrypoint for remote/mobile dictation.
 *
 * Inline desktop voice input streams PCM into the selected realtime provider. A
 * mobile phone records a finished file, so it must use the batch HTTP ASR
 * profile even when the desktop inline path is configured for realtime.
 */
export async function transcribeVoiceInputAudioFile(
  input: VoiceInputAudioFileTranscriptionInput,
): Promise<VoiceInputAudioFileTranscriptionResult> {
  const provider: VoiceInputProviderKind = 'litellm-batch';
  const profile = getVoiceInputAsrProfile(provider);
  // 停用轴(PR #744 review 第二十二/二十五轮):device-link 批量转写与内联 ASR 链
  // 同为经 XD 网关凭证的新付费调用 —— 本路径恒用 litellm proxy key 直连计费,不经
  // voice-server,提交前按 (来源, 模型) 双查,供应商级或该音频模型被点名停用即拒绝。
  if (isAsrProfileRouteDisabled(profile)) {
    throw new Error('voice transcription route disabled in settings');
  }
  const { proxyApiKey, proxyBaseUrl } = readLiteLlmProxyConfig();
  if (!proxyApiKey || !proxyBaseUrl) throw new Error(profile.missingCredentialMessage);
  const text = await transcribeLiteLlmAudioFile({
    proxyApiKey,
    baseUrl: proxyBaseUrl,
    model: profile.model,
    sourceLanguage: input.sourceLanguage,
    bytes: input.bytes,
    mimeType: input.mimeType,
    fileName: input.fileName,
  });
  return {
    text,
    provider,
    model: profile.model,
  };
}

/**
 * Register voice-input IPC channels.
 *
 * Renderer owns microphone capture; main owns credentials, provider sessions,
 * state transitions, and timeline logging.
 */
export function registerVoiceInputIpc(): void {
  registerVoiceInputDataStoreIpc();
  if (!appRestoreRegistered) {
    appRestoreRegistered = true;
    app.once('before-quit', () => {
      void systemAudioMuteGuard.restoreAll();
    });
  }
  const modelSelection = readActiveVoiceInputModelSelection('register');
  log.info('voice input model selection active', {
    path: getVoiceInputModelSelectionConfigPath(),
    asrProvider: modelSelection.asrProvider,
    refinerProvider: modelSelection.refinerProvider,
    refinerModel: modelSelection.refinerModel,
  });
  refreshMicrophonePermissionCache();
  void refreshVoiceInputInputMonitoringPermissionSnapshot().catch((error) => {
    log.debug('input monitoring permission warmup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  void refreshVoiceInputReadinessCache('register');

  ipcMain.handle(
    'voice-input:prewarm',
    async (_event, payload?: { sourceLanguage?: string; refinementEnabled?: boolean }): Promise<{ ok: true }> => {
      void refreshVoiceInputReadinessCache('prewarm');
      void prewarmVoiceInputProvider(payload);
      return { ok: true };
    },
  );

  ipcMain.on('voice-input:get-microphone-permission-cached', (event) => {
    event.returnValue = getCachedMicrophonePermission();
  });

  ipcMain.handle('voice-input:set-renderer-microphone-permission-verified', async (_event, verified: boolean) => {
    rendererVerifiedMicrophonePermission = verified;
    refreshMicrophonePermissionCache();
    return { ok: true };
  });

  ipcMain.on('voice-input:get-system-permissions-cached', (event) => {
    event.returnValue = getVoiceInputSystemPermissions();
  });

  ipcMain.on('voice-input:get-readiness-cached', (event) => {
    event.returnValue = cachedVoiceInputReadiness;
  });

  ipcMain.handle('voice-input:benchmark-fixture-audio', async (): Promise<BenchmarkFixtureAudioResult> => {
    try {
      return await readBenchmarkFixtureAudio();
    } catch (error) {
      log.warn('benchmark fixture audio read failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false };
    }
  });

  ipcMain.handle('voice-input:request-microphone-permission', async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const cached = refreshMicrophonePermissionCache();
    if (cached.ok) return { ok: true };
    if (process.platform !== 'darwin') return { ok: false, error: cached.error };
    const granted = await systemPreferences.askForMediaAccess('microphone');
    const next = refreshMicrophonePermissionCache();
    if (granted && next.ok) return { ok: true };
    return { ok: false, error: next.ok ? 'Microphone permission is required for voice input.' : next.error };
  });

  ipcMain.handle('voice-input:get-system-permissions', async (): Promise<VoiceInputSystemPermissions> => {
    return refreshVoiceInputSystemPermissions();
  });

  ipcMain.handle('voice-input:open-microphone-settings', async (): Promise<VoiceInputActionResult> => {
    const settingsUrl = getMicrophoneSettingsUrl(process.platform);
    if (!settingsUrl) {
      return { ok: false, error: 'Microphone settings are only available on macOS and Windows.' };
    }
    try {
      await shell.openExternal(settingsUrl);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('voice-input:get-readiness', async (event): Promise<VoiceInputReadiness> => {
    assertTrustedAppRendererEvent(event);
    return refreshVoiceInputReadinessCache('ipc');
  });

  ipcMain.handle(
    VOICE_INPUT_TEST_CONNECTION_CHANNEL,
    async (event): Promise<VoiceInputConnectionTestResult> => {
      assertTrustedAppRendererEvent(event);
      const selection = readActiveVoiceInputModelSelection('connection-test');
      const provider = selection.asrProvider;
      const profile = getVoiceInputAsrProfile(provider);
      const providerModel = resolveVoiceInputProviderModel(provider);

      if (
        !isVoiceInputByokMode()
        || profile.mode === 'batch-http'
        || provider === 'openai-realtime-whisper'
      ) {
        return {
          ok: false,
          provider,
          providerModel,
          reason: 'unsupported-provider',
        };
      }

      return runSerializedVoiceInputConnectionTest({
        provider,
        providerModel,
        configurationKey: voiceInputConnectionTestConfigurationKey(selection),
        createProvider: () => {
          invalidatePrewarmedRealtimeAsrWebSocketSession();
          return createVoiceInputProvider(provider, undefined);
        },
        onError: (error) => {
          log.warn('voice input connection test failed', {
            provider,
            errorType: error instanceof Error ? error.name : typeof error,
          });
        },
      });
    },
  );

  ipcMain.handle('voice-input:model-selection:get', async (event): Promise<VoiceInputModelSelectionIpcResult> => {
    assertTrustedAppRendererEvent(event);
    return buildVoiceInputModelSelectionIpcResult('get');
  });

  ipcMain.handle(
    'voice-input:model-selection:set',
    async (event, payload: unknown): Promise<VoiceInputModelSelectionIpcResult> => {
      assertTrustedAppRendererEvent(event);
      const patch = voiceInputModelSelectionPatchFromIpc(payload);
      const customAsrSecretUpdate = customAsrSecretUpdateFromIpc(payload);
      const currentSelection = readActiveVoiceInputModelSelection('ipc-set-before-write');
      assertCustomAsrCredentialScope(currentSelection, patch, customAsrSecretUpdate);
      let selection: VoiceInputModelSelection;
      try {
        selection = persistVoiceInputSelectionWithCustomAsrSecret(
          () => setVoiceInputModelSelection(patch),
          getProviderSecretStore(),
          customAsrSecretUpdate,
        );
      } catch (error) {
        log.warn('voice input model selection write failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        throwIpcError('INTERNAL', 'Failed to save voice input model selection.');
      }
      if (customAsrSecretUpdate.action !== 'none') {
        customAsrCredentialRevision += 1;
        invalidatePrewarmedRealtimeAsrWebSocketSession();
      }
      markVoiceInputModelSelectionApplied('ipc-set', selection);
      const result = await buildVoiceInputModelSelectionIpcResult('set');
      void prewarmVoiceInputProvider();
      return result;
    },
  );

  ipcMain.handle('voice-input:model-selection:reload', async (event): Promise<VoiceInputModelSelectionIpcResult> => {
    assertTrustedAppRendererEvent(event);
    const selection = reloadVoiceInputModelSelection();
    markVoiceInputModelSelectionApplied('ipc-reload', selection);
    const result = await buildVoiceInputModelSelectionIpcResult('reload');
    void prewarmVoiceInputProvider();
    return result;
  });

  ipcMain.handle(
    'voice-input:dictionary-learning:advise',
    async (event, payload: DictationDictionaryAdviceInput | undefined): Promise<DictionaryAdviceIpcResult> => {
      return adviseAndRecordVoiceInputDictionaryLearning(payload, {
        senderId: event.sender.id,
        // 这个桥是所有 renderer 共享的：浮窗 toast 锚点的资格由真实 sender 决定，
        // 不看 payload 里自报的 source。
        fromOverlaySender: isGlobalVoiceInputOverlaySender(event.sender),
      });
    },
  );

  ipcMain.handle('voice-input:mute-system-audio', async (event): Promise<VoiceInputActionResult> => {
    try {
      await systemAudioMuteGuard.mute(event.sender.id);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('system audio mute failed', { error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('voice-input:restore-system-audio', async (event): Promise<VoiceInputActionResult> => {
    try {
      await systemAudioMuteGuard.restore(event.sender.id);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('system audio restore failed', { error: message });
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('voice-input:start', async (event, payload: StartPayload | undefined): Promise<StartResult> => {
    const isInlineSender = !isGlobalVoiceInputOverlaySender(event.sender);
    const existing = activeByWebContentsId.get(event.sender.id);
    if (existing) {
      await existing.controller.cancel();
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      activeByWebContentsId.delete(event.sender.id);
      disposeVoiceInputProviderLater(existing.provider, 'replaced_existing_run', {
        sourceLanguage: existing.sourceLanguage,
        refinementEnabled: existing.refinementEnabled,
      });
    }
    if (isInlineSender) {
      registerActiveInlineVoiceInputWebContents(event.sender);
    }

    const readiness = await refreshVoiceInputReadinessCache('start');
    if (!readiness.ok) {
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      return {
        ok: false,
        error: readiness.error ?? 'Voice input provider is not ready.',
        authErrorReason: readiness.auth === 'codex' ? readiness.authErrorReason : undefined,
      };
    }
    const shouldRefine = payload?.refinementEnabled !== false;
    // Explicit service mode: managed Cindy voice service by default; the
    // user's own credentials only when they opted into BYOK in settings. The
    // two planes never fall back into each other.
    const useCindyVoiceService = !isVoiceInputByokMode();
    // Refiner fallback chain: credential-ready profiles in runtime priority
    // order. The built-in default is readiness-aware (Codex ready: Codex →
    // Kimi; Codex unavailable: LiteLLM GPT → Kimi), then cooldown-aware.
    const {
      refinerChainProfiles,
      refinerReadinessList,
      readyRefinerProfiles,
    } = shouldRefine
      ? await resolveVoiceInputRefinerChainForRuntime(useCindyVoiceService)
      : { refinerChainProfiles: [], refinerReadinessList: [], readyRefinerProfiles: [] };
    const primaryRefinerProfile = refinerChainProfiles[0] ?? null;
    const primaryRefinerReadiness = refinerReadinessList[0] ?? null;
    const canRefine = readyRefinerProfiles.length > 0;
    if (shouldRefine && primaryRefinerProfile && !canRefine) {
      log.warn('voice input refinement unavailable, continuing with raw ASR text', {
        refinerProvider: primaryRefinerProfile.id,
        refinerModel: primaryRefinerProfile.model,
        refinerChain: refinerChainProfiles.map((profile) => profile.id),
        error: primaryRefinerReadiness?.error,
        authErrorReason: primaryRefinerReadiness?.authErrorReason,
      });
    }
    const refinerAuthErrorReason = shouldRefine && primaryRefinerProfile && !canRefine && primaryRefinerReadiness?.auth === 'codex'
      ? primaryRefinerReadiness.authErrorReason
      : undefined;

    const asrLanguageHint = resolveAsrLanguageHint(payload?.sourceLanguage);
    const refineSourceLanguage = resolveRefineSourceLanguage(payload?.sourceLanguage);
    // Global overlay path: payload.refinementContext has no selection fields
    // (the renderer only knows about the overlay window itself). The cursor
    // surroundings of the user's REAL target field were captured in main when
    // the overlay was shown. We mutate refinementContext in place once that
    // capture resolves — kicked off in parallel with the provider create so
    // ASR start latency isn't blocked by AX capture.
    const refinementContext = normalizeRefinementContext(payload?.refinementContext, refineSourceLanguage);
    if (shouldRefine) {
      beginOverlayContextInjection(payload?.refinementContext, event.sender, refinementContext);
    }
    // Connect-phase fallback: hand FallbackAsrProvider the full startable
    // chain. Construction is lazy — providers beyond the first are only
    // instantiated when an earlier candidate fails to connect.
    const startableAsrChain = await resolveStartableAsrChain();
    const effectiveRefinerProfile = readyRefinerProfiles[0] ?? null;
    // BYOK mode must never allocate a managed voice-server session even when
    // the service is reachable — the user explicitly chose their own
    // credential plane.
    const voiceContext = useCindyVoiceService && isCindyVoiceServiceReady()
      ? new CindyVoiceRunContext(
          asrLanguageHint,
          // Managed refinement delegates model choice and failover to
          // voice-server; the session is registered with the 'auto' marker
          // instead of a concrete provider id.
          canRefine ? CINDY_MANAGED_REFINER_PROVIDER : undefined,
        )
      : undefined;
    if (startableAsrChain.length === 0) {
      log.warn(useCindyVoiceService
        ? 'no managed ASR provider is available'
        : 'no credential-ready BYOK ASR provider is available');
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      return {
        ok: false,
        error: useCindyVoiceService ? CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE : (readiness.error ?? CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE),
      };
    }
    let provider: FallbackAsrProvider;
    try {
      provider = new FallbackAsrProvider(startableAsrChain.map((kind) => ({
        kind,
        create: () => {
          // BYOK live 谓词(PR #744 review 第二十一/二十五轮):后备转写档在前一档
          // 失败后才被 connect,可能距会话开始数分钟 —— create 时刻按当前 override
          // 以 (来源, 模型) 双查,停用即抛错让 fallback 落到下一家。managed 模式
          // 路由在 voice-server,不查。
          if (!voiceContext && isAsrProfileRouteDisabled(getVoiceInputAsrProfile(kind))) {
            throw new Error('voice ASR provider disabled in settings');
          }
          return createVoiceInputProvider(kind, asrLanguageHint, voiceContext);
        },
      })));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('provider create failed', { error: message });
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      return { ok: false, error: message };
    }
    let runId = '';
    const emit = (message: VoiceInputRendererEvent): void => {
      if (event.sender.isDestroyed()) return;
      event.sender.send('voice-input:event', message);
    };
    let refiner: DictationRefiner | undefined;
    let managedRefinerCacheScope: string | undefined;
    if (canRefine && effectiveRefinerProfile) {
      const customCacheScope = payload?.refinementCacheScope;
      try {
        if (voiceContext) {
          // Managed mode: one request, voice-server runs the model failover
          // internally. No client-side fallback wrapper, no provider-health
          // cooldown — both only make sense when the client owns multiple
          // channels (BYOK below). The cache scope is provider-agnostic so
          // the warmup fired at recording start and the refinement after
          // stop always share one prompt_cache_key.
          managedRefinerCacheScope = customCacheScope
            ?? `${VOICE_INPUT_REFINEMENT_CACHE_SCOPE}:${CINDY_MANAGED_REFINER_PROVIDER}`;
          refiner = new DictationRefiner({
            client: createVoiceInputTextModelClient(effectiveRefinerProfile, {
              timeoutMs: VOICE_INPUT_MANAGED_REFINER_IDLE_TIMEOUT_MS,
              voiceContext,
              onUsage: ({ servedModel, ...usage }) => {
                if (!runId) return;
                // Server-side failover may answer with any chain model; map
                // the SSE-reported model back to a local provider id so the
                // Settings usage/cost breakdown attributes tokens correctly.
                const servedProvider = servedModel
                  ? resolveServedRefinerProviderForUsage(servedModel)
                  : null;
                emit({
                  type: 'usage',
                  runId,
                  refinement: {
                    ...usage,
                    refinerProvider: servedProvider ?? CINDY_MANAGED_REFINER_PROVIDER,
                  },
                });
              },
            }),
            model: CINDY_MANAGED_REFINER_PROVIDER,
            contextProvider: () => refinementContext,
            promptCacheScope: customCacheScope
              ?? `${VOICE_INPUT_REFINEMENT_CACHE_SCOPE}:${CINDY_MANAGED_REFINER_PROVIDER}`,
          });
        } else {
          const refinerAttempts: FallbackTextModelAttempt[] = readyRefinerProfiles.map((profile) => ({
            profileId: profile.id as VoiceInputRefinerProviderKind,
            model: profile.model,
            // live 谓词包装:精修请求在用户停止说话时才发出,可能距控制器构造
            // 数分钟 —— 每次请求前重查设置停用与付费权限,不可用即让 fallback
            // 落到下一档。
            client: guardRefinerClientAgainstUnavailableRoute(
              profile,
              createVoiceInputTextModelClient(profile, {
                timeoutMs: VOICE_INPUT_REFINER_IDLE_TIMEOUT_MS,
                onUsage: (usage) => {
                  if (!runId) return;
                  emit({ type: 'usage', runId, refinement: { ...usage, refinerProvider: profile.id } });
                },
              }),
            ),
            // A caller-supplied cache scope flows through unchanged for every
            // attempt; the default per-profile scope keeps cache keys separate
            // across providers.
            promptCacheScope: customCacheScope
              ? undefined
              : `${VOICE_INPUT_REFINEMENT_CACHE_SCOPE}:${profile.id}`,
          }));
          refiner = new DictationRefiner({
            client: new FallbackTextModelClient(refinerAttempts),
            model: effectiveRefinerProfile.model,
            contextProvider: () => refinementContext,
            promptCacheScope: customCacheScope
              ?? `${VOICE_INPUT_REFINEMENT_CACHE_SCOPE}:${effectiveRefinerProfile.id}`,
          });
        }
      } catch (error) {
        log.warn('voice input refiner create failed, continuing with raw ASR text', {
          refinerProvider: effectiveRefinerProfile.id,
          refinerModel: effectiveRefinerProfile.model,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const logger = new VoiceTimelineLogger((timelineEvent) => {
      log.debug('timeline', summarizeTimelineEventForLog(timelineEvent));
      logRefineSummary(timelineEvent, refinementContext);
      if (runId) emit({ type: 'timeline', runId, event: timelineEvent });
    });

    const controller = new VoiceInputController({
      asr: provider,
      refiner,
      logger,
      callbacks: {
        onStateChanged: (state, outcome) => {
          if (runId) emit({ type: 'state', runId, state, outcome });
        },
        onDraftChanged: (text, segment, source) => {
          if (runId) emit({ type: 'draft', runId, text, segment, source });
        },
        onSubmitted: (text, segment) => {
          if (runId) emit({ type: 'submitted', runId, text, segment });
          return makeEditableRange(text, segment);
        },
        onRefinementPreview: (text, segment, range) => {
          if (!runId) return;
          emit({
            type: 'refinement-preview',
            runId,
            text,
            segment,
            range,
          });
        },
        applyRefinement: (range, refinedText) => {
          if (!runId) return false;
          emit({
            type: 'refined',
            runId,
            text: refinedText,
            segment: makeRefinedSegment(refinedText, range),
            range,
          });
          return true;
        },
        onError: (message, code, details) => {
          if (runId) emit({ type: 'error', runId, message, code, transcriptKept: details?.transcriptKept });
        },
      },
    });

    try {
      runId = await controller.start();
      // The ASR session now exists server-side; warm the refiner prompt
      // cache in the background so the (large, mostly static) prompt prefix
      // is hot by the time the user stops speaking. Best effort by design.
      if (voiceContext && refiner && managedRefinerCacheScope) {
        warmManagedRefinerPromptCache(voiceContext, refiner, managedRefinerCacheScope);
      }
      if (refinerAuthErrorReason) {
        emit({
          type: 'auth-required',
          runId,
          provider: primaryRefinerProfile?.id ?? 'codex',
          reason: refinerAuthErrorReason,
        });
      }
      if (event.sender.isDestroyed()) {
        await controller.cancel();
        await disposeVoiceInputProvider(provider, 'sender_destroyed_before_active', {
          sourceLanguage: payload?.sourceLanguage,
          refinementEnabled: Boolean(refiner),
        });
        return { ok: false, error: 'Voice input window was closed.' };
      }
      activeByWebContentsId.set(event.sender.id, {
        controller,
        provider,
        sourceLanguage: payload?.sourceLanguage,
        refinementEnabled: Boolean(refiner),
      });
      event.sender.once('destroyed', () => {
        const active = activeByWebContentsId.get(event.sender.id);
        if (active?.controller !== controller) return;
        unregisterActiveInlineVoiceInputWebContents(event.sender.id);
        activeByWebContentsId.delete(event.sender.id);
        void (async () => {
          await controller.cancel();
          await disposeVoiceInputProvider(provider, 'web_contents_destroyed', {
            sourceLanguage: active.sourceLanguage,
            refinementEnabled: active.refinementEnabled,
          });
          await restoreSystemAudioForSender(event.sender.id);
        })();
      });
      log.info('started', {
        runId,
        webContentsId: event.sender.id,
        asrLanguageHint: asrLanguageHint ?? '<auto-detect>',
        refineSourceLanguage,
        provider: provider.activeProviderKind ?? readiness.provider,
        providerModel: provider.activeProviderKind
          ? resolveVoiceInputProviderModel(provider.activeProviderKind)
          : readiness.providerModel,
        asrChain: startableAsrChain,
        refiner: refiner ? effectiveRefinerProfile?.model : undefined,
        refinerProvider: refiner ? effectiveRefinerProfile?.id : undefined,
        refinerChain: refiner ? readyRefinerProfiles.map((profile) => profile.id) : undefined,
        refinementEnabled: Boolean(refiner),
        refinementRequested: shouldRefine,
        refinementContext: refiner ? summarizeRefinementContext(refinementContext) : undefined,
      });
      return { ok: true, runId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('start failed', { error: message });
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      await cleanupVoiceInputProvider(provider, 'start_failed');
      return {
        ok: false,
        error: voiceContext ? CINDY_VOICE_SERVICE_UNAVAILABLE_MESSAGE : message,
      };
    }
  });

  ipcMain.on('voice-input:audio', (event, payload: AudioPayload | undefined) => {
    const active = activeByWebContentsId.get(event.sender.id);
    if (!active || !payload?.pcm16k) return;
    active.controller.appendAudio(payload.pcm16k, payload.trace);
  });

  ipcMain.handle('voice-input:audio-drain', (): { ok: true } => ({ ok: true }));

  ipcMain.handle('voice-input:stop', async (event): Promise<{ ok: true } | { ok: false; error: string }> => {
    const active = activeByWebContentsId.get(event.sender.id);
    if (!active) {
      await restoreSystemAudioForSender(event.sender.id);
      return { ok: true };
    }
    try {
      await active.controller.stop();
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('stop failed', { error: message });
      return { ok: false, error: message };
    } finally {
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      activeByWebContentsId.delete(event.sender.id);
      disposeVoiceInputProviderLater(active.provider, 'stop_completed', {
        sourceLanguage: active.sourceLanguage,
        refinementEnabled: active.refinementEnabled,
      });
      await restoreSystemAudioForSender(event.sender.id);
    }
  });

  ipcMain.handle('voice-input:cancel', async (event, payload?: { runId?: string }): Promise<{ ok: true }> => {
    const active = activeByWebContentsId.get(event.sender.id);
    const requestedRunId = typeof payload?.runId === 'string' ? payload.runId : undefined;
    log.debug('voice input cancel requested', {
      webContentsId: event.sender.id,
      requestedRunId,
      activeRunId: active?.controller.id,
      hasActiveRun: Boolean(active),
    });
    if (active && (!requestedRunId || active.controller.id === requestedRunId)) {
      await active.controller.cancel();
      unregisterActiveInlineVoiceInputWebContents(event.sender.id);
      activeByWebContentsId.delete(event.sender.id);
      disposeVoiceInputProviderLater(active.provider, 'cancel_completed', {
        sourceLanguage: active.sourceLanguage,
        refinementEnabled: active.refinementEnabled,
      });
    }
    await restoreSystemAudioForSender(event.sender.id);
    return { ok: true };
  });
}

async function cleanupVoiceInputProvider(provider: AsrProvider, reason: string): Promise<void> {
  try {
    await provider.stop();
  } catch (error) {
    log.debug('voice input provider stop failed during cleanup', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  await disposeVoiceInputProvider(provider, reason);
}

type DisposeVoiceInputProviderOptions = {
  sourceLanguage?: string;
  refinementEnabled?: boolean;
};

async function disposeVoiceInputProvider(
  provider: AsrProvider,
  reason: string,
  options?: DisposeVoiceInputProviderOptions,
): Promise<void> {
  try {
    await provider.dispose?.();
  } catch (error) {
    // dispose 负责 finalize recorder / WS 调试文件 / 资源释放;
    // 失败意味着这些可能不完整,值得在日志里看到。
    log.warn('voice input provider dispose failed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    (reason === 'stop_completed' || reason === 'cancel_completed') &&
    isRealtimeAsrProvider(resolveVoiceInputAsrChain()[0] ?? resolveVoiceInputProviderKind())
  ) {
    void prewarmVoiceInputProvider(options);
  }
}

function disposeVoiceInputProviderLater(
  provider: AsrProvider,
  reason: string,
  options?: DisposeVoiceInputProviderOptions,
): void {
  // 兜底: disposeVoiceInputProvider 内部已经 catch 了 provider.dispose 的异常,
  // 这里的 catch 是防止未来在 disposeVoiceInputProvider 里加了未捕获逻辑导致
  // unhandled rejection。
  void disposeVoiceInputProvider(provider, reason, options).catch((error) => {
    log.warn('voice input provider dispose (later) failed', {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

function makeEditableRange(text: string, segment: SpeechSegment): EditableRange {
  return {
    id: segment.id,
    segmentIds: [segment.id],
    startOffset: 0,
    endOffset: text.length,
    userTouched: false,
  };
}

function makeRefinedSegment(text: string, range: EditableRange): SpeechSegment {
  return {
    id: `${range.id}:refined`,
    source: 'mic',
    status: 'refined',
    text,
    updatedAt: Date.now(),
  };
}

async function restoreSystemAudioForSender(webContentsId: number): Promise<void> {
  try {
    await systemAudioMuteGuard.restore(webContentsId);
  } catch (error) {
    log.warn('system audio restore failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

function logRefineSummary(event: VoiceTimelineEvent, context: DictationRefinementContext): void {
  // Demoted to debug: payload includes the user's raw dictation (basedOnText)
  // and refined transcription (refinedText), which is PII. Keep it accessible
  // for diagnosis (Settings → About → 调试日志 toggle bumps logger to debug)
  // but do not write it into the default packaged log file.
  if (event.type === 'refine_accepted') {
    log.debug('refine_summary', {
      runId: event.runId,
      accepted: true,
      elapsedMs: Math.round(event.elapsedMs),
      basedOnText: event.basedOnText,
      refinedText: event.refinedText,
      context: summarizeRefinementContext(context),
    });
    return;
  }

  if (event.type === 'refine_rejected') {
    log.debug('refine_summary', {
      runId: event.runId,
      accepted: false,
      reason: event.reason,
      elapsedMs: event.elapsedMs === undefined ? undefined : Math.round(event.elapsedMs),
      basedOnText: event.basedOnText,
      refinedText: event.refinedText,
      context: summarizeRefinementContext(context),
    });
  }
}
