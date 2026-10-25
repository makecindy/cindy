import type { AgentKind, Logger } from "@cindy/maker-core";
import {
  effectiveSourceIdForModel,
  movedCindyAutoSourceId,
  type ProviderView,
} from "@cindy/model-providers";
import {
  buildImDefaultRouteRecord,
  decideImDefaultRoute,
  imDefaultRouteMayNeedSync,
  parseImDefaultRouteRecord,
  recordClaimsPendingIntent,
  sameImDefaultRoute,
  serializeImDefaultRouteRecord,
  type ImDefaultRoute,
  type ImDefaultRouteDecision,
  type ImDefaultRouteRecord,
} from "./channelDefaultRoute";
import { toCoreAgentKind } from "./sessionRepo";

export interface ImChannelDefaultRouteSync {
  /**
   * 本条消息若会触发跟随切换, 返回将要切到的目标路由(新默认可用才返回), 供
   * 发送前的授权检查按真实会跑的路由判断 —— 旧默认坏掉时不能先被「缺授权」挡掉。
   * 只读, 不登记任何东西。
   */
  previewSwitchTarget(sessionId: string): Promise<ImDefaultRoute | null>;
  /**
   * 在 send 锁内对齐。从不抛错。
   * 返回 true = 跟随切换被暂缓(会话有后台工作 / 待处理交互) —— 调用方本次不得再走
   * 通用意图应用(那里的忙判定只看 isTurnRunning, 会立即应用刚登记的意图、跨引擎时
   * 重建仍在承载后台工作的会话, PR #5155 review P1)。
   */
  syncUnderLock(sessionId: string): Promise<boolean>;
  /**
   * 未接线(无运行实例)的任务在接线前先对齐, 避免先用可能已坏的旧路由起一次进程。
   * 自己取放 send 锁, 从不抛错。
   */
  syncBeforeWiring(sessionId: string): Promise<void>;
}

export type RouteAuthCheck = (
  route: Pick<
    ImDefaultRoute,
    "agentKind" | "model" | "providerId" | "agentDeviceId"
  >,
) => Promise<boolean>;

export interface SessionRouteRow {
  agentDeviceId?: string | null;
  source: string | null;
  status: string;
  remoteHostId: string | null;
  orcaRole: string | null;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  effort: string | null;
  /** Fast 不属于路由; 只有跟随切换用得到(保留任务自己的开关), 回填选择不带它。 */
  fastMode?: boolean | "ultrafast" | null;
  imDefaultRoute: string | null;
  feishuBotAppId: string | null;
  imBotContextId: string | null;
}

export interface ImDefaultRouteHost {
  log: Pick<Logger, "info" | "warn">;
  readSessionRouteRow(sessionId: string): Promise<SessionRouteRow | null>;
  listProviders(): Promise<ProviderView[] | null>;
  writeRecord(sessionId: string, json: string): Promise<void>;
  readPendingAgentSwitchRoute(
    sessionId: string,
  ): (ImDefaultRoute & { rev?: number }) | undefined;
  applySessionRouteUnderSendLock(
    sessionId: string,
    route: (ImDefaultRoute & { fastMode: boolean | "ultrafast" }) | null,
    currentAgentKind: AgentKind,
  ): Promise<"applied" | "staged">;
  cancelPendingAgentSwitchForSession(sessionId: string): void;
  acquirePendingAgentSwitchForImSend(
    sessionId: string,
    synchronize: () => Promise<boolean>,
  ): Promise<() => void>;
}
/** 本渠道自己的活跃本机任务。官方 hook / 已轮换的 Telegram 任务没有渠道标记列。 */
export function isChannelOwnedRow(
  row: SessionRouteRow,
  source: string,
  opts?: { includeRevivable?: boolean },
): boolean {
  const statusOk =
    row.status === "active" ||
    (opts?.includeRevivable === true &&
      (row.status === "archived" || row.status === "deleted"));
  if (row.source !== source || !statusOk) return false;
  if (row.remoteHostId || row.orcaRole || !row.model) return false;
  return source === "feishu" ? !!row.feishuBotAppId : !!row.imBotContextId;
}

export function currentRouteOf(row: SessionRouteRow): ImDefaultRoute {
  return {
    agentKind: toCoreAgentKind(row.agentKind),
    model: row.model ?? "",
    providerId: row.providerId?.trim() || null,
    ...(row.agentDeviceId ? { agentDeviceId: row.agentDeviceId } : {}),
    effort: row.effort ?? null,
  };
}

/**
 * 隐式来源按「新路由选择」口径落到具体来源 —— 系统建会话钉住 / 切换时独占改道
 * 用的就是这个口径, 与它钉出的具体 id 视为同一条路由。显式来源原样比较;
 * 唯一例外是被服务端挪到另一家 Cindy 来源的 Auto, 新旧位置视为同一条路由, 否则
 * 任务跟着 Auto 换了来源后会被误判成用户单独改过, 从此不再跟随渠道默认。
 */
export function providerNormalizer(providers: ProviderView[]) {
  return (route: ImDefaultRoute): string | null => {
    if (route.agentDeviceId) return route.providerId;
    const agent = route.agentKind as AgentKind;
    return (
      movedCindyAutoSourceId(providers, {
        agent,
        model: route.model,
        providerId: route.providerId,
      }) ??
      route.providerId ??
      effectiveSourceIdForModel(providers, null, route.model, agent)
    );
  };
}

interface Evaluation {
  decision: ImDefaultRouteDecision;
  record: ImDefaultRouteRecord;
  current: ImDefaultRoute;
  target: ImDefaultRoute;
  targetFingerprint: string;
  providers: ProviderView[];
  /**
   * 任务当前的 Fast 开关。渠道默认不存 Fast, 跟随切换只管 Agent/模型/来源/档位,
   * 单独开过 Fast 的任务不能被顺手清掉(chatgpt-codex-connector P2, PR #5155)。
   */
  currentFastMode: boolean | "ultrafast";
}

export function createDefaultRouteFollower(
  deps: {
    label: string;
    ownsRow(row: SessionRouteRow): boolean;
    fingerprint(): string;
    resolveTarget(
      providers: ProviderView[],
    ): Promise<ImDefaultRoute & { fingerprint: string }>;
    isRouteUsable: RouteAuthCheck;
  },
  host: ImDefaultRouteHost,
): ImChannelDefaultRouteSync {
  const {
    readSessionRouteRow,
    listProviders,
    writeRecord,
    applySessionRouteUnderSendLock,
    readPendingAgentSwitchRoute,
    cancelPendingAgentSwitchForSession,
    acquirePendingAgentSwitchForImSend,
    log,
  } = host;
  const source = deps.label;

  async function evaluate(
    sessionId: string,
  ): Promise<Evaluation | "defer-unknown" | null> {
    const row = await readSessionRouteRow(sessionId);
    if (!row || !deps.ownsRow(row)) return null;
    const record = parseImDefaultRouteRecord(row.imDefaultRoute);
    // 用户单独改过路由(墓碑): 永不跟随, 不必解析新默认。
    if (record?.manual) return null;
    if (!imDefaultRouteMayNeedSync(record, deps.fingerprint())) return null;
    const providers = await listProviders();
    // 目录拿不到就无法可靠比对来源, 本条消息先按原路由走 —— 但若记录仍认领着在世
    // 的系统意图, 调用方必须暂缓通用意图应用(PR #5155 review P2)。
    if (!providers) return "defer-unknown";
    const defaults = await deps.resolveTarget(providers);
    const target: ImDefaultRoute = {
      agentKind: defaults.agentKind,
      model: defaults.model,
      providerId: defaults.providerId,
      ...(defaults.agentDeviceId
        ? { agentDeviceId: defaults.agentDeviceId }
        : {}),
      effort: defaults.effort,
    };
    const current = currentRouteOf(row);
    const pending = readPendingAgentSwitchRoute(sessionId);
    const decision = decideImDefaultRoute({
      record,
      current,
      target,
      targetFp: defaults.fingerprint,
      pendingIntent: pending
        ? {
            agentKind: pending.agentKind,
            model: pending.model,
            providerId: pending.providerId,
            agentDeviceId:
              pending.agentDeviceId === undefined
                ? row.agentDeviceId
                : pending.agentDeviceId,
            effort: pending.effort ?? null,
          }
        : undefined,
      pendingRev: pending?.rev,
      normalizeProvider: providerNormalizer(providers),
    });
    return {
      decision,
      record,
      current,
      target,
      targetFingerprint: defaults.fingerprint,
      providers,
      currentFastMode: row.fastMode ?? false,
    };
  }

  async function switchRoute(
    sessionId: string,
    e: Evaluation,
  ): Promise<boolean> {
    if (!(await deps.isRouteUsable(e.target))) {
      log.warn(
        `default route sync skipped: new ${source} default unusable ` +
          `session=...${sessionId.slice(-8)} target=${e.target.agentKind}/${e.target.model}`,
      );
      return false;
    }
    // 先记下待生效目标(指纹保持旧值): 意图丢失(重启)或应用失败时, 下一条消息
    // 仍能认出这是「跟随中的任务」并重试, 而不是误判为用户改过。
    const pendingFor = (route: ImDefaultRoute, rev?: number) => ({
      route,
      fp: e.targetFingerprint,
      ...(rev !== undefined ? { rev } : {}),
    });
    await writeRecord(
      sessionId,
      buildImDefaultRouteRecord(
        e.record.fp,
        e.record.route,
        pendingFor(e.target),
      ),
    );
    let outcome: "applied" | "staged";
    try {
      outcome = await applySessionRouteUnderSendLock(
        sessionId,
        // Fast 不属于渠道默认: 保留任务自己的开关, 不拿新任务的固定默认覆盖。
        {
          ...e.target,
          agentDeviceId: e.target.agentDeviceId ?? null,
          fastMode: e.currentFastMode,
        },
        e.current.agentKind,
      );
    } catch (err) {
      await writeRecord(sessionId, serializeImDefaultRouteRecord(e.record));
      throw err;
    }
    if (outcome === "staged") {
      // 记登记后读回的意图与它的注册修订号 —— 系统登记时可能改道了来源;
      // 下一条消息据此认出「自己的意图」(用户重新挑过会换修订号, 不会误认)。
      // 这次写失败也不能丢「暂缓」结论: 否则外层会继续通用意图应用, 把刚登记的
      // 意图应用到仍在承载后台工作的会话上(PR #5155 review P1)。
      try {
        const intent = readPendingAgentSwitchRoute(sessionId);
        if (intent) {
          await writeRecord(
            sessionId,
            buildImDefaultRouteRecord(
              e.record.fp,
              e.record.route,
              pendingFor(
                {
                  agentKind: intent.agentKind,
                  model: intent.model,
                  providerId: intent.providerId,
                  agentDeviceId:
                    intent.agentDeviceId === undefined
                      ? e.target.agentDeviceId
                      : intent.agentDeviceId,
                  effort: intent.effort ?? null,
                },
                intent.rev,
              ),
            ),
          );
        }
      } catch (err) {
        // 声称写失败不能留「无修订号的声称 + 带修订号的意图」: 下一条消息的
        // decideImDefaultRoute 会把系统意图误判成用户选择, 走 manual 后被通用 apply
        // 用更宽的忙判定应用掉(chatgpt-codex-connector P2, PR #5155)。撤回本次意图
        // 并恢复原声称 —— 下一条消息按「仍在跟随」重新发起切换, 自愈确定。
        // (send 锁在手, 意图必然是本次登记的, 不会误伤用户的选择。)
        log.warn(
          `default route staged claim write failed; withdrawing intent session=...${sessionId.slice(-8)}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        cancelPendingAgentSwitchForSession(sessionId);
        try {
          await writeRecord(
            sessionId,
            buildImDefaultRouteRecord(e.record.fp, e.record.route),
          );
        } catch (restoreErr) {
          log.warn(
            `default route claim restore failed (non-fatal) session=...${sessionId.slice(-8)}: ` +
              (restoreErr instanceof Error
                ? restoreErr.message
                : String(restoreErr)),
          );
        }
      }
      log.info(
        `default route switch staged session=...${sessionId.slice(-8)} (runtime busy)`,
      );
      return true;
    }
    await recordApplied(sessionId, e);
    return false;
  }

  /**
   * 忙时登记的跟随意图由这里自己应用, 不交给通用发送路径: 同引擎应用失败在那边会
   * 直接让用户这条消息失败。这里失败则撤回意图、保持原路由。
   */
  async function applyStaged(
    sessionId: string,
    e: Evaluation,
  ): Promise<boolean> {
    let outcome: "applied" | "staged";
    try {
      outcome = await applySessionRouteUnderSendLock(
        sessionId,
        null,
        e.current.agentKind,
      );
    } catch (err) {
      await writeRecord(
        sessionId,
        buildImDefaultRouteRecord(e.record.fp, e.record.route),
      );
      throw err;
    }
    if (outcome === "applied") {
      await recordApplied(sessionId, e);
      return false;
    }
    return true;
  }

  async function recordApplied(
    sessionId: string,
    e: Evaluation,
  ): Promise<void> {
    // 记录读回的实际路由 —— 系统可能在应用时改道来源 / 校正档位。
    const after = await readSessionRouteRow(sessionId);
    const applied = after ? currentRouteOf(after) : e.target;
    const normalize = providerNormalizer(e.providers);
    if (!sameImDefaultRoute(applied, e.target, normalize)) {
      log.warn(
        `default route switch landed on a different route session=...${sessionId.slice(-8)} ` +
          `target=${e.target.agentKind}/${e.target.model} actual=${applied.agentKind}/${applied.model}`,
      );
    }
    await writeRecord(
      sessionId,
      buildImDefaultRouteRecord(e.targetFingerprint, applied),
    );
    log.info(
      `default route followed session=...${sessionId.slice(-8)} ` +
        `${e.current.agentKind}/${e.current.model} -> ${applied.agentKind}/${applied.model}`,
    );
  }

  async function previewSwitchTarget(
    sessionId: string,
  ): Promise<ImDefaultRoute | null> {
    try {
      const e = await evaluate(sessionId);
      if (!e || e === "defer-unknown") return null;
      if (e.decision.kind !== "switch" && e.decision.kind !== "staged")
        return null;
      return (await deps.isRouteUsable(e.target)) ? e.target : null;
    } catch (err) {
      log.warn(
        `default route preview failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * 目录暂不可读、无法判定要不要跟随时, 记录仍认领着在世系统意图 ⇒ 本次暂缓通用
   * 意图应用(返回 true): 那里的忙判定只看 isTurnRunning, 会把刚登记的意图应用到
   * 仍在承载后台工作/交互的会话上(PR #5155 review P2)。认不出是自己的意图就不挡。
   */
  async function followClaimStillPending(sessionId: string): Promise<boolean> {
    try {
      const row = await readSessionRouteRow(sessionId);
      if (!row || !deps.ownsRow(row)) return false;
      const pending = readPendingAgentSwitchRoute(sessionId);
      return recordClaimsPendingIntent(
        parseImDefaultRouteRecord(row.imDefaultRoute),
        pending
          ? {
              agentKind: pending.agentKind,
              model: pending.model,
              providerId: pending.providerId,
              agentDeviceId:
                pending.agentDeviceId === undefined
                  ? row.agentDeviceId
                  : pending.agentDeviceId,
              effort: pending.effort ?? null,
            }
          : undefined,
        pending?.rev,
      );
    } catch (err) {
      log.warn(
        `default route pending-claim check failed (non-fatal) session=...${sessionId.slice(-8)}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  async function syncUnderLock(sessionId: string): Promise<boolean> {
    try {
      const e = await evaluate(sessionId);
      if (e === "defer-unknown")
        return await followClaimStillPending(sessionId);
      if (!e) return false;
      switch (e.decision.kind) {
        case "adopt":
          if (e.decision.cancelPendingIntent)
            cancelPendingAgentSwitchForSession(sessionId);
          await writeRecord(
            sessionId,
            buildImDefaultRouteRecord(e.targetFingerprint, e.current),
          );
          return false;
        case "switch":
          return await switchRoute(sessionId, e);
        case "staged":
          return await applyStaged(sessionId, e);
        case "manual":
          // 用户的选择顶掉了本功能登记的待生效意图: 清掉过时声称, 但绝不动用户的意图。
          if (e.decision.clearStalePending) {
            await writeRecord(
              sessionId,
              buildImDefaultRouteRecord(e.record.fp, e.record.route),
            );
          }
          return false;
      }
    } catch (err) {
      log.warn(
        `default route sync failed (non-fatal, keeping current route) session=...${sessionId.slice(-8)}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
      return false;
    }
  }

  async function syncBeforeWiring(sessionId: string): Promise<void> {
    try {
      const release = await acquirePendingAgentSwitchForImSend(sessionId, () =>
        syncUnderLock(sessionId),
      );
      release();
    } catch (err) {
      log.warn(
        `default route pre-wiring sync failed (non-fatal) session=...${sessionId.slice(-8)}: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  return { previewSwitchTarget, syncUnderLock, syncBeforeWiring };
}
