import fs from 'node:fs';
import path from 'node:path';
import { createDiscordIM, createWecomIM, createDingTalkIM, createTelegramIM, createFeishuIM, TELEGRAM_DEFAULT_BEHAVIOR, type TelegramIMOptions } from '@cindy/im';
import { createBotImConnectionRuntime, type BotImConnectionRuntimeDeps, type BotImTransportInstance } from '@cindy/app-runtime/botImConnectionRuntime';
import { createBotImLaneRuntime } from '@cindy/app-runtime/botImLaneRuntime';
import { createBotCanonicalSessionRegistry } from '@cindy/app-runtime/botCanonicalSessionRegistry';
import { createImBotBindingRuntime } from '@cindy/app-runtime/imBotBindingRuntime';
import { secretKeyPrefixFor } from '@cindy/app-runtime/botImConnectionStore';
import type { createWechatChannelSettings } from '@cindy/app-runtime/wechatChannelSettings';
import { createRuntimeTranslator } from '@cindy/maker-shared/runtime-i18n';
import { mainLocaleResources } from '../../../desktop/src/shared/mainLocaleResources.js';
import { buildFeishuAdapter } from '@cindy/im-runtime/channels/feishu/adapter';
import { createFeishuUiText } from '@cindy/im-runtime/channels/feishu/uiText';
import { buildTelegramAdapter } from '@cindy/im-runtime/channels/telegram/adapter';
import { telegramUiText } from '@cindy/im-runtime/channels/telegram/uiText';
import { buildPersonalBotCommandMenu } from '@cindy/im-runtime/botCommands';
import { buildDingTalkAdapter, dingtalkManagedWorkingDirName } from '@cindy/im-runtime/channels/dingtalk/adapter';
import { buildWecomAdapter } from '@cindy/im-runtime/channels/wecom/adapter';
import { WecomTextInteractions } from '@cindy/im-runtime/channels/wecom/textInteractions';
import { buildDiscordAdapter } from '@cindy/im-runtime/channels/discord/adapter';
import { discordUiText } from '@cindy/im-runtime/channels/discord/uiText';
import { IM_DEFAULT_SETTINGS, IM_DEFAULT_EFFORT_OVERRIDES } from '@cindy/im-runtime/imDefaultSettings';
import type { ImChannelAdapter } from '@cindy/im-runtime/types';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { TerminalImTransportHost } from './transport-host.js';
import type { TerminalGroupWindows } from './group-window.js';
import type { Logger } from '@cindy/maker-core';
import type { RuntimeLocale } from '@cindy/maker-shared/runtime-i18n';
import { channelPermissionUnavailable } from '../ui/i18n.js';

/** Host ports only: connection admission, credential isolation, lane scope and
 * removal are the same runtime consumed by the graphical application. */
export async function createTerminalCompanionIm(options: {
  tasks: TerminalTaskHost; transport: TerminalImTransportHost; groups: TerminalGroupWindows;
  root: string; logger: Logger; guard(): void; locale(): RuntimeLocale;
  wechatSettings: ReturnType<typeof createWechatChannelSettings>;
  resolveFeishuNotificationReply: Parameters<typeof buildFeishuAdapter>[2]['resolveFeishuNotificationReply'];
  telegram: Pick<Parameters<typeof buildTelegramAdapter>[2], 'readTelegramPersona' | 'autoRegisterTelegramSpeaker'>;
  telegramOptions?:Pick<TelegramIMOptions,'apiFactory'>;
  removeWechatCompanionBinding: BotImConnectionRuntimeDeps['removeWechatCompanionBinding'];
}) {
  const { tasks, transport, groups } = options;
  if (!tasks.bots) throw new Error('BOT_SERVICES_NOT_READY');
  const bots=tasks.bots, database=await tasks.database;
  const getDbClient=()=>{options.guard();return database.getDbClient();};
  const routes=createImBotBindingRuntime({getDbClient,...bots.profiles,...createBotCanonicalSessionRegistry(getDbClient),
    tryGetBotDelegationService:()=>tasks.botDelegations??null,
    prepareBotSessionForImSend:id=>tasks.prepareBotSessionForImSend(id),
  });
  const lanes=createBotImLaneRuntime({getDbClient,...tasks.botImConnections,log:options.logger});
  lanes.configureBotImLaneRuntime({isTurnRunning:id=>tasks.isTurnRunning(id),
    restartSession:id=>tasks.restartOriginalBotRuntime(id,options.guard)});
  const runtime=createBotImConnectionRuntime<undefined>({
    ...tasks.botImConnections,...tasks.botProfileLocks,...bots.profiles,...lanes,...options.wechatSettings,
    getDbClient,log:options.logger,ownerScopedImSecrets:transport.host.secrets,
    ipcMain:{handle:(channel,handler)=>transport.host.ipc.handle(channel,payload=>handler(undefined,payload))},
    assertTrustedAppRendererEvent:()=>options.guard(),broadcast:transport.host.ipc.broadcast,
  });
  const {t}=createRuntimeTranslator(mainLocaleResources,options.locale);
  const config={agentKind:IM_DEFAULT_SETTINGS.agentKind,defaultModel:IM_DEFAULT_SETTINGS.agents[IM_DEFAULT_SETTINGS.agentKind].model,
    defaultPermissionMode:IM_DEFAULT_SETTINGS.permissionMode,effortOverrides:IM_DEFAULT_EFFORT_OVERRIDES};
  const directory=(name:string)=>{options.guard();const dir=path.join(options.root,'im-working-dir',name);fs.mkdirSync(dir,{recursive:true,mode:0o700});return dir;};
  const validatedDirectory=(prefix:string)=>(id:string)=>{if(!/^[\w-]{1,128}$/.test(id))throw new Error('INVALID_IM_CONTEXT');return directory(prefix+id);};
  const resolveImageUrl=(url:string)=>{const file=transport.host.media!.resolveMediaUrl(url);if(!file)throw new Error('INVALID_MEDIA_URL');return file;};
  runtime.configureBotImConnectionRuntime({
    removeWechatCompanionBinding:options.removeWechatCompanionBinding,
    settingsIdentity:()=>({telegramToken:transport.host.secrets.read('telegram-bot-token')?.trim()||null,
      feishuAppId:transport.host.secrets.read('feishu_bot_app_id')?.trim()||null,wecomBotId:transport.host.secrets.read('wecom-bot-id')?.trim()||null,
      dingtalkAppKey:transport.host.secrets.read('dingtalk-bot-app-key')?.trim()||null,discordToken:transport.host.secrets.read('discord-bot-token')?.trim()||null}),
    listKnownGroups:record=>record.channel==='telegram'&&record.botContextId
      ?groups.channel('telegram-personal').listKnownGroups(record.botContextId):Promise.resolve([]),
    create(record):BotImTransportInstance {
      options.guard();
      const secretKeyPrefix=secretKeyPrefixFor(record.id),common={secretKeyPrefix,ipc:false};
      const attach=(adapter:ImChannelAdapter)=>tasks.channelOrchestrators.attach(adapter,{instanceKey:`${record.channel}#${record.id}`,companion:routes.createImCompanionRouteDeps(record.botId)});
      if(record.channel==='feishu'){
        const im=createFeishuIM(transport.host,{...common,guests:true});
        const orchestrator=attach(buildFeishuAdapter(im,config,{log:options.logger,ui:createFeishuUiText(()=>channelPermissionUnavailable(options.locale())),
          readImDefaultSettings:channel=>tasks.channelDefaults.read(channel),
          resolveFeishuNotificationReply:options.resolveFeishuNotificationReply,
          requestUtilityText:(prompt,opts)=>tasks.requestChannelUtilityText('feishu',prompt,opts),
          ensureWorkingDir:validatedDirectory(''),
        }));return {kind:'feishu',im,orchestrator};
      }
      if(record.channel==='telegram'){
        const im=createTelegramIM(transport.host,{...options.telegramOptions,...common,guestDm:true,resolveImageUrl,expiredCardNotice:telegramUiText.expiredCardNotice,
          ownerNoticeText:phase=>t(`settings.telegramBot.ownerNotice.${phase}`),
          behavior:()=>({...TELEGRAM_DEFAULT_BEHAVIOR,groupActivation:tasks.botImConnections.readBotImConnection(record.id)?.groupActivation}),
          commandMenu:buildPersonalBotCommandMenu(key=>t(key),{surface:'companion'}),
        });
        const window=groups.channel('telegram-personal');
        const orchestrator=attach(buildTelegramAdapter(im,config,{
          ...options.telegram,
          buildTelegramGroupContextPrefix:args=>window.buildContextPrefix(args),
          ensureWorkingDir:validatedDirectory('telegram-'),
        },{companionBotId:record.botId}));
        const off=im.onGroupWindowMessage(entry=>{
          const account=tasks.channelControl.account,generation=account.captureImAccountGeneration();
          if(generation!==null)void account.runInImAccountGeneration(generation,()=>window.record(entry)).catch(()=>options.logger.warn('IM_GROUP_HISTORY_RECORD_FAILED'));
        });
        const unregister=orchestrator.unregister;orchestrator.unregister=()=>{off();unregister();};
        return {kind:'telegram',im,orchestrator};
      }
      if(record.channel==='wecom'){
        const im=createWecomIM(transport.host,common);
        return {kind:'wecom',im,orchestrator:attach(buildWecomAdapter(im,new WecomTextInteractions(im),config,{
          log:options.logger,window:groups.channel('wecom-personal'),
          ensureWorkingDir:id=>directory(`wecom-${Buffer.from(id,'utf8').toString('base64url').slice(0,96)}`),
        }))};
      }
      if(record.channel==='dingtalk'){
        const im=createDingTalkIM(transport.host,{...common,fetcher:fetch});
        return {kind:'dingtalk',im,orchestrator:attach(buildDingTalkAdapter(im,config,{log:options.logger,
          window:groups.channel('dingtalk-personal'),ensureWorkingDir:id=>directory(dingtalkManagedWorkingDirName(id))}))};
      }
      const im=createDiscordIM(transport.host,{...common,resolveImageUrl,expiredCardNotice:discordUiText.expiredCardNotice,
        ownerNoticeText:phase=>t(`settings.discordBot.ownerNotice.${phase}`)});
      return {kind:'discord',im,orchestrator:attach(buildDiscordAdapter(im,config,validatedDirectory('discord-')))};
    },
  });
  runtime.registerBotImConnectionIpc();
  return { ...runtime, routes };
}
