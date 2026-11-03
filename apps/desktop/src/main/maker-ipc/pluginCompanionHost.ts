import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { COMPANION_LIVE_CHANNEL, COMPANION_LIVE_VERSION, REMOTE_RESOURCE_LIST_CHANNEL } from '@cindy/device-link';
import { resolveTeammateStatus, TEAMMATE_STATUS_ORDER, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import type { PluginCompanionAdapter } from '../cindy-brain/pluginCompanionSlot.js';
import type { PluginCompanion, PluginCompanionInteraction, PluginCompanionReply } from '../../shared/pluginCompanions.js';
import { isSingleBotAvatarGrapheme } from '../../shared/botAvatarValue.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { listBotRemoteResourceSources, type BotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { visibleBotRemoteResourceSources } from '../localDb/ipc/botRemoteResourceProjection.js';
import { rosterBotActivities } from '../localDb/ipc/botRemoteResourceProvider.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { readLatestMirrorRows } from '../companion-cloud/host.js';
import { mirrorMessageText } from '../companion-cloud/mirror.js';
import { companionAvatarThumbnail } from '../agent-island/companionIdentity.js';
import { summarizeInteraction } from '../bot-autonomy/phase.js';

/** Longest reply text handed to a plugin; longer replies are cut and marked truncated. */
export const PLUGIN_COMPANION_REPLY_MAX = 8000;
const REPLY_SCAN_ROWS = 20;
/** Plugins re-list on every change notice; one read per home computer serves them all for this long. */
export const REMOTE_COMPANION_CACHE_MS = 800;
/** A home computer that does not answer in time is shown as unreachable rather than holding the list. */
export const REMOTE_COMPANION_READ_TIMEOUT_MS = 4000;
const MAX_REMOTE_COMPANIONS = 200;
const MAX_TEXT = 200;

const unavailable = (): never => { throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' }); };
const notReady = (): never => { throw Object.assign(new Error('HOST_NOT_READY'), { code: 'HOST_NOT_READY' }); };
const invalid = (): never => { throw Object.assign(new Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
const hash = (...parts: string[]) => createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32);
/** Opaque and stable for one pending request of one task; never the host's own request id. */
const interactionRef = (sessionId: string, requestId: string) => hash(sessionId, requestId);
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : error instanceof Error ? /^\[([A-Z_]+)\]/.exec(error.message)?.[1] ?? '' : '';
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown, max = MAX_TEXT) => typeof value === 'string' ? Array.from(value).slice(0, max).join('') : '';
const time = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const STATUSES: ReadonlySet<string> = new Set(TEAMMATE_STATUS_ORDER);

export interface PluginCompanionRemoteDeps {
  /** This account's other computers; null when computers cannot be reached from here at all. */
  devices(): Promise<ReadonlyArray<{ deviceId: string; name: string; online: boolean; reachable: boolean }> | null>;
  /** Invoke a channel on another computer of the account; rejects with an error carrying `code`. */
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
}

export interface PluginCompanionHostDeps {
  /** Agent and host-owned requests pending in one task (register.ts getPendingInteractionsForSession). */
  pending(sessionId: string): Array<{ request: unknown }>;
  /** Show a task in the main window without stealing focus; `deviceId` for a companion on another computer. */
  openSession(sessionId: string, deviceId?: string): void;
  /** Let replies still being written reach the database before reading them. */
  flushMessages(): Promise<void>;
  /** Reading companions whose home is another computer; without it they are listed as unreachable. */
  remote?: PluginCompanionRemoteDeps;
  now?: () => number;
}

/** What one computer reports about the companions it runs (also the payload of COMPANION_LIVE_CHANNEL). */
interface CompanionView {
  companions: PluginCompanion[];
  /** Interaction ref → the task holding that request, for `open`. Never handed to plugins. */
  sessions: Record<string, string>;
  /** Companion id → its conversation, for `open`. Never handed to plugins. */
  conversations: Record<string, string>;
}

interface RemoteHomeView extends CompanionView {
  reachable: boolean;
  /** False for an older home that only lists status: no requests or replies. */
  live: boolean;
}

const offlineCompanion = (id: string, name: string, deviceName: string | null): PluginCompanion => ({
  id, name, description: '', home: { isSelf: false, online: false, deviceName }, status: 'offline',
  activity: { phase: 'unknown', workingPhase: null, summary: null, startedAt: null, lastActivityAt: null },
  interactions: [], lastReplyAt: null,
});

/** A companion as its home computer reported it, re-checked field by field (it may run another version). */
function parseRemoteCompanion(value: unknown, deviceName: string | null): PluginCompanion | null {
  const item = record(value);
  const activity = record(item.activity);
  const id = text(item.id, 256);
  const status = typeof item.status === 'string' && STATUSES.has(item.status) ? item.status as TeammateStatus : null;
  if (!id || !status) return null;
  const interactions = (Array.isArray(item.interactions) ? item.interactions : []).flatMap((raw): PluginCompanionInteraction[] => {
    const interaction = record(raw);
    const ref = text(interaction.ref, 64);
    const kind = text(interaction.kind, 64);
    return ref && kind ? [{ ref, kind, title: typeof interaction.title === 'string' ? text(interaction.title, 400) : null }] : [];
  }).slice(0, 20);
  return {
    id,
    name: text(item.name),
    description: text(item.description, 400),
    home: { isSelf: false, online: true, deviceName },
    status,
    activity: {
      phase: text(activity.phase, 64) || 'unknown',
      workingPhase: typeof activity.workingPhase === 'string' ? text(activity.workingPhase, 64) : null,
      summary: typeof activity.summary === 'string' ? text(activity.summary, 400) : null,
      startedAt: time(activity.startedAt),
      lastActivityAt: time(activity.lastActivityAt),
    },
    interactions,
    lastReplyAt: time(item.lastReplyAt),
  };
}

const stringMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(value)).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''));

/** An older home: status from the same teammate list the sidebar reads; nothing else is available. */
function parseTeammateList(value: unknown, deviceName: string | null): CompanionView {
  const response = record(value);
  const conversations: Record<string, string> = {};
  const companions = (Array.isArray(response.items) ? response.items : []).slice(0, MAX_REMOTE_COMPANIONS).flatMap((raw): PluginCompanion[] => {
    const item = record(raw);
    const ref = record(item.ref);
    const display = record(item.display);
    const id = text(ref.id, 256);
    if (ref.collectionId !== 'teammates' || !id) return [];
    const phase = text(record(display.teammateActivity).phase, 64) || 'idle';
    const generation = record(display.generation);
    const attention = Array.isArray(display.badges) && display.badges.length > 0;
    const link = (Array.isArray(item.links) ? item.links : []).map(record)
      .find(entry => entry.rel === 'conversation' && record(entry.target).kind === 'session');
    const sessionId = text(record(link?.target).sessionId, 256);
    if (sessionId) conversations[id] = sessionId;
    return [{
      id, name: text(display.title), description: text(display.subtitle, 400),
      home: { isSelf: false, online: true, deviceName },
      status: resolveTeammateStatus({ activities: [{ phase }], unread: attention || phase === 'completed' }),
      activity: {
        phase, workingPhase: phase === 'running' && typeof generation.phase === 'string' ? text(generation.phase, 64) : null,
        summary: null, startedAt: time(generation.startedAt), lastActivityAt: time(display.timestamp),
      },
      interactions: [], lastReplyAt: time(display.lastReplyAt) || null,
    }];
  });
  return { companions, sessions: {}, conversations };
}

/**
 * The data behind `cindy.companions`: the same roster, visibility and status precedence as the desktop
 * sidebar and phones. Companions running here are read locally; companions whose home is another computer
 * are read from that computer (COMPANION_LIVE_CHANNEL), so every computer shows the same thing. Every read
 * re-checks the caller's guard after each await.
 */
export function createPluginCompanionHost(deps: PluginCompanionHostDeps) {
  const now = deps.now ?? Date.now;
  const localSources = async (guard: () => void) => {
    const sources = visibleBotRemoteResourceSources(await listBotRemoteResourceSources());
    guard();
    // A companion whose home is another computer is read from that computer instead.
    return sources.filter(source => companionHomes.isHomeHere(source.id));
  };
  const localSource = async (companionId: string, guard: () => void): Promise<BotRemoteResourceSource> =>
    (await localSources(guard)).find(source => source.id === companionId) ?? unavailable();

  const interactionsOf = (activity: SessionActivitySnapshot | undefined): Array<PluginCompanionInteraction & { sessionId: string }> => {
    if (activity?.phase !== 'needs-interaction') return [];
    return deps.pending(activity.sessionId).flatMap(({ request }) => {
      const summary = summarizeInteraction(request);
      const kind = (request as { kind?: unknown } | null)?.kind;
      if (!summary?.interactionId || typeof kind !== 'string') return [];
      return [{ ref: interactionRef(activity.sessionId, summary.interactionId), kind, title: summary.summary, sessionId: activity.sessionId }];
    });
  };

  const localView = async (guard: () => void): Promise<CompanionView> => {
    const sources = await localSources(guard);
    const activities = await rosterBotActivities(sources);
    guard();
    const view: CompanionView = { companions: [], sessions: {}, conversations: {} };
    for (const source of sources) {
      const activity = activities.get(source.id);
      const interactions = interactionsOf(activity);
      for (const interaction of interactions) view.sessions[interaction.ref] = interaction.sessionId;
      if (source.canonicalSessionId) view.conversations[source.id] = source.canonicalSessionId;
      view.companions.push({
        id: source.id,
        name: source.name,
        description: source.description,
        home: { isSelf: true, online: true, deviceName: null },
        status: resolveTeammateStatus({ activities: [activity], unread: source.needsAttention }),
        activity: {
          phase: activity?.phase ?? 'idle',
          workingPhase: activity?.workingPhase ?? null,
          summary: activity?.currentActionSummary ?? null,
          startedAt: activity?.startedAtMs ?? null,
          lastActivityAt: activity?.lastActivityAtMs ?? null,
        },
        interactions: interactions.map(({ ref, kind, title }) => ({ ref, kind, title })),
        lastReplyAt: source.lastReplyAt ?? null,
      });
    }
    return view;
  };

  const localReply = async (companionId: string, guard: () => void): Promise<PluginCompanionReply | null> => {
    const source = await localSource(companionId, guard);
    const sessionId = source.canonicalSessionId ?? unavailable();
    await deps.flushMessages();
    guard();
    const db = getCurrentDbClientSnapshot()?.client.drizzle ?? notReady();
    const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const rows = await readLatestMirrorRows(sessionId, REPLY_SCAN_ROWS);
    guard();
    // The newest assistant row the companion conversation shows: not private, commentary or sub-agent output.
    for (const row of rows) {
      if (row.role !== 'assistant' || (session?.clearedAt != null && row.createdAt <= session.clearedAt)) continue;
      const replyText = mirrorMessageText(row, { placeholders: false });
      if (!replyText) continue;
      const chars = Array.from(replyText);
      return { text: chars.slice(0, PLUGIN_COMPANION_REPLY_MAX).join(''), createdAt: row.createdAt, truncated: chars.length > PLUGIN_COMPANION_REPLY_MAX };
    }
    return null;
  };

  // —— Companions whose home is another computer ——

  /** Cloud actors running elsewhere, grouped by home computer. */
  const remoteActors = (exclude: ReadonlySet<string>) => {
    const view = companionHomes.snapshot();
    const byHome = new Map<string, Array<{ id: string; name: string }>>();
    if (!view.enabled) return byHome;
    for (const actor of view.actors) {
      if (!actor.homeDeviceId || actor.homeDeviceId === view.selfDeviceId || exclude.has(actor.externalId)) continue;
      byHome.set(actor.homeDeviceId, [...(byHome.get(actor.homeDeviceId) ?? []), { id: actor.externalId, name: actor.name }]);
    }
    return byHome;
  };

  const homeCache = new Map<string, { at: number; view: Promise<RemoteHomeView> }>();
  const unreachableHome = (): RemoteHomeView => ({ companions: [], sessions: {}, conversations: {}, reachable: false, live: false });

  const fetchHome = async (deviceId: string, deviceName: string): Promise<RemoteHomeView> => {
    const remote = deps.remote ?? notReady();
    try {
      const value = record(await remote.invoke(deviceId, COMPANION_LIVE_CHANNEL, [{ version: COMPANION_LIVE_VERSION, kind: 'list' }]));
      const companions = (Array.isArray(value.companions) ? value.companions : []).slice(0, MAX_REMOTE_COMPANIONS)
        .flatMap(item => parseRemoteCompanion(item, deviceName) ?? []);
      return { companions, sessions: stringMap(value.sessions), conversations: stringMap(value.conversations), reachable: true, live: true };
    } catch (error) {
      if (errorCode(error) !== 'CHANNEL_NOT_ALLOWED') throw error;
    }
    const list = await remote.invoke(deviceId, REMOTE_RESOURCE_LIST_CHANNEL, [{
      client: { protocolVersion: 1, primitives: ['status', 'session-link'] }, collectionId: 'teammates', limit: MAX_REMOTE_COMPANIONS,
    }]);
    return { ...parseTeammateList(list, deviceName), reachable: true, live: false };
  };

  /** One read per home computer serves every plugin re-listing within REMOTE_COMPANION_CACHE_MS. */
  const readHome = (deviceId: string, deviceName: string, fresh = false): Promise<RemoteHomeView> => {
    const cached = homeCache.get(deviceId);
    if (!fresh && cached && now() - cached.at < REMOTE_COMPANION_CACHE_MS) return cached.view;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const view = Promise.race([
      fetchHome(deviceId, deviceName),
      new Promise<RemoteHomeView>(resolve => { timer = setTimeout(() => resolve(unreachableHome()), REMOTE_COMPANION_READ_TIMEOUT_MS); }),
    ]).catch(unreachableHome).finally(() => clearTimeout(timer));
    homeCache.set(deviceId, { at: now(), view });
    return view;
  };

  const homeDevices = async (guard: () => void) => {
    const devices = deps.remote ? await deps.remote.devices().catch(() => null) : null;
    guard();
    return new Map((devices ?? []).map(device => [device.deviceId, device]));
  };

  /** The home computer of a companion running elsewhere, reachable from here, or TARGET_UNAVAILABLE. */
  const remoteHome = async (companionId: string, guard: () => void) => {
    const [deviceId] = [...remoteActors(new Set())].find(([, actors]) => actors.some(actor => actor.id === companionId)) ?? unavailable();
    const device = (await homeDevices(guard)).get(deviceId);
    return device?.online && device.reachable ? device : unavailable();
  };

  const isLocal = async (companionId: string, guard: () => void) =>
    (await localSources(guard)).some(source => source.id === companionId);

  const adapter: PluginCompanionAdapter = {
    async list(guard) {
      const local = await localView(guard);
      const byHome = remoteActors(new Set(local.companions.map(companion => companion.id)));
      if (byHome.size === 0) return local.companions;
      const devices = await homeDevices(guard);
      const homes = await Promise.all([...byHome].map(async ([deviceId, actors]) => {
        const device = devices.get(deviceId);
        const view = device?.online && device.reachable ? await readHome(deviceId, device.name) : unreachableHome();
        return { actors, view, deviceName: device?.name ?? null };
      }));
      guard();
      const remote = homes.flatMap(({ actors, view, deviceName }) => actors.flatMap((actor): PluginCompanion[] => {
        if (!view.reachable) return [offlineCompanion(actor.id, actor.name, deviceName)];
        const companion = view.companions.find(item => item.id === actor.id);
        // Reachable but not listed there: hidden, archived or moving; the sidebar does not show it either.
        if (!companion) return [];
        return [{ ...companion, name: companion.name || actor.name }];
      }));
      return [...local.companions, ...remote];
    },

    async avatar(companionId, guard) {
      const local = (await localSources(guard)).find(source => source.id === companionId);
      const view = companionHomes.snapshot();
      const actor = local ? null : view.actors.find(item => item.externalId === companionId && item.homeDeviceId !== view.selfDeviceId);
      if (!local && !actor) return unavailable();
      const avatar = (local?.avatar ?? actor?.avatar ?? '').trim();
      const name = local?.name ?? actor?.name ?? '';
      const fallback = isSingleBotAvatarGrapheme(avatar) ? avatar : Array.from(name.trim())[0] ?? '?';
      const jpeg = avatar && !isSingleBotAvatarGrapheme(avatar) ? await companionAvatarThumbnail(avatar, actor?.homeDeviceId ?? null) : undefined;
      guard();
      return { src: jpeg ? `data:image/jpeg;base64,${jpeg}` : null, fallback };
    },

    async reply(companionId, guard) {
      if (await isLocal(companionId, guard)) return localReply(companionId, guard);
      const device = await remoteHome(companionId, guard);
      try {
        const value = record(await (deps.remote ?? notReady()).invoke(device.deviceId, COMPANION_LIVE_CHANNEL,
          [{ version: COMPANION_LIVE_VERSION, kind: 'reply', companionId }]));
        guard();
        const reply = record(value.reply);
        const createdAt = time(reply.createdAt);
        if (typeof reply.text !== 'string' || createdAt === null) return null;
        const chars = Array.from(reply.text);
        return { text: chars.slice(0, PLUGIN_COMPANION_REPLY_MAX).join(''), createdAt, truncated: reply.truncated === true || chars.length > PLUGIN_COMPANION_REPLY_MAX };
      } catch (error) {
        // An older home cannot be asked for replies.
        if (errorCode(error) === 'CHANNEL_NOT_ALLOWED') return null;
        throw errorCode(error) === 'PERMISSION_DENIED' ? error : Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
      }
    },

    async open(companionId, ref, guard) {
      if (await isLocal(companionId, guard)) {
        const view = await localView(guard);
        if (ref !== undefined) {
          const sessionId = view.sessions[ref];
          const owner = view.companions.find(item => item.id === companionId);
          if (!sessionId || !owner?.interactions.some(item => item.ref === ref)) return unavailable();
          deps.openSession(sessionId);
          return;
        }
        deps.openSession(view.conversations[companionId] ?? unavailable());
        return;
      }
      const device = await remoteHome(companionId, guard);
      const view = await readHome(device.deviceId, device.name, true);
      guard();
      if (!view.reachable) return unavailable();
      if (ref !== undefined) {
        const owner = view.companions.find(item => item.id === companionId);
        const sessionId = view.sessions[ref];
        if (!sessionId || !owner?.interactions.some(item => item.ref === ref)) return unavailable();
        deps.openSession(sessionId, device.deviceId);
        return;
      }
      deps.openSession(view.conversations[companionId] ?? unavailable(), device.deviceId);
    },
  };

  return {
    ...adapter,
    /**
     * COMPANION_LIVE_CHANNEL on this computer: the companions running here, exactly as a plugin here sees
     * them, for plugins on the owner's other computers. Companions running elsewhere are not relayed.
     */
    async serveRemote(raw: unknown) {
      const request = record(raw);
      if (request.version !== COMPANION_LIVE_VERSION) return invalid();
      const noGuard = () => {};
      if (request.kind === 'list') {
        const view = await localView(noGuard);
        return { version: COMPANION_LIVE_VERSION, ...view };
      }
      if (request.kind === 'reply' && typeof request.companionId === 'string' && request.companionId) {
        return { version: COMPANION_LIVE_VERSION, reply: await localReply(request.companionId, noGuard) };
      }
      return invalid();
    },
  };
}

export type PluginCompanionHost = ReturnType<typeof createPluginCompanionHost>;
