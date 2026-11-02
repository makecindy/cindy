/**
 * 伙伴自主跟进 · 轻量入口（hub）。
 *
 * 输入协调器（register）、伙伴 IPC（bots.ts）只经这里读写，不直接 import 带设备互联 / 通知 /
 * 灵动岛依赖的 service.ts；运行体由 service.ts 在例行任务引擎启动后挂进来。
 */
import type { BrowserWindow } from 'electron';
import type { RoutineEngine, RoutineRun } from '@cindy/maker-scheduler';

import {
  type BotAutonomySettingsView,
  type BotGlance,
  type BotAutonomyExecution,
} from '../../shared/botAutonomy.js';
import type { BotSystemSkillId } from '../../shared/botSystemSkills.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { createLogger } from '../logger.js';
import {
  readBotAutonomySettingsOverride,
  resetBotAutonomySettings,
  writeBotAutonomySchedulerBotId,
} from '../maker-host/bot-autonomy-settings-store.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { filterFollowUpEvents, resolveSchedulerBotId, type FollowUpSubject } from './follower.js';
import { readBotDirectory, readBotSystemSkillsOffFor, readLocalSessionMetas, readTaskOwnership } from './hostData.js';
import type { BotAutonomyRuntime, GlanceOptions } from './runtime.js';
import { errorCode, type BotAutonomyInputProjection } from './taskWatch.js';

const log = createLogger('bot-autonomy');

export interface BotAutonomyHostDeps {
  readSessionExecution(sessionId: string): BotAutonomyExecution | null;
  /** A durable terminal receipt owns this event's execution, including pending delivery. */
  isCompletionHandledByTeammate(sessionId: string, botId: string, execution: BotAutonomyExecution): Promise<boolean | null>;
  hasTaskDeliveryOrigin?(sessionId: string): Promise<boolean>;
  restoreTaskDeliveries?(): void;
  noteTaskDelivery?(sessionId: string, execution: BotAutonomyExecution, final: boolean): boolean;
  /** 某个本机任务当前挂起的交互请求（只读）。 */
  getPendingInteractions(sessionId: string): readonly unknown[];
  getMainWindow(): BrowserWindow | null;
}

let hostDeps: Partial<BotAutonomyHostDeps> = {};
let current: { scope: string; engine: RoutineEngine; runtime: BotAutonomyRuntime } | null = null;

/** 各宿主模块分别补自己持有的入口（register 给挂起交互，bootstrap 给主窗口）。 */
export function configureBotAutonomyHost(deps: Partial<BotAutonomyHostDeps>): void {
  hostDeps = { ...hostDeps, ...deps };
}

export function getBotAutonomyHostDeps(): Partial<BotAutonomyHostDeps> {
  return hostDeps;
}

export function getActiveBotAutonomy(): typeof current {
  return current;
}

export function setActiveBotAutonomy(next: typeof current): void {
  current = next;
  if (next && scopeIsCurrent(next.scope)) hostDeps.restoreTaskDeliveries?.();
}

export function scopeIsCurrent(scope: string): boolean {
  return !isAppSessionBoundaryPending() && activeOwnerScopeKey() === scope;
}

/** 输入协调器投影（出错 / 用量上限等待）旁路进状态表。 */
export function noteBotAutonomyInputProjection(projection: unknown): void {
  const runtime = current?.runtime;
  if (!runtime || !projection || typeof projection !== 'object') return;
  runtime.watch.applyInputProjection(projection as BotAutonomyInputProjection);
}

/** Followed work and tasks with a recorded origin share the same delivery report. */
export async function readTaskDeliveryNote(sessionId: string): Promise<string | null> {
  const active = current;
  if (!active || !scopeIsCurrent(active.scope)) return null;
  const ownership = await readTaskOwnership(ownerScopedUserDataPath());
  if (current !== active || !scopeIsCurrent(active.scope)) return null;
  if ([...ownership.bots.values()].some(bot => bot.canonicalSessionId === sessionId)) return null;
  const hasOrigin = await hostDeps.hasTaskDeliveryOrigin?.(sessionId);
  if (current !== active || !scopeIsCurrent(active.scope)) return null;
  if (!ownership.creatorBySession.has(sessionId) && !active.runtime.watch.getSchedulerBotId() && !hasOrigin) return null;
  return '[Task delivery] Host bookkeeping, not a user message: before your final answer in every turn, call cindy_helper.call_tool({name:"report_task_delivery",args:{final_delivery:true|false}}). Judge whether this turn newly delivers the requested result: PR delivered for human review, merged/closed, or goal achieved is true; intermediate review fixes, waiting for CI, or repeated status is false. A true report followed by normal completion is delivered by the host to the recorded original conversation, or uses existing follow-up when no origin is recorded.';
}

export function reportTaskDelivery(sessionId: string, finalDelivery: boolean, sessionInstanceId?: string):
  { ok: true } | { ok: false; errorCode: string; message: string } {
  const active = current;
  const execution = hostDeps.readSessionExecution?.(sessionId);
  if (!active || !scopeIsCurrent(active.scope) || !execution
    || (sessionInstanceId !== undefined && sessionInstanceId !== execution.instanceId)) {
    return { ok: false, errorCode: 'PRECONDITION_FAILED', message: 'The current task execution is not running.' };
  }
  const originReported = hostDeps.noteTaskDelivery?.(sessionId, execution, finalDelivery) ?? false;
  if (!active.runtime.watch.reportDelivery(sessionId, execution, finalDelivery) && !originReported) {
    return { ok: false, errorCode: 'PRECONDITION_FAILED', message: 'The current task execution is not running.' };
  }
  return { ok: true };
}

export function getBotAutonomyGlance(
  botId: string, options?: GlanceOptions, refreshRemote = true,
): BotGlance {
  if (isAppSessionBoundaryPending()) throwIpcError('PRECONDITION_FAILED', 'App session is switching; retry later.');
  const active = current && scopeIsCurrent(current.scope) ? current.runtime : null;
  // 与伙伴工具读取保持一致：运行体或归属未就绪不是「没有任务」。
  // 沿用已有错误协议，旧查看端也能进入读取失败分支；就绪后的变化推送会触发重读。
  if (!active?.watch.isReady()) throwIpcError('PRECONDITION_FAILED', 'Bot autonomy is not ready; retry later.');
  const scope = activeOwnerScopeKey();
  // The hidden auto-open probe and Agent reads use cached projections only.
  // Return cached/local rows immediately; the watch pushes changes when remote IO settles.
  if (refreshRemote && active.watch.getSchedulerBotId() === botId) {
    void active.watch.refreshRemote().catch((error) => log.warn('autonomy remote refresh failed', { error: errorCode(error) }));
  }
  assertOwner(scope);
  if (current?.runtime !== active) throwIpcError('PRECONDITION_FAILED', 'Task observation changed; retry later.');
  return active.glance(botId, options);
}

export async function getBotAutonomySettingsView(): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  const bots = await readBotDirectory();
  assertOwner(scope);
  const override = readBotAutonomySettingsOverride();
  return {
    schedulerBotId: resolveSchedulerBotId(override, bots),
    isCustomized: override.customized,
    defaults: { schedulerBotId: null },
  };
}

function assertOwner(scope: string): void {
  if (!scopeIsCurrent(scope)) throwIpcError('PRECONDITION_FAILED', 'App session changed; retry in the current account.');
}

/** 设置「自动跟进所有任务」归谁；null = 关闭。目标伙伴必须存在、没被归档，且没关掉「跟进」。 */
export async function setBotAutonomySchedulerBotId(schedulerBotId: string | null): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  assertOwner(scope);
  if (schedulerBotId !== null) {
    const bots = await readBotDirectory();
    assertOwner(scope);
    const bot = bots.get(schedulerBotId);
    if (!bot || bot.status === 'archived' || bot.status === 'deleting') throwIpcError('NOT_FOUND', 'Teammate not found');
    if (bot.followOff) throwIpcError('PRECONDITION_FAILED', 'SYSTEM_SKILL_OFF: this teammate\'s follow-up system Skill is turned off');
  }
  await writeBotAutonomySchedulerBotId(schedulerBotId);
  return afterSettingsChange(scope);
}

/** 删除 override，跟随当前版本默认。 */
export async function resetBotAutonomySchedulerSettings(): Promise<BotAutonomySettingsView> {
  const scope = activeOwnerScopeKey();
  assertOwner(scope);
  await resetBotAutonomySettings();
  return afterSettingsChange(scope);
}

async function afterSettingsChange(scope: string): Promise<BotAutonomySettingsView> {
  assertOwner(scope);
  const runtime = current && current.scope === scope ? current.runtime : null;
  if (runtime) await runtime.refreshFollowers().catch((error) => log.warn('autonomy refresh failed', { error: errorCode(error) }));
  log.info('autonomy scheduler setting changed');
  return getBotAutonomySettingsView();
}

/**
 * 伙伴当前关掉的系统技能（cindy-bots-runtime.md §6「伙伴技能分层」）：例行任务执行前据此跳过它的跟进与「每天查待办」，
 * 待办设置与执行入口据此拒绝。
 */
export async function botSystemSkillsOff(botId: string): Promise<BotSystemSkillId[]> {
  return readBotSystemSkillsOffFor(botId);
}

/** null means startup is not ready; an empty batch has lost its authorization. */
export async function currentFollowUpEvents(botId: string, events: RoutineRun['events']): Promise<{
  events: RoutineRun['events']; canDispatch(): boolean;
} | null> {
  const active = current;
  if (!active || !scopeIsCurrent(active.scope) || !active.runtime.watch.isReady()) return null;
  const watch = active.runtime.watch;
  const botsAtRead = watch.getBots();
  // The queue outlives watched rows (including across restarts). Read current durable
  // ownership for event subjects; only sweep needs the transient pending-state table.
  const [metas, ownership] = await Promise.all([
    readLocalSessionMetas(events.flatMap(({ event }) => event.type !== 'sweep' && typeof event.subject === 'string' ? [event.subject] : [])),
    readTaskOwnership(ownerScopedUserDataPath()),
  ]);
  if (current !== active || !scopeIsCurrent(active.scope) || watch.getBots() !== botsAtRead) return null;
  const subjects: FollowUpSubject[] = metas.filter(meta => meta.status === 'active' && meta.hiddenAt === null
    && meta.orcaRole !== 'worker' && meta.source !== 'review'
    && !['history', 'group', 'channel', 'thread'].includes(meta.laneRole ?? '')).map(meta => {
      const canonical = [...ownership.bots].find(([, bot]) => bot.canonicalSessionId === meta.id)?.[0]
        ?? (meta.laneRole === 'canonical' ? meta.laneBotId : null);
      const creator = ownership.creatorBySession.get(meta.id) ?? null;
      return { sessionId: meta.id, deviceId: null, shared: meta.source === 'shared',
        canonicalOfBotId: canonical, creatorBotId: creator === canonical ? null : creator };
    });
  const allowedNow = () => filterFollowUpEvents(botId, events, watch.list(),
    resolveSchedulerBotId(readBotAutonomySettingsOverride(), ownership.bots), ownership.bots, Date.now(), subjects);
  const eligible = allowedNow();
  // Only the built-in follow-up consumes this gate. Keep publishing host events
  // for user-authored routines, and recheck persisted batches before model work.
  let handled: (boolean | null)[];
  try {
    handled = await Promise.all(eligible.map(({ event }) => {
      const { executionInstanceId, executionGeneration } = event.data;
      // Legacy batches have no execution proof. Preserve their follow-up rather
      // than attributing them to whichever native turn happens to be live now.
      if (event.type !== 'finished' || typeof event.subject !== 'string'
        || typeof executionInstanceId !== 'string' || !executionInstanceId
        || typeof executionGeneration !== 'number' || !Number.isSafeInteger(executionGeneration)) return false;
      return hostDeps.isCompletionHandledByTeammate?.(event.subject, botId,
        { instanceId: executionInstanceId, generation: executionGeneration }) ?? null;
    }));
  } catch (error) {
    log.warn('autonomy completion ownership deferred', { error: errorCode(error) });
    return null;
  }
  if (current !== active || !scopeIsCurrent(active.scope) || watch.getBots() !== botsAtRead
    || handled.includes(null)) return null;
  const allowed = eligible.filter((_event, index) => !handled[index]);
  return { events: allowed, canDispatch: () => current === active && scopeIsCurrent(active.scope) && watch.isReady()
    && watch.getBots() === botsAtRead && allowedNow().length === eligible.length };
}
