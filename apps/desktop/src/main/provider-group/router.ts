/**
 * 供应商组的分配(docs/product-rules/provider-groups.md §5、§6)：新任务第一次运行时选一台组内电脑，
 * 之后固定在这台；那台出问题时由 failover 换到下一台。
 *
 * 分配结果写回任务记录(`sessions.agent_device_id` / `provider_id`)：选中别的电脑后，这个任务就是
 * 普通的远程 Agent 任务，复用现有的整条链路，不改协议。
 *
 * 组内电脑的状态以本机(组所在电脑)为准(2026-10-11 用户确认)：本机读到的在线、供应商、模型、负载，加上那台账号的问题
 * (用量上限、登录失效、服务繁忙)记下的冷却，同步给所有使用方，使用方按它筛选；使用方自己那边的问题(连不上、版本不配等)
 * 不记进组里。状态有延迟时使用方试过不行就换下一台，带着这一轮试过的来选时本机现读最新状态。
 *
 * 冷却按账号落盘(coolingStore.ts)，重启后照样避开；轮询游标与「这一轮已试过」只在本次运行内有效。
 */
import { findCatalogModel, isModelSelectableForNewRoute } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';
import type { RemoteAgentCaps } from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupMember, ProviderGroupView } from '../../shared/providerGroup.js';
import type { ProviderGroupBinding } from './bindings.js';
import type { ProviderGroupDirectory, ResolvedProviderGroupMember } from './directory.js';
import { pickProviderGroupMember, type SchedulableMember } from './scheduler.js';
import { createGuestSupportReader } from './sharedStatus.js';
import { providerGroupUsageState } from './usage.js';
import { coolingScope, currentCooling, PROVIDER_GROUP_COOLING_SCOPE_CAP, type ProviderGroupPersistedCooling } from './cooling.js';
export { PROVIDER_GROUP_FAILURE_COOLDOWN_MS, type ProviderGroupPersistedCooling } from './cooling.js';

/** 撞到用量上限但拿不到重置时刻时，默认冷却多久。 */
export const PROVIDER_GROUP_DEFAULT_COOLDOWN_MS = 30 * 60_000;
/**
 * 「这一轮已试过」多久后作废：一轮里每台最多试一次；换过去之后正常跑了一阵再出错，算新的一轮。
 */
export const PROVIDER_GROUP_TURN_WINDOW_MS = 30 * 60_000;

/**
 * 选电脑时等组内电脑状态的时间：到点已经有一台能接的就不再等更慢的那几台(那几台这次按不能用算，读取照常在后台
 * 完成、留在缓存里)；一台能接的都还没有时照旧等全部读完，不会因为慢就误报都不能用。
 */
export const PROVIDER_GROUP_PICK_QUICK_MS = 3_000;

export interface ProviderGroupRouterDeps {
  directory: ProviderGroupDirectory;
  /** 仅详情页按需读取；分配与普通状态查询不探测远端能力。 */
  readCaps?(member: ProviderGroupMember): Promise<RemoteAgentCaps>;
  readGroup(providerId: string): ProviderGroupConfig | null;
  listBindings(): Record<string, ProviderGroupBinding>;
  /** 这个任务现在是否正在运行一轮。 */
  isTurnRunning(sessionId: string): boolean;
  /**
   * 经本组分出去、但不在本机任务表里的运行中任务(同账号其他电脑报来的、刚选中还没报来的)。
   * 不提供 = 只算本机任务。
   */
  externalRunning?(providerId: string, memberKey: string): number;
  /** 冷却的落盘位置；不提供 = 只在本次运行内有效。 */
  coolingStore?: {
    read(): ProviderGroupPersistedCooling;
    write(value: ProviderGroupPersistedCooling): void;
  };
  now(): number;
  random(): number;
}

export interface ProviderGroupPickInput {
  providerId: string;
  agentKind: AgentKind;
  model: string;
  /**
   * 仅本机任务入口设置：本机任务与其他使用方走同一组策略(2026-10-15 用户裁决)，只是本机的「暂停对外分配」
   * 不拦本机自己的任务。远程请求与分享中转不传，也不从请求载荷读取，不能借它绕过暂停。
   */
  localTask?: true;
  exclude?: ReadonlySet<string>;
  /** 现读组内电脑的最新状态，不用短时缓存(试过不行、带着这一轮试过的来选时)。 */
  fresh?: boolean;
  /**
   * 选中后在同一步(读负载与选电脑之间没有等待)调用，用来立即记上占用：同时来的几个请求各自读到前一个的
   * 占用，不会全落到同一台。
   */
  onPicked?(memberKey: string): void;
  /**
   * 本机任务：选中的同一步给这个任务记上临时占用(PROVIDER_GROUP_LOCAL_PROVISIONAL_MS)，直到它开始运行一轮
   * (之后按运行中的绑定计)。本机同时开的几个任务不会读到同一份负载、全落到同一台。
   */
  reserveFor?: string;
}

/** 本机任务选中后、开始运行一轮之前的临时占用时长(与同账号电脑选中后的临时占用相同)。 */
export const PROVIDER_GROUP_LOCAL_PROVISIONAL_MS = 30_000;

export type ProviderGroupPickResult =
  | { kind: 'none' }
  | { kind: 'member'; member: ProviderGroupMember; label: string; resolved: ResolvedProviderGroupMember[] }
  | { kind: 'unavailable'; resolved: ResolvedProviderGroupMember[] };

export interface ProviderGroupRouter {
  pick(input: ProviderGroupPickInput): Promise<ProviderGroupPickResult>;
  view(providerId: string, options?: string | { model?: string; includeGuestSupport?: boolean }): Promise<ProviderGroupView>;
  /** 经本组分到这台、正在运行的任务数。 */
  running(providerId: string, memberKey: string): number;
  markCooling(providerId: string, memberKey: string, until: number, model?: string): void;
  coolingUntil(providerId: string, memberKey: string, model?: string): number | null;
  /** 记一次「这一轮试过这台」，返回这一轮已试过的全部。 */
  markTried(sessionId: string, memberKey: string): ReadonlySet<string>;
  triedThisTurn(sessionId: string): ReadonlySet<string>;
  /** 这一轮结束(有实质产出、用户接手、放弃换电脑)：下一轮重新从头试。 */
  resetTurn(sessionId: string): void;
}

function coolKey(providerId: string, memberKey: string): string {
  return `${providerId}\u0000${memberKey}`;
}

export function createProviderGroupRouter(deps: ProviderGroupRouterDeps): ProviderGroupRouter {
  const guestSupportReader = deps.readCaps ? createGuestSupportReader(deps.readCaps) : null;
  const cooling = new Map<string, Record<string, number>>();
  let hasLegacyCooling = false;
  try {
    for (const [providerId, members] of Object.entries(deps.coolingStore?.read() ?? {})) {
      for (const [memberKey, value] of Object.entries(members)) {
        if (typeof value === 'number') hasLegacyCooling = true;
        cooling.set(coolKey(providerId, memberKey), currentCooling(value, deps.now()));
      }
    }
  } catch {
    // 读不到落盘的冷却：按没有冷却开始，之后撞上的照常记。
  }

  function persistCooling(): void {
    if (!deps.coolingStore) return;
    const now = deps.now();
    const value: ProviderGroupPersistedCooling = {};
    for (const [key, remembered] of cooling) {
      const scopes = currentCooling(remembered, now);
      if (Object.keys(scopes).length === 0) continue;
      const split = key.indexOf('\u0000');
      (value[key.slice(0, split)] ??= {})[key.slice(split + 1)] = scopes;
    }
    try {
      deps.coolingStore.write(value);
    } catch {
      // 落盘失败只影响重启后的记忆，本次运行照常避开。
    }
  }

  // 固定首次加载时截短的截止时间，重启或切回账号不能重新起算两分钟。
  if (hasLegacyCooling) persistCooling();

  const lastPicked = new Map<string, string>();
  const tried = new Map<string, { at: number; keys: Set<string> }>();
  /** 本机任务刚选中、还没开始运行一轮的临时占用：任务 id → 那台。 */
  const provisional = new Map<string, { providerId: string; memberKey: string; until: number }>();

  function currentTried(sessionId: string): Set<string> | null {
    const entry = tried.get(sessionId);
    if (!entry) return null;
    if (deps.now() - entry.at > PROVIDER_GROUP_TURN_WINDOW_MS) {
      tried.delete(sessionId);
      return null;
    }
    return entry.keys;
  }

  function coolingUntil(providerId: string, memberKey: string, model?: string): number | null {
    const key = coolKey(providerId, memberKey);
    const scopes = currentCooling(cooling.get(key), deps.now());
    if (Object.keys(scopes).length === 0) {
      cooling.delete(key);
      return null;
    }
    const until = Math.max(scopes[''] ?? 0, scopes[coolingScope(model)] ?? 0);
    return until || null;
  }

  function running(providerId: string, memberKey: string): number {
    let count = 0;
    for (const [sessionId, binding] of Object.entries(deps.listBindings())) {
      if (binding.providerId === providerId && binding.memberKey === memberKey && deps.isTurnRunning(sessionId)) {
        count++;
      }
    }
    const now = deps.now();
    for (const [sessionId, entry] of provisional) {
      // 已经开始运行一轮的按上面的绑定计，不重复计；过期的放掉(没能启动等)。
      if (entry.until <= now || deps.isTurnRunning(sessionId)) {
        provisional.delete(sessionId);
        continue;
      }
      if (entry.providerId === providerId && entry.memberKey === memberKey) count++;
    }
    return count + (deps.externalRunning?.(providerId, memberKey) ?? 0);
  }

  /**
   * 分配与设置页共用的运行数。那台实际跑着的数(本机现算、同账号电脑报来那台的总数、分享来的电脑报来本账号
   * 在那里的数，都含不经组直接用的)里已包含经组分过去的，取两者较大的：刚选中、还没开始跑的任务仍按经组的
   * 计数占着；那台较旧报不出时照旧只算经组的。
   */
  function memberRunning(providerId: string, resolved: ResolvedProviderGroupMember): number {
    return Math.max(running(providerId, resolved.member.key), resolved.reportedRunning ?? 0);
  }

  /** 那台能为新会话提供这个模型：停用、已退役、需要付费的都不算(与新建任务、切模型同一准入)。 */
  function offersModel(resolved: ResolvedProviderGroupMember, agentKind: AgentKind, model: string): boolean {
    if (resolved.state !== 'ok' || !resolved.view) return false;
    const found = findCatalogModel(resolved.view, model, agentKind);
    return found !== undefined
      && isModelSelectableForNewRoute(found, { userProvider: resolved.view.source === 'user' });
  }

  return {
    async pick(input) {
      const config = deps.readGroup(input.providerId);
      if (!config) return { kind: 'none' };
      const usable = (r: ResolvedProviderGroupMember) =>
        offersModel(r, input.agentKind, input.model) && coolingUntil(input.providerId, r.member.key, input.model) === null
        && !providerGroupUsageState(r.claudeUsage, input.model, deps.now()).limited;
      // 「暂停对外分配」只拦本机以外的新任务；除此之外本机任务与其他使用方同一套组策略，不另设本机优先。
      const paused = (r: ResolvedProviderGroupMember) =>
        r.member.paused && !(input.localTask === true && r.member.kind === 'local');
      const resolved = await deps.directory.resolveMembers(input.providerId, config, {
        quickMs: PROVIDER_GROUP_PICK_QUICK_MS,
        // 已经有一台能用、可以分的电脑(满载仍可接)：不再等慢的那几台。未满优先由调度器决定。
        enough: (r) => usable(r)
          && !paused(r)
          && !input.exclude?.has(r.member.key),
        ...(input.fresh ? { fresh: true } : {}),
      });
      const now = deps.now();
      const schedulable: SchedulableMember[] = resolved.map((r) => {
        const quota = providerGroupUsageState(r.claudeUsage, input.model, now);
        return {
          key: r.member.key,
          usable: usable(r),
          paused: paused(r),
          running: memberRunning(input.providerId, r),
          limit: r.member.limit,
          weight: r.member.weight,
          usagePercent: quota.usagePercent,
          weeklyResetAtMs: quota.weeklyResetAtMs,
          fiveHourResetAtMs: quota.fiveHourResetAtMs,
        };
      });
      const key = pickProviderGroupMember(schedulable, config.strategy, {
        exclude: input.exclude,
        lastPicked: lastPicked.get(input.providerId) ?? null,
        random: deps.random,
        now,
      });
      if (!key) return { kind: 'unavailable', resolved };
      lastPicked.set(input.providerId, key);
      if (input.reserveFor) {
        provisional.set(input.reserveFor, {
          providerId: input.providerId,
          memberKey: key,
          until: deps.now() + PROVIDER_GROUP_LOCAL_PROVISIONAL_MS,
        });
      }
      input.onPicked?.(key);
      const chosen = resolved.find((r) => r.member.key === key)!;
      return { kind: 'member', member: chosen.member, label: chosen.label, resolved };
    },

    async view(providerId, options) {
      const config = deps.readGroup(providerId);
      if (!config) return { providerId, config: null, members: [] };
      const resolved = await deps.directory.resolveMembers(providerId, config);
      const viewOptions = typeof options === 'string' ? { model: options } : options;
      const model = viewOptions?.model;
      const readSupport = viewOptions?.includeGuestSupport ? guestSupportReader : null;
      return {
        providerId,
        config,
        members: await Promise.all(resolved.map(async (r) => {
          const guestSupport = readSupport
            ? (r.member.kind === 'local' || r.state === 'ok' ? await readSupport(r.member) : 'unknown' as const)
            : undefined;
          const quota = providerGroupUsageState(r.claudeUsage, model, deps.now());
          const remembered = coolingUntil(providerId, r.member.key, model);
          const until = quota.limited && quota.resetAtMs === null ? null
            : remembered === null ? quota.resetAtMs
            : quota.resetAtMs === null ? remembered : Math.max(remembered, quota.resetAtMs);
          const count = memberRunning(providerId, r);
          // 那台电脑上这个供应商现在的显示名，读不到时用加入时的快照：同一台电脑有几个账号时界面按它区分。
          const providerName = r.view?.name || r.member.providerName;
          const state = r.member.paused
            ? 'paused' as const
            : r.state !== 'ok'
              ? r.state
              : until !== null || quota.limited
                ? 'cooling' as const
                : count >= r.member.limit
                  ? 'full' as const
                  : 'available' as const;
          return {
            key: r.member.key,
            kind: r.member.kind,
            label: r.label,
            ...(providerName ? { providerName } : {}),
            ...(r.ownerName ? { ownerName: r.ownerName } : {}),
            ...(r.appVersion ? { appVersion: r.appVersion } : {}),
            ...(guestSupport ? { guestSupport } : {}),
            state,
            ...(r.reason ? { reason: r.reason } : {}),
            running: count,
            limit: r.member.limit,
            weight: r.member.weight,
            paused: r.member.paused,
            ...(until !== null ? { coolingUntil: until } : {}),
          };
        })),
        ...(model ? { model } : {}),
      };
    },

    running,

    markCooling(providerId, memberKey, until, model) {
      const key = coolKey(providerId, memberKey);
      const scopes = currentCooling(cooling.get(key), deps.now());
      const scope = coolingScope(model);
      // Always leave room for account-wide authentication/overload failures.
      if (scope && !(scope in scopes) && Object.keys(scopes).length >= PROVIDER_GROUP_COOLING_SCOPE_CAP - 1) return;
      scopes[scope] = Math.max(scopes[scope] ?? 0, until);
      cooling.set(key, scopes);
      persistCooling();
    },

    coolingUntil,

    markTried(sessionId, memberKey) {
      const keys = currentTried(sessionId) ?? new Set<string>();
      keys.add(memberKey);
      tried.set(sessionId, { at: deps.now(), keys });
      return keys;
    },

    triedThisTurn(sessionId) {
      return currentTried(sessionId) ?? new Set<string>();
    },

    resetTurn(sessionId) {
      tried.delete(sessionId);
    },
  };
}
