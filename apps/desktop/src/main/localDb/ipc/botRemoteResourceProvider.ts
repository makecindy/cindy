import { TEAMMATE_STATUS_ORDER, resolveTeammateStatus } from '@cindy/maker-shared/teammate-status';
import { readForwardedRequestSource } from '../../../shared/forwardedRequest.js';
import { createHash } from 'node:crypto';
import { botTodoRemoteProjection } from './botTodoRemoteProjection.js';
import { todoAccess } from '../../maker-ipc/botTodoAccess.js';
import { queryTodoItems, type TodoListQuery, type TodoPatch } from '@cindy/maker-shared/teammate-todo';
import { and, desc, inArray, isNull } from 'drizzle-orm';
import { getDbClient } from '../client/current.js';
import { botSessionLinks } from '../schema.js';
import type { BotRemoteResourceSource } from './bots.js';
import { getAgentIslandService } from '../../agent-island/service.js';
import { scheduleBotRemoteResourceChangedForSession } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { getWorkingStatusCopy } from '../../maker-ipc/workingStatus.js';
import { WORKING_PHASES } from '../../../shared/workingStatus.js';
import { resolveSystemLocale } from '../../../shared/locale.js';
import type { botRemoteManagement } from './botRemoteManagement.js';
import { editorCopy } from './botRemoteEditors.js';
import { BOT_SETTINGS_ACTION_ID } from '../../../shared/botRemoteSettings.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import {
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from './bots.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { routineTools } from '../../routines/service.js';
import { broadcastBotRemoteResourceChanged } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { getBotRemoteMessageService } from '../../maker-ipc/botRemoteMessageReceiver.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
  TEAMMATES_TITLE,
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';

/**
 * A missing or hidden teammate is an ordinary absence. `readBotRemoteResourceSource`
 * reports that as `[NOT_FOUND]`; leaving it uncaught makes the registry wrap the
 * read as INTERNAL, so other devices show "the remote call did not complete".
 * The roster skips the same absence one companion at a time in `listBotRemoteResourceSources`.
 */
async function readVisibleBotSource(botId: string): Promise<BotRemoteResourceSource | null> {
  try {
    const [source] = visibleBotRemoteResourceSources([await getBotRemoteResourceSource(botId)]);
    return source ?? null;
  } catch (error) {
    if (isIpcError(error) && error.code === 'NOT_FOUND') return null;
    throw error;
  }
}

/** The canonical conversation and live delegations share the local roster priority. */
async function rosterBotActivities(sources: readonly BotRemoteResourceSource[]) {
  const running = getAgentIslandService()?.getSessionActivitySnapshots() ?? [];
  const bySession = new Map(running.map(activity => [activity.sessionId, activity]));
  const delegated = sources.length && running.length ? await getDbClient().drizzle
    .select({ botId: botSessionLinks.botId, sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks).where(and(
      inArray(botSessionLinks.botId, sources.map(source => source.id)),
      inArray(botSessionLinks.sessionId, running.map(activity => activity.sessionId)),
      inArray(botSessionLinks.role, ['canonical', 'delegation']),
      isNull(botSessionLinks.archivedAt),
    )).orderBy(desc(botSessionLinks.createdAt)) : [];
  return new Map(sources.map(source => [source.id,
    [...(source.canonicalSessionId ? [bySession.get(source.canonicalSessionId)] : []),
      ...delegated.filter(link => link.botId === source.id).map(link => bySession.get(link.sessionId))]
      .filter(activity => !!activity).sort((a, b) =>
        TEAMMATE_STATUS_ORDER.indexOf(resolveTeammateStatus({ activities: [a], unread: true }))
        - TEAMMATE_STATUS_ORDER.indexOf(resolveTeammateStatus({ activities: [b], unread: true })))[0],
  ]));
}

let registered = false;

/** Register the Bot module through the same API future host modules use. */
export function registerBotRemoteResourceProvider(management?: typeof botRemoteManagement): void {
  if (registered) return;
  remoteResourceRegistry.register({
    collection: {
      id: TEAMMATES_REMOTE_COLLECTION_ID,
      resourceKind: BOT_REMOTE_RESOURCE_KIND,
      title: TEAMMATES_TITLE,
      placement: 'home-scope',
      icon: { name: 'users', fallbackText: '••' },
      // `management:settings` tells a desktop controller this host runs the teammate settings pages itself.
      ...(management ? { actions: [{ id: 'open-create', label: editorCopy.create }, { id: BOT_SETTINGS_ACTION_ID, label: 'Teammate settings' }] } : {}),
    },
    async list(_context, request) {
      const scope = captureDataOwnerBroadcastScope();
      const rawQuery = request.query?.trim().toLocaleLowerCase() ?? '';
      const sources = visibleBotRemoteResourceSources(await listBotRemoteResourceSources());
      const filtered = rawQuery
        ? sources.filter((source) =>
            [source.name, source.description]
              .some((value) => value.toLocaleLowerCase().includes(rawQuery)))
        : sources;
      const page = filtered.slice(0, request.limit ?? 200);
      const activities = await rosterBotActivities(page);
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const items = page
        .map(source => {
          const item = botRemoteCollectionItemFromSource(source);
          const activity = activities.get(source.id);
          if (activity && activity.phase !== 'idle') {
            item.display.teammateActivity = { phase: activity.phase };
            item.revision += `:${activity.phase}`;
          }
          if (activity?.phase === 'running') {
            item.display.generation = { phase: activity.workingPhase ?? 'processing', startedAt: activity.startedAtMs };
            item.revision += `:${activity.startedAtMs}:${item.display.generation.phase}`;
          }
          return item;
        });
      return {
        collectionId: TEAMMATES_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
      };
    },
    async get(context, request) {
      if (request.ref.id.startsWith('todos:')) {
        const scope = captureDataOwnerBroadcastScope();
        const botId = request.ref.id.slice(6);
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
        const all = await (await todoAccess(botId)).list();
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        const page = queryTodoItems(all.items, request.query ? JSON.parse(request.query) as TodoListQuery : {});
        page.items = page.items.map(botTodoRemoteProjection);
        // 近况「每天帮我查一次」的当前状态；旧客户端忽略，新客户端缺这个字段（旧宿主）时不显示开关。
        // 例行任务读不到（引擎未就绪、伙伴暂停）时不带这个字段，待办照常返回。
        const dailyCheck = await routineTools.todoCheckEnabled(botId).catch(() => undefined);
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        return {ref:request.ref,revision:createHash('sha256').update(JSON.stringify(all.items)).digest('hex'),display:{title:source.name},links:[],
          blocks:[{id:'todos',primitive:'teammate-todos',fallbackMarkdown:page.items.map(t=>t.title+' — '+t.progress).join('\n').slice(0,8000),data:{...page,...(dailyCheck === undefined ? {} : {dailyCheck})}}]};
      }

      if (management && (request.ref.id === 'create' || request.ref.id.startsWith('settings:'))) {
        const resource = await management.getEditor(context, request.ref.id, request.client.locale, { query: request.query, primitives: request.client.primitives });
        if (request.ref.id === 'create') resource.actions = [...(resource.actions ?? []), { id: 'open-agent-import', label: { fallback: 'Import an Agent', translations: { 'zh-CN': '从其他 Agent 导入', 'zh-TW': '從其他 Agent 匯入', ja: 'Agent からインポート', ko: 'Agent에서 가져오기' } } }];
        return resource;
      }
      if (request.ref.id.startsWith('working:')) {
        const [botId, phase, extra] = request.ref.id.slice('working:'.length).split('/');
        if (extra !== undefined || !botId || !WORKING_PHASES.includes(phase as typeof WORKING_PHASES[number]))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Unknown working status');
        const scope = captureDataOwnerBroadcastScope();
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
        const activity = (await rosterBotActivities([source])).get(source.id);
        if (activity?.phase !== 'running' || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate is not running');
        const result = await getWorkingStatusCopy({ sessionId: activity.sessionId, phase, locale: resolveSystemLocale(request.client.locale) });
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        return { ref: request.ref, revision: String(source.currentVersion), display: { title: source.name }, links: [],
          blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: result.text ?? '' }] };
      }
      const source = await readVisibleBotSource(request.ref.id);
      if (!source) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      }
      const resource = management && request.client.primitives.includes('form') ? await management.get(context, source.id) : management && source.invitation ? await management.getInvitation(context, source.id) : botRemoteResourceFromSource(source);
      if (management && request.client.primitives.includes('form')) {
        for (const page of ['avatar', 'skills', 'connections', 'projects', 'followUp'] as const) {
          const block = resource.blocks?.find(block => block.id === page);
          const data = { entries: [{ id: page, title: editorCopy[page], resourceId: `settings:${source.id}/${page === 'followUp' ? 'follow-up' : page}` }] };
          if (block) block.data = data;
          else resource.blocks?.push({ id: page, primitive: 'list', fallbackMarkdown: '', data });
        }
        // The `memory` block stays the toggle/USER.md form; saved entries are a separate list page.
        resource.blocks?.push({ id: 'memories', primitive: 'list', fallbackMarkdown: '', data: {
          entries: [{ id: 'memories', title: editorCopy.memories, resourceId: `settings:${source.id}/memory` }],
        } });
      }
      resource.links = [...(resource.links ?? []), {rel:'todos',label:{fallback:'Todos',translations:{'zh-CN':'待办','zh-TW':'待辦',ja:'Todo',ko:'할 일'}},target:{kind:'resource',ref:{collectionId:TEAMMATES_REMOTE_COLLECTION_ID,kind:'bot',id:'todos:'+source.id}}}];
      return { ...resource, teammateMessaging: { version: 1, available: source.status === 'active' } };
    },
    async invoke(context, request) {
      if (request.actionId === 'todo-update' || request.actionId === 'todo-act') {
        const scope = captureDataOwnerBroadcastScope();
        if (!request.resourceRef?.id.startsWith('todos:')) throw new RemoteResourceRegistryError('NOT_FOUND', 'Todo resource required');
        const botId = request.resourceRef.id.slice(6);
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
        const access = await todoAccess(botId);
        const input = request.input ?? {};
        const result = request.actionId === 'todo-update' ? await access.patch(input as TodoPatch) : await access.act(input.id as string,input.revision as number,input.requestId as string,request.client.locale);
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        return {effects:[],todo:result ? botTodoRemoteProjection(result) : null};
      }
      if (request.actionId === 'todo-daily-check') {
        const scope = captureDataOwnerBroadcastScope();
        if (!request.resourceRef?.id.startsWith('todos:')) throw new RemoteResourceRegistryError('NOT_FOUND', 'Todo resource required');
        const botId = request.resourceRef.id.slice(6);
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
        if (typeof request.input?.enabled !== 'boolean') throw new RemoteResourceRegistryError('INVALID_PARAMS', 'enabled must be boolean');
        const dailyCheck = await routineTools.setTodoCheck(botId, request.input.enabled);
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        broadcastBotRemoteResourceChanged(botId);
        return { effects: [], dailyCheck };
      }

      if (management && request.actionId === BOT_SETTINGS_ACTION_ID) return management.settingsHost.invoke(context, request);
      if (management && request.actionId === 'open-agent-import' && request.resourceRef?.id === 'create') return {
        effects: [{ kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'companion-import', kind: 'import', id: 'sources' } } }],
      };
      const scope = captureDataOwnerBroadcastScope();
      if (request.actionId !== 'send-message' && request.actionId !== 'verify-message' && request.actionId !== 'message-receipt') {
        if (management) return management.invoke(context, request);
        throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Unknown teammate action');
      }
      const input = request.input;
      const requestSource = readForwardedRequestSource(input?.requestSource);
      if (input?.requestSource !== undefined && !requestSource) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid teammate request source');
      }
      const validBotId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
      const validMessageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
      if (!validBotId(request.resourceRef?.id) || !validBotId(request.actionId === 'verify-message' ? input?.targetBotId : input?.senderBotId) || !validMessageId(input?.messageId)
        || (request.actionId !== 'message-receipt' && (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > (input.requestSource ? 200_000 : 12_000)))) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid teammate message');
      }
      const source = await readVisibleBotSource(request.resourceRef.id);
      if (!source) throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const service = getBotRemoteMessageService();
      if (!service) throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Teammate messaging is unavailable');
      if (request.actionId === 'message-receipt') {
        const receipt = await service.readRemoteReceipt({ controllerDeviceId: context.controllerDeviceId,
          senderBotId: input.senderBotId as string, targetBotId: request.resourceRef.id,
          messageId: input.messageId });
        return { effects: [], ...receipt };
      }
      if (request.actionId === 'verify-message') {
        const verified = await service.verifyRemoteMessage({ controllerDeviceId: context.controllerDeviceId,
          senderBotId: request.resourceRef.id, targetBotId: input.targetBotId as string,
          ...(requestSource ? { requestSource } : {}),
          messageId: input.messageId, message: input.message as string });
        return { effects: [], verified };
      }
      const teammateMessage = await service.receiveRemote({
        controllerDeviceId: context.controllerDeviceId,
        senderBotId: input.senderBotId as string, targetBotId: request.resourceRef.id,
        ...(requestSource ? { requestSource } : {}),
        messageId: input.messageId, message: input.message as string,
      });
      return { effects: [], teammateMessage };
    },
  });
  getAgentIslandService()?.subscribeSessionActivity(({ sessionId, previous, current }) => {
    if (previous?.phase !== current?.phase || previous?.workingPhase !== current?.workingPhase
      || previous?.startedAtMs !== current?.startedAtMs) scheduleBotRemoteResourceChangedForSession(sessionId);
  });
  registered = true;
}
