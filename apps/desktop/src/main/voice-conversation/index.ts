import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron';
import type { AsrProvider } from '@cindy/voice-input-core';
import { normalizeVoiceConversationSelection } from '../../shared/voiceConversation.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { getProviderSecretStore } from '../secrets/providerSecretStore.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { outboundFetch } from '../maker-host/outbound-fetch.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getBotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { isProviderModelRouteDisabled } from '../utility-model/oneShotCandidates.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { VoiceConversationService } from './service.js';
import { speechModels } from './models.js';

function boundedString(value: unknown, name: string, limit: number): string {
  const text = requireString(value, name);
  if (!text.trim() || text.length > limit) throwIpcError('INVALID_PARAMS', `Invalid ${name}`);
  return text;
}

/** Local top-level renderer only; deliberately absent from device-link and plugin allowlists. */
export function registerVoiceConversationIpc(deps: {
  createProvider(): Promise<AsrProvider>;
  hasDictation(): boolean;
}): void {
  const service = new VoiceConversationService({
    ...deps,
    owner: () => (isAppSessionBoundaryPending() ? 'changing-account' : activeOwnerScopeKey()),
    assertCompanion: async (botId, sessionId) => {
      const bot = await getBotRemoteResourceSource(botId);
      if (bot.hiddenAt !== null || bot.canonicalSessionId !== sessionId)
        throw new Error('invalid_companion');
    },
    models: () =>
      speechModels(getActiveCatalog(), getAppCapabilities().canUseCindyGateway, (id) =>
        isProviderModelRouteDisabled('xd', id),
      ),
    connection: () => {
      if (!getAppCapabilities().canUseCindyGateway) throw new Error('unavailable');
      return {
        baseUrl: effectiveXdGatewayBaseUrl(),
        apiKey: getProviderSecretStore().get('xd') ?? '',
      };
    },
    fetch: outboundFetch,
    emit: (sender, event) => {
      const target = webContents.fromId(sender);
      if (target && !target.isDestroyed()) target.send('voice-conversation:event', event);
    },
  });
  const observed = new Set<number>();
  const handle = (
    name: string,
    action: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
  ): void => {
    ipcMain.handle(`voice-conversation:${name}`, async (event, ...args: unknown[]) => {
      assertTrustedAppRendererEvent(event);
      try {
        return await action(event, ...args);
      } catch {
        throwIpcError('PRECONDITION_FAILED', 'Voice conversation is unavailable.');
      }
    });
  };
  handle('models', () => service.models());
  handle('start', async (event, raw) => {
    if (isAppSessionBoundaryPending()) throw new Error('changing_account');
    const value = requireObject(raw);
    const selection = normalizeVoiceConversationSelection(value);
    if (!selection) throwIpcError('INVALID_PARAMS', 'Invalid speech selection');
    if (!observed.has(event.sender.id)) {
      observed.add(event.sender.id);
      const sender = event.sender.id;
      event.sender.once('destroyed', () => {
        observed.delete(sender);
        void service.end(sender);
      });
    }
    return service.start(event.sender.id, {
      ...selection,
      callId: boundedString(value.callId, 'callId', 64),
      botId: boundedString(value.botId, 'botId', 256),
      sessionId: boundedString(value.sessionId, 'sessionId', 256),
    });
  });
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
      service.audio(event.sender.id, boundedString(value.callId, 'callId', 64), value.pcm);
    } catch {
      /* Untrusted or late frames are ignored; no payload is logged. */
    }
  });
  handle('finish-utterance', (event, id) =>
    service.finishUtterance(event.sender.id, boundedString(id, 'callId', 64)),
  );
  handle('end', (event, id) => service.end(event.sender.id, boundedString(id, 'callId', 64)));
  handle('interrupt', (event, id) =>
    service.interrupt(event.sender.id, boundedString(id, 'callId', 64)),
  );
  handle('speak', (event, raw) => {
    const value = requireObject(raw);
    return service.speak(
      event.sender.id,
      boundedString(value.callId, 'callId', 64),
      boundedString(value.requestId, 'requestId', 128),
      boundedString(value.text, 'text', 4_096),
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
