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
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap.js';
import {
  getBotRemoteResourceSource,
  listBotRemoteResourceSources,
} from './bots.js';
import { RemoteResourceRegistryError, remoteResourceRegistry } from '../../device-link/remoteResourceRegistry.js';
import { getBotRemoteMessageService } from '../../maker-ipc/botRemoteMessageReceiver.js';
import {
  BOT_REMOTE_RESOURCE_KIND,
  TEAMMATES_REMOTE_COLLECTION_ID,
  TEAMMATES_TITLE,
  botRemoteCollectionItemFromSource,
  botRemoteResourceFromSource,
  visibleBotRemoteResourceSources,
} from './botRemoteResourceProjection.js';

/** Canonical activity wins, then the newest running delegation, like the local roster. */
async function runningBotActivities(sources: readonly BotRemoteResourceSource[]) {
  const running = getAgentIslandService()?.getSessionActivitySnapshots().filter(activity => activity.phase === 'running') ?? [];
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
    (source.canonicalSessionId ? bySession.get(source.canonicalSessionId) : undefined)
      ?? bySession.get(delegated.find(link => link.botId === source.id)?.sessionId ?? ''),
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
      ...(management ? { actions: [{ id: 'open-create', label: editorCopy.create }] } : {}),
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
      const activities = await runningBotActivities(page);
      if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
      const items = page
        .map(source => {
          const item = botRemoteCollectionItemFromSource(source);
          const activity = activities.get(source.id);
          if (activity?.phase === 'running' && activity.workingPhase) {
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
      if (management && (request.ref.id === 'create' || request.ref.id.startsWith('settings:'))) {
        return management.getEditor(context, request.ref.id, request.client.locale, { query: request.query, primitives: request.client.primitives });
      }
      if (request.ref.id.startsWith('working:')) {
        const [botId, phase, extra] = request.ref.id.slice('working:'.length).split('/');
        if (extra !== undefined || !botId || !WORKING_PHASES.includes(phase as typeof WORKING_PHASES[number]))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Unknown working status');
        const scope = captureDataOwnerBroadcastScope();
        const [source] = visibleBotRemoteResourceSources([await getBotRemoteResourceSource(botId)]);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate unavailable');
        const activity = (await runningBotActivities([source])).get(source.id);
        if (!activity || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Teammate is not running');
        const result = await getWorkingStatusCopy({ sessionId: activity.sessionId, phase, locale: resolveSystemLocale(request.client.locale) });
        if (!isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Account changed');
        return { ref: request.ref, revision: String(source.currentVersion), display: { title: source.name }, links: [],
          blocks: [{ id: 'working', primitive: 'status', fallbackMarkdown: result.text ?? '' }] };
      }
      const [source] = visibleBotRemoteResourceSources([
        await getBotRemoteResourceSource(request.ref.id),
      ]);
      if (!source) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'remote resource does not exist');
      }
      const resource = management && request.client.primitives.includes('form') ? await management.get(context, source.id) : management && source.invitation ? await management.getInvitation(context, source.id) : botRemoteResourceFromSource(source);
      if (management && request.client.primitives.includes('form')) {
        for (const page of ['avatar', 'skills', 'connections'] as const) {
          const block = resource.blocks?.find(block => block.id === page);
          const data = { entries: [{ id: page, title: editorCopy[page], resourceId: `settings:${source.id}/${page}` }] };
          if (block) block.data = data;
          else resource.blocks?.push({ id: page, primitive: 'list', fallbackMarkdown: '', data });
        }
        // The `memory` block stays the toggle/USER.md form; saved entries are a separate list page.
        resource.blocks?.push({ id: 'memories', primitive: 'list', fallbackMarkdown: '', data: {
          entries: [{ id: 'memories', title: editorCopy.memories, resourceId: `settings:${source.id}/memory` }],
        } });
      }
      return { ...resource, teammateMessaging: { version: 1, available: source.status === 'active' } };
    },
    async invoke(context, request) {
      const scope = captureDataOwnerBroadcastScope();
      if (request.actionId !== 'send-message' && request.actionId !== 'verify-message' && request.actionId !== 'message-receipt') {
        if (management) return management.invoke(context, request);
        throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Unknown teammate action');
      }
      const input = request.input;
      const validBotId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
      const validMessageId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
      if (!validBotId(request.resourceRef?.id) || !validBotId(request.actionId === 'verify-message' ? input?.targetBotId : input?.senderBotId) || !validMessageId(input?.messageId)
        || (request.actionId !== 'message-receipt' && (typeof input?.message !== 'string' || !input.message.trim() || input.message.length > 12_000))) {
        throw new RemoteResourceRegistryError('NOT_FOUND', 'Invalid teammate message');
      }
      const [source] = visibleBotRemoteResourceSources([await getBotRemoteResourceSource(request.resourceRef.id)]);
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
          messageId: input.messageId, message: input.message as string });
        return { effects: [], verified };
      }
      const teammateMessage = await service.receiveRemote({
        controllerDeviceId: context.controllerDeviceId,
        senderBotId: input.senderBotId as string, targetBotId: request.resourceRef.id,
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
