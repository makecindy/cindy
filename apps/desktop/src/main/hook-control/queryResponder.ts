/**
 * hook-control/queryResponder.ts
 * ---------------------------------------------------------------------------
 * query.request(server 实时问答)的应答构造: /bind 要工作区清单, /model
 * /effort 要模型 + 档位清单。纯函数 + 注入依赖, 单测不需要 Electron / maker。
 *
 * 数据源:
 *   - workspaces: 连接配置的别名表(store, 与 hello 同源 —— 但按"敲指令那一刻"
 *     的最新配置取, 满足实时性要求);
 *   - models: 与会话内模型选择器**同一套规则**派生(live providers -> 已连接
 *     供应商 -> 可见性过滤, 见 ipc.ts 接线), 保证 Slack 卡的可选清单与应用内
 *     逐模型一致。listProviders 是异步的, 因此 listAgentModels 允许返回 Promise。
 */

import type {
  QueryAgentModels,
  QueryRequestPayload,
  QueryResponsePayload,
  QuerySessionEntry,
} from '@cindy/slack-hook-protocol';

/** 单 agent 能力面(getCapabilities 的最小消费形状)。 */
export interface AgentModelSource {
  agentKind: string;
  models: Array<{
    id: string;
    displayName: string;
    efforts: readonly string[];
    defaultEffort: string | null;
    /** 目录分组 id(如 'gpt-budget'): 折扣版与官方版同名, server 靠它加区分后缀。 */
    group?: string;
  }>;
  /** 该 agent 支持的权限档(capabilities.permissionModes; label 用 displayName 原样透传)。 */
  permissionModes: Array<{ id: string; displayName: string }>;
}

export interface QueryResponderDeps {
  /** 当前连接的工作区别名清单(实时读配置)。 */
  listWorkspaces: () => string[];
  /** 全部 agent 的可用模型(与会话选择器同规则实时派生; listProviders 异步故允许 Promise)。 */
  listAgentModels: () => AgentModelSource[] | Promise<AgentModelSource[]>;
  /** 当前账号、仅本地白名单内的隐私最小化 recent sessions。 */
  listSessions?: () => QuerySessionEntry[] | Promise<QuerySessionEntry[]>;
}

/** 构造 query.response payload; 数据源抛错 / reject 时回 ok:false + 原因。 */
export async function buildQueryResponse(
  deps: QueryResponderDeps,
  request: QueryRequestPayload,
): Promise<QueryResponsePayload> {
  try {
    if (request.kind === 'workspaces') {
      return {
        queryId: request.queryId,
        kind: 'workspaces',
        ok: true,
        error: null,
        workspaces: deps.listWorkspaces(),
      };
    }
    if (request.kind === 'sessions') {
      const sessions = (await (deps.listSessions?.() ?? [])).slice(0, 20);
      return {
        queryId: request.queryId,
        kind: 'sessions',
        ok: true,
        error: null,
        sessions,
      };
    }
    const agents: QueryAgentModels[] = (await deps.listAgentModels()).map((src) => ({
      agentKind: src.agentKind,
      models: src.models.map((m) => ({
        id: m.id,
        label: m.displayName,
        efforts: [...m.efforts],
        defaultEffort: m.defaultEffort,
        group: m.group ?? null,
      })),
      permissionModes: src.permissionModes.map((pm) => ({ id: pm.id, label: pm.displayName })),
    }));
    return { queryId: request.queryId, kind: 'models', ok: true, error: null, agents };
  } catch (err) {
    return {
      queryId: request.queryId,
      kind: request.kind,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
