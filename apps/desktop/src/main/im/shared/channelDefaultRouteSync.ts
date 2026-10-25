import {
  createDefaultRouteFollower as createSharedDefaultRouteFollower,
  isChannelOwnedRow,
  currentRouteOf,
  providerNormalizer,
  type SessionRouteRow,
  type RouteAuthCheck,
} from '@cindy/im-runtime/channelDefaultRouteSync';
export type { SessionRouteRow } from '@cindy/im-runtime/channelDefaultRouteSync';
import { type ImChannelDefaultRouteSync } from '@cindy/im-runtime/channelDefaultRouteSync';
export { type ImChannelDefaultRouteSync } from '@cindy/im-runtime/channelDefaultRouteSync';
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
import {
  effectiveSourceIdForModel,
  movedCindyAutoSourceId,
  type ProviderView,
} from '@cindy/model-providers';

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
      agentDeviceId: sessions.agentDeviceId,
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

async function listProviders(): Promise<ProviderView[] | null> {
  try {
    return await getDesktopProviderService().listProviders({ allowSideEffects: true });
  } catch {
    return null;
  }
}

export function createImChannelDefaultRouteSync(deps: {
  source: ImDefaultSettingsChannel;
  config: ImOrchestratorConfig;
  isRouteUsable: RouteAuthCheck;
}): ImChannelDefaultRouteSync {
  const { source, config } = deps;
  return createDefaultRouteFollower({
    label: source,
    ownsRow: (row) => isChannelOwnedRow(row, source),
    fingerprint: () => readImDefaultSettingsFingerprint(source),
    resolveTarget: (providers) => resolveImSessionDefaults(config, providers, source),
    isRouteUsable: deps.isRouteUsable,
  });
}

/** 两类 bot 共用切换判定、待生效意图与发送锁，只由各入口提供默认配置。 */
export function createDefaultRouteFollower(
  deps: Parameters<typeof createSharedDefaultRouteFollower>[0],
): ImChannelDefaultRouteSync {
  return createSharedDefaultRouteFollower(deps, {
    log,
    readSessionRouteRow,
    listProviders,
    writeRecord: async (sessionId, json) => {
      await getDbClient()
        .drizzle.update(sessions)
        .set({ imDefaultRoute: json })
        .where(eq(sessions.id, sessionId));
    },
    readPendingAgentSwitchRoute: (...args) => readPendingAgentSwitchRoute(...args),
    applySessionRouteUnderSendLock: (...args) => applySessionRouteUnderSendLock(...args),
    cancelPendingAgentSwitchForSession: (...args) => cancelPendingAgentSwitchForSession(...args),
    acquirePendingAgentSwitchForImSend: (...args) => acquirePendingAgentSwitchForImSend(...args),
  });
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
  const rows = await dbClient.drizzle
    .select({
      id: sessions.id,
      source: sessions.source,
      status: sessions.status,
      remoteHostId: sessions.remoteHostId,
      orcaRole: sessions.orcaRole,
      agentKind: sessions.agentKind,
      model: sessions.model,
      providerId: sessions.providerId,
      agentDeviceId: sessions.agentDeviceId,
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
  const legacyRows = rows.filter((row) =>
    isChannelOwnedRow(row, source, { includeRevivable: true }),
  );
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
      agentDeviceId: defaults.agentDeviceId ?? null,
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
    await dbClient.drizzle
      .update(sessions)
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
