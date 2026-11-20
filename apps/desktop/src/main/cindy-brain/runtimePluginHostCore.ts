import { eq } from 'drizzle-orm';
import { isDataOwnerPushStamp, type DataOwnerPushStamp } from '../../shared/dataOwnerPush.js';
import { ghostControlPointActive, type GhostControlPointData, type GhostControlPointFailureAction,
  type GhostControlPointId, type GhostControlPointResult, type GhostRuntimeControlPointResult,
  type InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart, resolvePluginInstanceQuery } from '../../shared/pluginIdentity.js';
import type { PluginModelPickerRoute } from '../../shared/pluginModelPicker.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import * as localDbSchema from '../localDb/schema.js';
import type { Logger } from '../logger.js';
import type { GhostToolApprovalResolver } from '../maker-host/mcp-tool-approval-policy.js';
import { readRuntimePluginSettings } from '../maker-host/runtime-plugin-settings.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isGhostCardModelRouteAvailable } from './ghostModelPicker.js';
import type { GhostOwnerScope } from './ghostOwnerScope.js';
import { createRuntimeContextProviders } from './runtimeContext.js';
import { createRuntimePluginControl } from './runtimeControl.js';
import { createStaticPromptProvider } from './staticPrompt.js';
import { GhostSubscriptionGateway, isGhostEligibleSessionRow, isGhostSessionSwitchEligibleRow,
  type GhostScreenResult, type GhostSubscriptionGatewayDeps } from './subscriptionGateway.js';
import { createPluginToolLifecycle } from './toolLifecycleControl.js';

export const GHOST_HOOK_FUSED_CHANNEL = 'ghosts:hook-fused';

type DeliveryPorts = {
  availableGhosts(): InstalledGhost[];
  getGhostRuntime(): {
    stateOf(id: string): string;
    spawn(ghost: InstalledGhost): Promise<{ ok: true } | { ok: false; reason: string }>;
  };
  isRunningInstall?: GhostSubscriptionGatewayDeps['isRunningInstall'];
  listGhostNotificationCandidates: NonNullable<GhostSubscriptionGatewayDeps['listGhostsAsync']>;
  findGhostNotificationTarget: NonNullable<GhostSubscriptionGatewayDeps['findGhostForDelivery']>;
  sendToGhostLogic(id: string, event: Parameters<GhostSubscriptionGatewayDeps['sendToGhost']>[1]): boolean;
  broadcastGhostWindowPush(channel: string, payload: unknown, owner?: DataOwnerPushStamp): void;
  ghostOwnerScope?: GhostOwnerScope;
  hookDeliveryPauseSignal?: GhostSubscriptionGatewayDeps['hookDeliveryPauseSignal'];
  log: Pick<Logger, 'warn' | 'info'>;
};

/** One gateway for event publication, hook requests and authenticated sandbox replies. */
export function createSubscriptionGatewayReader(ports: DeliveryPorts) {
  const { getGhostRuntime, availableGhosts, listGhostNotificationCandidates, findGhostNotificationTarget,
    sendToGhostLogic, broadcastGhostWindowPush, ghostOwnerScope, log } = ports;
  let subscriptionGatewaySingleton: GhostSubscriptionGateway | null = null;
  function getGhostSubscriptionGateway(): GhostSubscriptionGateway {
    if (!subscriptionGatewaySingleton) {
      subscriptionGatewaySingleton = new GhostSubscriptionGateway({
        listGhosts: availableGhosts,
        listGhostsAsync: listGhostNotificationCandidates,
        findGhostForDelivery: findGhostNotificationTarget,
        isRunning: (id) => getGhostRuntime().stateOf(id) === 'running',
        isRunningInstall: ports.isRunningInstall,
        wake: async (ghost) => {
          const r = await getGhostRuntime().spawn(ghost);
          if (!r.ok) throw new Error(r.reason);
        },
        sendToGhost: (ghostId, payload, synchronousInstall) => {
          const ghost = synchronousInstall ?? findGhostNotificationTarget(ghostId);
          // 适配:底层返回 false 表示投递失败(网关契约是抛错 → 走缓冲/熔断)。
          if (!ghost?.enabled || ('topic' in payload && !ghost.manifest.subscribe?.topics?.includes(payload.topic))
            || !sendToGhostLogic(installedGhostStoragePart(ghost), payload)) {
            throw new Error('ghost pipe send failed');
          }
        },
        now: () => Date.now(),
        onHookFused: (ghost, ownerStamp) => {
          broadcastGhostWindowPush(
            GHOST_HOOK_FUSED_CHANNEL,
            {
              ghostId: ghost.manifest.id,
              name: ghost.manifest.name,
            },
            isDataOwnerPushStamp(ownerStamp) ? ownerStamp : undefined,
          );
        },
        ownerScope: ghostOwnerScope,
        hookDeliveryPauseSignal: ports.hookDeliveryPauseSignal,
        log,
      });
    }
    return subscriptionGatewaySingleton;
  }
  return { getGhostSubscriptionGateway, dropGhost: (id: string) => subscriptionGatewaySingleton?.dropGhost(id) };
}

export interface RuntimePluginHostPorts extends DeliveryPorts {
  ghostOwnerScope: GhostOwnerScope;
  log: Pick<Logger, 'debug' | 'warn' | 'info'>;
  getGhostOwnerPushStamp(): DataOwnerPushStamp | undefined;
  isGhostOwnerStampCurrent(stamp: DataOwnerPushStamp | undefined): boolean;
  findGhostForInstanceId(id: string, namespace?: string | null): InstalledGhost | null;
  modelRouteSources(): Parameters<typeof isGhostCardModelRouteAvailable>[1];
}

export function createRuntimePluginHost(ports: RuntimePluginHostPorts) {
  const { availableGhosts, findGhostNotificationTarget, getGhostOwnerPushStamp,
    isGhostOwnerStampCurrent, findGhostForInstanceId, log } = ports;
  const { getGhostSubscriptionGateway, dropGhost } = createSubscriptionGatewayReader(ports);
  /**
   * 会话是否在订阅事件的投递范围。默认只允许非 Orca 用户主任务；session-switch
   * 额外允许已归一后的 Orca Lead，行级判定见 subscriptionGateway。
   * outcome 三值:eligible / ineligible(查到行且明确不合格,可终身缓存)/
   * retry(DB 未就绪、查询抛错、行还没落库——都是暂时态,调用方稍后重试;
   * 2026-07-12 实测:启动期会话接线早于 DbClient 就绪,一次性判定会把
   * 所有重连会话终身误杀)。
   */
  async function isGhostEligibleSession(
    sessionId: string,
    scope: 'default' | 'session-switch' = 'default',
  ): Promise<
    | { outcome: 'eligible'; agentKind?: string; workdir?: string }
    | { outcome: 'ineligible' }
    | { outcome: 'retry' }
  > {
    try {
      // 查询必须 await(DB 走 worker-thread 异步代理,全仓惯用法),不能用
      // 同步 .all()——代理下拿不到真实行(2026-07-12 实测踩坑)。
      const rows = await getDbClient()
        .drizzle.select({
          source: localDbSchema.sessions.source,
          orcaRole: localDbSchema.sessions.orcaRole,
          agentKind: localDbSchema.sessions.agentKind,
          workingDir: localDbSchema.sessions.workingDir,
        })
        .from(localDbSchema.sessions)
        .where(eq(localDbSchema.sessions.id, sessionId))
        .limit(1);
      const row = rows[0];
      if (!row) return { outcome: 'retry' }; // 行未落库(极早期)→ 暂时态
      const isEligible =
        scope === 'session-switch'
          ? isGhostSessionSwitchEligibleRow(row)
          : isGhostEligibleSessionRow(row);
      if (isEligible) {
        return {
          outcome: 'eligible',
          agentKind: row.agentKind ?? undefined,
          workdir: row.workingDir ?? undefined,
        };
      }
      log.debug('ghost eligibility: rejected', {
        sessionId,
        source: String(row.source),
        orcaRole: String(row.orcaRole),
      });
      return { outcome: 'ineligible' };
    } catch (err) {
      // DB 未就绪等基建失败:暂时态,绝不终身定性(也绝不影响会话)。
      log.debug('ghost eligibility: transient failure, will retry', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { outcome: 'retry' };
    }
  }

  /**
   * 是否装有**启用中**的 will-user-message 拦截意识(纯本地判定,不触发钩子)。
   *
   * 调用方(自动起名)据此决定要不要把用户原话送去标题模型:那是一次独立的 AI 发送,
   * 而拦截钩的全部意义就是不让某些内容到达 AI。这里只问"有没有人在管",不重复询问
   * 钩子本身 —— 重复询问会让 Ghost 对同一条消息被问两次,产生它没预期的副作用。
   */
  function hasEnabledUserMessageHookGhost(): boolean {
    try {
      return availableGhosts().some(
        (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
      );
    } catch {
      // 判定不了就按"有人在管"处理:宁可少一个智能标题,也不把内容送出去。
      return true;
    }
  }

  async function screenGhostUserMessage(
    sessionId: string,
    text: string,
  ): Promise<GhostScreenResult> {
    const ownerStamp = getGhostOwnerPushStamp();
    try {
      const hasHookGhost = availableGhosts().some(
        (g) => g.enabled && g.manifest.subscribe?.hooks?.includes('will-user-message'),
      );
      if (!hasHookGhost) return { action: 'allow' };
      // retry(DB 未就绪)也放行:拦截是尽力而为的旁路,fail-open 不挡发送。
      if ((await isGhostEligibleSession(sessionId)).outcome !== 'eligible')
        return { action: 'allow' };
      const result = await getGhostSubscriptionGateway().screenUserMessage(
        { sessionId, text },
        ownerStamp,
      );
      return isGhostOwnerStampCurrent(ownerStamp) ? result : { action: 'allow' };
    } catch (err) {
      log.warn('ghost screen failed (fail-open)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { action: 'allow' };
    }
  }

  /**
   * 控制节点询问(定时任务、例行任务在运行前调用)。只问该任务选定的插件(preRunPlugin);
   * 插件不可用或出错时按任务的 onFailure 处理。owner 在询问期间切换时按放行收口，调用方的
   * 流程自己也会因 owner 失效而中止；网关本身异常同样按 onFailure 处理，不静默放行。
   */
  function getGhostRuntimePluginControl(): ReturnType<typeof createRuntimePluginControl> {
    return ghostRuntimeControl ??= createRuntimePluginControl({
      readSettings: readRuntimePluginSettings,
      captureOwner: () => {
        const owner = getGhostOwnerPushStamp();
        return () => isGhostOwnerStampCurrent(owner) && !isAppSessionBoundaryPending();
      },
      screen: (point, data, target, timeoutMs) => screenGhostControlPoint(point, data, target, timeoutMs),
    });
  }
  let ghostRuntimeControl: ReturnType<typeof createRuntimePluginControl> | undefined;
  const ghostToolLifecycleControl = createPluginToolLifecycle({ readSettings: readRuntimePluginSettings, control: getGhostRuntimePluginControl });
  let ghostRuntimeContexts: ReturnType<typeof createRuntimeContextProviders> | undefined;
  function runtimeContextProviders() {
    return ghostRuntimeContexts ??= createRuntimeContextProviders(getGhostRuntimePluginControl());
  }
  function composeGhostRuntimeContext(sessionId: string, text: string | (() => string), signal?: AbortSignal): Promise<string> | undefined {
    return runtimeContextProviders().compose(sessionId, text, signal);
  }
  const ghostTaskSystemPrompt = createStaticPromptProvider({ readSettings: readRuntimePluginSettings,
    find: id => findGhostNotificationTarget(id) ?? undefined });
  function searchGhostRuntimeMemories(query: string,
    opts: { type?: 'user' | 'feedback' | 'project' | 'reference'; limit?: number },
    context?: { sessionId?: string }) {
    if (!context?.sessionId) return undefined;
    return runtimeContextProviders().search({ sessionId: context.sessionId, query, limit: opts.limit ?? 10,
      ...(opts.type ? { type: opts.type } : {}) });
  }

  function screenGhostControlPoint(
    point: 'will-start-turn' | 'will-model-request' | 'will-compose-context' | 'will-search-memory' | 'will-tool-call' | 'did-tool-result',
    data: GhostControlPointData,
    target: { pluginId: string; onFailure: GhostControlPointFailureAction },
    timeoutMs?: number,
  ): Promise<GhostRuntimeControlPointResult>;
  function screenGhostControlPoint(
    point: Exclude<GhostControlPointId, 'will-start-turn' | 'will-model-request' | 'will-compose-context' | 'will-search-memory' | 'will-tool-call' | 'did-tool-result'>,
    data: GhostControlPointData,
    target: { pluginId: string; onFailure: GhostControlPointFailureAction },
  ): Promise<GhostControlPointResult>;
  async function screenGhostControlPoint(
    point: GhostControlPointId,
    data: GhostControlPointData,
    target: { pluginId: string; onFailure: GhostControlPointFailureAction },
    timeoutMs?: number,
  ): Promise<GhostRuntimeControlPointResult> {
    const ownerStamp = getGhostOwnerPushStamp();
    try {
      const result = await getGhostSubscriptionGateway().screenControlPoint(point, data, target, timeoutMs);
      return isGhostOwnerStampCurrent(ownerStamp) ? result : { action: 'allow' };
    } catch (err) {
      log.warn('ghost control point screen failed', {
        point,
        error: err instanceof Error ? err.message : String(err),
      });
      if (target.onFailure === 'allow') return { action: 'allow' };
      return { action: target.onFailure, ghostId: target.pluginId, ghostName: target.pluginId, reason: '', failure: true };
    }
  }

  /**
   * 保存任务的插件前置检查时把用户 / Agent 给的插件(实例 id 或唯一的插件 id)解析成
   * 实例 id；插件不可选(没装、停用、没声明或没批准该节点)时报错，不保存一个必然失败的检查。
   */
  function resolveGhostControlPointPlugin(point: GhostControlPointId, pluginId: string): string {
    const resolved = resolvePluginInstanceQuery(availableGhosts(), pluginId);
    if (resolved.status === 'ambiguous') throwIpcError('INVALID_PARAMS', 'Several installed plugins share this id; use the instance id');
    if (resolved.status !== 'unique') throwIpcError('NOT_FOUND', 'The pre-run check plugin is not installed');
    if (!ghostControlPointActive(resolved.ghost, point)) {
      throwIpcError('INVALID_PARAMS', 'This plugin is not enabled for pre-run checks; enable it and allow the check in its install or update prompt');
    }
    return installedGhostStoragePart(resolved.ghost);
  }

  /** 卡内模型下拉框回传的模型:远程位置还须是当前可选的位置。 */
  async function isPluginModelRouteAvailableNow(route: PluginModelPickerRoute): Promise<boolean> {
    const owner = activeOwnerScopeKey();
    const available = await isGhostCardModelRouteAvailable(route, ports.modelRouteSources());
    return owner === activeOwnerScopeKey() && available;
  }

  const resolveToolApproval: GhostToolApprovalResolver = ({ ghostId, namespace, tool }) => {
    const ghost = findGhostForInstanceId(ghostId, namespace);
    if (!ghost || ghost.approval.state !== 'approved') return null;
    const decl = ghost.manifest.tools?.find((candidate) => candidate.name === tool);
    if (!decl) return null;
    const declared = decl.approval === 'each-call'
      ? 'each-call' as const
      : decl.approval === 'auto' && ghost.approvedAutoTools?.includes(tool) === true ? 'auto' as const : null;
    return { declared };
  };

  return { getGhostSubscriptionGateway, dropGhost, isGhostEligibleSession, hasEnabledUserMessageHookGhost,
    screenGhostUserMessage, getGhostRuntimePluginControl, ghostToolLifecycleControl, composeGhostRuntimeContext,
    ghostTaskSystemPrompt, searchGhostRuntimeMemories, screenGhostControlPoint, resolveGhostControlPointPlugin,
    isPluginModelRouteAvailableNow, resolveToolApproval };
}
