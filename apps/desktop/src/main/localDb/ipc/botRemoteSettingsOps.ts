import type { TeammateMediaCatalog } from '@cindy/maker-shared/teammate-media-models';
import {
  BOT_SETTINGS_CAPABILITY_FIELDS,
  BOT_SETTINGS_PATCH_FIELDS,
  type BotSettingsOp,
} from '../../../shared/botRemoteSettings.js';
import type { BotAutonomySettingsView } from '../../../shared/botAutonomy.js';
import {
  BOT_IM_CHANNELS,
  type BotImAdoptablePersonalBotsPayload,
  type BotImChannel,
  type BotImConnectionAddResult,
  type BotImConnectionGroupsPayload,
  type BotImConnectionLanesPayload,
  type BotImConnectionListPayload,
} from '../../../shared/botImConnection.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import type { BotLifecycleActionRequest } from '../../../shared/botLifecycle.js';
import type { BotMemoryDeleteInput, BotMemoryUpdateInput } from '../../../shared/botMemory.js';
import type { BotCoreSkill, BotSkillDetail, BotSkillSaveInput, BotSkillSummary } from '../../../shared/botSkill.js';
import { parseRoutineInput, type Routine, type RoutineRun, type RoutineSource, type RoutineDeliveryTarget } from '@cindy/maker-scheduler';
import { throwIpcError } from '../../utils/ipcValidate.js';
import type { BotSettingsCall, BotSettingsOpHandler } from './botRemoteSettingsHost.js';

type Kind = 'skill' | 'mcp' | 'toolset';
export interface BotCapabilityCatalogEntry {
  id: string;
  name: string;
  description: string;
  available: boolean;
  joined: boolean;
}

/** Services the local settings IPC already uses; injected so the operations stay free of main singletons. */
export interface BotSettingsOpsDeps {
  mediaModels?(): Promise<TeammateMediaCatalog>;
  readProfile(botId: string): Promise<unknown>;
  updateProfile(input: Record<string, unknown>): Promise<unknown>;
  setAvatar(botId: string, avatarImageBase64: string): Promise<unknown>;
  retryInvitation(botId: string): Promise<unknown>;
  lifecycle(request: BotLifecycleActionRequest, guard: () => Promise<void>): Promise<unknown>;
  defaultModelChain(): Promise<BotModelRoute[]>;
  memory: {
    list(botId: string, query?: string): Promise<unknown>;
    read(botId: string, filename: string): Promise<unknown>;
    update(input: BotMemoryUpdateInput): Promise<unknown>;
    delete(input: BotMemoryDeleteInput): Promise<void>;
  };
  /** Canonical task of a visible teammate (null while it has none). */
  canonicalSessionId(botId: string): Promise<string | null>;
  capabilities(callerSessionId: string, kind: Kind): Promise<BotCapabilityCatalogEntry[]>;
  personalSkills(botId: string): Promise<BotSkillSummary[]>;
  /** Core text and learned Skill actions (shared with the local capability page). */
  skills: {
    core(): BotCoreSkill;
    read(botId: string, slug: string): Promise<BotSkillDetail | null>;
    save(botId: string, input: BotSkillSaveInput): Promise<void>;
    setEnabled(botId: string, slug: string, enabled: boolean): Promise<void>;
    delete(botId: string, slug: string): Promise<void>;
  };
  autonomy: {
    get(): Promise<BotAutonomySettingsView>;
    set(schedulerBotId: string | null): Promise<BotAutonomySettingsView>;
    reset(): Promise<BotAutonomySettingsView>;
  };
  searchHistory(botId: string, query: string, limit: number): Promise<unknown>;
  /**
   * Messaging platforms. Credentials are entered and stored on this computer only: there is no
   * operation that adds a connection from credentials, and no result carries one.
   */
  channels: {
    im: {
      list(): Promise<BotImConnectionListPayload>;
      remove(id: string): Promise<BotImConnectionListPayload>;
      listGroups(id: string): Promise<BotImConnectionGroupsPayload>;
      setGroupActivation(id: string, chatId: string, mode: 'mention' | 'always'): Promise<BotImConnectionGroupsPayload>;
      listLanes(id: string): Promise<BotImConnectionLanesPayload>;
      resetLane(id: string, sessionId: string): Promise<BotImConnectionLanesPayload>;
      listAdoptable(): Promise<BotImAdoptablePersonalBotsPayload>;
      adopt(input: { botId: string; channel: BotImChannel }): Promise<BotImConnectionAddResult>;
    };
    wechat(): Promise<{
      getState(): unknown;
      getChannelSettings(): unknown;
      setCompanion(botId: string | null): Promise<unknown>;
      unbind(): Promise<unknown>;
      cancelAuthorization(): void;
    } | null>;
    x: {
      summary(): Promise<{ available: boolean; visible?: boolean; enabled: boolean; connected: boolean; companionBotId: string | null }>;
      setCompanion(botId: string | null, expectedBotId: string | null): Promise<unknown>;
    };
  };
  /** Speech catalog and the per-teammate preference (the voice IPC's own services). */
  voice: {
    models(): unknown;
    voices(selection: unknown): Promise<unknown>;
    preference(botId: string): Promise<unknown>;
    setPreference(botId: string, selection: unknown, sentencePlayback: unknown): Promise<unknown>;
  };
  /** The routine service every surface shares (`routineTools`). */
  routines: {
    list(botId: string): Promise<Routine[]>;
    sources(): Promise<RoutineSource[]>;
    deliveryTargets?(botId: string): Promise<RoutineDeliveryTarget[]>;
    history(botId: string, id: string): Promise<RoutineRun[]>;
    save(botId: string, input: ReturnType<typeof parseRoutineInput>, id?: string): Promise<Routine>;
    runNow(botId: string, id: string): Promise<unknown>;
    remove(botId: string, id: string): Promise<void>;
  };
}

const fail = (message = 'Invalid settings arguments'): never => throwIpcError('INVALID_PARAMS', message);
const record = (value: unknown, name: string): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : fail(`${name} must be an object`);
const text = (value: unknown, name: string, max: number, allowEmpty = false): string =>
  typeof value === 'string' && value.length <= max && (allowEmpty || value.length > 0) ? value : fail(`${name} is invalid`);
const keysWithin = (value: Record<string, unknown>, allowed: readonly string[], name: string) => {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail(`${name} has an unsupported field`);
};
const botOf = (call: BotSettingsCall): string => call.botId ?? fail('Teammate required');

/** Strips what the controller must not receive: Home path, runtime snapshots, last-message content and hidden lanes. */
export function projectBotSettingsProfile(raw: unknown): Record<string, unknown> {
  const { homeDir: _homeDir, lastMessagePreview: _preview, lastMessageAt: _at, lastMessageRole: _role, unreadCount: _unread, sessions, ...profile } =
    record(raw, 'profile') as Record<string, unknown> & { sessions?: unknown };
  return {
    ...profile,
    sessions: (Array.isArray(sessions) ? sessions : []).flatMap(item => {
      const session = item as Record<string, unknown>;
      // Group and IM lanes are not the teammate's own tasks and their records live in the group / IM.
      if (!session || typeof session.id !== 'string' || session.role === 'group' || session.role === 'channel') return [];
      return [{ id: session.id, title: session.title, kind: session.kind, updatedAt: session.updatedAt, status: session.status, role: session.role,
        ...(session.threadRoot ? { threadRoot: session.threadRoot } : {}) }];
    }),
  };
}

/** Whitelist of what an autosave may write; raising permissions stays in the confirmed generic form. */
export function readBotSettingsPatch(value: unknown): Record<string, unknown> {
  const patch = record(value, 'patch');
  keysWithin(patch, BOT_SETTINGS_PATCH_FIELDS, 'patch');
  if (patch.capabilities !== undefined) keysWithin(record(patch.capabilities, 'capabilities'), BOT_SETTINGS_CAPABILITY_FIELDS, 'capabilities');
  if (patch.capabilityBaseline !== undefined) record(patch.capabilityBaseline, 'capabilityBaseline');
  if (!Object.keys(patch).length) fail('patch is empty');
  return patch;
}

const ACTIONS = new Set(['resume', 'restart', 'delete']);
const GROUP_CHAT_ID = /^-?\d{1,32}$/;
const LANE_SESSION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;

/** A connection page operation may touch only this teammate's own connections. */
async function ownConnection(deps: BotSettingsOpsDeps, call: BotSettingsCall): Promise<string> {
  const id = text(call.args.id, 'id', 200);
  const own = (await deps.channels.im.list()).connections.some((connection) => connection.id === id && connection.botId === botOf(call));
  return own ? id : throwIpcError('NOT_FOUND', 'Connection unavailable');
}
const onlyThisTeammate = (deps: BotSettingsOpsDeps, payload: BotImConnectionListPayload, call: BotSettingsCall): BotImConnectionListPayload =>
  ({ connections: payload.connections.filter((connection) => connection.botId === botOf(call)) });

/** The path of the WeChat working folder belongs to the teammate's computer. */
const wechatSettings = (settings: unknown) => ({ ...record(settings, 'settings'), workingDir: null });
async function wechatOf(deps: BotSettingsOpsDeps) {
  return (await deps.channels.wechat()) ?? throwIpcError('PRECONDITION_FAILED', 'WeChat is unavailable');
}

/** The local voice IPC answers every failure with one message and logs no arguments; so does the remote page. */
const voiceCall = async <T>(run: () => T | Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch {
    return throwIpcError('PRECONDITION_FAILED', 'Voice conversation is unavailable.');
  }
};

/** The local routine IPC reports every failure with this one message; so does the remote page. */
const routineCall = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch {
    return throwIpcError('INVALID_PARAMS', 'Routine operation failed; check the teammate and trigger settings');
  }
};
const KINDS: readonly Kind[] = ['skill', 'mcp', 'toolset'];

export function createBotRemoteSettingsOps(deps: BotSettingsOpsDeps): Partial<Record<BotSettingsOp, BotSettingsOpHandler>> {
  return {
    'profile.get': async call => ({ profile: projectBotSettingsProfile(await deps.readProfile(botOf(call))) }),
    'profile.update': async call => {
      const botId = botOf(call);
      const patch = readBotSettingsPatch(call.args.patch);
      return { profile: projectBotSettingsProfile(await deps.updateProfile({ id: botId, ...patch })) };
    },
    'profile.chooseAvatar': async call => ({
      profile: projectBotSettingsProfile(await deps.setAvatar(botOf(call), text(call.args.avatarImageBase64, 'avatarImageBase64', 80_000))),
    }),
    'profile.retryInvitation': async call => {
      await deps.retryInvitation(botOf(call));
      return { profile: projectBotSettingsProfile(await deps.readProfile(botOf(call))) };
    },
    'lifecycle.run': async call => {
      const botId = botOf(call);
      const action = text(call.args.action, 'action', 16);
      if (!ACTIONS.has(action)) fail('Unknown lifecycle action');
      const confirmName = call.args.confirmName === undefined ? undefined : text(call.args.confirmName, 'confirmName', 200);
      const worktreeDisposition = call.args.worktreeDisposition === 'retain' || call.args.worktreeDisposition === 'recycle' ? call.args.worktreeDisposition : undefined;
      return deps.lifecycle({ botId, action: action as BotLifecycleActionRequest['action'], confirmName, worktreeDisposition, keepTaskHistory: call.args.keepTaskHistory === true },
        async () => call.assertCurrent());
    },
    ...(deps.mediaModels ? { 'models.media': async () => deps.mediaModels!() } : {}),
    'models.default': async () => ({ modelChain: await deps.defaultModelChain() }),
    'memory.list': async call => deps.memory.list(botOf(call), call.args.query === undefined ? '' : text(call.args.query, 'query', 200, true)),
    'memory.read': async call => deps.memory.read(botOf(call), text(call.args.filename, 'filename', 256)),
    'memory.update': async call => deps.memory.update({
      botId: botOf(call),
      filename: text(call.args.filename, 'filename', 256),
      title: text(call.args.title, 'title', 1_000, true),
      body: text(call.args.body, 'body', 40_000, true),
      expectedUpdatedAt: text(call.args.expectedUpdatedAt, 'expectedUpdatedAt', 64),
    }),
    'memory.delete': async call => {
      await deps.memory.delete({ botId: botOf(call), filename: text(call.args.filename, 'filename', 256), expectedUpdatedAt: text(call.args.expectedUpdatedAt, 'expectedUpdatedAt', 64) });
      return null;
    },
    'capabilities.catalog': async call => {
      const botId = botOf(call);
      const callerSessionId = await deps.canonicalSessionId(botId);
      call.assertCurrent();
      if (!callerSessionId) throwIpcError('PRECONDITION_FAILED', 'Missing canonical task');
      const personal = await deps.personalSkills(botId);
      const entries = await Promise.all(KINDS.map(async kind => [kind, await deps.capabilities(callerSessionId, kind)] as const));
      return { personal, entries: Object.fromEntries(entries) };
    },
    'skills.core': async call => {
      botOf(call);
      return deps.skills.core();
    },
    'skills.read': async call => deps.skills.read(botOf(call), text(call.args.slug, 'slug', 128)),
    'skills.save': async call => {
      await deps.skills.save(botOf(call), {
        slug: text(call.args.slug, 'slug', 128),
        name: text(call.args.name, 'name', 64),
        description: text(call.args.description, 'description', 280),
        body: text(call.args.body, 'body', 64 * 1024),
        ...(call.args.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: text(call.args.expectedUpdatedAt, 'expectedUpdatedAt', 64, true) }),
      });
      return null;
    },
    'skills.setEnabled': async call => {
      if (typeof call.args.enabled !== 'boolean') fail('enabled must be a boolean');
      await deps.skills.setEnabled(botOf(call), text(call.args.slug, 'slug', 128), call.args.enabled as boolean);
      return null;
    },
    'skills.delete': async call => {
      await deps.skills.delete(botOf(call), text(call.args.slug, 'slug', 128));
      return null;
    },
    'autonomy.get': async () => deps.autonomy.get(),
    'autonomy.set': async call => {
      const value = call.args.schedulerBotId;
      if (value !== null && (typeof value !== 'string' || !value.trim() || value.length > 128)) fail('schedulerBotId must be a teammate id or null');
      return deps.autonomy.set(value as string | null);
    },
    'autonomy.reset': async () => deps.autonomy.reset(),
    'routines.list': call => routineCall(() => deps.routines.list(botOf(call))),
    'routines.sources': () => routineCall(() => deps.routines.sources()),
    'routines.history': call => routineCall(() => deps.routines.history(botOf(call), text(call.args.id, 'id', 128))),
    'routines.save': call => routineCall(() => {
      const id = call.args.id === undefined ? undefined : text(call.args.id, 'id', 128);
      return deps.routines.save(botOf(call), parseRoutineInput(call.args.input), id);
    }),
    'routines.saveWithModel': call => routineCall(() => {
      const id = call.args.id === undefined ? undefined : text(call.args.id, 'id', 128);
      return deps.routines.save(botOf(call), parseRoutineInput(call.args.input), id);
    }),
    // Advertised separately: older hosts accept `saveWithModel` but drop `sessionMode`.
    'routines.saveWithSessionMode': call => routineCall(() => {
      const id = call.args.id === undefined ? undefined : text(call.args.id, 'id', 128);
      return deps.routines.save(botOf(call), parseRoutineInput(call.args.input), id);
    }),
    'routines.deliveryTargets': call => routineCall(() => deps.routines.deliveryTargets?.(botOf(call)) ?? Promise.resolve([])),
    'routines.saveWithDelivery': call => routineCall(() => {
      const id = call.args.id === undefined ? undefined : text(call.args.id, 'id', 128);
      return deps.routines.save(botOf(call), parseRoutineInput(call.args.input), id);
    }),
    'routines.runNow': call => routineCall(() => deps.routines.runNow(botOf(call), text(call.args.id, 'id', 128))),
    'routines.remove': call => routineCall(async () => {
      await deps.routines.remove(botOf(call), text(call.args.id, 'id', 128));
      return null;
    }),
    'voice.models': () => voiceCall(() => deps.voice.models()),
    'voice.voices': call => voiceCall(() => deps.voice.voices(call.args.selection)),
    'voice.preference': call => voiceCall(() => deps.voice.preference(botOf(call))),
    'voice.setPreference': call => voiceCall(() => deps.voice.setPreference(
      botOf(call),
      'selection' in call.args ? call.args.selection : undefined,
      'sentencePlayback' in call.args ? call.args.sentencePlayback : undefined,
    )),
    'channels.im.list': async call => onlyThisTeammate(deps, await deps.channels.im.list(), call),
    'channels.im.remove': async call => onlyThisTeammate(deps, await deps.channels.im.remove(await ownConnection(deps, call)), call),
    'channels.im.listGroups': async call => deps.channels.im.listGroups(await ownConnection(deps, call)),
    'channels.im.setGroupActivation': async call => {
      const id = await ownConnection(deps, call);
      if (typeof call.args.chatId !== 'string' || !GROUP_CHAT_ID.test(call.args.chatId)) fail('chatId is invalid');
      return deps.channels.im.setGroupActivation(id, call.args.chatId as string, call.args.mode === 'always' ? 'always' : 'mention');
    },
    'channels.im.listLanes': async call => deps.channels.im.listLanes(await ownConnection(deps, call)),
    'channels.im.resetLane': async call => {
      const id = await ownConnection(deps, call);
      if (typeof call.args.sessionId !== 'string' || !LANE_SESSION_ID.test(call.args.sessionId)) fail('sessionId is invalid');
      return deps.channels.im.resetLane(id, call.args.sessionId as string);
    },
    'channels.im.listAdoptable': async () => deps.channels.im.listAdoptable(),
    'channels.im.adopt': async call => {
      const channel = BOT_IM_CHANNELS.find((item) => item === call.args.channel) ?? fail('channel is invalid');
      const result = await deps.channels.im.adopt({ botId: botOf(call), channel });
      return { ...onlyThisTeammate(deps, result, call), connection: result.connection };
    },
    'channels.wechat.get': async call => {
      botOf(call);
      const wechat = await wechatOf(deps);
      return { state: wechat.getState(), channelSettings: wechatSettings(wechat.getChannelSettings()) };
    },
    'channels.wechat.setCompanion': async call => {
      const botId = botOf(call);
      const wechat = await wechatOf(deps);
      // A teammate's page may assign WeChat to itself or release its own assignment, never another's.
      if (call.args.assign !== true && (wechat.getChannelSettings() as { companionBotId?: string | null }).companionBotId !== botId)
        throwIpcError('PRECONDITION_FAILED', 'WeChat is assigned to another teammate');
      return { channelSettings: wechatSettings(await wechat.setCompanion(call.args.assign === true ? botId : null)) };
    },
    'channels.wechat.unbind': async call => {
      const wechat = await wechatOf(deps);
      if ((wechat.getChannelSettings() as { companionBotId?: string | null }).companionBotId !== botOf(call))
        throwIpcError('PRECONDITION_FAILED', 'WeChat is assigned to another teammate');
      await wechat.unbind();
      return null;
    },
    'channels.wechat.cancelAuthorization': async call => {
      botOf(call);
      (await wechatOf(deps)).cancelAuthorization();
      return null;
    },
    'channels.x.get': async call => {
      botOf(call);
      return await deps.channels.x.summary();
    },
    'channels.x.setCompanion': async call => {
      const botId = botOf(call);
      const summary = await deps.channels.x.summary();
      const expected = call.args.expectedBotId === null ? null : text(call.args.expectedBotId, 'expectedBotId', 128);
      if (call.args.assign !== true && summary.companionBotId !== botId) throwIpcError('PRECONDITION_FAILED', 'The official X account belongs to another teammate');
      await deps.channels.x.setCompanion(call.args.assign === true ? botId : null, expected);
      return deps.channels.x.summary();
    },
    'history.search': async call => {
      const limit = typeof call.args.limit === 'number' && Number.isFinite(call.args.limit) ? Math.max(1, Math.min(50, Math.floor(call.args.limit))) : 20;
      return deps.searchHistory(botOf(call), text(call.args.query, 'query', 500), limit);
    },
  };
}
