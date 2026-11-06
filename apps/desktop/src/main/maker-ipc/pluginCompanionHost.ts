import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { COMPANION_LIVE_CHANNEL, COMPANION_LIVE_VERSION, REMOTE_RESOURCE_LIST_CHANNEL } from '@cindy/device-link';
import { resolveTeammateStatus, TEAMMATE_STATUS_ORDER, type TeammateStatus } from '@cindy/maker-shared/teammate-status';
import type { SessionActivitySnapshot } from '@cindy/maker-shared/session-activity';
import { answerKey, describePermissionAction, encodeMultiSelectAnswer, normalizeAskQuestions } from '@cindy/maker-shared/interaction';
import type { PluginCompanionAdapter } from '../cindy-brain/pluginCompanionSlot.js';
import type {
  PluginCompanion, PluginCompanionAnswer, PluginCompanionHistory, PluginCompanionInteraction, PluginCompanionInteractionDetail, PluginCompanionInteractionKind,
  PluginCompanionMessage, PluginCompanionReply,
} from '../../shared/pluginCompanions.js';
import { OWNER_ONLY_HOST_CONFIRMATION_TOOL_NAMES } from '../agent-app-update/constants.js';
import { isSingleBotAvatarGrapheme } from '../../shared/botAvatarValue.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { listBotRemoteResourceSources, type BotRemoteResourceSource } from '../localDb/ipc/bots.js';
import { visibleBotRemoteResourceSources } from '../localDb/ipc/botRemoteResourceProjection.js';
import { rosterBotActivityCandidates } from '../localDb/ipc/botRemoteResourceProvider.js';
import { companionHomes } from '../companion-cloud/homes.js';
import { readLatestMirrorRows, readMirrorRowsBefore } from '../companion-cloud/host.js';
import { mirrorMessageText, type CompanionMirrorRow } from '../companion-cloud/mirror.js';
import { companionAvatarThumbnail } from '../agent-island/companionIdentity.js';
import { summarizeInteraction } from '../bot-autonomy/phase.js';

/** Longest reply text handed to a plugin; longer replies are cut and marked truncated. */
export const PLUGIN_COMPANION_REPLY_MAX = 8000;
/** Most messages `history` returns, and the longest text of one of them. */
export const PLUGIN_COMPANION_HISTORY_MAX = 50;
export const PLUGIN_COMPANION_MESSAGE_MAX = 2000;
/** Conversation rows read per page while walking back past what the chat hides (tool steps, progress notes, sub-agents). */
const MIRROR_PAGE_ROWS = 100;
/** Plugins re-list on every change notice; one read per home computer serves them all for this long. */
export const REMOTE_COMPANION_CACHE_MS = 800;
/** A home computer that does not answer in time is shown as unreachable rather than holding the list. */
export const REMOTE_COMPANION_READ_TIMEOUT_MS = 4000;
const MAX_REMOTE_COMPANIONS = 200;
const MAX_TEXT = 200;
/** Longest plan body handed to a plugin; the rest stays in the conversation. */
export const PLUGIN_COMPANION_PLAN_MAX = 20000;
const PREVIEW_MAX = 4000;
/** The most text Cindy's own allow dialog shows whole; a longer plan or command is allowed in Cindy itself. */
export const PLUGIN_COMPANION_CONFIRM_MAX = 1200;
/** Tool arguments are summarized whole up to this length (maker-shared describePermissionAction cuts longer ones). */
const WHOLE_ARGUMENTS_MAX = 500;
const RESOLVE_INTERACTION_CHANNEL = 'maker:resolve-interaction';
const PENDING_INTERACTIONS_CHANNEL = 'maker:get-pending-interactions';
/** Requests only the owner settles in Cindy itself, even though they ride the generic permission card. */
const OWNER_ONLY_TOOLS: ReadonlySet<string> = new Set([...OWNER_ONLY_HOST_CONFIRMATION_TOOL_NAMES, 'ghost_contribution_submit', 'ghost_cancel_plugin_review']);

const unavailable = (): never => { throw Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' }); };
const notReady = (): never => { throw Object.assign(new Error('HOST_NOT_READY'), { code: 'HOST_NOT_READY' }); };
const invalid = (): never => { throw Object.assign(new Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' }); };
const busy = (): never => { throw Object.assign(new Error('TASK_BUSY'), { code: 'TASK_BUSY' }); };
const allowInCindy = (): never => { throw Object.assign(new Error('ALLOW_IN_CINDY'), { code: 'ALLOW_IN_CINDY' }); };
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
const KINDS: ReadonlySet<string> = new Set<PluginCompanionInteractionKind>(['question', 'permission', 'plan', 'other']);

/** What a pending request asks of the owner, as far as a plugin may handle it. */
export function companionInteractionKind(raw: unknown): PluginCompanionInteractionKind {
  const request = record(raw);
  if (request.kind === 'ask_user_question') return normalizeAskQuestions(request.questions).length ? 'question' : 'other';
  if (request.kind === 'plan_review') return typeof request.plan === 'string' ? 'plan' : 'other';
  if (request.kind !== 'permission') return 'other';
  // Cindy's own confirmations (plugin install, app update, task actions…) ride this card; they stay in Cindy.
  if (record(request.metadata).hostOwnedConfirmation !== undefined) return 'other';
  const tool = typeof request.toolName === 'string' ? request.toolName : '';
  return !tool || OWNER_ONLY_TOOLS.has(tool) || OWNER_ONLY_TOOLS.has(tool.split('__').pop() ?? '') ? 'other' : 'permission';
}

/**
 * Whether the summary of a permission shows all of what allowing it lets the companion do, so that Cindy's own
 * dialog can show the owner everything before a plugin's answer allows it: the whole command with its working
 * directory, or the paths and query read. A file write shows where, not what is written; a browser step, plugin or
 * tool call is shown whole only when its arguments are short enough not to be cut (the longest summary of them is
 * the indented JSON of the whole input). Anything else is allowed in Cindy itself.
 */
function permissionShownWhole(action: string, input: unknown): boolean {
  if (action === 'command' || action === 'file-read') return true;
  if (action !== 'browser' && action !== 'plugin' && action !== 'mcp' && action !== 'tool') return false;
  if (input !== undefined && (typeof input !== 'object' || input === null || Array.isArray(input))) return false;
  return (JSON.stringify(input ?? {}, null, 2) ?? '').length <= WHOLE_ARGUMENTS_MAX;
}

/** One pending request the way its conversation card shows it. */
export function companionInteractionDetail(raw: unknown, ref: string): PluginCompanionInteractionDetail {
  const request = record(raw);
  const kind = companionInteractionKind(raw);
  if (kind === 'question') {
    return {
      ref, kind,
      questions: normalizeAskQuestions(request.questions).slice(0, 20).map(question => ({
        question: text(question.question, 2000),
        header: question.header ? text(question.header) : null,
        options: (question.options ?? []).slice(0, 20).map(option => ({ label: text(option.label, 400), description: option.description ? text(option.description, 1000) : null })),
        multiSelect: question.multiSelect === true,
      })),
    };
  }
  if (kind === 'permission') {
    const toolName = text(request.toolName, 400);
    const action = describePermissionAction(toolName, record(request.input));
    return {
      ref, kind, action: action.kind === 'mcp' ? 'tool' : action.kind, tool: text(request.displayName, 400) || text(request.title, 400) || toolName,
      subject: action.subject ? text(action.subject, 400) : null, preview: text(action.preview, PREVIEW_MAX),
      allowHere: permissionShownWhole(action.kind, request.input) && Array.from(action.preview).length <= PLUGIN_COMPANION_CONFIRM_MAX,
    };
  }
  if (kind === 'plan') {
    const chars = Array.from(String(request.plan));
    return {
      ref, kind, plan: chars.slice(0, PLUGIN_COMPANION_PLAN_MAX).join(''), truncated: chars.length > PLUGIN_COMPANION_PLAN_MAX,
      allowHere: chars.length <= PLUGIN_COMPANION_CONFIRM_MAX,
    };
  }
  return { ref, kind, title: summarizeInteraction(raw)?.summary ?? null };
}

/** The decision Cindy's own card would send for this answer; INVALID_PARAMS when it does not fit the request. */
export function companionInteractionDecision(raw: unknown, answer: PluginCompanionAnswer): Record<string, unknown> {
  const request = record(raw);
  const kind = companionInteractionKind(raw);
  if (answer.kind !== kind) return invalid();
  if (answer.kind === 'permission') return { kind: 'permission', behavior: answer.decision };
  if (answer.kind === 'plan') {
    const feedback = answer.decision === 'deny' ? answer.feedback?.trim() : undefined;
    return { kind: 'plan_review', behavior: answer.decision, ...(feedback ? { reason: feedback } : {}) };
  }
  const questions = normalizeAskQuestions(request.questions);
  if (answer.answers.length !== questions.length) return invalid();
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const { choices, text: own = '' } = answer.answers[index]!;
    const labels = new Set((question.options ?? []).map(option => option.label));
    if (choices.some(choice => !labels.has(choice)) || (!question.multiSelect && choices.length > 1)) invalid();
    const value = question.multiSelect ? encodeMultiSelectAnswer(question.options ?? [], new Set(choices), own) : own.trim() || choices[0] || '';
    if (!value || value === '[]') invalid();
    answers[answerKey(question)] = value;
  });
  return { kind: 'ask_user_question', answers };
}

/** Allowing lets the companion act: Cindy confirms that itself instead of trusting the plugin's page. */
const needsOwnerConfirmation = (answer: PluginCompanionAnswer) => answer.kind !== 'question' && answer.decision === 'allow';

export interface PluginCompanionAllowPrompt {
  ghostId: string;
  companion: string;
  detail: Extract<PluginCompanionInteractionDetail, { kind: 'permission' | 'plan' }>;
}

export interface PluginCompanionRemoteDeps {
  /** This account's other computers; null when computers cannot be reached from here at all. */
  devices(): Promise<ReadonlyArray<{ deviceId: string; name: string; online: boolean; reachable: boolean }> | null>;
  /** Read from another computer of the account; rejects with an error carrying `code`. */
  invoke(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
  /** Change something on another computer (answering a request there), the way remote control does. */
  write?(deviceId: string, channel: string, args: unknown[]): Promise<unknown>;
}

export interface PluginCompanionHostDeps {
  /** Agent and host-owned requests pending in one task (register.ts getPendingInteractionsForSession). */
  pending(sessionId: string): Array<{ request: unknown }>;
  /** Show a task in the main window without stealing focus; `deviceId` for a companion on another computer. */
  openSession(sessionId: string, deviceId?: string): void;
  /** Let replies still being written reach the database before reading them. */
  flushMessages(): Promise<void>;
  /** Settle one of a companion's own requests here (register.ts resolvePendingInteraction); false once it is gone. */
  resolve?(requestId: string, decision: Record<string, unknown>): boolean;
  /** Cindy's own confirmation, outside the plugin's page; true only when the owner allows. */
  confirmAllow?(prompt: PluginCompanionAllowPrompt): Promise<boolean>;
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
    const kind = KINDS.has(String(interaction.kind)) ? interaction.kind as PluginCompanionInteractionKind : 'other';
    return ref ? [{ ref, kind, title: typeof interaction.title === 'string' ? text(interaction.title, 400) : null }] : [];
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
      if (!summary?.interactionId) return [];
      return [{ ref: interactionRef(activity.sessionId, summary.interactionId), kind: companionInteractionKind(request), title: summary.summary, sessionId: activity.sessionId }];
    });
  };

  const localView = async (guard: () => void): Promise<CompanionView> => {
    const sources = await localSources(guard);
    const candidates = await rosterBotActivityCandidates(sources);
    guard();
    const view: CompanionView = { companions: [], sessions: {}, conversations: {} };
    for (const source of sources) {
      // Status follows the session the roster shows; requests come from every session waiting on the owner
      // (the main conversation and delegated tasks can wait at the same time).
      const live = candidates.get(source.id) ?? [];
      const activity = live[0];
      const interactions = live.flatMap(interactionsOf);
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

  /** The conversation's rows newest first, a page at a time, down to where it was last cleared or its first row. */
  async function* conversationRows(sessionId: string, clearedAt: number | null, guard: () => void): AsyncGenerator<CompanionMirrorRow> {
    let page = await readLatestMirrorRows(sessionId, MIRROR_PAGE_ROWS);
    for (;;) {
      guard();
      for (const row of page) {
        if (clearedAt != null && row.createdAt <= clearedAt) return;
        yield row;
      }
      if (page.length < MIRROR_PAGE_ROWS) return;
      const last = page[page.length - 1]!;
      page = await readMirrorRowsBefore(sessionId, { createdAt: last.createdAt, id: last.id }, MIRROR_PAGE_ROWS);
    }
  }

  const localReply = async (companionId: string, guard: () => void): Promise<PluginCompanionReply | null> => {
    const source = await localSource(companionId, guard);
    const sessionId = source.canonicalSessionId ?? unavailable();
    await deps.flushMessages();
    guard();
    const db = getCurrentDbClientSnapshot()?.client.drizzle ?? notReady();
    const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    // The newest assistant row the companion conversation shows: not private, commentary or sub-agent output,
    // however many of those a long turn left after it.
    for await (const row of conversationRows(sessionId, session?.clearedAt ?? null, guard)) {
      if (row.role !== 'assistant') continue;
      const replyText = mirrorMessageText(row, { placeholders: false });
      if (!replyText) continue;
      const chars = Array.from(replyText);
      return { text: chars.slice(0, PLUGIN_COMPANION_REPLY_MAX).join(''), createdAt: row.createdAt, truncated: chars.length > PLUGIN_COMPANION_REPLY_MAX };
    }
    return null;
  };

  /** The conversation as the chat shows it (the mirror's projection): no tool steps, progress notes or sub-agents. */
  const localHistory = async (companionId: string, limit: number, guard: () => void): Promise<PluginCompanionHistory> => {
    const source = await localSource(companionId, guard);
    const sessionId = source.canonicalSessionId ?? unavailable();
    await deps.flushMessages();
    guard();
    const db = getCurrentDbClientSnapshot()?.client.drizzle ?? notReady();
    const [session] = await db.select({ clearedAt: sessions.clearedAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const messages: PluginCompanionMessage[] = [];
    let more = false;
    for await (const row of conversationRows(sessionId, session?.clearedAt ?? null, guard)) { // newest first
      const text = mirrorMessageText(row);
      if (!text || (row.role !== 'user' && row.role !== 'assistant')) continue;
      if (messages.length === limit) { more = true; break; }
      const chars = Array.from(text);
      messages.push({ role: row.role, text: chars.slice(0, PLUGIN_COMPANION_MESSAGE_MAX).join(''), createdAt: row.createdAt, truncated: chars.length > PLUGIN_COMPANION_MESSAGE_MAX });
    }
    return { messages: messages.reverse(), more };
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

  /** A request still pending in the task the companion is working in, by the ref the plugin listed. */
  interface FoundRequest { requestId: string; request: unknown; companion: string; device?: { deviceId: string; name: string } }
  const matching = (sessionId: string, ref: string, entries: unknown[]) =>
    entries.map(entry => record(entry).request).find(request => {
      const requestId = text(record(request).requestId, 512);
      return !!requestId && interactionRef(sessionId, requestId) === ref;
    });

  const localRequest = async (companionId: string, ref: string, guard: () => void): Promise<FoundRequest> => {
    const view = await localView(guard);
    const owner = view.companions.find(item => item.id === companionId);
    const sessionId = view.sessions[ref];
    if (!sessionId || !owner?.interactions.some(item => item.ref === ref)) return unavailable();
    const request = matching(sessionId, ref, deps.pending(sessionId)) ?? unavailable();
    return { requestId: text(record(request).requestId, 512), request, companion: owner.name };
  };

  const remoteRequest = async (companionId: string, ref: string, guard: () => void): Promise<FoundRequest> => {
    const device = await remoteHome(companionId, guard);
    const view = await readHome(device.deviceId, device.name, true);
    guard();
    const owner = view.companions.find(item => item.id === companionId);
    const sessionId = view.sessions[ref];
    if (!view.reachable || !sessionId || !owner?.interactions.some(item => item.ref === ref)) return unavailable();
    let pending: unknown;
    try {
      pending = await (deps.remote ?? notReady()).invoke(device.deviceId, PENDING_INTERACTIONS_CHANNEL, [sessionId]);
    } catch (error) {
      throw errorCode(error) === 'PERMISSION_DENIED' ? error : Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
    }
    guard();
    const request = matching(sessionId, ref, Array.isArray(pending) ? pending : []) ?? unavailable();
    return { requestId: text(record(request).requestId, 512), request, companion: owner.name, device };
  };

  const findRequest = async (companionId: string, ref: string, guard: () => void) =>
    await isLocal(companionId, guard) ? localRequest(companionId, ref, guard) : remoteRequest(companionId, ref, guard);

  // One Cindy confirmation at a time: a second one would stack dialogs the owner did not ask for.
  let confirming = false;

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

    async history(companionId, limit, guard) {
      if (await isLocal(companionId, guard)) return localHistory(companionId, limit, guard);
      const device = await remoteHome(companionId, guard);
      try {
        const value = record(await (deps.remote ?? notReady()).invoke(device.deviceId, COMPANION_LIVE_CHANNEL,
          [{ version: COMPANION_LIVE_VERSION, kind: 'history', companionId, limit }]));
        guard();
        const history = record(value.history);
        if (!Array.isArray(history.messages)) return null;
        const messages = history.messages.slice(-limit).flatMap((raw): PluginCompanionMessage[] => {
          const item = record(raw);
          const createdAt = time(item.createdAt);
          if ((item.role !== 'user' && item.role !== 'assistant') || typeof item.text !== 'string' || createdAt === null) return [];
          const chars = Array.from(item.text);
          return [{ role: item.role, text: chars.slice(0, PLUGIN_COMPANION_MESSAGE_MAX).join(''), createdAt, truncated: item.truncated === true || chars.length > PLUGIN_COMPANION_MESSAGE_MAX }];
        });
        return { messages, more: history.more === true || history.messages.length > limit };
      } catch (error) {
        // A home that cannot be asked for the conversation yet.
        if (['CHANNEL_NOT_ALLOWED', 'INVALID_PARAMS'].includes(errorCode(error))) return null;
        throw errorCode(error) === 'PERMISSION_DENIED' ? error : Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
      }
    },

    async interaction(companionId, ref, guard) {
      const found = await findRequest(companionId, ref, guard);
      return companionInteractionDetail(found.request, ref);
    },

    async answer(companionId, ref, answer, ctx) {
      const found = await findRequest(companionId, ref, ctx.guard);
      const decision = companionInteractionDecision(found.request, answer);
      if (needsOwnerConfirmation(answer)) {
        const confirmAllow = deps.confirmAllow ?? notReady();
        // The owner allows what the dialog shows: what it cannot show whole is allowed in Cindy (open).
        const detail = companionInteractionDetail(found.request, ref) as PluginCompanionAllowPrompt['detail'];
        if (!detail.allowHere) return allowInCindy();
        if (confirming) return busy();
        confirming = true;
        const shown = JSON.stringify(found.request);
        let allowed: boolean;
        try {
          allowed = await confirmAllow({ ghostId: ctx.ghostId, companion: found.companion, detail });
        } finally {
          confirming = false;
        }
        ctx.guard();
        if (!allowed) return { answered: false };
        // The owner allowed what the dialog showed: only that exact request, if it is still waiting.
        const again = await findRequest(companionId, ref, ctx.guard);
        if (again.requestId !== found.requestId || JSON.stringify(again.request) !== shown) return unavailable();
      }
      if (!found.device) {
        if (!(deps.resolve ?? notReady())(found.requestId, decision)) return unavailable();
        return { answered: true };
      }
      const write = deps.remote?.write ?? notReady();
      let result: unknown;
      try {
        result = await write(found.device.deviceId, RESOLVE_INTERACTION_CHANNEL, [found.requestId, decision]);
      } catch (error) {
        throw errorCode(error) === 'PERMISSION_DENIED' ? error : Object.assign(new Error('TARGET_UNAVAILABLE'), { code: 'TARGET_UNAVAILABLE' });
      }
      ctx.guard();
      if (record(result).accepted !== true) return unavailable();
      return { answered: true };
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
      if (request.kind === 'history' && typeof request.companionId === 'string' && request.companionId) {
        const limit = Number.isInteger(request.limit) && (request.limit as number) >= 1 ? Math.min(request.limit as number, PLUGIN_COMPANION_HISTORY_MAX) : PLUGIN_COMPANION_HISTORY_MAX;
        return { version: COMPANION_LIVE_VERSION, history: await localHistory(request.companionId, limit, noGuard) };
      }
      return invalid();
    },
  };
}

export type PluginCompanionHost = ReturnType<typeof createPluginCompanionHost>;
