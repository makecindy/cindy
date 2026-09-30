/**
 * 个人 IM 渠道任务跟随渠道默认 —— 读写 `sessions.im_default_route` 并驱动切换。
 *
 * 时机: 渠道自有任务收到下一条消息、进入 send 锁之后(acquirePendingAgentSwitchForImSend
 * 的回调)。切换走与伙伴模型对齐同一套路由选择(跨引擎带交接, 会话忙时留意图);
 * 任何失败都只记日志、保持原路由, 绝不挡住用户这条消息。判定规则见
 * channelDefaultRoute.ts。
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { AgentKind } from '@cindy/maker-core';
import { effectiveSourceIdForModel, type ProviderView } from '@cindy/model-providers';

import type { ImDefaultSettingsChannel } from '../../../shared/imDefaultSettings.js';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { createLogger } from '../../logger';
import { getDesktopProviderService } from '../../maker-host/createDesktopProviderService';
import {
  acquirePendingAgentSwitchForImSend,
  applySessionRouteUnderSendLock,
  cancelPendingAgentSwitchForSession,
  readPendingAgentSwitchRoute,
} from '../../maker-ipc/register';
import { withSendToSessionLock } from '../../maker-ipc/sendToSessionLock';
import {
  readImDefaultSettingsFingerprint,
  readImRawDefaultRoute,
  resolveImSessionDefaults,
} from '../defaultSessionSettings';
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
} from './channelDefaultRoute';
import { resetSessionToDefaults, toCoreAgentKind, type ImSessionRow } from './sessionRepo';
import type { ImOrchestratorConfig } from './types';

const log = createLogger('im:default-route');

type RouteAuthCheck = (route: Pick<ImDefaultRoute, 'agentKind' | 'model' | 'providerId'>) => Promise<boolean>;

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

interface SessionRouteRow {
  source: string | null;
  status: string;
  remoteHostId: string | null;
  orcaRole: string | null;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  effort: string | null;
  /** Fast 不属于路由; 只有跟随切换用得到(保留任务自己的开关), 回填选择不带它。 */
  fastMode?: boolean | null;
  imDefaultRoute: string | null;
  feishuBotAppId: string | null;
  imBotContextId: string | null;
}

async function readSessionRouteRow(sessionId: string): Promise<SessionRouteRow | null> {
  const [row] = await getDbClient()
    .drizzle.select({
      source: sessions.source,
      status: sessions.status,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      effort: sessions.effort,
      fastMode: sessions.fastMode,
      imDefaultRoute: sessions.imDefaultRoute,
      feishuBotAppId: sessions.feishuBotAppId,
      imBotContextId: sessions.imBotContextId,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row ?? null;
}

/** 本渠道自己的活跃本机任务。官方 hook / 已轮换的 Telegram 任务没有渠道标记列。 */
function isChannelOwnedRow(
  row: SessionRouteRow,
  source: string,
  opts?: { includeRevivable?: boolean },
): boolean {
  const statusOk =
    row.status === 'active' ||
    (opts?.includeRevivable === true && (row.status === 'archived' || row.status === 'deleted'));
  if (row.source !== source || !statusOk) return false;
  if (row.remoteHostId || row.orcaRole || !row.model) return false;
  return source === 'feishu' ? !!row.feishuBotAppId : !!row.imBotContextId;
}

function currentRouteOf(row: SessionRouteRow): ImDefaultRoute {
  return {
    agentKind: toCoreAgentKind(row.agentKind),
    model: row.model ?? '',
    providerId: row.providerId?.trim() || null,
    effort: row.effort ?? null,
  };
}

/**
 * 隐式来源按「新路由选择」口径落到具体来源 —— 系统建会话钉住 / 切换时独占改道
 * 用的就是这个口径, 与它钉出的具体 id 视为同一条路由。显式来源原样比较。
 */
function providerNormalizer(providers: ProviderView[]) {
  return (route: ImDefaultRoute): string | null =>
    route.providerId ?? effectiveSourceIdForModel(providers, null, route.model, route.agentKind as AgentKind);
}

async function listProviders(): Promise<ProviderView[] | null> {
  try {
    return await getDesktopProviderService().listProviders({ allowSideEffects: true });
  } catch {
    return null;
  }
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
  currentFastMode: boolean;
}

export function createImChannelDefaultRouteSync(deps: {
  source: ImDefaultSettingsChannel;
  config: ImOrchestratorConfig;
  isRouteUsable: RouteAuthCheck;
}): ImChannelDefaultRouteSync {
  const { source, config } = deps;

  async function evaluate(sessionId: string): Promise<Evaluation | 'defer-unknown' | null> {
    const row = await readSessionRouteRow(sessionId);
    if (!row || !isChannelOwnedRow(row, source)) return null;
    const record = parseImDefaultRouteRecord(row.imDefaultRoute);
    // 用户单独改过路由(墓碑): 永不跟随, 不必解析新默认。
    if (record?.manual) return null;
    if (!imDefaultRouteMayNeedSync(record, readImDefaultSettingsFingerprint(source))) return null;
    const providers = await listProviders();
    // 目录拿不到就无法可靠比对来源, 本条消息先按原路由走 —— 但若记录仍认领着在世
    // 的系统意图, 调用方必须暂缓通用意图应用(PR #5155 review P2)。
    if (!providers) return 'defer-unknown';
    const defaults = await resolveImSessionDefaults(config, providers, source);
    const target: ImDefaultRoute = {
      agentKind: defaults.agentKind,
      model: defaults.model,
      providerId: defaults.providerId,
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
      currentFastMode: row.fastMode === true,
    };
  }

  async function writeRecord(sessionId: string, json: string): Promise<void> {
    await getDbClient()
      .drizzle.update(sessions)
      .set({ imDefaultRoute: json })
      .where(eq(sessions.id, sessionId));
  }

  async function switchRoute(sessionId: string, e: Evaluation): Promise<boolean> {
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
    await writeRecord(sessionId, buildImDefaultRouteRecord(e.record.fp, e.record.route, pendingFor(e.target)));
    let outcome: 'applied' | 'staged';
    try {
      outcome = await applySessionRouteUnderSendLock(
        sessionId,
        // Fast 不属于渠道默认: 保留任务自己的开关, 不拿新任务的固定默认覆盖。
        { ...e.target, fastMode: e.currentFastMode },
        e.current.agentKind,
      );
    } catch (err) {
      await writeRecord(sessionId, serializeImDefaultRouteRecord(e.record));
      throw err;
    }
    if (outcome === 'staged') {
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
          await writeRecord(sessionId, buildImDefaultRouteRecord(e.record.fp, e.record.route));
        } catch (restoreErr) {
          log.warn(
            `default route claim restore failed (non-fatal) session=...${sessionId.slice(-8)}: ` +
              (restoreErr instanceof Error ? restoreErr.message : String(restoreErr)),
          );
        }
      }
      log.info(`default route switch staged session=...${sessionId.slice(-8)} (runtime busy)`);
      return true;
    }
    await recordApplied(sessionId, e);
    return false;
  }

  /**
   * 忙时登记的跟随意图由这里自己应用, 不交给通用发送路径: 同引擎应用失败在那边会
   * 直接让用户这条消息失败。这里失败则撤回意图、保持原路由。
   */
  async function applyStaged(sessionId: string, e: Evaluation): Promise<boolean> {
    let outcome: 'applied' | 'staged';
    try {
      outcome = await applySessionRouteUnderSendLock(sessionId, null, e.current.agentKind);
    } catch (err) {
      await writeRecord(sessionId, buildImDefaultRouteRecord(e.record.fp, e.record.route));
      throw err;
    }
    if (outcome === 'applied') {
      await recordApplied(sessionId, e);
      return false;
    }
    return true;
  }

  async function recordApplied(sessionId: string, e: Evaluation): Promise<void> {
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
    await writeRecord(sessionId, buildImDefaultRouteRecord(e.targetFingerprint, applied));
    log.info(
      `default route followed session=...${sessionId.slice(-8)} ` +
        `${e.current.agentKind}/${e.current.model} -> ${applied.agentKind}/${applied.model}`,
    );
  }

  async function previewSwitchTarget(sessionId: string): Promise<ImDefaultRoute | null> {
    try {
      const e = await evaluate(sessionId);
      if (!e || e === 'defer-unknown') return null;
      if (e.decision.kind !== 'switch' && e.decision.kind !== 'staged') return null;
      return (await deps.isRouteUsable(e.target)) ? e.target : null;
    } catch (err) {
      log.warn(`default route preview failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
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
      if (!row || !isChannelOwnedRow(row, source)) return false;
      const pending = readPendingAgentSwitchRoute(sessionId);
      return recordClaimsPendingIntent(
        parseImDefaultRouteRecord(row.imDefaultRoute),
        pending
          ? {
              agentKind: pending.agentKind,
              model: pending.model,
              providerId: pending.providerId,
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
      if (e === 'defer-unknown') return await followClaimStillPending(sessionId);
      if (!e) return false;
      switch (e.decision.kind) {
        case 'adopt':
          if (e.decision.cancelPendingIntent) cancelPendingAgentSwitchForSession(sessionId);
          await writeRecord(sessionId, buildImDefaultRouteRecord(e.targetFingerprint, e.current));
          return false;
        case 'switch':
          return await switchRoute(sessionId, e);
        case 'staged':
          return await applyStaged(sessionId, e);
        case 'manual':
          // 用户的选择顶掉了本功能登记的待生效意图: 清掉过时声称, 但绝不动用户的意图。
          if (e.decision.clearStalePending) {
            await writeRecord(sessionId, buildImDefaultRouteRecord(e.record.fp, e.record.route));
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
      const release = await acquirePendingAgentSwitchForImSend(sessionId, () => syncUnderLock(sessionId));
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

/**
 * 本功能上线前建的任务没有记录。保存 / 恢复渠道默认之前, 把仍在用**旧默认**的这类
 * 任务补上旧默认的记录, 让它们在下一条消息时跟随新默认。规则允许的「历史缺少状态」
 * 情形, 只做值比较。返回补记的任务数。
 *
 * 旧默认的识别有两条路, 只靠解析结果会漏(chatgpt-codex-connector P2, PR #5155):
 * 旧默认的来源断开 / 模型停用后, `resolveImSessionDefaults` 会把旧设置回落到别的
 * 可用路由, 拿回落值去跟历史任务实际落点比永远匹配不到, 这些任务的 `im_default_route`
 * 会一直空着 —— 而用户正是在修坏默认时最需要迁移它们。所以同时按**保存的原始默认**
 * (未过可用性回落)认领。
 *
 * 匹配要求**整条路由相等**(含 effort): 思考强度是承诺按手动选择保护的路由轴, 只
 * 改过 effort 的历史任务不能被认领(PR #5155 review P1);原始默认的 effort 在设置
 * 保存时就已按模型 reconcile 过, 与历史落点一致。
 *
 * 另外两类历史兼容落点(PR #5155 review P2):
 * - 归档/软删的可复活任务: 用户从 IM 再发消息会原地复活, 复活不补记录, 保存前
 *   不认领就永久错过 —— 回填一并覆盖。
 * - 隐式默认(null)建任务时被系统钉成当时的有效来源, 该来源后来断开后两条候选
 *   都对不上 —— **不认领**: 「来源已断开」无法证明当年是系统钉住还是用户手动
 *   钉的, 无法区分时保守不动(同 thread 后续裁决); 本功能之后建的任务在创建时
 *   就写记录(route 含钉住的来源), 不依赖这层历史猜测。
 *
 * 无法可靠识别时(供应商目录拿不到)必须抛错而不是返回 0: 调用方把 0 当成「补完了」
 * 就会提交新默认, 下一次只能按新默认匹配, 还停在旧默认上的老任务永久失去跟随资格。
 */
export async function backfillLegacyImDefaultRoutes(
  source: ImDefaultSettingsChannel,
  config: ImOrchestratorConfig,
  /** 进入时捕获的客户端: 读写全程复用, 不在 await 间隙重读全局(owner 切换后指向新账号)。 */
  dbClient: ReturnType<typeof getDbClient> = getDbClient(),
): Promise<number> {
  const rows = await dbClient
    .drizzle.select({
      id: sessions.id,
      source: sessions.source,
      status: sessions.status,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      effort: sessions.effort,
      imDefaultRoute: sessions.imDefaultRoute,
      feishuBotAppId: sessions.feishuBotAppId,
      imBotContextId: sessions.imBotContextId,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.source, source),
        // 归档/软删的可复活任务一并覆盖: findActiveSession 会原地复活它们且不补
        // 记录, 保存前不认领就永久错过(PR #5155 review P2)。
        inArray(sessions.status, ['active', 'archived', 'deleted']),
        isNull(sessions.imDefaultRoute),
      ),
    );
  const legacyRows = rows.filter((row) => isChannelOwnedRow(row, source, { includeRevivable: true }));
  // 没有要补的就不碰供应商目录 —— 目录不可用也挡不住用户的设置保存。
  if (legacyRows.length === 0) return 0;
  const providers = await listProviders();
  if (!providers) {
    throw new Error(
      `provider catalog unavailable; cannot backfill ${source} default-route records`,
    );
  }
  const rawDefault = readImRawDefaultRoute(source);
  const fingerprint = readImDefaultSettingsFingerprint(source);
  let resolvedDefault: ImDefaultRoute | null = null;
  try {
    const defaults = await resolveImSessionDefaults(config, providers, source);
    resolvedDefault = {
      agentKind: defaults.agentKind,
      model: defaults.model,
      providerId: defaults.providerId,
      effort: defaults.effort,
    };
  } catch (err) {
    // 旧默认已坏到解析不出来(如全部模型被停用): 只按保存的原始默认认领 —— 用户
    // 正是要存新默认来修它, 不能因为解析旧默认失败而把保存也堵死。
    log.warn(
      `default route backfill: old ${source} default unresolvable; matching raw settings only: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  const normalize = providerNormalizer(providers);
  let count = 0;
  for (const row of legacyRows) {
    const current = currentRouteOf(row);
    // 匹配只认整条路由相等: 隐式默认的历史钉住与用户手动钉住无法区分(断开的来源
    // 证明不了出身), 无法区分时保守不认领(PR #5155 review P2 后续裁决)。
    const matches =
      (!!resolvedDefault && sameImDefaultRoute(current, resolvedDefault, normalize)) ||
      sameImDefaultRoute(current, rawDefault, normalize);
    if (!matches) continue;
    await dbClient
      .drizzle.update(sessions)
      .set({ imDefaultRoute: buildImDefaultRouteRecord(fingerprint, current) })
      .where(and(eq(sessions.id, row.id), isNull(sessions.imDefaultRoute)));
    count += 1;
  }
  if (count > 0) log.info(`backfilled default route records for ${count} legacy ${source} task(s)`);
  return count;
}

/**
 * 启动期补齐:回填此前只由设置保存/重置触发, 升级时已有、`im_default_route` 仍
 * 为空的老任务若用户从未动过设置就永远轮不到 —— 同步对空记录直接跳过, 后续
 * 版本把内置默认从 A 改到 B 后, 这些未自定义的老任务会永久固定在 A
 * (PR #5155 review P2)。在仍能识别当前基线的启动阶段补上, 不依赖用户以后
 * 主动保存。
 *
 * 每次启动都跑(幂等: 无候选行即返回, 也是失败后的自愈重试); 失败只告警、
 * 不挡连接启动。只补记录不写设置, 全程复用进入时捕获的 DbClient(owner
 * 切换后不跨账号写)。
 */
export async function backfillLegacyImDefaultRoutesAtStartup(
  entries: Array<{ source: ImDefaultSettingsChannel; config: ImOrchestratorConfig }>,
  dbClient: ReturnType<typeof getDbClient> = getDbClient(),
): Promise<void> {
  for (const { source, config } of entries) {
    try {
      await backfillLegacyImDefaultRoutes(source, config, dbClient);
    } catch (err) {
      log.warn(
        `default route startup backfill failed for ${source} (retries next boot): ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/**
 * 单行渠道的 `/new`: 在 send 锁内把任务重置为渠道默认(连同跟随记录), 并撤掉残留的
 * 切换意图 —— 否则重置前登记的意图会在下一条消息时把刚重置的任务又切走。
 */
export async function resetImSessionToChannelDefaults(
  sessionId: string,
  config: ImOrchestratorConfig,
  prepared: ImSessionRow | undefined,
  channel: ImDefaultSettingsChannel,
): Promise<void> {
  await withSendToSessionLock(sessionId, async () => {
    await resetSessionToDefaults(sessionId, config, prepared, channel);
    if (readPendingAgentSwitchRoute(sessionId)) cancelPendingAgentSwitchForSession(sessionId);
  });
}
