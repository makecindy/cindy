import {eq} from 'drizzle-orm';
import {BOT_AUTONOMY_IPC} from '@cindy/companion-core/botAutonomy';
import {botProfiles} from '@cindy/runtime-db/schema';
import {isBotVisibleRemotely} from './botRemoteVisibility.js';
import {requireObject,requireString,throwIpcError} from '@cindy/remote-agent/ipcValidate';
import type {DbClient} from '@cindy/runtime-db';
import type {createBotAutonomyHub} from './botAutonomyHub.js';
import type {MessageServiceHost} from './messageServiceHost.js';
export function createBotAutonomyIpc<Event>(host:Pick<ReturnType<typeof createBotAutonomyHub>,'getBotAutonomyGlance'|'getBotAutonomySettingsView'|'resetBotAutonomySchedulerSettings'|'setBotAutonomySchedulerBotId'>&{
 ipcMain:MessageServiceHost<Event>['ipc'];isDeviceLinkInvoke():boolean;getDbClient():DbClient;assertTrustedAppRendererEvent(event:Event):void;
}) {
 const {ipcMain,isDeviceLinkInvoke,getDbClient,assertTrustedAppRendererEvent,getBotAutonomyGlance,getBotAutonomySettingsView,resetBotAutonomySchedulerSettings,setBotAutonomySchedulerBotId}=host;
function registerBotAutonomyIpc(): void {
  ipcMain.handle(BOT_AUTONOMY_IPC.glance, async (event, rawId: unknown, refreshRemote: unknown = true) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const botId = requireString(rawId, 'botId');
    if (typeof refreshRemote !== 'boolean') throwIpcError('INVALID_PARAMS', 'refreshRemote must be boolean');
    if (remote) {
      // 远程只能看远程可见的伙伴（隐藏 / 归档的伙伴只在本机恢复）。
      const [profile] = await getDbClient().drizzle
        .select({ hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
        .from(botProfiles)
        .where(eq(botProfiles.id, botId))
        .limit(1);
      if (!profile || !isBotVisibleRemotely(profile)) throwIpcError('NOT_FOUND', 'Bot 不存在');
      // 总调度看全部任务：隐藏 / 归档伙伴开的、它的主任务与它在跟的任务也不能经远程露出。
      const profiles = await getDbClient().drizzle
        .select({ id: botProfiles.id, hiddenAt: botProfiles.hiddenAt, status: botProfiles.status })
        .from(botProfiles);
      const excludeBotIds = new Set(profiles.filter((item) => !isBotVisibleRemotely(item)).map((item) => item.id));
      return getBotAutonomyGlance(botId, { excludeBotIds }, refreshRemote);
    }
    return getBotAutonomyGlance(botId, undefined, refreshRemote);
  });

  ipcMain.handle(BOT_AUTONOMY_IPC.settingsGet, async (event) => {
    assertTrustedAppRendererEvent(event);
    return getBotAutonomySettingsView();
  });

  ipcMain.handle(BOT_AUTONOMY_IPC.settingsSet, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'settings');
    const value = body.schedulerBotId;
    if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128)) {
      throwIpcError('INVALID_PARAMS', 'schedulerBotId must be a teammate id or null');
    }
    return setBotAutonomySchedulerBotId(value as string | null);
  });

  ipcMain.handle(BOT_AUTONOMY_IPC.settingsReset, async (event) => {
    assertTrustedAppRendererEvent(event);
    return resetBotAutonomySchedulerSettings();
  });
}

return {registerBotAutonomyIpc};
}
