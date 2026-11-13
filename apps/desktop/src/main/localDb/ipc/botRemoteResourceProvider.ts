import { TEAMMATE_STATUS_ORDER, resolveTeammateStatus } from '@cindy/maker-shared/teammate-status';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
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
import { markBotReadPositions, readBotReadPosition } from '../../maker-ipc/botReadStateStore.js';
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

/**
 * Every live session of each companion — its canonical conversation and live delegations — highest roster
 * priority first. Plugins' cindy.companions collects pending requests from all of them.
 */
export async function rosterBotActivityCandidates(sources: readonly BotRemoteResourceSource[]) {
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
        - TEAMMATE_STATUS_ORDER.indexOf(resolveTeammateStatus({ activities: [b], unread: true }))),
  ]));
}

/** The canonical conversation and live delegations share the local roster priority: the one session the roster shows. */
export async function rosterBotActivities(sources: readonly BotRemoteResourceSource[]) {
  const candidates = await rosterBotActivityCandidates(sources);
  return new Map([...candidates].map(([id, activities]) => [id, activities[0]]));
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
      ...(management ? { actions: [{ id: 'open-create', label: editorCopy.create }, { id: BOT_SETTINGS_ACTION_ID, label: 'Buddy settings' }] } : {}),
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
        // Teammates no longer keep todos. An older computer still opens this page, so answer with
        // an empty list rather than an error; new clients are never linked here.
        const source = await readVisibleBotSource(request.ref.id.slice(6));
        if (!source) throw new RemoteResourceRegistryError('NOT_FOUND', 'Buddy unavailable');
        return { ref: request.ref, revision: 'empty', display: { title: source.name }, links: [],
          blocks: [{ id: 'todos', primitive: 'teammate-todos', fallbackMarkdown: '', data: { items: [], total: 0 } }] };
      }

      if (management && (request.ref.id === 'create' || request.ref.id.startsWith('settings:'))) {
        const resource = await management.getEditor(context, request.ref.id, request.client.locale, { query: request.query, primitives: request.client.primitives });
        if (request.ref.id === 'create') resource.actions = [...(resource.actions ?? []), { id: 'open-agent-import', label: { fallback: 'Import an Agent', translations: { 'zh-CN': '从其他 Agent 导入', 'zh-TW': '從其他 Agent 匯入', ja: 'Agent からインポート', ko: 'Agent에서 가져오기' , "es":"Importar un Agent","fr":"Importer un Agent","de":"Agent importieren","pt-PT":"Importar um Agent","pt-BR":"Importar um Agent","zh-Hant-x-lzh":"自他 Agent 納入","zh-Hans-x-lzh":"自他 Agent 纳入"} } }];
        return resource;
      }
      if (request.ref.id.startsWith('working:')) {
        const [botId, phase, extra] = request.ref.id.slice('working:'.length).split('/');
        if (extra !== undefined || !botId || !WORKING_PHASES.includes(phase as typeof WORKING_PHASES[number]))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Unknown working status');
        const scope = captureDataOwnerBroadcastScope();
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Buddy unavailable');
        const activity = (await rosterBotActivities([source])).get(source.id);
        if (activity?.phase !== 'running' || !isDataOwnerBroadcastScopeCurrent(scope))
          throw new RemoteResourceRegistryError('NOT_FOUND', 'Buddy is not running');
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
        for (const page of ['avatar', 'skills', 'connections', 'projects'] as const) {
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
      return resource;
    },
    async invoke(context, request) {
      if (request.actionId === 'read') {
        // The device showed this conversation up to `at` (host time, the reply it displayed).
        // With `threadSessionId` it is one of the teammate's private-chat topics, which keep their
        // own position and never move the main chat's.
        const scope = captureDataOwnerBroadcastScope();
        const botId = request.resourceRef?.id;
        const at = request.input?.at;
        const threadSessionId = request.input?.threadSessionId;
        if (request.resourceRef?.collectionId !== TEAMMATES_REMOTE_COLLECTION_ID || request.resourceRef.kind !== BOT_REMOTE_RESOURCE_KIND
          || typeof botId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(botId)
          || typeof at !== 'number' || !Number.isFinite(at) || at <= 0
          || (threadSessionId !== undefined && (typeof threadSessionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(threadSessionId)))) {
          throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid read position');
        }
        const source = await readVisibleBotSource(botId);
        if (!source || !isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Buddy unavailable');
        if (threadSessionId !== undefined) {
          const [link] = await getDbClient().drizzle.select({ id: botSessionLinks.id }).from(botSessionLinks).where(and(
            eq(botSessionLinks.botId, botId), eq(botSessionLinks.sessionId, threadSessionId),
            eq(botSessionLinks.role, 'thread'), isNull(botSessionLinks.archivedAt),
          )).limit(1);
          if (!link || !isDataOwnerBroadcastScopeCurrent(scope)) throw new RemoteResourceRegistryError('NOT_FOUND', 'Topic unavailable');
          // A topic reply's time is not in the roster row: never past this computer's clock.
          const key = `thread:${threadSessionId}`;
          markBotReadPositions({ [key]: Math.min(Math.floor(at), Date.now()) });
          return { effects: [], lastReadAt: readBotReadPosition(key) ?? 0 };
        }
        // Never past what exists here: a clock-skewed or future report cannot pre-read replies.
        const latest = Math.max(source.lastMessageAt ?? 0, source.lastReplyAt ?? 0);
        if (latest > 0) markBotReadPositions({ [botId]: Math.min(Math.floor(at), latest) });
        return { effects: [], lastReadAt: readBotReadPosition(botId) ?? 0 };
      }
      if (management && request.actionId === BOT_SETTINGS_ACTION_ID) return management.settingsHost.invoke(context, request);
      if (management && request.actionId === 'open-agent-import' && request.resourceRef?.id === 'create') return {
        effects: [{ kind: 'navigate', target: { kind: 'resource', ref: { collectionId: 'companion-import', kind: 'import', id: 'sources' } } }],
      };
      if (management) return management.invoke(context, request);
      throw new RemoteResourceRegistryError('UNSUPPORTED_CAPABILITY', 'Unknown buddy action');
    },
  });
  getAgentIslandService()?.subscribeSessionActivity(({ sessionId, previous, current }) => {
    if (previous?.phase !== current?.phase || previous?.workingPhase !== current?.workingPhase
      || previous?.startedAtMs !== current?.startedAtMs) scheduleBotRemoteResourceChangedForSession(sessionId);
  });
  registered = true;
}
