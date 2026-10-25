import {desc} from 'drizzle-orm';
import {botProfiles} from '@cindy/runtime-db/schema';
import type {DbClient} from '@cindy/runtime-db';
import {requireString,throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {normalizeBotWelcomeContext} from '@cindy/companion-core/botWelcomeContext';
import type {createBotProfileService} from './botProfileService.js';
import type {createBotModelChainSettings} from './botModelChainSettings.js';
import type {createAppDefaultModelControl} from './appDefaultModelControl.js';
import type {createBotCapabilityRuntime} from './botCapabilityService.js';
type Profiles=ReturnType<typeof createBotProfileService>;
export function registerBotProfileHandlers<Event>(host:Pick<Profiles,'captureBotOperationOwner'|'readBotInvitationLocale'|'provisionDefaultBotForList'|'readLastReadAtMap'|'queueBotInvitation'|'readRemoteBotProfile'|'readProfile'|'createBotProfile'|'updateBotProfile'|'createBotCanonicalSession'|'readText'> & Pick<ReturnType<typeof createBotModelChainSettings>,'readBotModelChainSettingsState'|'writeBotModelChainSettings'|'resetBotModelChainSettings'|'readEffectiveBotModelChain'> & Pick<ReturnType<typeof createAppDefaultModelControl>,'validateTaskModel'> & {
 getDbClient():DbClient;
 tryGetDbClient():DbClient|null;
 isDeviceLinkInvoke():boolean;
 assertTrustedAppRendererEvent(event:Event):void;
 ipcMain:{handle(channel:string,handler:(event:Event,...args:any[])=>unknown):void};
 validateBotCapabilityAdditions:ReturnType<ReturnType<typeof createBotCapabilityRuntime>['createBotCapabilityService']>['validateAdditions'];
}) {
 const {ipcMain,isDeviceLinkInvoke,assertTrustedAppRendererEvent,getDbClient,tryGetDbClient,captureBotOperationOwner,readBotInvitationLocale,provisionDefaultBotForList,readLastReadAtMap,queueBotInvitation,readRemoteBotProfile,readProfile,createBotProfile,updateBotProfile,readBotModelChainSettingsState,writeBotModelChainSettings,resetBotModelChainSettings,readEffectiveBotModelChain,validateTaskModel,validateBotCapabilityAdditions,createBotCanonicalSession,readText}=host;
  ipcMain.handle('local-db:bots:model-chain-settings-get', async (event) => {
    assertTrustedAppRendererEvent(event);
    const state = await readBotModelChainSettingsState();
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  ipcMain.handle('local-db:bots:model-chain-settings-set', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const state = await writeBotModelChainSettings(body.modelChain);
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  // Global model preferences are desktop-local settings, like get/set above.
  ipcMain.handle('local-db:bots:model-chain-settings-reset', async (event) => {
    assertTrustedAppRendererEvent(event);
    const owner = captureBotOperationOwner();
    try {
      const state = await resetBotModelChainSettings();
      owner.assertCurrent();
      return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
    } catch {
      owner.assertCurrent();
      throwIpcError('INTERNAL', 'Could not restore Bot model defaults');
    }
  });

  ipcMain.handle('local-db:bots:list', async (event, raw: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = tryGetDbClient();
    if (!client) return [];
    const owner = captureBotOperationOwner();
    const welcomeContext = !remote && raw && typeof raw === 'object'
      ? normalizeBotWelcomeContext((raw as Record<string, unknown>).welcomeContext) : undefined;
    const locale = !remote && raw && typeof raw === 'object'
      ? readBotInvitationLocale((raw as Record<string, unknown>).locale) : undefined;
    await provisionDefaultBotForList(client, owner, welcomeContext, locale);
    const db = client.drizzle;
    // Unread accounting is opt-in: the read position lives in the renderer, so
    // a caller that has none (device-link, first boot) simply gets zeros.
    const lastReadAtByBotId = remote ? new Map<string, number>() : readLastReadAtMap(raw);
    const profiles = await db
      .select({ id: botProfiles.id, status: botProfiles.status })
      .from(botProfiles)
      .orderBy(desc(botProfiles.updatedAt));
    // Resume persisted invitations only; listing existing teammates never seeds Skills.
    if (!remote) {
      for (const { id, status } of profiles) {
        if (status !== 'archived') queueBotInvitation(id);
      }
    }
    const results = [];
    for (const { id } of profiles) {
      owner.assertCurrent();
      results.push(await (remote
        ? readRemoteBotProfile(client, id)
        : readProfile(client, id, lastReadAtByBotId.get(id) ?? null)));
    }
    owner.assertCurrent();
    return results.filter((profile) => profile !== null);
  });

  ipcMain.handle('local-db:bots:get', async (event, rawId: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = getDbClient();
    const botId = requireString(rawId, 'botId');
    if (!remote) return readProfile(client, botId);
    const profile = await readRemoteBotProfile(client, botId);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile;
  });

  ipcMain.handle('local-db:bots:create', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (body.prepareInvitation === true) {
      const owner = captureBotOperationOwner();
      const capabilities = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
        ? body.capabilities as Record<string, unknown> : {};
      const [primary] = await readEffectiveBotModelChain(capabilities);
      owner.assertCurrent();
      const available = primary && await validateTaskModel(primary);
      owner.assertCurrent();
      if (!available) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
    }
    return createBotProfile(raw);
  });

  ipcMain.handle('local-db:bots:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return updateBotProfile(raw, undefined, validateBotCapabilityAdditions);
  });


  ipcMain.handle('local-db:bots:create-canonical-session', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    if (!Object.prototype.hasOwnProperty.call(body, 'expectedCanonicalSessionId')) {
      throwIpcError('INVALID_PARAMS', 'expectedCanonicalSessionId 必须显式提供');
    }
    const expectedCanonicalSessionId =
      body.expectedCanonicalSessionId === null
        ? null
        : readText(body.expectedCanonicalSessionId, 'expectedCanonicalSessionId', 128, true);
    if (!Number.isInteger(body.expectedProfileVersion) || Number(body.expectedProfileVersion) < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    if (body.recoverMissingOnly !== undefined && typeof body.recoverMissingOnly !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'recoverMissingOnly 必须是 boolean');
    }
    return createBotCanonicalSession({
      botId,
      expectedCanonicalSessionId,
      expectedProfileVersion: Number(body.expectedProfileVersion),
      recoverMissingOnly: body.recoverMissingOnly === true,
    });
  });

}
