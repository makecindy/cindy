import { createHash } from 'node:crypto';
import { CompanionCallDialogue } from './dialogue.js';
import { normalizeRealtimeVoiceSelection } from '../../shared/realtimeVoice.js';
import { loadSpeechVoices } from './voices.js';
import { realtimeCustomVoiceConnection, realtimeModels, resolveRealtimeConnection } from './realtimeModels.js';
import { updateRealtimeVoicePreference } from './preferences.js';
import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import type { AsrProvider, AudioGate } from '@cindy/voice-input-core';
import { storedCustomProviderId } from '@cindy/model-providers';
import {
  normalizeVoiceConversationSelection,
  normalizeSpeechModelSelection,
  type VoiceConversationPreference,
} from '../../shared/voiceConversation.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { readCachedGenericOAuthAccessToken, readGenericOAuthAccessToken } from '../maker-host/generic-oauth.desktop.js';
import { getModelVisibilityOverride, waitForModelVisibilityMirror } from '../maker-host/model-visibility-mirror.js';
import { getProviderSecretStore, readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getBotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { isProviderModelRouteDisabled } from '../utility-model/oneShotCandidates.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { voiceCallCoordinator } from './callCoordinator.js';
import type {
  VoiceCallCommand,
  VoiceCallStatus,
  VoiceCallStatusUpdate,
} from '../../shared/voiceConversation.js';
import { VoiceConversationService } from './service.js';
import { SpeechError } from './speechError.js';
import { resolveSpeechConnection, resolveSpeechConnectionForRequest, speechModels, type SpeechCatalogDeps } from './models.js';
import {
  companionVoicePreference,
  updateCompanionVoicePreference,
  updateSentencePlaybackPreference,
} from './preferences.js';
import { hasEnabledGhostAssistantHook } from '../cindy-brain/index.js';
import type { VoiceInputSettings } from '../../shared/voiceInputData.js';
import { createLogger } from '../logger.js';
import { classifyVoiceExit } from './semanticExit.js';

const log = createLogger('voice-conversation');

/** What a remote Desktop's voice settings page needs; the IPC channels stay local to this window. */
export interface VoiceSettingsHostApi {
  selfPreference(botId: string): Promise<ReturnType<typeof selfVoicePreference>>;
  models(): ReturnType<VoiceConversationService['models']>;
  voices(selection: unknown): ReturnType<VoiceConversationService['voices']>;
  preference(botId: unknown): Promise<VoiceConversationPreference>;
  setPreference(botId: unknown, value: unknown, sentencePlayback: unknown, expectedRevision?: string): Promise<VoiceConversationPreference>;
}
function selfVoicePreference(settings: VoiceInputSettings, botId: string) {
  const value = companionVoicePreference(settings, botId);
  const sources = {
    selection: Object.hasOwn(settings.conversationSelections ?? {}, botId) ? 'teammate' : 'device',
    sentencePlayback: Object.hasOwn(settings.conversationSentencePlayback ?? {}, botId) ? 'teammate' : 'device',
  };
  const revision = createHash('sha256').update(JSON.stringify([value, sources])).digest('hex');
  return { ...value, sources, revision };
}

let settingsApi: VoiceSettingsHostApi | null = null;
export function getVoiceSettingsHostApi(): VoiceSettingsHostApi | null {
  return settingsApi;
}

/** Status comes from the trusted main window; bound only what Main itself reads. */
function readVoiceCallStatusUpdate(raw: unknown): VoiceCallStatusUpdate | null {
  const value = requireObject(raw);
  if (value.status === null) return { status: null };
  if (typeof value.ready === 'boolean') return { ready: value.ready };
  if (typeof value.level === 'number' && Number.isFinite(value.level))
    return { level: value.level };
  const status = value.status as Partial<VoiceCallStatus> | undefined;
  return status && typeof status === 'object' && typeof status.open === 'boolean'
    ? { status: status as VoiceCallStatus }
    : null;
}

function readVoiceCallCommand(raw: unknown): VoiceCallCommand {
  const value = requireObject(raw);
  const sessionId = boundedString(value.sessionId, 'sessionId', 256);
  if (value.type === 'start') {
    const bot = requireObject(value.bot);
    const optional = (key: string, limit: number) => {
      const text = bot[key];
      return typeof text === 'string' && text.length <= limit ? { [key]: text } : {};
    };
    return {
      type: 'start',
      sessionId,
      bot: {
        id: boundedString(bot.id, 'botId', 256),
        name: boundedString(bot.name, 'botName', 256),
        ...optional('templateId', 256),
        ...optional('avatar', 4_096),
        ...optional('avatarColor', 64),
      },
    };
  }
  if (
    !['end', 'mute', 'interrupt', 'send', 'cancel-exit', 'resume'].includes(
      value.type as string,
    )
  )
    throwIpcError('INVALID_PARAMS', 'Invalid call command');
  return { type: value.type, sessionId } as VoiceCallCommand;
}

function boundedString(value: unknown, name: string, limit: number): string {
  const text = requireString(value, name);
  if (!text.trim() || text.length > limit) throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  return text;
}

/**
 * Local top-level renderer only; the IPC channels are deliberately absent from device-link and plugin
 * allowlists. Model catalog and per-teammate preference are also served to the teammate settings host.
 */
export function registerVoiceConversationIpc(deps: {
  createProvider(): Promise<AsrProvider>;
  /** `onFiltered` runs each time the gate mutes someone else's speech. */
  createAudioGate(onFiltered: () => void): AudioGate | undefined;
  hasDictation(): boolean;
  getSettings(): VoiceInputSettings;
  updateSettings(patch: Partial<VoiceInputSettings>): VoiceInputSettings;
}): void {
  const catalogDeps = (): SpeechCatalogDeps => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    return {
      catalog: getActiveCatalog(),
      gatewayAllowed: getAppCapabilities().canUseCindyGateway,
      disabled: isProviderModelRouteDisabled,
      visibilityOverride: getModelVisibilityOverride,
      readKey: readCustomProviderKey,
      readOAuthToken: (providerId, oauth) => readCachedGenericOAuthAccessToken(storedCustomProviderId(providerId), oauth),
      readOAuthTokenForRequest: (providerId, oauth) => readGenericOAuthAccessToken(storedCustomProviderId(providerId), oauth),
      gatewayConnection: () => ({
        baseUrl: effectiveXdGatewayBaseUrl(),
        apiKey: getProviderSecretStore().get('xd') ?? '',
      }),
    };
  };
  const service = new VoiceConversationService({
    createDialogue: (selection, emit, nativeResult) => new CompanionCallDialogue({ ...selection, emit, nativeResult }),
    realtimeConnection: selection => resolveRealtimeConnection(catalogDeps(), selection),
    ...deps,
    log,
    owner: () => (isAppSessionBoundaryPending() ? 'changing-account' : activeOwnerScopeKey()),
    assertCompanion: async (botId, sessionId) => {
      const bot = await getBotRemoteResourceSource(botId);
      if (bot.hiddenAt !== null || bot.canonicalSessionId !== sessionId)
        throw new Error('invalid_companion');
    },
    models: () => speechModels(catalogDeps()),
    connection: (selection) => resolveSpeechConnection(catalogDeps(), selection),
    prepareConnection: (selection) => resolveSpeechConnectionForRequest(catalogDeps(), selection),
    fetch: outboundFetch,
    hasReplyHook: hasEnabledGhostAssistantHook,
    classifyExit: classifyVoiceExit,
    emit: (sender, event) => {
      const target = webContents.fromId(sender);
      if (target && !target.isDestroyed()) target.send('voice-conversation:event', event);
    },
  });
  const catalogRequests = new Map<number, { id: string; controller: AbortController }>();
  const observed = new Set<number>();
  const observe = (event: IpcMainInvokeEvent): void => {
    if (observed.has(event.sender.id)) return;
    const sender = event.sender.id;
    observed.add(sender);
    const released = () => {
      catalogRequests.get(sender)?.controller.abort();
      catalogRequests.delete(sender);
      void service.end(sender);
      voiceCallCoordinator.windowGone(sender);
    };
    event.sender.once('destroyed', () => {
      observed.delete(sender);
      released();
    });
    // A reload loses the renderer's controller without destroying its webContents.
    // In-page routing is a separate event, so task navigation never reaches this.
    event.sender.on('did-navigate', released);
  };
  const handle = (
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(`voice-conversation:${name}`, async (event, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      try {
        return await action(event, ...args);
      } catch (error) {
        // Do not log args or upstream errors: either can include text or secrets.
        log.warn('IPC operation failed', { operation: name });
        if (error instanceof SpeechError && error.code === 'timeout')
          throwIpcError('VOICE_SPEECH_TIMEOUT', 'Speech response timed out.');
        if (error instanceof Error && error.message === 'busy')
          throwIpcError('VOICE_CONVERSATION_BUSY', 'Another voice session is using the microphone.');
        throwIpcError('PRECONDITION_FAILED', 'Voice conversation is unavailable.');
      }
    });
  };
  handle('models', async () => {
    await waitForModelVisibilityMirror();
    return service.models();
  });
  handle('realtime-models', async () => {
    await waitForModelVisibilityMirror();
    return realtimeModels(catalogDeps());
  });
  handle('realtime-custom-voices', async (event, raw, requestId) => {
    const id = boundedString(requestId, 'requestId', 64);
    const model = normalizeSpeechModelSelection(raw);
    if (!model?.providerId || !model.agent) throw new Error('invalid_realtime_model');
    const route = { providerId: model.providerId, agent: model.agent, modelId: model.modelId, protocol: 'qwen-audio-realtime' as const };
    const resolve = () => realtimeCustomVoiceConnection(catalogDeps(), route);
    const owner = activeOwnerScopeKey();
    const connection = resolve();
    const identity = JSON.stringify(connection);
    const sender = event.sender.id;
    observe(event);
    catalogRequests.get(sender)?.controller.abort();
    const controller = new AbortController();
    catalogRequests.set(sender, { id, controller });
    try {
      const catalog = await loadSpeechVoices(connection, route.modelId, outboundFetch, () => {
        if (activeOwnerScopeKey() !== owner || JSON.stringify(resolve()) !== identity)
          throw new Error('connection_changed');
      }, undefined, controller.signal);
      return controller.signal.aborted ? { source: 'manual', voices: [] } : catalog;
    } finally {
      if (catalogRequests.get(sender)?.controller === controller) catalogRequests.delete(sender);
    }
  });
  handle('cancel-realtime-custom-voices', (event, rawId) => {
    const id = boundedString(rawId, 'requestId', 64);
    const request = catalogRequests.get(event.sender.id);
    if (request?.id === id) request.controller.abort();
  });
  handle('voices', (_event, raw) => {
    const selection = normalizeSpeechModelSelection(raw);
    if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech model');
    return service.voices(selection);
  });
  handle('preview', (event, raw) => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    const value = requireObject(raw);
    const selection = value.mode === 'realtime'
      ? normalizeRealtimeVoiceSelection(value)
      : normalizeVoiceConversationSelection(value);
    if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid preview selection');
    observe(event);
    return service.startPreview(event.sender.id, {
      ...selection,
      previewId: boundedString(value.previewId, 'previewId', 64),
      botId: boundedString(value.botId, 'botId', 256),
      sessionId: boundedString(value.sessionId, 'sessionId', 256),
      text: boundedString(value.text, 'text', 256),
    });
  });
  handle('read-preview', (event, id) =>
    service.readPreview(event.sender.id, boundedString(id, 'previewId', 64)),
  );
  handle('stop-preview', (event, id) =>
    service.stopPreview(event.sender.id, boundedString(id, 'previewId', 64)),
  );
  const preferenceBot = async <T>(
    raw: unknown,
    action: (botId: string) => T,
  ): Promise<T> => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    const owner = activeOwnerScopeKey();
    const botId = boundedString(raw, 'botId', 256);
    const bot = await getBotRemoteResourceSource(botId);
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || bot.hiddenAt !== null)
      throw new Error('invalid_companion');
    return action(botId);
  };
  const readPreference = (raw: unknown) =>
    preferenceBot(raw, (botId) => companionVoicePreference(deps.getSettings(), botId));
  const writePreference = (raw: unknown, value: unknown, sentencePlayback: unknown, expectedRevision?: string) =>
    preferenceBot(raw, (botId) => {
      const settings = deps.getSettings();
      if (expectedRevision !== undefined && expectedRevision !== selfVoicePreference(settings, botId).revision)
        throw new Error('VOICE_PREFERENCE_CHANGED');
      const patch: Partial<VoiceInputSettings> = {};
      if (value !== undefined) {
        const selection = value === null ? null : normalizeVoiceConversationSelection(value);
        if (selection === undefined) throwIpcError('INVALID_PARAMS', 'Invalid speech selection');
        // Validate explicit speed against Main's actual endpoint/model binding.
        if (selection?.speed !== undefined) resolveSpeechConnection(catalogDeps(), selection);
        patch.conversationSelections = updateCompanionVoicePreference(settings, botId, selection);
      }
      if (sentencePlayback !== undefined) {
        if (sentencePlayback !== null && typeof sentencePlayback !== 'boolean')
          throwIpcError('INVALID_PARAMS', 'Invalid speech preference');
        patch.conversationSentencePlayback = updateSentencePlaybackPreference(
          settings,
          botId,
          sentencePlayback,
        );
      }
      return companionVoicePreference(deps.updateSettings(patch), botId);
    });
  handle('preference', (_event, raw) => readPreference(raw));
  handle('set-realtime-preference', (_event, raw, value) => preferenceBot(raw, botId => {
    const selection = value === null ? null : normalizeRealtimeVoiceSelection(value);
    if (selection === undefined) throwIpcError('INVALID_PARAMS', 'Invalid realtime selection');
    if (selection) resolveRealtimeConnection(catalogDeps(), selection);
    return companionVoicePreference(deps.updateSettings(
      updateRealtimeVoicePreference(deps.getSettings(), botId, selection),
    ), botId);
  }));
  handle('realtime-question', (event, id, pending) => {
    if (typeof pending !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid question state');
    service.setRealtimeQuestion(event.sender.id, boundedString(id, 'callId', 64), pending);
  });
  handle('set-preference', (_event, raw, value, sentencePlayback) =>
    writePreference(raw, value, sentencePlayback),
  );
  // The settings page of a remote Desktop reads and writes the same preference through the
  // teammate settings host. Calls, previews and audio stay on the IPC channels above.
  settingsApi = {
    models: () => service.models(),
    voices: (raw) => {
      const selection = normalizeSpeechModelSelection(raw);
      if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech model');
      return service.voices(selection!);
    },
    preference: readPreference,
    selfPreference: raw => preferenceBot(raw, botId => selfVoicePreference(deps.getSettings(), botId)),
    setPreference: writePreference,
  };
  for (const operation of ['start', 'start-playback'] as const) {
    handle(operation, async (event, raw) => {
      if (isAppSessionBoundaryPending()) throw new Error('changing_account');
      const value = requireObject(raw);
      const selection = value.mode === 'realtime' && operation === 'start'
        ? normalizeRealtimeVoiceSelection(value) : normalizeVoiceConversationSelection(value);
      if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech selection');
      observe(event);
      const input = {
        ...selection,
        callId: boundedString(value.callId, 'callId', 64),
        botId: boundedString(value.botId, 'botId', 256),
        sessionId: boundedString(value.sessionId, 'sessionId', 256),
      };
      return operation === 'start'
        ? service.start(event.sender.id, input)
        : service.startPlayback(event.sender.id, input);
    });
  }
  ipcMain.on('voice-conversation:audio', (event, raw: unknown) => {
    try {
      assertTrustedAppRendererEvent(event);
      const value = requireObject(raw);
      if (
        !(value.pcm instanceof ArrayBuffer) ||
        !value.pcm.byteLength ||
        value.pcm.byteLength > 16_000 ||
        value.pcm.byteLength % 2
      )
        return;
      if (
        value.inputGeneration !== undefined &&
        (typeof value.inputGeneration !== 'number' ||
          !Number.isSafeInteger(value.inputGeneration) ||
          value.inputGeneration < 0)
      )
        return;
      service.audio(
        event.sender.id,
        boundedString(value.callId, 'callId', 64),
        value.pcm,
        undefined,
        value.inputGeneration,
      );
    } catch {
      /* Untrusted or late frames are ignored; no payload is logged. */
    }
  });
  handle('promote-turn', (event, id, inputId) => service.promoteTurn(event.sender.id, boundedString(id, 'callId', 64), boundedString(inputId, 'inputId', 128)));
  handle('submit-turn', (event, id, inputId, text, forceHandoff) => {
    if (typeof forceHandoff !== 'boolean') throw new Error('invalid_handoff');
    return service.submitTurn(event.sender.id, boundedString(id, 'callId', 64),
      boundedString(inputId, 'inputId', 128), boundedString(text, 'text', 32000), forceHandoff);
  });
  handle('finish-utterance', (event, id) =>
    service.finishUtterance(event.sender.id, boundedString(id, 'callId', 64)),
  );
  handle('classify-exit', (event, id, utteranceId, inputGeneration) => {
    if (
      typeof inputGeneration !== 'number' ||
      !Number.isSafeInteger(inputGeneration) ||
      inputGeneration < 0
    )
      throwIpcError('INVALID_PARAMS', 'Invalid input generation');
    return service.classifyExit(
      event.sender.id,
      boundedString(id, 'callId', 64),
      boundedString(utteranceId, 'utteranceId', 128),
      inputGeneration,
    );
  });
  handle('set-input-muted', (event, id, muted) => {
    if (typeof muted !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid microphone state');
    if (!muted && isAppSessionBoundaryPending()) throw new Error('changing_account');
    return service.setInputMuted(event.sender.id, boundedString(id, 'callId', 64), muted);
  });
  handle('call-status', (event) => {
    observe(event);
    return voiceCallCoordinator.subscribe(event.sender.id);
  });
  handle('call-command', (event, raw) => {
    observe(event);
    return { ok: voiceCallCoordinator.command(readVoiceCallCommand(raw)) };
  });
  ipcMain.on('voice-conversation:call-publish', (event, raw: unknown) => {
    try {
      assertTrustedAppRendererEvent(event);
      observe(event);
      const update = readVoiceCallStatusUpdate(raw);
      if (update) voiceCallCoordinator.publish(event.sender.id, update);
    } catch {
      log.warn('IPC operation failed', { operation: 'call-publish' });
    }
  });
  handle('end', (event, id) => service.end(event.sender.id, boundedString(id, 'callId', 64)));
  handle('interrupt', (event, id, raw, throughResponse) => {
    if (throughResponse !== undefined && (typeof throughResponse !== 'number' || !Number.isSafeInteger(throughResponse) || throughResponse < 0 || throughResponse > 2_000))
      throwIpcError('INVALID_PARAMS', 'Invalid response position');
    let position;
    if (raw !== undefined) {
      const value = requireObject(raw);
      if (typeof value.playedMs !== 'number' || !Number.isFinite(value.playedMs) || value.playedMs < 0 || value.playedMs > 3_600_000)
        throwIpcError('INVALID_PARAMS', 'Invalid playback position');
      position = { itemId: boundedString(value.itemId, 'itemId', 128), playedMs: value.playedMs };
    }
    service.interrupt(event.sender.id, boundedString(id, 'callId', 64), position, throughResponse as number | undefined);
  });
  handle('speak', (event, raw) => {
    const value = requireObject(raw);
    if (value.streaming !== undefined && typeof value.streaming !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'Invalid speech state');
    return service.speak(
      event.sender.id,
      boundedString(value.callId, 'callId', 64),
      boundedString(value.requestId, 'requestId', 128),
      boundedString(value.text, 'text', 4_096),
      value.streaming === true,
    );
  });
  handle('read-speech', (event, id, requestId) =>
    service.readSpeech(
      event.sender.id,
      boundedString(id, 'callId', 64),
      boundedString(requestId, 'requestId', 128),
    ),
  );
}
