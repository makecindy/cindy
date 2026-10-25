import { BrowserWindow, ipcMain } from 'electron';
import { createBotImConnectionRuntime } from '@cindy/app-runtime/botImConnectionRuntime';
import { getDbClient } from '../../localDb/client/current';
import { archiveBotChannelLanes } from '../../localDb/ipc/bots';
import { withBotProfileLocks } from '../../maker-ipc/botProfileLock';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { createLogger } from '../../logger';
import { ownerScopedImSecrets } from '../ownerScopedStorage';
import { readWechatChannelSettings, writeWechatCompanionBinding } from '../wechat/channelSettings';
import * as store from './botImConnectionStore';
import { listBotImConnectionLanes, resetBotImConnectionLane, archiveBotImConnectionLane } from './botImLaneRuntime';
export type { BotImTransportInstance, BotImSettingsIdentity, BotImConnectionRuntimeDeps, BotImConnectionAddOptions } from '@cindy/app-runtime/botImConnectionRuntime';
export { SECRET_KEYS_BY_CHANNEL, IDENTITY_SECRET_KEY } from '@cindy/app-runtime/botImConnectionRuntime';
export const { configureBotImConnectionRuntime, buildBotImConnectionListPayload, startBotImConnections, stopBotImConnections, getBotImConnectionOrchestrator, getBotFeishuTransport, findBotImConnectionByIdentity, assertBotImConnectionAddable, addBotImConnection, listBotImConnectionGroups, setBotImConnectionGroupMode, removeBotImConnection, setWechatCompanionBinding, removeBotImConnectionsForBot, parseBotImConnectionAddInput, registerBotImConnectionIpc, __testing }=createBotImConnectionRuntime({
  ...store,getDbClient,archiveBotChannelLanes,withBotProfileLocks,assertTrustedAppRendererEvent,
  ipcMain,ownerScopedImSecrets,readWechatChannelSettings,writeWechatCompanionBinding,
  listBotImConnectionLanes,resetBotImConnectionLane,archiveBotImConnectionLane,log:createLogger('im:bot-connections'),
  broadcast(channel,payload){for(const win of BrowserWindow.getAllWindows()){
    if(win.isDestroyed())continue;
    try{win.webContents.send(channel,payload);}catch{/* Best-effort refresh. */}
  }},
});
