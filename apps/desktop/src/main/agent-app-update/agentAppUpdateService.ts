/**
 * Agent-initiated Cindy updates (install / idle auto-install switch).
 *
 * The Agent never installs anything itself. Each request becomes a Host-owned
 * permission card on the calling task (Desktop, same-account phone and IM card
 * share one decision through the interaction router; Full Access cannot skip it
 * because it never passes the Agent's own approval callback). Only after the
 * owner approves does the built-in updater run, via the same check → download →
 * relaunch state machine as Settings → About.
 *
 * Restarting ends this process, so the outcome is recorded in an owner-scoped
 * marker and written back to the calling task on the next start.
 */
import { randomUUID } from 'node:crypto';

import type { InteractionDecision, InteractionRequest } from '@cindy/maker-core';

import {
  AGENT_APP_AUTO_UPDATE_TOOL_NAME,
  AGENT_APP_UPDATE_HOST_CONFIRMATION,
  AGENT_APP_UPDATE_TOOL_NAME,
} from './constants.js';

export interface AgentAppUpdateCaller {
  sessionId: string;
  sessionInstanceId: string;
}

export interface AgentAppUpdateCheck {
  status: string;
  currentVersion: string;
  targetVersion?: string;
  reason?: string;
}

export type AgentAppUpdateApplyResult =
  | { status: 'relaunching'; targetVersion?: string }
  | { status: 'failed'; reason: string; errorCode?: string; stagedVersion?: string };

/**
 * User-visible failure text is localized from the stable error code; the
 * updater's own `reason` is Chinese diagnostic text for the model only.
 */
const FAILURE_REASON_KEYS: Record<string, string> = {
  download_failed: 'downloadFailed',
  manifest_failed: 'manifestFailed',
  manual_download: 'manualDownload',
  idle: 'noUpdate',
  version_changed: 'versionChanged',
  relaunch_cancelled: 'notRestarted',
  not_ready: 'notReady',
  relaunch_not_started: 'updaterNotStarted',
  relaunch_in_progress: 'relaunchInProgress',
  updater_spawn_failed: 'updaterNotStarted',
  unsupported: 'unsupported',
  linux_installation_unsupported: 'unsupported',
  windows_vc_runtime_missing: 'unsupported',
};

export interface AgentAppUpdateMarker {
  requestId: string;
  sessionId: string;
  fromVersion: string;
  targetVersion?: string;
  requestedAt: number;
  /** Process that attempted the restart; a same-process read means it has not happened. */
  pid: number;
}

type PermissionRequest = Extract<InteractionRequest, { kind: 'permission' }>;

/**
 * The account that confirmed an install. Captured once at confirmation; the
 * marker, the restart gate and every result notice stay bound to it so an
 * account switch can neither restart the next owner's app nor receive the
 * previous owner's result. Opaque to this module.
 */
export interface AgentAppUpdateOwner {
  readonly ownerId: string;
}

/** `task-missing`: the task no longer exists for that owner, so the result can never be shown. */
export type AgentAppUpdateNotifyOutcome = 'written' | 'task-missing';

export interface AgentAppUpdateDeps {
  appVersion(): string;
  platform: NodeJS.Platform;
  pid: number;
  now(): number;
  check(): Promise<AgentAppUpdateCheck>;
  /** Built-in updater. `expectedVersion` is the version the owner confirmed; a different staged version is not installed. */
  apply(options: {
    expectedVersion?: string;
    beforeRelaunch: () => Promise<boolean>;
    beforeSpawn?: () => boolean;
  }): Promise<AgentAppUpdateApplyResult>;
  readAutoUpdate(): boolean;
  writeAutoUpdate(enabled: boolean): boolean;
  /** 'owner' only for a live local turn the account owner started (see callerAuthority.ts). */
  resolveCaller(caller: AgentAppUpdateCaller): 'owner' | 'not-owner' | 'unavailable';
  countOtherRunningTasks(callerSessionId: string): number;
  /** Background work a restart would also stop (see relaunchBusyActivity.ts); unknown is true. */
  hasBackgroundWork(): Promise<boolean>;
  /** Host permission card on the calling task; null when that task is gone. */
  requestHostPermission(
    sessionId: string,
    sessionInstanceId: string,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<InteractionDecision | null>;
  /** Let the calling turn finish its reply before the restart (bounded by the host). */
  waitForCallerTurnToEnd(caller: AgentAppUpdateCaller): Promise<void>;
  /** The current account, or null while none is active or an account boundary is pending. */
  captureOwner(): AgentAppUpdateOwner | null;
  /** The captured account is still active and no account boundary is pending. */
  isOwnerCurrent(owner: AgentAppUpdateOwner): boolean;
  /** The owner's restart records: one per attempted restart whose result is not yet written back. */
  marker: {
    list(owner: AgentAppUpdateOwner): AgentAppUpdateMarker[];
    add(owner: AgentAppUpdateOwner, record: AgentAppUpdateMarker): void;
    remove(owner: AgentAppUpdateOwner, requestId: string): void;
  };
  /**
   * Persist a visible host notice in the owner's task (idempotent per clientId).
   * Throws on transient failure or when the owner is no longer current.
   */
  notify(
    owner: AgentAppUpdateOwner,
    sessionId: string,
    clientId: string,
    text: string,
  ): Promise<AgentAppUpdateNotifyOutcome>;
  compareVersions(candidate: string | undefined, current: string): string;
  translate(key: string): string;
  logger?: { info?(msg: string, meta?: unknown): void; warn?(msg: string, meta?: unknown): void };
}

type ToolResult = Record<string, unknown>;

/** Card answers that never reached the user; reporting them as a refusal would mislead. */
const UNDELIVERED_REASONS = new Set([
  'no_interaction_route',
  'interaction_handler_failed',
  'duplicate_request_id',
]);
const MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingNotice {
  /** Account id, not a captured scope: a later sign-in of the same account still matches. */
  ownerId: string;
  sessionId: string;
  clientId: string;
  message: string;
}
const UPDATABLE_STATUSES = new Set(['available', 'ready', 'downloading']);
const HINT_SESSION_LIMIT = 500;

function interpolate(template: string, args: Record<string, string | number>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(args, name) ? String(args[name]) : match,
  );
}

function ownerTurnRequired(): ToolResult {
  return {
    ok: false,
    errorCode: 'OWNER_TURN_REQUIRED',
    message:
      '只有 Cindy 主人本人在本机、手机远程或私聊中发起的请求才能更新 Cindy；自动化、其他任务、群成员或共享任务成员的消息不能触发。',
  };
}

function callerUnavailable(): ToolResult {
  return { ok: false, errorCode: 'CALLER_UNAVAILABLE', message: '当前任务实例已结束或不再有效。' };
}

export function createAgentAppUpdateService(deps: AgentAppUpdateDeps) {
  const text = (key: string, args: Record<string, string | number> = {}) =>
    interpolate(deps.translate(key), args);
  /** One install request at a time: a pending card or a started install blocks repeats. */
  let flow: { kind: 'confirming' | 'installing'; targetVersion?: string } | null = null;
  let autoUpdateConfirming = false;
  const hintedSessions = new Set<string>();

  const decide = async (
    caller: AgentAppUpdateCaller,
    request: PermissionRequest,
  ): Promise<'allow' | 'deny' | 'timeout' | 'undelivered' | 'unavailable'> => {
    const decision = await deps.requestHostPermission(
      caller.sessionId,
      caller.sessionInstanceId,
      request,
      new AbortController().signal,
    );
    if (!decision || decision.kind !== 'permission') return 'unavailable';
    if (decision.behavior === 'allow') return 'allow';
    if (decision.reason && UNDELIVERED_REASONS.has(decision.reason)) return 'undelivered';
    if (decision.reason && /timeout/.test(decision.reason)) return 'timeout';
    return 'deny';
  };

  const declined = (outcome: 'deny' | 'timeout' | 'undelivered' | 'unavailable'): ToolResult => {
    if (outcome === 'unavailable') return callerUnavailable();
    if (outcome === 'undelivered') {
      return {
        ok: false,
        errorCode: 'CONFIRMATION_UNAVAILABLE',
        message: '确认卡没有送达用户，未做任何更改。',
      };
    }
    return {
      status: outcome === 'timeout' ? 'confirmation_timeout' : 'declined',
      message: '用户没有确认，未做任何更改。',
    };
  };

  const buildInstallCard = async (
    caller: AgentAppUpdateCaller,
    from: string,
    to: string,
  ): Promise<PermissionRequest> => {
    const others = deps.countOtherRunningTasks(caller.sessionId);
    const background = await deps.hasBackgroundWork().catch(() => true);
    const lines = [
      text('update.agentInstall.versions', { from, to }),
      ...(others > 0 ? [text('update.agentInstall.otherTasks', { count: others })] : []),
      ...(background ? [text('update.agentInstall.backgroundWork')] : []),
      ...(others === 0 && !background ? [text('update.agentInstall.noOtherTasks')] : []),
      text('update.agentInstall.thisTask'),
      text('update.agentInstall.remote'),
      ...(deps.platform === 'linux' ? [text('update.agentInstall.linuxAuth')] : []),
    ];
    return {
      kind: 'permission',
      requestId: randomUUID(),
      toolName: AGENT_APP_UPDATE_TOOL_NAME,
      title: text('update.agentInstall.title', { version: to }),
      description: lines.join('\n'),
      input: { from, to },
      metadata: { hostOwnedConfirmation: AGENT_APP_UPDATE_HOST_CONFIRMATION },
    };
  };

  /** Outcome after a restart: compare the running version with the one before it. */
  const restartMessage = (marker: AgentAppUpdateMarker): string => {
    const version = deps.appVersion();
    return deps.compareVersions(version, marker.fromVersion) === 'newer'
      ? text('update.agentInstall.succeeded', { version, from: marker.fromVersion })
      : [
          text('update.agentInstall.failed', { version }),
          text('update.agentInstall.retryHint'),
        ].join(' ');
  };

  const failureMessage = (
    request: AgentAppUpdateMarker,
    failure: { errorCode?: string; stagedVersion?: string },
  ): string =>
    [
      text('update.agentInstall.failed', { version: deps.appVersion() }),
      text(
        `update.agentInstall.reasons.${FAILURE_REASON_KEYS[failure.errorCode ?? ''] ?? 'generic'}`,
        {
          version: failure.stagedVersion ?? '',
          confirmed: request.targetVersion ?? '',
        },
      ),
      text('update.agentInstall.retryHint'),
    ].join(' ');

  /**
   * Outcomes produced without a restart live only in memory: they are retried
   * on every owner-ready delivery and on the next install request, and only
   * while their own account is active. Nothing here blocks a new install.
   */
  const pendingNotices: PendingNotice[] = [];
  // Never truncated: a notice leaves only once written or its task is gone.
  const queueNotice = (notice: PendingNotice) => {
    pendingNotices.push(notice);
  };
  const flushNotices = async () => {
    const owner = deps.captureOwner();
    if (!owner) return;
    for (const notice of [...pendingNotices]) {
      // Never write into a different account; a concurrent flush may already have delivered it.
      if (notice.ownerId !== owner.ownerId || !pendingNotices.includes(notice)) continue;
      try {
        await deps.notify(owner, notice.sessionId, notice.clientId, notice.message);
      } catch (error) {
        deps.logger?.warn?.('agent app update notice failed; will retry', { error: String(error) });
        continue;
      }
      // Identity-based removal: overlapping flushes never remove another notice.
      const index = pendingNotices.indexOf(notice);
      if (index >= 0) pendingNotices.splice(index, 1);
    }
  };

  /**
   * Restart records exist only for restarts that were about to happen: each is
   * added at the last gate before the updater spawns and read back by a later
   * process. Records never replace each other; each is removed on its own once
   * its result is persisted, its task is gone, or it is stale.
   */
  const deliverRestartResults = async (owner: AgentAppUpdateOwner) => {
    for (const record of deps.marker.list(owner)) {
      // Same process: that restart has not happened (yet).
      if (record.pid === deps.pid) continue;
      if (deps.now() - record.requestedAt > MARKER_MAX_AGE_MS) {
        deps.marker.remove(owner, record.requestId);
        continue;
      }
      try {
        await deps.notify(
          owner,
          record.sessionId,
          `agent-app-update:${record.requestId}`,
          restartMessage(record),
        );
      } catch (error) {
        deps.logger?.warn?.('agent app update result notice failed; will retry', {
          error: String(error),
        });
        continue;
      }
      deps.marker.remove(owner, record.requestId);
    }
  };

  /** Last gate before the updater spawns (synchronous): owner check, then the restart record. */
  const recordRestart = (owner: AgentAppUpdateOwner, request: AgentAppUpdateMarker): boolean => {
    if (!deps.isOwnerCurrent(owner)) return false;
    try {
      deps.marker.add(owner, request);
      return true;
    } catch (error) {
      // Without the record the outcome could not be reported after the restart.
      deps.logger?.warn?.('agent app update marker write failed; not restarting', {
        error: String(error),
      });
      return false;
    }
  };

  const runInstall = async (
    caller: AgentAppUpdateCaller,
    owner: AgentAppUpdateOwner,
    request: AgentAppUpdateMarker,
  ) => {
    let failure: { errorCode?: string; stagedVersion?: string };
    try {
      const result = await deps.apply({
        expectedVersion: request.targetVersion,
        beforeRelaunch: async () => {
          await deps.waitForCallerTurnToEnd(caller);
          // Logout or an account switch cancels the restart; the patch stays staged.
          return deps.isOwnerCurrent(owner);
        },
        beforeSpawn: () => recordRestart(owner, request),
      });
      // A relaunch ends this process; the next start reports from the marker.
      if (result.status === 'relaunching') return;
      deps.logger?.warn?.('agent app update did not restart', {
        errorCode: result.errorCode,
        reason: result.reason,
      });
      failure = result;
    } catch (error) {
      deps.logger?.warn?.('agent app update failed', { error: String(error) });
      failure = {};
    } finally {
      flow = null;
    }
    // A spawn that failed after the record was written did not restart anything.
    deps.marker.remove(owner, request.requestId);
    queueNotice({
      ownerId: owner.ownerId,
      sessionId: request.sessionId,
      clientId: `agent-app-update:${request.requestId}`,
      message: failureMessage(request, failure),
    });
    await flushNotices();
  };

  return {
    async check(
      caller: AgentAppUpdateCaller,
    ): Promise<AgentAppUpdateCheck & { autoUpdateEnabled: boolean; autoUpdateHint?: true }> {
      const result = await deps.check();
      const autoUpdateEnabled = deps.readAutoUpdate();
      // Suggest the switch at most once per task, and only when it would matter.
      const hint =
        !autoUpdateEnabled &&
        UPDATABLE_STATUSES.has(result.status) &&
        !hintedSessions.has(caller.sessionId);
      if (hint) {
        if (hintedSessions.size >= HINT_SESSION_LIMIT) hintedSessions.clear();
        hintedSessions.add(caller.sessionId);
      }
      return { ...result, autoUpdateEnabled, ...(hint ? { autoUpdateHint: true as const } : {}) };
    },

    async install(caller: AgentAppUpdateCaller): Promise<ToolResult> {
      if (flow) {
        return flow.kind === 'confirming'
          ? {
              status: 'confirmation_pending',
              message: '已有一张更新确认卡在等待用户处理，不要重复发起。',
            }
          : {
              status: 'in_progress',
              targetVersion: flow.targetVersion,
              message: '更新已在进行中，完成后 Cindy 会自动重启。',
            };
      }
      const authority = deps.resolveCaller(caller);
      if (authority === 'unavailable') return callerUnavailable();
      if (authority !== 'owner') return ownerTurnRequired();
      flow = { kind: 'confirming' };
      let started = false;
      try {
        await flushNotices();
        const check = await deps.check();
        if (!UPDATABLE_STATUSES.has(check.status)) return { ...check };
        // Every confirmation names a concrete version; the updater installs only that one.
        if (!check.targetVersion) {
          return {
            status: 'target_unknown',
            currentVersion: check.currentVersion,
            message:
              '暂时无法确定要安装的版本（可能无法读取当前渠道信息），未弹出确认；请稍后再试。',
          };
        }
        const from = check.currentVersion;
        const to = check.targetVersion;
        flow.targetVersion = to;
        const outcome = await decide(caller, await buildInstallCard(caller, from, to));
        if (outcome !== 'allow') return declined(outcome);
        // The user may have stopped or replaced the task while the card was open.
        const current = deps.resolveCaller(caller);
        if (current === 'unavailable') return callerUnavailable();
        if (current !== 'owner') return ownerTurnRequired();
        const owner = deps.captureOwner();
        if (!owner) return callerUnavailable();
        const request: AgentAppUpdateMarker = {
          requestId: randomUUID(),
          sessionId: caller.sessionId,
          fromVersion: from,
          targetVersion: to,
          requestedAt: deps.now(),
          pid: deps.pid,
        };
        flow = { kind: 'installing', targetVersion: to };
        started = true;
        void runInstall(caller, owner, request);
        return {
          status: 'started',
          currentVersion: from,
          targetVersion: to,
          message:
            'Cindy 正在通过内置更新器下载并安装更新，本轮回复结束后会自动重启；重启后结果会写回本任务。请简短告知用户，不要再执行其他操作。',
        };
      } finally {
        if (!started) flow = null;
      }
    },

    async setAutoUpdate(caller: AgentAppUpdateCaller, enabled: boolean): Promise<ToolResult> {
      const authority = deps.resolveCaller(caller);
      if (authority === 'unavailable') return callerUnavailable();
      if (authority !== 'owner') return ownerTurnRequired();
      if (deps.readAutoUpdate() === enabled)
        return { status: 'unchanged', autoUpdateEnabled: enabled };
      if (autoUpdateConfirming) {
        return {
          status: 'confirmation_pending',
          message: '已有一张自动更新确认卡在等待用户处理。',
        };
      }
      autoUpdateConfirming = true;
      try {
        const outcome = await decide(caller, {
          kind: 'permission',
          requestId: randomUUID(),
          toolName: AGENT_APP_AUTO_UPDATE_TOOL_NAME,
          title: text(
            enabled ? 'update.agentAutoUpdate.enableTitle' : 'update.agentAutoUpdate.disableTitle',
          ),
          description: [
            text(
              enabled
                ? 'update.agentAutoUpdate.enableDescription'
                : 'update.agentAutoUpdate.disableDescription',
            ),
            text('update.agentAutoUpdate.settingsHint'),
          ].join('\n'),
          input: { enabled },
          metadata: { hostOwnedConfirmation: AGENT_APP_UPDATE_HOST_CONFIRMATION },
        });
        if (outcome !== 'allow') return declined(outcome);
        const current = deps.resolveCaller(caller);
        if (current === 'unavailable') return callerUnavailable();
        if (current !== 'owner') return ownerTurnRequired();
        return { status: 'updated', autoUpdateEnabled: deps.writeAutoUpdate(enabled) };
      } finally {
        autoUpdateConfirming = false;
      }
    },

    /**
     * Owner-ready delivery: a failure recorded earlier (any process) or the
     * outcome of an install that restarted the app. Safe to call repeatedly.
     */
    async deliverPendingResult(): Promise<void> {
      const owner = deps.captureOwner();
      if (owner) await deliverRestartResults(owner);
      await flushNotices();
    },
  };
}

export type AgentAppUpdateService = ReturnType<typeof createAgentAppUpdateService>;
