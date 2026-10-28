/**
 * Background sync and home changes owned by one Chat Server instance (one account +
 * endpoint). Started only when the server announces companion homes; background
 * failures are logged and retried, never surfaced to chat.
 */
import type {
  CompanionCindyCopy,
  CompanionMergeResult,
  CompanionTranscriptMessage,
  CompanionCloudActionResult,
  CompanionHomeChoices,
  CompanionSwitchOptions,
  CompanionTranscriptPage,
  CompanionTransferTarget,
} from '../../shared/companionCloud.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { CompanionHomeRegistry } from './homes.js';
import type { CompanionArrivalNotice } from './capabilities.js';
import { materializeCompanion, rebuildPending, type CompanionHistoryAttachment, type CompanionMaterializeHost, type CompanionMaterializeResult, type CompanionRoomDownload } from './materialize.js';
import { createCompanionMirror, type CompanionMediaUpload, type CompanionMirrorAttachment, type CompanionMirrorCursor, type CompanionMirrorRow } from './mirror.js';
import { readAllRoomMessages, transcriptPageOf } from './room.js';
import { isCindyCompanion, mergeCompanionsInto, readProfileSnapshot } from './merge.js';
import { importCloudHistory } from './materialize.js';
import type { CompanionCloudState } from './state.js';
import { chatRejection, errorCode, isUnreachable, type CompanionApi, type CompanionLog } from './types.js';
import { COMPANION_PROFILE_KEY, COMPANION_READ_INCOMPLETE, COMPANION_VALUE_TOO_LARGE, createCompanionUploader, isCompanionProfileSnapshot, type CompanionPreferenceValue } from './uploader.js';

/** Electron/database side of the feature, wired in register.ts. */
export interface CompanionCloudHost {
  homes: CompanionHomeRegistry;
  openState: (endpoint: string, humanActorId: string, current: () => boolean) => CompanionCloudState;
  readValues: (botId: string) => Promise<CompanionPreferenceValue[]>;
  /** The files a companion reply refers to that go to the room with it (replyArtifacts.ts). */
  replyAttachments?: (botId: string, sessionId: string, row: CompanionMirrorRow, text: string) => Promise<CompanionMirrorAttachment[]>;
  /** The companion's main task; null when it has none yet. Throws when it cannot be told (conflicting links). */
  canonicalSession: (botId: string) => Promise<string | null>;
  rowsAfter: (sessionId: string, cursor: CompanionMirrorCursor, limit: number) => Promise<CompanionMirrorRow[]>;
  latestRows: (sessionId: string, limit: number, options?: { excludeClientIdPrefix?: string }) => Promise<CompanionMirrorRow[]>;
  /** Hand a room message to the companion's canonical Session as an ordinary user message. */
  deliverToCanonical: (botId: string, text: string, clientId: string) => Promise<{ ok: true } | { ok: false; errorCode: string }>;
  /** Local profile, memory, skill or canonical message change of a companion. */
  onLocalChange?: (listener: (botId: string) => void) => () => void;
  /** Local side of taking a companion over; absent disables take-over and auto-materialize. */
  materializer?: Omit<CompanionMaterializeHost, 'latestRows'>;
  /** The owner's devices from device-link. */
  listDevices?: () => Promise<DeviceLinkDeviceView[]>;
  /** Does that computer's Cindy support cloud companions (`maker:companion-cloud:caps`)? */
  probeCompanionCloud?: (deviceId: string) => Promise<boolean>;
  /**
   * Ask a companion's home on another computer (device-link): its cloud-companion version (0 when
   * it cannot be reached), the computers it can hand the companion to, and the hand-over itself.
   */
  homeLink?: {
    version: (deviceId: string) => Promise<number>;
    targets: (deviceId: string) => Promise<CompanionTransferTarget[]>;
    handOver: (deviceId: string, botId: string, targetDeviceId: string, options?: CompanionSwitchOptions) => Promise<CompanionCloudActionResult>;
    /** Ask the kept Cindy's home to merge the other copies into it. */
    merge?: (deviceId: string, keepBotId: string, fromBotIds: string[]) => Promise<CompanionMergeResult>;
    /** Ask a copy's home to send everything it has not sent yet (before a merge reads the cloud). */
    flush?: (deviceId: string, botId: string) => Promise<CompanionCloudActionResult>;
  };
  /** Stop every running or queued turn of the companion (its main task, group lanes, delegations). */
  stopBotTurns?: (botId: string) => Promise<void>;
  /** A turn is running (or queued) in any of the companion's tasks (main task, group lanes, delegations). */
  isBotBusy?: (botId: string) => Promise<boolean>;
  /** Random id of this Cindy installation (per userData); absent disables the install guard. */
  installationId?: () => string;
  /** Owner-scoped persisted shadow set (demotion survives restarts, an offline server and a disabled feature). */
  shadows?: { read: () => string[]; write: (ids: string[]) => void };
}

export interface CompanionCloudBot { botId: string; actorId: string; name: string }
/** Live actor record owned by chatServer.ts; home changes are written back in place. */
export interface CompanionRuntimeActor {
  id: string; kind: string; externalId: string; name: string; avatar?: string | null; homeDeviceId?: string | null;
  /** Retired in the cloud (deleted on its home); ignored everywhere. */
  disabled?: boolean;
}

export interface CompanionCloudRuntime {
  readonly state: CompanionCloudState;
  kickUploads: (botId?: string) => void;
  kickMirror: (botId?: string) => void;
  roomIdFor: (botId: string) => string | null;
  isDirectRoom: (roomId: string) => boolean;
  /** One full upload + mirror pass (tests and explicit refresh). */
  syncNow: () => Promise<void>;
  /** Demote local copies homed elsewhere and materialize companions handed to this computer. */
  reconcile: (localProfiles: Array<{ id: string; status: string }>) => void;
  takeOver: (botId: string) => Promise<CompanionCloudActionResult>;
  transfer: (botId: string, targetDeviceId: string, options?: CompanionSwitchOptions) => Promise<CompanionCloudActionResult>;
  transferTargets: () => Promise<CompanionTransferTarget[]>;
  /** Where the companion can move, seen from this computer (any computer, not only its home). */
  homeChoices: (botId: string) => Promise<CompanionHomeChoices>;
  /** Move the companion to `targetDeviceId` from any computer: hand over here, ask its home, or take over. */
  switchHome: (botId: string, targetDeviceId: string, options?: CompanionSwitchOptions) => Promise<CompanionCloudActionResult>;
  transcript: (botId: string, before?: string) => Promise<CompanionTranscriptPage>;
  /** The copies of Cindy in the cloud when there is more than one (otherwise empty). */
  cindyCopies: () => Promise<CompanionCindyCopy[]>;
  /** Merge the other copies into `keepBotId`, on its home (here, or asked over device-link). */
  mergeCindy: (keepBotId: string, fromBotIds: string[]) => Promise<CompanionMergeResult>;
  /** The same merge, asked by another computer: only when this computer runs the kept copy. */
  mergeCindyHere: (keepBotId: string, fromBotIds: string[]) => Promise<CompanionMergeResult>;
  /** Before a merge on another computer: send everything of a companion homed here to the server. */
  flushHere: (botId: string) => Promise<CompanionCloudActionResult>;
  /** What the last move to this computer could not keep of the companion's setup, until dismissed. */
  arrivalNotices: (botId: string) => CompanionArrivalNotice[];
  dismissArrivalNotices: (botId: string) => void;
  /** One of the files in the companion's room, brought to this computer. */
  attachment: (botId: string, mediaId: string) => Promise<CompanionHistoryAttachment>;
  /** The companion was deleted on its home (this computer): retire its cloud actor (retried until it succeeds). */
  retire: (botId: string) => Promise<void>;
  /** Demoted here, or homed on this device but owned by another Cindy installation. */
  isShadowed: (botId: string) => boolean;
  /** This installation is confirmed to run the companion (always true without an install guard). */
  installConfirmed: (botId: string) => boolean;
  /** Every shadowed local companion id (persisted by the caller). */
  shadowIds: () => string[];
  dispose: () => void;
}

/**
 * Bot preference naming the installation (and its device) that runs the companion. Another
 * installation on the same device defers to it; a record from another device means the
 * companion was handed here.
 */
export const COMPANION_INSTALL_KEY = 'companion.install.v1';
const INSTALL_RECHECK_MS = 2 * 60_000;

let active: CompanionCloudRuntime | null = null;
/** The running sync of the current account, or null when the feature is off. */
export function activeCompanionCloud(): CompanionCloudRuntime | null { return active; }

type Only = Set<string> | null | undefined;
const union = (left: Only, right: Set<string> | null): Only =>
  left === null || right === null ? null : new Set([...(left ?? []), ...right]);

export { isUnreachable };

function actionFailure(error: unknown, fallback: 'FAILED' | 'OFFLINE' = 'FAILED'): CompanionCloudActionResult {
  const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
  if (conflict) return { ok: false, code: 'HOME_CONFLICT', homeDeviceId: typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null };
  return { ok: false, code: isUnreachable(error) ? 'OFFLINE' : fallback };
}

const AUTO_RETRY_MS = 60_000;
/** How long a whole room read serves "load older" in the cloud conversation view. */
const TRANSCRIPT_CACHE_MS = 5 * 60_000;
/** How long a companion's profile snapshot answers "is this a copy of Cindy". */
const PROFILE_CACHE_MS = 5 * 60_000;

/** Home versions that accept a hand-over request from another computer (device-link caps). */
const REMOTE_HAND_OVER_VERSION = 2;
/** How long a move waits for the companion to finish its turn (the device-link budget is larger). */
export const COMPANION_BUSY_WAIT_MS = 4 * 60_000;
/** After asking the turn to stop, how long it may take to settle. */
const COMPANION_STOP_SETTLE_MS = 30_000;
const BUSY_POLL_MS = 2_000;

/** The home has uploaded the profile snapshot a take-over builds the companion from. */
export function hasProfileSnapshot(rows: unknown): boolean {
  const row = (Array.isArray(rows) ? rows : []).find((candidate: { key?: unknown }) => candidate?.key === COMPANION_PROFILE_KEY) as { value?: unknown } | undefined;
  return isCompanionProfileSnapshot(row?.value);
}

/** Same computers Orca may run work on (orcaRemoteWorkers.isExecutionDeviceCandidate). */
export function isCompanionTransferTarget(device: DeviceLinkDeviceView): boolean {
  return device.online && device.remoteControlEnabled && device.controlEnabled && !device.isSelf && !isMobilePlatform(device.platform);
}

export function startCompanionCloud(input: {
  api: CompanionApi;
  host: CompanionCloudHost;
  endpoint: string;
  humanActorId: string;
  selfDeviceId?: string;
  current: () => boolean;
  /** Durable Chat Server display projection; takeover and runtime reconstruction still read authoritative history. */
  transcript?: (roomId: string, actorId: string, refresh: boolean) => Promise<CompanionTranscriptMessage[]>;
  /** Active local companions whose home is this computer (and not demoted). */
  bots: () => CompanionCloudBot[];
  /** A local companion the owner paused: not synced or moved, and a merge asks to resume it first. */
  paused?: (botId: string) => boolean;
  /** The account's actors as last read by register(). */
  actors?: () => CompanionRuntimeActor[];
  /** Re-read actors now (forced register). */
  refresh?: () => Promise<void>;
  /** Publish the registry snapshot after a local home change. */
  publish?: () => void;
  /** The set of hidden local copies changed (a copy was demoted or taken over): what depends on it re-reads. */
  onShadowChanged?: () => void;
  /** Publish the companions' actor name and avatar now (they sync outside the preferences). */
  syncProfile?: (botId: string) => Promise<void>;
  /** Room files (chatServerMedia): the mirror uploads the owner's attachments; readers download them. */
  media?: { upload: CompanionMediaUpload; download: CompanionRoomDownload };
  log?: CompanionLog;
  uploadIntervalMs?: number;
  mirrorIntervalMs?: number;
  /** Run a first pass shortly after start (default). Harnesses drive passes explicitly. */
  initialKick?: boolean;
}): CompanionCloudRuntime {
  const state = input.host.openState(input.endpoint, input.humanActorId, input.current);
  const uploader = createCompanionUploader({ api: input.api, state, readValues: input.host.readValues, log: input.log,
    confirmHome: async (_botId, actorId) => {
      const actors = await input.api<CompanionRuntimeActor[]>('/actors');
      return actors.find(actor => actor.id === actorId)?.homeDeviceId === input.selfDeviceId;
    },
    onLostHome: () => { void input.refresh?.().catch(() => undefined); },
  });
  const mirror = createCompanionMirror({ api: input.api, state, humanActorId: () => input.humanActorId,
    canonicalSession: input.host.canonicalSession, rowsAfter: input.host.rowsAfter, latestRows: input.host.latestRows,
    ...(input.media ? { uploadMedia: input.media.upload } : {}),
    ...(input.host.replyAttachments ? { replyAttachments: input.host.replyAttachments } : {}), ...(input.log ? { log: input.log } : {}) });
  let disposed = false;
  const live = () => !disposed && input.current();
  const aborts = new AbortController();
  /** Writes started by this account stop as soon as it is no longer current. */
  const fence = {
    assertCurrent: () => { if (!live()) throw new Error('OWNER_CHANGED'); },
    signal: aborts.signal,
  };
  // Install guard: which bots this installation runs ('mine'), another install on this device
  // runs ('other'), or another computer ran before handing them here ('handed').
  type InstallOwner = 'mine' | 'other' | 'handed';
  const installs = new Map<string, { owner: InstallOwner | 'pending'; checkedAt: number }>();
  const installId = input.host.installationId?.();
  const installOwner = (botId: string) => installId ? installs.get(botId)?.owner : 'mine';
  const pick = (only: Set<string> | null) => input.bots()
    .filter(bot => (!only || only.has(bot.botId)) && installOwner(bot.botId) === 'mine');
  const actorOf = (botId: string) => (input.actors?.() ?? []).find(a => a.kind === 'bot' && !a.disabled && (a.externalId === botId || a.id === botId));
  let shadowKey = '';
  const publish = () => {
    if (!live()) return;
    input.publish?.();
    const key = [...state.demotedBotIds(), ...[...installs].flatMap(([botId, value]) => value.owner === 'other' ? [botId] : [])].sort().join('|');
    if (key !== shadowKey) { shadowKey = key; input.onShadowChanged?.(); }
  };

  function loop(run: (only: Set<string> | null) => Promise<void>, intervalMs: number, debounceMs: number) {
    let busy: Promise<void> | undefined;
    let queued: Only;
    let kicked: Only;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const hold = (work: Promise<unknown>): Promise<void> => {
      busy = work.then(() => undefined, () => undefined).finally(() => {
        busy = undefined;
        const next = queued; queued = undefined;
        if (next !== undefined) void fire(next);
      });
      return busy;
    };
    const fire = (only: Set<string> | null): Promise<void> => {
      if (!live()) return Promise.resolve();
      if (busy) { queued = union(queued, only); return busy; }
      return hold(run(only).catch(error => { input.log?.warn('Companion sync cycle failed', { code: errorCode(error) }); }));
    };
    const interval = setInterval(() => { void fire(null); }, intervalMs);
    interval.unref?.();
    return {
      run: () => fire(null),
      /** Run `task` once the cycle in flight is done; cycles started meanwhile wait for it. */
      async exclusive<T>(task: () => Promise<T>): Promise<T> {
        while (busy) await busy;
        const result = task();
        void hold(result);
        return result;
      },
      kick(botId?: string) {
        kicked = union(kicked, botId === undefined ? null : new Set([botId]));
        clearTimeout(debounce);
        debounce = setTimeout(() => { const only = kicked ?? null; kicked = undefined; void fire(only); }, debounceMs);
        debounce.unref?.();
      },
      dispose() { clearInterval(interval); clearTimeout(debounce); },
    };
  }

  const uploads = loop(async only => {
    // A first-upgrade burst is spread over cycles; continue soon when the budget ran out.
    if (await uploader.syncAll(pick(only))) uploads.kick();
  }, input.uploadIntervalMs ?? 60_000, 15_000);
  const mirrors = loop(async only => {
    for (const bot of pick(only)) {
      if (!live()) return;
      try {
        if (state.bot(bot.botId)?.pendingRebuild && input.host.materializer) {
          const sessionId = await input.host.canonicalSession(bot.botId);
          if (sessionId) await rebuildPending({ state, host: input.host.materializer, botId: bot.botId, actorId: bot.actorId, sessionId, fence });
        }
        await mirror.syncBot(bot.botId, bot.actorId, bot.name);
      } catch (error) { input.log?.warn('Companion conversation mirror will retry', { actorId: bot.actorId, code: errorCode(error) }); }
    }
  }, input.mirrorIntervalMs ?? 15_000, 2_000);
  const unsubscribe = input.host.onLocalChange?.(botId => { mirrors.kick(botId); uploads.kick(botId); });

  /** Profile snapshots of companion actors (to find the copies of Cindy), read at most every few minutes. */
  const profiles = new Map<string, { at: number; value: unknown }>();
  const profileOf = async (actorId: string) => {
    const cached = profiles.get(actorId);
    if (cached && Date.now() - cached.at < PROFILE_CACHE_MS) return cached.value;
    const value = await readProfileSnapshot(input.api, actorId);
    profiles.set(actorId, { at: Date.now(), value });
    return value;
  };

  /** Merge here (this computer runs the kept copy). */
  async function mergeHere(keepBotId: string, fromBotIds: string[]): Promise<CompanionMergeResult> {
    // A paused copy (kept or merged) is not synced: say so instead of failing part way.
    if (input.paused?.(keepBotId)) return { ok: false, code: 'PAUSED' };
    const keep = pick(null).find(bot => bot.botId === keepBotId);
    const keepActor = actorOf(keepBotId);
    const materializer = input.host.materializer;
    if (!keep || !keepActor || !materializer) return { ok: false, code: 'FAILED' };
    const copies = await runtime.cindyCopies();
    const from = fromBotIds.flatMap(botId => {
      const actor = actorOf(botId);
      return actor && botId !== keepBotId && copies.some(copy => copy.botId === botId) ? [actor] : [];
    });
    if (!from.length || !copies.some(copy => copy.botId === keepBotId)) return { ok: false, code: 'FAILED' };
    const roomOf = (actor: { id: string; externalId: string; name: string }) => mirror.ensureRoom(actor.externalId, actor.id, actor.name);
    // The merge reads the cloud: each copy's own computer first sends what it has not sent yet
    // (conversation backlog, a memory just edited). A busy copy waits; a failed sync stops the merge.
    for (const actor of from) {
      const synced = await syncCopy(actor);
      if (!synced.ok) return synced as CompanionMergeResult;
    }
    const devices = await input.host.listDevices?.().catch(() => []) ?? [];
    const labelled = from.map(actor => ({ ...actor, label: devices.find(device => device.deviceId === actor.homeDeviceId)?.name?.trim() || '' }));
    try {
      const summary = await mergeCompanionsInto({ api: input.api, host: materializer, keep: keepActor, from: labelled, humanActorId: input.humanActorId,
        roomOf, fence, ...(input.media ? { media: input.media } : {}), ...(input.log ? { log: input.log } : {}),
        beforeRetire: async () => {
          for (const actor of from) {
            const synced = await syncCopy(actor);
            if (!synced.ok) throw Object.assign(new Error(synced.code), { companionResult: synced });
          }
        },
        importHistory: async () => {
          // Without its task here the merged conversation would never reach the kept Cindy: fail,
          // so the copies stay active and the merge can run again.
          const sessionId = await input.host.canonicalSession(keepBotId);
          if (!sessionId) throw new Error('COMPANION_TASK_UNAVAILABLE');
          const inserted = await importCloudHistory({ api: input.api, host: materializer, sessionId, botActorId: keepActor.id,
            roomId: await roomOf(keepActor), fence, ...(input.media ? { download: input.media.download } : {}), ...(input.log ? { log: input.log } : {}) });
          // The merged conversation becomes the companion's context at its next idle point.
          if (inserted > 0) state.update(keepBotId, keepActor.id, entry => { entry.pendingRebuild = true; });
        } });
      for (const actor of from) actor.disabled = true;
      input.log?.info?.('Copies of Cindy merged', { actorId: keepActor.id, merged: summary.merged, messages: summary.messages });
      await input.refresh?.().catch(() => undefined);
      publish(); mirrors.kick(keepBotId); uploads.kick(keepBotId);
      return { ok: true, ...summary };
    } catch (error) {
      input.log?.warn('Merging copies of Cindy will need another try', { code: errorCode(error) });
      await input.refresh?.().catch(() => undefined);
      publish();
      // A copy that got busy (or could not send) right before retiring: say why, as before the merge.
      const settled = (error as { companionResult?: CompanionCloudActionResult } | null)?.companionResult;
      return (settled ?? actionFailure(error)) as CompanionMergeResult;
    }
  }

  /** The last whole read of each room for the cloud conversation view. */
  const transcripts = new Map<string, { at: number; messages: CompanionTranscriptMessage[] }>();

  // One materialize per companion at a time; take-over and automatic runs share it.
  const materializing = new Map<string, Promise<CompanionMaterializeResult>>();
  const autoRetryAt = new Map<string, number>();
  function materialize(actor: CompanionRuntimeActor): Promise<CompanionMaterializeResult> {
    const materializer = input.host.materializer;
    if (!materializer) return Promise.reject(new Error('MATERIALIZE_UNAVAILABLE'));
    const botId = actor.externalId;
    const pending = materializing.get(botId);
    if (pending) return pending;
    const run = materializeCompanion({ api: input.api, state, log: input.log, fence, onDemoted: publish, host: { ...materializer, latestRows: input.host.latestRows },
      ...(input.media ? { download: input.media.download } : {}),
      actor: { id: actor.id, externalId: botId, name: actor.name, avatar: actor.avatar ?? null },
      roomId: () => mirror.ensureRoom(botId, actor.id, actor.name) })
      .finally(() => { materializing.delete(botId); });
    materializing.set(botId, run);
    return run;
  }

  /**
   * Record that this installation runs the companion. `check` only claims an empty record;
   * `handed` (automatic take-over) also replaces another computer's record, never another
   * installation's claim on this computer; `takeover` (the user's explicit take-over) replaces any.
   */
  async function claimInstall(actor: CompanionRuntimeActor, mode: 'check' | 'handed' | 'takeover'): Promise<InstallOwner> {
    if (!installId) return 'mine';
    const rows = await input.api<Array<{ key: string; value: unknown; revision: number }>>('/preferences', 'GET', undefined, actor.id);
    const row = (Array.isArray(rows) ? rows : []).find(candidate => candidate.key === COMPANION_INSTALL_KEY);
    const record = row?.value && typeof row.value === 'object' ? row.value as { installationId?: unknown; deviceId?: unknown } : {};
    const current = record.installationId;
    let owner: InstallOwner = current === installId ? 'mine'
      : typeof record.deviceId === 'string' && record.deviceId !== input.selfDeviceId ? 'handed' : 'other';
    // A hand-over is completed by the take-over (which overwrites), never by this check.
    if ((owner === 'other' && (mode === 'takeover' || typeof current !== 'string')) || (owner === 'handed' && mode !== 'check')) {
      try {
        await input.api('/preferences', 'POST', { operationId: `cinstall:${actor.id}:${installId}:${row?.revision ?? 0}`,
          key: COMPANION_INSTALL_KEY, expectedRevision: row?.revision ?? 0,
          value: { installationId: installId, ...(input.selfDeviceId ? { deviceId: input.selfDeviceId } : {}) } }, actor.id);
        owner = 'mine';
      } catch (error) {
        // Another installation on this device claimed it first.
        if (!chatRejection(error, 409, 'REVISION_CONFLICT')) throw error;
      }
    }
    installs.set(actor.externalId, { owner, checkedAt: Date.now() });
    return owner;
  }

  function checkInstall(actor: CompanionRuntimeActor) {
    if (!installId) return;
    const known = installs.get(actor.externalId);
    if (known && Date.now() - known.checkedAt < INSTALL_RECHECK_MS) return;
    installs.set(actor.externalId, { owner: known?.owner ?? 'pending', checkedAt: Date.now() });
    void claimInstall(actor, 'check').then(owner => {
      // Handed here before this computer ever saw the move: take the existing copy over.
      if (owner === 'handed' && input.host.materializer) scheduleAuto(actor);
      if (owner !== known?.owner) { publish(); uploads.kick(actor.externalId); mirrors.kick(actor.externalId); }
    }, error => {
      installs.delete(actor.externalId);
      input.log?.warn('Companion installation check will retry', { actorId: actor.id, code: errorCode(error) });
    });
  }

  /** Hide and stop the local copy now (materialize lifts it once the take-over completes). */
  function demoteNow(actor: CompanionRuntimeActor) {
    if (state.isDemoted(actor.externalId)) return;
    state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
    publish();
  }

  function scheduleAuto(actor: CompanionRuntimeActor) {
    const botId = actor.externalId;
    if (materializing.has(botId) || Date.now() < (autoRetryAt.get(botId) ?? 0)) return;
    autoRetryAt.set(botId, Date.now() + AUTO_RETRY_MS);
    // Hidden first, through the home confirmation and the claim: the stale copy must not run or sync
    // meanwhile. The take-over lifts it once complete; a failure keeps it hidden and retries.
    demoteNow(actor);
    // Confirm the home with the server before un-demoting: a stale actor cache must not
    // resurrect a copy whose companion has already moved on.
    void input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: input.selfDeviceId })
      .then(async () => {
        // Automatic: never take the companion from the other installation on this computer.
        if (await claimInstall(actor, 'handed') !== 'mine') throw new Error('INSTALL_CLAIM_LOST');
        return materialize(actor);
      }).then(result => {
      autoRetryAt.delete(botId);
      input.log?.info?.('Companion moved to this computer', { actorId: actor.id, created: result.created, inserted: result.inserted, rebuild: result.rebuild });
      publish(); mirrors.kick(botId); uploads.kick(botId);
    }, error => {
      autoRetryAt.set(botId, Date.now() + AUTO_RETRY_MS);
      if (chatRejection(error, 409, 'HOME_DEVICE_CONFLICT')) { void input.refresh?.().catch(() => undefined); return; }
      input.log?.warn('Companion take-over will retry', { actorId: actor.id, code: errorCode(error) });
    });
  }

  /** Retire only from the installation that may run it: another Cindy on this computer may own it. */
  async function retireOwned(actor: CompanionRuntimeActor) {
    let owner = installOwner(actor.externalId);
    // Not confirmed yet (pending, failed, or just handed here): claim it the way the automatic
    // take-over does, so only one installation on this computer can win; a failure retries later.
    if (owner !== 'mine' && owner !== 'other') owner = await claimInstall(actor, 'handed');
    if (owner !== 'mine') {
      state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
      return;
    }
    await retireActor(actor);
  }

  async function retireActor(actor: CompanionRuntimeActor) {
    // Compare-and-set on the home: if another computer took the companion over meanwhile, this
    // was only a copy, and deleting it never retires the companion itself.
    try {
      await input.api(`/actors/${actor.id}`, 'PATCH', { disabled: true, homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: input.selfDeviceId });
    } catch (error) {
      const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
      if (!conflict) throw error;
      actor.homeDeviceId = typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null;
      state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
      void input.refresh?.().catch(() => undefined);
      publish();
      return;
    }
    actor.disabled = true;
    state.update(actor.externalId, actor.id, entry => { delete entry.retirePending; });
    publish();
  }

  async function flush(botId: string) {
    const bot = pick(null).find(candidate => candidate.botId === botId);
    if (!bot) throw new Error('NOT_HOME');
    // The whole conversation backlog first: the old copy stops mirroring once demoted, and a long
    // drain must not leave edits made meanwhile behind.
    await mirror.syncBot(bot.botId, bot.actorId, bot.name, { drain: true });
    // The actor's name and avatar too (once demoted, this copy may no longer publish them). Before
    // the values: an avatar upload takes a while, and an edit made meanwhile must still go up.
    await input.syncProfile?.(bot.botId);
    // Every portable value must reach the server: a skipped one would be lost by the move. Repeat
    // until a pass writes nothing, so the move starts from what is on disk right now; that last pass
    // is the last await before the busy check and the move.
    for (let pass = 0; ; pass += 1) {
      if (await uploader.syncBot(bot.botId, bot.actorId, Number.POSITIVE_INFINITY, { requireAll: true }) === 0) break;
      if (pass >= 2) throw new Error('COMPANION_STILL_CHANGING');
    }
  }

  /** A sync that must be complete (a hand-over, a merge) did not finish: why, as an action result. */
  function syncFailure(error: unknown): CompanionCloudActionResult {
    const code = errorCode(error);
    return [COMPANION_VALUE_TOO_LARGE, COMPANION_READ_INCOMPLETE, 'COMPANION_STILL_CHANGING', 'INVALID_AVATAR', 'AVATAR_UPLOAD_FAILED'].includes(code)
      ? { ok: false, code: 'FAILED' } : actionFailure(error, 'OFFLINE');
  }

  /** Everything of a companion homed here reaches the server, without moving it. */
  async function flushOwn(botId: string): Promise<CompanionCloudActionResult> {
    if (!input.selfDeviceId || actorOf(botId)?.homeDeviceId !== input.selfDeviceId) return { ok: false, code: 'HOME_CONFLICT' };
    if (input.paused?.(botId)) return { ok: false, code: 'PAUSED' };
    if (await input.host.isBotBusy?.(botId)) return { ok: false, code: 'BUSY' };
    try {
      await flush(botId);
      // A turn that started during the flush keeps producing: not settled yet (as before a hand-over).
      if (await input.host.isBotBusy?.(botId)) return { ok: false, code: 'BUSY' };
      return { ok: true };
    }
    catch (error) {
      input.log?.warn('Companion sync before a merge did not finish', { code: errorCode(error) });
      return syncFailure(error);
    }
  }

  /**
   * A copy about to be merged: its home sends what it has not sent yet. A home that cannot be
   * reached (or predates the request) keeps the rest on that computer; the cloud has what it last sent.
   */
  async function syncCopy(actor: CompanionRuntimeActor): Promise<CompanionCloudActionResult> {
    const home = actor.homeDeviceId;
    if (!home) return { ok: true };
    if (home === input.selfDeviceId) return flushOwn(actor.externalId);
    const link = input.host.homeLink;
    if (!link?.flush) return { ok: true };
    const version = await link.version(home).catch(() => 0);
    if (version < REMOTE_HAND_OVER_VERSION) return { ok: true };
    try { return await link.flush(home, actor.externalId); }
    catch (error) { return actionFailure(error, 'OFFLINE'); }
  }

  /** True once the companion has no running or queued turn; `wait` / `stop` give it time to get there. */
  async function settleBusy(botId: string, whenBusy: CompanionSwitchOptions['whenBusy']): Promise<boolean> {
    const busy = async () => !!(await input.host.isBotBusy?.(botId));
    if (!(await busy())) return true;
    if (!whenBusy) return false;
    if (whenBusy === 'stop') await input.host.stopBotTurns?.(botId).catch(error => {
      input.log?.warn('Companion turns could not be stopped before a move', { code: errorCode(error) });
    });
    const deadline = Date.now() + (whenBusy === 'stop' ? COMPANION_STOP_SETTLE_MS : COMPANION_BUSY_WAIT_MS);
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, BUSY_POLL_MS));
      if (!live()) return false;
      if (!(await busy())) return true;
    }
    return false;
  }

  /** Everything the new home needs reaches the server, then the home moves and this copy is demoted. */
  async function handOver(actor: CompanionRuntimeActor, targetDeviceId: string): Promise<CompanionCloudActionResult> {
    // A running turn would keep working here (tools, files, replies) after the target took over.
    const turnActive = async () => !!(await input.host.isBotBusy?.(actor.externalId));
    if (await turnActive()) return { ok: false, code: 'BUSY' };
    try { await flush(actor.externalId); }
    catch (error) {
      input.log?.warn('Companion hand-over stopped: sync did not finish', { actorId: actor.id, code: errorCode(error) });
      return syncFailure(error);
    }
    // Checked again right before the move: a turn may have started during the flush.
    if (await turnActive()) return { ok: false, code: 'BUSY' };
    try {
      await input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: targetDeviceId, expectedHomeDeviceId: input.selfDeviceId });
    } catch (error) {
      const failure = actionFailure(error);
      if (!failure.ok && failure.code === 'HOME_CONFLICT') await input.refresh?.().catch(() => undefined);
      return failure;
    }
    actor.homeDeviceId = targetDeviceId;
    state.update(actor.externalId, actor.id, entry => { entry.demoted = true; });
    publish();
    return { ok: true };
  }

  const runtime: CompanionCloudRuntime = {
    state,
    kickUploads: botId => uploads.kick(botId),
    kickMirror: botId => mirrors.kick(botId),
    roomIdFor: botId => state.bot(botId)?.roomId ?? null,
    isDirectRoom: roomId => state.botForRoom(roomId) !== null,
    syncNow: async () => { await uploads.run(); await mirrors.run(); },

    reconcile(localProfiles) {
      const self = input.selfDeviceId;
      if (!self || !live()) return;
      for (const actor of input.actors?.() ?? []) {
        if (actor.kind !== 'bot') continue;
        const botId = actor.externalId;
        const local = localProfiles.find(profile => profile.id === botId);
        const entry = state.bot(botId);
        if (actor.disabled) {
          // Deleted on its main computer (perhaps while this one was offline): a copy here is no
          // longer the companion, so it is hidden and stopped like any other old copy.
          if (local && local.status !== 'deleting' && !entry?.demoted) {
            state.update(botId, actor.id, next => { next.demoted = true; });
            input.log?.info?.('Companion was deleted on its main computer; local copy demoted', { actorId: actor.id });
          }
          continue;
        }
        if (entry?.retirePending && actor.homeDeviceId !== self) {
          // Another computer took the companion over before the retry: the deletion here only
          // removed a copy (as with HOME_DEVICE_CONFLICT), and must not retire it if handed back.
          state.update(botId, actor.id, next => { delete next.retirePending; });
        } else if (entry?.retirePending) {
          if (Date.now() >= (autoRetryAt.get(`retire:${botId}`) ?? 0)) {
            autoRetryAt.set(`retire:${botId}`, Date.now() + AUTO_RETRY_MS);
            void retireOwned(actor).catch(error => input.log?.warn('Companion retire will retry', { actorId: actor.id, code: errorCode(error) }));
          }
          continue;
        }
        if (actor.homeDeviceId === self && local) checkInstall(actor);
        if (actor.homeDeviceId && actor.homeDeviceId !== self) {
          if (local && local.status !== 'deleting' && !entry?.demoted) {
            state.update(botId, actor.id, next => { next.demoted = true; });
            input.log?.info?.('Companion now runs on another computer; local copy demoted', { actorId: actor.id });
          }
        } else if (actor.homeDeviceId === self && input.host.materializer) {
          // Handed here: the local copy was demoted, or this computer never ran it. A companion
          // deleted on its own home keeps its sync history and is not revived.
          const ranHere = !!entry?.mirror || entry?.prefsSeeded === true;
          if (installOwner(botId) !== 'other' && (entry?.demoted === true || (!local && !ranHere))) scheduleAuto(actor);
        }
      }
    },

    async takeOver(botId) {
      const self = input.selfDeviceId;
      if (!self || !live() || !input.host.materializer) return { ok: false, code: 'NOT_ENABLED' };
      let actor = actorOf(botId);
      if (!actor) {
        try { await input.refresh?.(); } catch (error) { return actionFailure(error); }
        actor = actorOf(botId);
      }
      if (!actor) return { ok: false, code: 'FAILED' };
      // Never move the home before the companion's profile snapshot is in the cloud: without it
      // this copy could not be built, and the old home would already be demoted.
      try {
        const rows = await input.api<Array<{ key: string; value: unknown }>>('/preferences', 'GET', undefined, actor.id);
        if (!hasProfileSnapshot(rows)) return { ok: false, code: 'FAILED' };
      } catch (error) { return actionFailure(error); }
      // Always compare-and-set, even when the cached home already says "here": the cache may be
      // stale (another computer took over while this one was offline). Unchanged homes are a no-op.
      try {
        await input.api(`/actors/${actor.id}`, 'PATCH', { homeDeviceId: self, expectedHomeDeviceId: actor.homeDeviceId ?? null });
      } catch (error) {
        const failure = actionFailure(error);
        if (!failure.ok && failure.code === 'HOME_CONFLICT') {
          actor.homeDeviceId = failure.homeDeviceId ?? null;
          await input.refresh?.().catch(() => undefined);
          publish();
        }
        return failure;
      }
      actor.homeDeviceId = self;
      try {
        // Taking over from this installation also takes it from another install on the same device.
        demoteNow(actor);
        if (await claimInstall(actor, 'takeover') !== 'mine') return { ok: false, code: 'FAILED' };
        await materialize(actor);
      } catch (error) {
        input.log?.warn('Companion take-over could not finish locally', { actorId: actor.id, code: errorCode(error) });
        publish();
        return actionFailure(error);
      }
      publish(); mirrors.kick(actor.externalId); uploads.kick(actor.externalId);
      return { ok: true };
    },

    async transferTargets() {
      const devices = (await input.host.listDevices?.().catch(() => []) ?? []).filter(isCompanionTransferTarget);
      // Older Cindy versions cannot take a companion over: never strand one there.
      const probe = input.host.probeCompanionCloud;
      const supported = probe ? await Promise.all(devices.map(device => probe(device.deviceId).catch(() => false))) : devices.map(() => true);
      return devices.filter((_device, index) => supported[index])
        .map(device => ({ deviceId: device.deviceId, name: device.name, online: device.online }));
    },

    async transfer(botId, targetDeviceId, options) {
      const self = input.selfDeviceId;
      if (!self || !live()) return { ok: false, code: 'NOT_ENABLED' };
      const actor = actorOf(botId);
      if (!actor || actor.homeDeviceId !== self) return { ok: false, code: 'FAILED', homeDeviceId: actor?.homeDeviceId ?? null };
      const devices = await input.host.listDevices?.().catch(() => []) ?? [];
      const target = devices.find(device => device.deviceId === targetDeviceId && isCompanionTransferTarget(device));
      const probe = input.host.probeCompanionCloud;
      if (!target || (probe && !(await probe(targetDeviceId).catch(() => false)))) return { ok: false, code: 'TARGET_UNAVAILABLE' };
      // No background cycle may write in between: one already in flight could carry older values
      // past the flush, or past the move. Background sync resumes after the copy is demoted.
      // Still working: wait for (or stop) the turn first, outside the sync lock so its reply keeps syncing.
      if (!(await settleBusy(actor.externalId, options?.whenBusy))) return { ok: false, code: 'BUSY' };
      return mirrors.exclusive(() => uploads.exclusive(() => handOver(actor, targetDeviceId)));
    },

    async homeChoices(botId) {
      const self = input.selfDeviceId;
      const actor = actorOf(botId);
      const home = actor?.homeDeviceId ?? null;
      if (!self || !live()) return { homeDeviceId: home, mode: 'unavailable', reason: 'NOT_ENABLED', targets: [] };
      if (!actor) return { homeDeviceId: null, mode: 'unavailable', reason: 'NOT_FOUND', targets: [] };
      const devices = await input.host.listDevices?.().catch(() => []) ?? [];
      const homeName = (home && devices.find(device => device.deviceId === home)?.name) || '';
      if (home === self) return { homeDeviceId: home, homeName, mode: 'local', targets: await runtime.transferTargets() };
      const selfDevice = devices.find(device => device.deviceId === self);
      const here: CompanionTransferTarget = { deviceId: self, name: selfDevice?.name ?? '', online: true, isSelf: true };
      const homeDevice = home ? devices.find(device => device.deviceId === home) : undefined;
      // Unreachable home (offline, or not controllable from here): only this computer can continue it.
      const version = home && homeDevice?.online && input.host.homeLink
        ? await input.host.homeLink.version(home).catch(() => 0) : 0;
      if (!home || version === 0) return { homeDeviceId: home, homeName, mode: 'takeOver', targets: [here] };
      if (version < REMOTE_HAND_OVER_VERSION) return { homeDeviceId: home, homeName, mode: 'unavailable', reason: 'HOME_OUTDATED', targets: [] };
      // The home's own view: it decides which computers can receive the companion (this one included).
      const targets = await input.host.homeLink!.targets(home);
      return { homeDeviceId: home, homeName, mode: 'remote',
        targets: targets.filter(target => target.deviceId !== home).map(target => target.deviceId === self
          ? { ...target, name: target.name || here.name, isSelf: true } : { ...target, isSelf: false }),
        // The home only lists computers that allow its control, so this one is missing for that reason.
        ...(selfDevice?.remoteControlEnabled === false && !targets.some(target => target.deviceId === self)
          ? { thisComputer: 'REMOTE_CONTROL_OFF' as const } : {}) };
    },

    async switchHome(botId, targetDeviceId, options) {
      const self = input.selfDeviceId;
      if (!self || !live()) return { ok: false, code: 'NOT_ENABLED' };
      const choices = await runtime.homeChoices(botId);
      if (choices.homeDeviceId === targetDeviceId) return { ok: true };
      if (choices.mode === 'unavailable') return { ok: false, code: choices.reason === 'HOME_OUTDATED' ? 'HOME_OUTDATED' : 'FAILED' };
      if (!choices.targets.some(target => target.deviceId === targetDeviceId)) return { ok: false, code: 'TARGET_UNAVAILABLE' };
      if (choices.mode === 'local') return runtime.transfer(botId, targetDeviceId, options);
      if (choices.mode === 'takeOver') return runtime.takeOver(botId);
      // The home hands it over itself (flush, busy check, compare-and-set), exactly as from its own settings.
      let result: CompanionCloudActionResult;
      try { result = await input.host.homeLink!.handOver(choices.homeDeviceId!, botId, targetDeviceId, options); }
      catch (error) {
        // A lost answer may still have moved it: show where it runs now.
        await input.refresh?.().catch(() => undefined);
        publish();
        return actionFailure(error, 'OFFLINE');
      }
      // Moved here: re-read homes now so the automatic take-over starts without waiting for the push.
      if (result.ok || result.code === 'HOME_CONFLICT') await input.refresh?.().catch(() => undefined);
      publish();
      return result;
    },

    async transcript(botId, before) {
      const actor = actorOf(botId);
      if (!actor) throw new Error('COMPANION_NOT_FOUND');
      const roomId = await mirror.ensureRoom(actor.externalId, actor.id, actor.name);
      // The room orders by arrival (older history may be uploaded later): read it whole, show it
      // by message time. The durable reader validates its cached scan against room
      // changes; the legacy reader reuses a recent scan for older pages.
      const cached = transcripts.get(roomId);
      const messages = input.transcript ? await input.transcript(roomId, actor.id, !before)
        : before && cached && Date.now() - cached.at < TRANSCRIPT_CACHE_MS ? cached.messages
        : await readAllRoomMessages(input.api, roomId, actor.id);
      transcripts.set(roomId, { at: Date.now(), messages });
      return transcriptPageOf(messages, before ? Number(before) : undefined);
    },


    async cindyCopies() {
      if (!live()) return [];
      const copies: CompanionCindyCopy[] = [];
      for (const actor of input.actors?.() ?? []) {
        if (actor.kind !== 'bot' || actor.disabled) continue;
        const profile = await profileOf(actor.id).catch(() => null);
        if (isCindyCompanion(actor.externalId, profile)) copies.push({ botId: actor.externalId, name: actor.name, homeDeviceId: actor.homeDeviceId ?? null });
      }
      return copies;
    },

    async mergeCindy(keepBotId, fromBotIds) {
      const self = input.selfDeviceId;
      if (!self || !live()) return { ok: false, code: 'NOT_ENABLED' };
      const keep = actorOf(keepBotId);
      if (!keep?.homeDeviceId) return { ok: false, code: 'FAILED' };
      if (keep.homeDeviceId === self) return mergeHere(keepBotId, fromBotIds);
      // The kept copy runs elsewhere: its home merges (it writes the companion's files).
      const link = input.host.homeLink;
      if (!link?.merge) return { ok: false, code: 'HOME_OUTDATED' };
      const version = await link.version(keep.homeDeviceId).catch(() => 0);
      if (version === 0) return { ok: false, code: 'OFFLINE' };
      if (version < REMOTE_HAND_OVER_VERSION) return { ok: false, code: 'HOME_OUTDATED' };
      try {
        const result = await link.merge(keep.homeDeviceId, keepBotId, fromBotIds);
        await input.refresh?.().catch(() => undefined);
        publish();
        return result;
      } catch (error) {
        await input.refresh?.().catch(() => undefined);
        return actionFailure(error, 'OFFLINE') as CompanionMergeResult;
      }
    },

    async mergeCindyHere(keepBotId, fromBotIds) {
      if (!input.selfDeviceId || !live()) return { ok: false, code: 'NOT_ENABLED' };
      if (actorOf(keepBotId)?.homeDeviceId !== input.selfDeviceId) return { ok: false, code: 'HOME_CONFLICT' };
      return mergeHere(keepBotId, fromBotIds);
    },

    async flushHere(botId) {
      if (!input.selfDeviceId || !live()) return { ok: false, code: 'NOT_ENABLED' };
      return flushOwn(botId);
    },

    arrivalNotices: botId => state.bot(botId)?.arrivalNotices ?? [],
    dismissArrivalNotices(botId) {
      const entry = state.bot(botId);
      if (!entry?.arrivalNotices) return;
      state.update(botId, entry.actorId, next => { delete next.arrivalNotices; });
    },

    async attachment(botId, mediaId) {
      const actor = actorOf(botId);
      if (!actor || !input.media) throw new Error('COMPANION_NOT_FOUND');
      const roomId = await mirror.ensureRoom(actor.externalId, actor.id, actor.name);
      return input.media.download(roomId, mediaId);
    },

    async retire(botId) {
      const self = input.selfDeviceId;
      const actor = actorOf(botId);
      // A demoted copy is not the companion: deleting it never touches the cloud.
      if (!self || !live() || !actor || actor.homeDeviceId !== self || runtime.isShadowed(botId)) return;
      state.update(botId, actor.id, entry => { entry.retirePending = true; });
      await retireOwned(actor);
    },

    isShadowed: botId => state.isDemoted(botId) || installOwner(botId) === 'other',
    installConfirmed: botId => installOwner(botId) === 'mine',
    shadowIds: () => [...new Set([...state.demotedBotIds(),
      ...[...installs].flatMap(([botId, value]) => value.owner === 'other' ? [botId] : [])])].sort(),

    dispose() {
      disposed = true;
      aborts.abort();
      uploads.dispose(); mirrors.dispose(); unsubscribe?.();
      if (active === runtime) active = null;
    },
  };
  active = runtime;
  // First pass soon after start; later passes follow the intervals and local changes.
  if (input.initialKick !== false) { uploads.kick(); mirrors.kick(); }
  return runtime;
}
