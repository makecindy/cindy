/**
 * 供应商组的分配(docs/product-rules/provider-groups.md §5、§6)：新任务第一次运行时选一台组内电脑，
 * 之后固定在这台；那台出问题时由 failover 换到下一台。
 *
 * 分配结果写回任务记录(`sessions.agent_device_id` / `provider_id`)：选中别的电脑后，这个任务就是
 * 普通的远程 Agent 任务，复用现有的整条链路，不改协议。
 *
 * 冷却、轮询游标与「这一轮已试过」只在本次运行内有效，不落盘；重启后按组内电脑的实时状态重新判断。
 */
import { findCatalogModel, isModelSelectableForNewRoute } from '@cindy/model-providers';
import type { AgentKind } from '@cindy/maker-core';

import type { ProviderGroupConfig, ProviderGroupMember, ProviderGroupView } from '../../shared/providerGroup.js';
import type { ProviderGroupBinding } from './bindings.js';
import type { ProviderGroupDirectory, ResolvedProviderGroupMember } from './directory.js';
import { pickProviderGroupMember, type SchedulableMember } from './scheduler.js';

/** 撞到用量上限但拿不到重置时刻时，默认冷却多久。 */
export const PROVIDER_GROUP_DEFAULT_COOLDOWN_MS = 30 * 60_000;
/** 连不上 / 登录失效等失败后，短时间内不再给它分新任务。 */
export const PROVIDER_GROUP_FAILURE_COOLDOWN_MS = 2 * 60_000;
/**
 * 「这一轮已试过」多久后作废：一轮里每台最多试一次；换过去之后正常跑了一阵再出错，算新的一轮。
 */
export const PROVIDER_GROUP_TURN_WINDOW_MS = 30 * 60_000;

export interface ProviderGroupRouterDeps {
  directory: ProviderGroupDirectory;
  readGroup(providerId: string): ProviderGroupConfig | null;
  listBindings(): Record<string, ProviderGroupBinding>;
  /** 这个任务现在是否正在运行一轮。 */
  isTurnRunning(sessionId: string): boolean;
  now(): number;
  random(): number;
}

export interface ProviderGroupPickInput {
  providerId: string;
  agentKind: AgentKind;
  model: string;
  exclude?: ReadonlySet<string>;
}

export type ProviderGroupPickResult =
  | { kind: 'none' }
  | { kind: 'member'; member: ProviderGroupMember; label: string; resolved: ResolvedProviderGroupMember[] }
  | { kind: 'unavailable'; resolved: ResolvedProviderGroupMember[] };

export interface ProviderGroupRouter {
  pick(input: ProviderGroupPickInput): Promise<ProviderGroupPickResult>;
  view(providerId: string): Promise<ProviderGroupView>;
  /** 经本组分到这台、正在运行的任务数。 */
  running(providerId: string, memberKey: string): number;
  markCooling(providerId: string, memberKey: string, until: number): void;
  coolingUntil(providerId: string, memberKey: string): number | null;
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
  const cooling = new Map<string, number>();
  const lastPicked = new Map<string, string>();
  const tried = new Map<string, { at: number; keys: Set<string> }>();

  function currentTried(sessionId: string): Set<string> | null {
    const entry = tried.get(sessionId);
    if (!entry) return null;
    if (deps.now() - entry.at > PROVIDER_GROUP_TURN_WINDOW_MS) {
      tried.delete(sessionId);
      return null;
    }
    return entry.keys;
  }

  function coolingUntil(providerId: string, memberKey: string): number | null {
    const key = coolKey(providerId, memberKey);
    const until = cooling.get(key);
    if (until === undefined) return null;
    if (until <= deps.now()) {
      cooling.delete(key);
      return null;
    }
    return until;
  }

  function running(providerId: string, memberKey: string): number {
    let count = 0;
    for (const [sessionId, binding] of Object.entries(deps.listBindings())) {
      if (binding.providerId === providerId && binding.memberKey === memberKey && deps.isTurnRunning(sessionId)) {
        count++;
      }
    }
    return count;
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
      const resolved = await deps.directory.resolveMembers(input.providerId, config);
      const schedulable: SchedulableMember[] = resolved.map((r) => ({
        key: r.member.key,
        usable: offersModel(r, input.agentKind, input.model) && coolingUntil(input.providerId, r.member.key) === null,
        paused: r.member.paused,
        running: running(input.providerId, r.member.key),
        limit: r.member.limit,
        weight: r.member.weight,
      }));
      const key = pickProviderGroupMember(schedulable, config.strategy, {
        exclude: input.exclude,
        lastPicked: lastPicked.get(input.providerId) ?? null,
        random: deps.random,
      });
      if (!key) return { kind: 'unavailable', resolved };
      lastPicked.set(input.providerId, key);
      const chosen = resolved.find((r) => r.member.key === key)!;
      return { kind: 'member', member: chosen.member, label: chosen.label, resolved };
    },

    async view(providerId) {
      const config = deps.readGroup(providerId);
      if (!config) return { providerId, config: null, members: [] };
      const resolved = await deps.directory.resolveMembers(providerId, config);
      return {
        providerId,
        config,
        members: resolved.map((r) => {
          const until = coolingUntil(providerId, r.member.key);
          const count = running(providerId, r.member.key);
          const state = r.member.paused
            ? 'paused' as const
            : r.state !== 'ok'
              ? r.state
              : until !== null
                ? 'cooling' as const
                : count >= r.member.limit
                  ? 'full' as const
                  : 'available' as const;
          return {
            key: r.member.key,
            kind: r.member.kind,
            label: r.label,
            ...(r.ownerName ? { ownerName: r.ownerName } : {}),
            state,
            ...(r.reason ? { reason: r.reason } : {}),
            running: count,
            limit: r.member.limit,
            weight: r.member.weight,
            paused: r.member.paused,
            ...(until !== null ? { coolingUntil: until } : {}),
          };
        }),
      };
    },

    running,

    markCooling(providerId, memberKey, until) {
      const key = coolKey(providerId, memberKey);
      cooling.set(key, Math.max(cooling.get(key) ?? 0, until));
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
