import {requireObject,requireString,throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {MAKER_INVOKE} from '@cindy/maker-shared/maker-channels';
import type {BotLifecycleActionRequest} from '@cindy/companion-core/botLifecycle';
import type {createBotLifecycleRuntime} from './botLifecycleService.js';
export function registerBotLifecycleActionHandler<Event>(host:{
 ipcMain:{handle(channel:string,handler:(event:Event,...args:any[])=>unknown):void};
 assertTrustedAppRendererEvent(event:Event):void;
 service:ReturnType<ReturnType<typeof createBotLifecycleRuntime>['createBotLifecycleService']>;
}){
 const {ipcMain,assertTrustedAppRendererEvent,service}=host;
  ipcMain.handle(MAKER_INVOKE.BOT_LIFECYCLE_ACTION, async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'request');
    const botId = requireString(body.botId, 'botId');
    const action = requireString(body.action, 'action');
    if (!['pause', 'resume', 'restart', 'delete'].includes(action)) {
      throwIpcError('INVALID_PARAMS', '未知 Bot 生命周期操作');
    }
    return service.run({
      botId,
      action: action as BotLifecycleActionRequest['action'],
      confirmName: typeof body.confirmName === 'string' ? body.confirmName : undefined,
      worktreeDisposition:
        body.worktreeDisposition === 'retain' || body.worktreeDisposition === 'recycle'
          ? body.worktreeDisposition
          : undefined,
      keepTaskHistory: body.keepTaskHistory === true,
    });
  });
}
