import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import type { AsrProvider } from '@cindy/voice-input-core';
import {
  normalizeVoiceConversationSelection,
  normalizeSpeechModelSelection,
  type VoiceConversationPreference,
} from '../../shared/voiceConversation.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getProviderSecretStore, readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getBotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { isProviderModelRouteDisabled } from '../utility-model/oneShotCandidates.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { VoiceConversationService } from './service.js';
import { resolveSpeechConnection, speechModels, type SpeechCatalogDeps } from './models.js';
import {
  companionVoicePreference,
  updateCompanionVoicePreference,
  updateSentencePlaybackPreference,
} from './preferences.js';
import { hasEnabledGhostAssistantHook } from '../cindy-brain/index.js';
import type { VoiceInputSettings } from '../../shared/voiceInputData.js';
import { createLogger } from '../logger.js';

const log = createLogger('voice-conversation');

function boundedString(value: unknown, name: string, limit: number): string {
  const text = requireString(value, name);
  if (!text.trim() || text.length > limit) throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  return text;
}

/** Local top-level renderer only; deliberately absent from device-link and plugin allowlists. */
export function registerVoiceConversationIpc(deps: {
  createProvider(): Promise<AsrProvider>;
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
      readKey: readCustomProviderKey,
      gatewayConnection: () => ({
        baseUrl: effectiveXdGatewayBaseUrl(),
        apiKey: getProviderSecretStore().get('xd') ?? '',
      }),
    };
  };
  const service = new VoiceConversationService({
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
    fetch: outboundFetch,
    hasReplyHook: hasEnabledGhostAssistantHook,
    emit: (sender, event) => {
      const target = webContents.fromId(sender);
      if (target && !target.isDestroyed()) target.send('voice-conversation:event', event);
    },
  });
  const observed = new Set<number>();
  const observe = (event: IpcMainInvokeEvent): void => {
    if (observed.has(event.sender.id)) return;
    const sender = event.sender.id;
    observed.add(sender);
    event.sender.once('destroyed', () => {
      observed.delete(sender);
      void service.end(sender);
    });
  };
  const handle = (
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(`voice-conversation:${name}`, async (event, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      try {
        return await action(event, ...args);
      } catch {
        // Do not log args or upstream errors: either can include text or secrets.
        log.warn('IPC operation failed', { operation: name });
        throwIpcError('PRECONDITION_FAILED', 'Voice conversation is unavailable.');
      }
    });
  };
  handle('models', () => service.models());
  handle('voices', (_event, raw) => {
    const selection = normalizeSpeechModelSelection(raw);
    if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech model');
    return service.voices(selection);
  });
  handle('preview', (event, raw) => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    const value = requireObject(raw);
    const selection = normalizeVoiceConversationSelection(value);
    if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech selection');
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
  const preferenceBot = async (
    raw: unknown,
    action: (botId: string) => VoiceConversationPreference,
  ): Promise<VoiceConversationPreference> => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    const owner = activeOwnerScopeKey();
    const botId = boundedString(raw, 'botId', 256);
    const bot = await getBotRemoteResourceSource(botId);
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner || bot.hiddenAt !== null)
      throw new Error('invalid_companion');
    return action(botId);
  };
  handle('preference', (_event, raw) =>
    preferenceBot(raw, (botId) => companionVoicePreference(deps.getSettings(), botId)),
  );
  handle('set-preference', (_event, raw, value, sentencePlayback) =>
    preferenceBot(raw, (botId) => {
      const settings = deps.getSettings();
      const patch: Partial<VoiceInputSettings> = {};
      if (value !== undefined) {
        const selection = value === null ? null : normalizeVoiceConversationSelection(value);
        if (selection === undefined) throwIpcError('INVALID_PARAMS', 'Invalid speech selection');
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
    }),
  );
  for (const operation of ['start', 'start-playback'] as const) {
    handle(operation, async (event, raw) => {
      if (isAppSessionBoundaryPending()) throw new Error('changing_account');
      const value = requireObject(raw);
      const selection = normalizeVoiceConversationSelection(value);
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
  handle('finish-utterance', (event, id) =>
    service.finishUtterance(event.sender.id, boundedString(id, 'callId', 64)),
  );
  handle('set-input-muted', (event, id, muted) => {
    if (typeof muted !== 'boolean') throwIpcError('INVALID_PARAMS', 'Invalid microphone state');
    if (!muted && isAppSessionBoundaryPending()) throw new Error('changing_account');
    return service.setInputMuted(event.sender.id, boundedString(id, 'callId', 64), muted);
  });
  handle('end', (event, id) => service.end(event.sender.id, boundedString(id, 'callId', 64)));
  handle('interrupt', (event, id) =>
    service.interrupt(event.sender.id, boundedString(id, 'callId', 64)),
  );
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
