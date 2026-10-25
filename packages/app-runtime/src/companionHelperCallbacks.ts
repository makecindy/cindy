import {and,eq,inArray} from 'drizzle-orm';
import type {DbClient} from '@cindy/runtime-db';
import {botSessionLinks,sessions} from '@cindy/runtime-db/schema';
import type {XdtHelperMcpDeps} from '@cindy/mcps';
import {activeCompanionCloud} from '@cindy/companion-core/runtime';
import {isIpcError} from '@cindy/remote-agent/shared/ipc-errors';
import {TodoError,queryTodoItems,type TodoListQuery,type TodoPatch,type preflightTodoEvents} from '@cindy/maker-shared/teammate-todo';
import type {createBotTodoAccess} from './botTodoAccess.js';
import type {createBotProfileService} from './botProfileService.js';
import type {createBotWorkbenchTools,BotWorkbenchHostDeps} from './botWorkbenchTools.js';
type Callbacks=Pick<XdtHelperMcpDeps,'botRoutines'|'teammateHome'|'botProfiles'|'botWorkbench'>;
export function createCompanionHelperCallbacks(host:Pick<ReturnType<typeof createBotWorkbenchTools>,'runBotProjectsTool'|'runBotWorkbenchTool'>&Pick<ReturnType<typeof createBotTodoAccess>,'todoForCaller'>&{activeOwnerScopeKey():string;isAppSessionBoundaryPending():boolean;getActiveAppSession():{dataOwnerId:unknown};tryGetDbClient():DbClient|null;routineTools?:NonNullable<XdtHelperMcpDeps['botRoutines']>['service'];createBotProfile:ReturnType<typeof createBotProfileService>['createBotProfile'];getTaskActionInputState(id:string):{ownerInput:boolean};workbenchHost:BotWorkbenchHostDeps}):Callbacks{
const {activeOwnerScopeKey,isAppSessionBoundaryPending,getActiveAppSession,tryGetDbClient,routineTools,createBotProfile,getTaskActionInputState,workbenchHost,runBotProjectsTool,runBotWorkbenchTool,todoForCaller}=host;
return {
      botRoutines: routineTools ? {
        service: routineTools,
        resolveBotId: async (callerSessionId) => {
          const scope = activeOwnerScopeKey();
          if (!getActiveAppSession().dataOwnerId || isAppSessionBoundaryPending()) {
            throw new Error('Routine account is no longer active');
          }
          const dbClient = tryGetDbClient();
          if (!dbClient) throw new Error('localDb not ready');
          const [owned] = await dbClient.drizzle
            .select({ botId: botSessionLinks.botId })
            .from(botSessionLinks)
            .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
            .where(and(
              eq(botSessionLinks.sessionId, callerSessionId),
              eq(sessions.source, 'bot'),
              // The owner's Bot Chat: the main Chat or one of its private-chat topics.
              inArray(botSessionLinks.role, ['canonical', 'thread']),
            ))
            .limit(1);
          if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scope) {
            throw new Error('Routine account is no longer active');
          }
          if (!owned) throw new Error('当前调用未绑定伙伴主任务');
          return owned.botId;
        },
      } : undefined,
      // 伙伴的主力电脑:与界面同一条路径(本机交出 / 请主力电脑交出 / 在这台电脑继续)。
      teammateHome: {
        get: async ({ teammateId }) => {
          const runtime = activeCompanionCloud();
          if (!runtime) return { ok: false, errorCode: 'NOT_ENABLED', message: 'Cloud companions are not available on this server' };
          const choices = await runtime.homeChoices(teammateId);
          if (choices.reason === 'NOT_FOUND') return { ok: false, errorCode: 'NOT_FOUND', message: 'No such teammate in this account' };
          return { ok: true, teammateId, mode: choices.mode, ...(choices.reason ? { reason: choices.reason } : {}),
            home: choices.homeDeviceId ? { deviceId: choices.homeDeviceId, name: choices.homeName ?? '', isSelf: choices.mode === 'local' } : null,
            choices: choices.targets.map(target => ({ deviceId: target.deviceId, name: target.name, isSelf: target.isSelf === true })) };
        },
        move: async ({ teammateId, targetDeviceId, whenBusy }) => {
          const runtime = activeCompanionCloud();
          if (!runtime) return { ok: false, errorCode: 'NOT_ENABLED', message: 'Cloud companions are not available on this server' };
          const result = await runtime.switchHome(teammateId, targetDeviceId, whenBusy ? { whenBusy } : undefined);
          return result.ok ? { ok: true, teammateId, homeDeviceId: targetDeviceId }
            : { ok: false, errorCode: result.code, message: `The teammate did not move (${result.code})` };
        },
      },
      botProfiles: {
        create: async ({ callerSessionId, name, description, identitySource }) => {
          const dbClient = tryGetDbClient();
          if (!dbClient) {
            return { ok: false, errorCode: 'HOST_NOT_READY', message: 'localDb not ready' };
          }
          const [owned] = await dbClient.drizzle
            .select({ botId: botSessionLinks.botId })
            .from(botSessionLinks)
            .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
            .where(
              and(
                eq(botSessionLinks.sessionId, callerSessionId),
                eq(sessions.source, 'bot'),
                inArray(botSessionLinks.role, ['canonical', 'thread']),
              ),
            )
            .limit(1);
          if (!owned) {
            return { ok: false, errorCode: 'NOT_A_BOT_SESSION', message: '当前调用未绑定伙伴主任务' };
          }
          try {
            const profile = await createBotProfile({
              name,
              description,
              identitySource,
              prepareInvitation: true,
            });
            return {
              ok: true,
              bot: { id: profile.id, name: profile.name, description: profile.description },
            };
          } catch (err) {
            return {
              ok: false,
              errorCode: isIpcError(err) && err.code === 'INVALID_PARAMS' ? 'INVALID_ARGS' : 'INTERNAL',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        },
      },

      botWorkbench: {
        projects: runBotProjectsTool,
        todos: async (caller, operation, input) => {
          try {
            const access = await todoForCaller(caller, () => getTaskActionInputState(caller).ownerInput);
            if (operation === 'list') {
              const all = await access.list();
              const q = (input ?? {}) as TodoListQuery & {id?:string;key?:string};
              if (q.id || q.key) {
                const items = all.items.filter(t => q.id ? t.id === q.id : t.key === q.key);
                return {ok:true,items,total:items.length};
              }
              return {ok:true,...queryTodoItems(all.items,q)};
            }
            if (operation === 'update') return {ok:true,todo:await access.patch(input as TodoPatch)};
            if (operation === 'preflight') return {ok:true,events:await access.preflight(input as Parameters<typeof preflightTodoEvents>[1])};
            return {ok:true,...await access.ingest(input as Parameters<typeof access.ingest>[0])};
          } catch(error) { return {ok:false,errorCode:error instanceof TodoError ? error.code : 'INTERNAL',message:error instanceof Error?error.message:'INTERNAL'}; }
        },
        setResponsibility: (params) => runBotWorkbenchTool(workbenchHost, (access) => access.setResponsibility(params)),
        get: (params) => runBotWorkbenchTool(workbenchHost, (access) => access.get(params)),
        read: (params) => runBotWorkbenchTool(workbenchHost, (access) => access.read(params)),
        continueTask: (params) => runBotWorkbenchTool(workbenchHost, (access) => access.continueTask(params)),
      },

};
}