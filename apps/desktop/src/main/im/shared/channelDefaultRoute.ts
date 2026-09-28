/**
 * 个人 IM 渠道任务「跟随渠道默认」的记录与判定(纯逻辑, 无 IO)。
 *
 * 渠道默认(设置页「新对话配置」)改了之后, 仍跟随默认的已有任务在下一条渠道
 * 消息到来时换到新默认; 用户用 `/model`、桌面或手机单独改过路由的任务不动。
 *
 * 「跟随」按状态判断, 不拿旧默认值去猜: 渠道每次把默认落到任务上(建任务 /
 * `/new` / 跟随切换成功)都在 `sessions.im_default_route` 记下当时的设置指纹与
 * **读回的实际路由**; 之后任务当前路由与记录不一致 = 有人单独改过。
 */
import type { AgentKind } from '@cindy/maker-core';

import type { ImDefaultSettings } from '../../../shared/imDefaultSettings.js';

export interface ImDefaultRoute {
  agentKind: AgentKind;
  model: string;
  providerId: string | null;
  effort: string | null;
}

export interface ImDefaultRouteRecord {
  v: 1;
  /** 应用默认时渠道原始设置的指纹(fingerprintImDefaultSettings)。 */
  fp: string;
  /** 应用后任务上的实际路由。 */
  route: ImDefaultRoute;
  /** 已登记、尚未生效的跟随切换意图(登记后读回, 任务在跑 / 意图待发送时应用)。 */
  pendingRoute?: ImDefaultRoute;
  /** 登记该意图时的设置指纹 —— 设置没再变就不重复登记。 */
  pendingFp?: string;
  /**
   * 登记该意图时 pending 注册表的修订号。用户重新挑选(哪怕选了同一模型/来源)
   * 会推进修订号 —— 光比路由值分不出「自己的意图」和「用户挑了同值」,后者必须
   * 按用户选择对待,不能被下一次默认变化覆盖。
   */
  pendingRev?: number;
  /**
   * 用户单独改过路由的永久标记(脱离跟随)。同值重选在路由值上无痕, 只能在用户
   * 选择落地时立碑; 之后无论默认怎么变都不再跟随, `/new` 重置才会重新跟随
   * (greptile P1 补充, PR #5155)。
   */
  manual?: true;
}

const AGENT_KINDS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * 渠道原始设置里影响路由的部分。三个引擎都算进去: 选定引擎的模型全被停用时
 * 解析会回落到别的引擎, 那边的设置同样决定落点。权限档不在内 —— 它不跟随。
 */
export function fingerprintImDefaultSettings(raw: ImDefaultSettings): string {
  return JSON.stringify([
    raw.agentKind,
    AGENT_KINDS.map((agent) => {
      const settings = raw.agents[agent];
      return settings ? [settings.providerId ?? null, settings.model, settings.effort] : null;
    }),
  ]);
}

function parseRoute(value: unknown): ImDefaultRoute | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (!AGENT_KINDS.includes(r.agentKind as AgentKind)) return null;
  if (typeof r.model !== 'string' || !r.model) return null;
  if (r.providerId !== null && typeof r.providerId !== 'string') return null;
  if (r.effort !== null && typeof r.effort !== 'string') return null;
  return {
    agentKind: r.agentKind as AgentKind,
    model: r.model,
    providerId: (r.providerId as string | null) || null,
    effort: (r.effort as string | null) || null,
  };
}

/** 坏记录按「无记录」处理 —— 宁可不跟随, 不因脏数据误切用户的任务。 */
export function parseImDefaultRouteRecord(json: string | null | undefined): ImDefaultRouteRecord | null {
  if (!json) return null;
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.v !== 1 || typeof r.fp !== 'string') return null;
  const route = parseRoute(r.route);
  if (!route) return null;
  const manual = r.manual === true;
  const pendingRoute = r.pendingRoute === undefined ? undefined : parseRoute(r.pendingRoute);
  if (pendingRoute === null) return null;
  const pendingFp = typeof r.pendingFp === 'string' ? r.pendingFp : undefined;
  const pendingRev = typeof r.pendingRev === 'number' && Number.isFinite(r.pendingRev) ? r.pendingRev : undefined;
  return {
    v: 1,
    fp: r.fp,
    route,
    ...(manual ? { manual: true } : {}),
    ...(pendingRoute ? { pendingRoute } : {}),
    ...(pendingRoute && pendingFp ? { pendingFp } : {}),
    ...(pendingRoute && pendingRev !== undefined ? { pendingRev } : {}),
  };
}

export function serializeImDefaultRouteRecord(record: ImDefaultRouteRecord): string {
  return JSON.stringify(record);
}

export function buildImDefaultRouteRecord(
  fp: string,
  route: ImDefaultRoute,
  pending?: { route: ImDefaultRoute; fp: string; rev?: number },
): string {
  return serializeImDefaultRouteRecord({
    v: 1,
    fp,
    route,
    ...(pending
      ? {
          pendingRoute: pending.route,
          pendingFp: pending.fp,
          ...(pending.rev !== undefined ? { pendingRev: pending.rev } : {}),
        }
      : {}),
  });
}

/**
 * 用户单独改过路由的永久标记(脱离跟随)。同值重选在路由值上无痕 —— 记录一旦写成
 * 这份墓碑就不再跟随渠道默认, `/new` 重置会用普通记录覆盖它、重新跟随。
 */
export function buildImManualRouteOverrideRecord(route: ImDefaultRoute): string {
  return serializeImDefaultRouteRecord({ v: 1, fp: '', route, manual: true });
}

/**
 * 路由相等。供应商由调用方先归一化: 系统会把隐式来源(null)钉成具体来源
 * (启动改道 / 切换时的独占改道), 不归一化会把这类系统行为误判成用户改过。
 */
export function sameImDefaultRoute(
  a: ImDefaultRoute,
  b: ImDefaultRoute,
  normalizeProvider: (route: ImDefaultRoute) => string | null = (route) => route.providerId,
): boolean {
  return (
    a.agentKind === b.agentKind &&
    a.model === b.model &&
    (a.effort ?? null) === (b.effort ?? null) &&
    normalizeProvider(a) === normalizeProvider(b)
  );
}

/** 指纹没变就不必解析新默认(每条消息都会走到这里, 这一步不碰供应商列表)。 */
export function imDefaultRouteMayNeedSync(
  record: ImDefaultRouteRecord | null,
  fp: string,
): record is ImDefaultRouteRecord {
  return !!record && record.fp !== fp;
}

export type ImDefaultRouteDecision =
  /** 当前路由已是新默认: 只更新记录(必要时撤掉本功能此前登记的过时意图)。 */
  | { kind: 'adopt'; cancelPendingIntent?: true }
  /** 本功能此前登记的跟随切换仍待生效, 且目标没变: 不重复登记。 */
  | { kind: 'staged' }
  /** 仍跟随默认, 需要切到新默认。 */
  | { kind: 'switch' }
  /**
   * 用户单独改过(已生效或已挑选待生效): 不动。
   * `clearStalePending` = 记录里挂着的待生效意图已被用户的选择顶掉,
   * 顺手清掉这条过时声称, 免得用户的选择落地后被误认成「跟随中的切换落地」。
   */
  | { kind: 'manual'; clearStalePending?: true };

/**
 * 记录里的待生效声称是否就是这一个在世意图 —— 本功能登记、尚未被用户顶掉。
 * 注册表有修订号就必须逐号对上(用户重挑过哪怕同值也算用户的);
 * 读不到修订号(测试最小 harness)才回落按值比较。
 */
export function recordClaimsPendingIntent(
  record: ImDefaultRouteRecord | null | undefined,
  pendingIntent: ImDefaultRoute | undefined,
  pendingRev: number | undefined,
  normalizeProvider?: (route: ImDefaultRoute) => string | null,
): boolean {
  if (!record || record.manual || !record.pendingRoute || !pendingIntent) return false;
  return (
    sameImDefaultRoute(pendingIntent, record.pendingRoute, normalizeProvider) &&
    (pendingRev === undefined || record.pendingRev === pendingRev)
  );
}

/**
 * `current` 取 DB 持久路由: 用户的选择要么已落库, 要么是待应用的切换意图;
 * 自动回退 / Agent 自选只在内存里生效, 与伙伴配置变更同口径 —— 渠道默认一改就覆盖它们。
 */
export function decideImDefaultRoute(input: {
  record: ImDefaultRouteRecord;
  current: ImDefaultRoute;
  target: ImDefaultRoute;
  /** 解析出 target 的设置指纹。 */
  targetFp: string;
  /** 会话上待应用的切换意图目标(无则 undefined)。 */
  pendingIntent?: ImDefaultRoute;
  /** 当前待应用意图在 pending 注册表的修订号(读回时带出)。 */
  pendingRev?: number;
  normalizeProvider?: (route: ImDefaultRoute) => string | null;
}): ImDefaultRouteDecision {
  const same = (a: ImDefaultRoute, b: ImDefaultRoute) =>
    sameImDefaultRoute(a, b, input.normalizeProvider);
  const { record, current, target, pendingIntent } = input;
  // 用户单独改过(含同值重选的墓碑): 永不跟随。
  if (record.manual) return { kind: 'manual' };
  // 「仍在跟随」的证据: 当前路由就是记录的路由, 或落到了本功能登记的待生效目标上
  // (意图被发送路径应用了、记录还没来得及更新)。**不能**用「恰好等于新默认」当证据 ——
  // 用户单独改成 B、默认随后也改成 B 时, 按值相等认领会把手动覆盖洗成跟随
  // (chatgpt-codex-connector P2, PR #5155)。
  const followingNow =
    same(current, record.route) || (!!record.pendingRoute && same(current, record.pendingRoute));
  if (pendingIntent) {
    // 意图是不是本功能登记的那一次: 路由值相等还不够 —— 自动切换未生效时用户又
    // 明确挑了同样的模型/来源, 会顶掉登记、值却一模一样(greptile P1, PR #5155)。
    // 修订号每次 set/clear 都推进, 用户重新挑过就对不上; 对不上一律按用户选择。
    const ours = recordClaimsPendingIntent(record, pendingIntent, input.pendingRev, input.normalizeProvider);
    if (!ours) {
      return record.pendingRoute ? { kind: 'manual', clearStalePending: true } : { kind: 'manual' };
    }
    // 自己登记的: 设置没再变就等发送路径应用(按指纹判断 —— 登记时系统可能改道了
    // 来源, 意图与 target 不必逐字相等); 设置又改了就改登记到最新目标;
    // 设置改回了任务当前路由 → 撤掉过时意图。
    if (record.pendingFp ? record.pendingFp === input.targetFp : same(pendingIntent, target)) {
      return { kind: 'staged' };
    }
    return same(current, target) ? { kind: 'adopt', cancelPendingIntent: true } : { kind: 'switch' };
  }
  if (same(current, target)) return followingNow ? { kind: 'adopt' } : { kind: 'manual' };
  if (followingNow) return { kind: 'switch' };
  return { kind: 'manual' };
}
