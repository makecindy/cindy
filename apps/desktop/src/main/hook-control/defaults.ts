/**
 * hook-control/defaults.ts
 * ---------------------------------------------------------------------------
 * Hook 新会话的 agent / model / effort / permissionMode / providerId 合成
 * (取值链的桌面端末段):
 *
 *   server 显式值(用户在 Slack 按工作目录设置的偏好) > 桌面端 IM 新会话
 *   默认值(草稿, 建 session 那一刻实时读) > 当前可用模型清单的首项 >
 *   草稿裸值(没有任何可用模型时的兼容兜底)
 *
 * 与 im/defaultSessionSettings 同一默认值数据源(readImDefaultSettings),
 * 语义是「Slack 里开的会话与桌面端新开会话行为一致」。显式值非法(模型不在
 * 可用清单 / effort 不被该模型支持)时静默回落并记日志 —— server 侧渲染按钮
 * 的清单本就来自本机实时供应商目录, 非法值只出现在
 * "偏好过期"(模型下架 / agent 换代)的窗口里。
 *
 * permissionMode 例外: IM 草稿默认没有权限概念, 取值链是「显式且该 agent
 * 支持 > 显式但不支持时回落该 agent **最严**档 > 从未填显式档时
 * 'bypassPermissions'」。
 *
 * 「不支持时只能更严不能更宽」是安全方向的硬要求(2026-07 修正; 旧实现在此
 * 回落 bypass): 用户填过显式档 = 明确表达过「不要默认的完全访问」, 换 agent
 * 后原档不被支持(如 Claude 的 acceptEdits / plan 在 Codex 上不存在)时若回落
 * bypassPermissions, 等于选了更严的档反而被静默放宽成完全访问 —— 而这是无人
 * 值守的 IM 派发链路, 没有人在旁边确认。capabilities 的 permissionModes 一律
 * 按**从严到宽**声明(claude-code: ask/acceptEdits/auto/bypassPermissions;
 * codex: ask/auto/bypassPermissions), 故取 [0] 即最严档。
 * 「从未填显式档 → bypassPermissions」的无人值守历史默认保持不变。
 *
 * 纯函数 + 注入依赖(规则 14), Electron / maker 绑定在 session-runner 组装。
 */

import type { Effort } from '@cindy/maker-core';

/** 依赖注入面: IM 默认值 + 各 agent 当前可用模型清单。 */
export interface HookDefaultsDeps {
  readDefaults: () => {
    agentKind: 'claude-code' | 'codex' | 'pi';
    agents: Record<
      'claude-code' | 'codex' | 'pi',
      { providerId: string | null; model: string; effort: string }
    >;
  };
  getModels: (agentKind: 'claude-code' | 'codex' | 'pi') => Array<{
    id: string;
    efforts: readonly string[];
    defaultEffort: string | null;
  }>;
  /** 该 agent 支持的权限档 id 清单(capabilities.permissionModes)。 */
  getPermissionModes: (agentKind: 'claude-code' | 'codex' | 'pi') => readonly string[];
  log: { warn(msg: string): void };
}

export interface ResolvedHookSessionConfig {
  agentKind: 'claude-code' | 'codex' | 'pi';
  model: string;
  effort: Effort | undefined;
  permissionMode: string;
  /**
   * 草稿默认的来源(供应商)id, 未设置为 null。这里只透传设置值不校验连接态 ——
   * 供应商目录是异步接口, 本函数保持纯同步; session-runner 会在同一份实时
   * 目录快照里把最终模型解析到具体已连接来源。
   */
  providerId: string | null;
}

const AGENT_KINDS = new Set(['claude-code', 'codex', 'pi']);

/**
 * 合成新 hook 会话的 agent/model/effort。
 * overrides 来自 dispatch options(server 侧个人习惯), 任一为 null = 未指定。
 */
export function resolveHookSessionConfig(
  deps: HookDefaultsDeps,
  overrides: {
    agentKind: string | null;
    model: string | null;
    effort: string | null;
    permissionMode: string | null;
  },
): ResolvedHookSessionConfig {
  const defaults = deps.readDefaults();

  // 1. agent: 显式合法值 > 草稿默认
  const agentKind: 'claude-code' | 'codex' | 'pi' =
    overrides.agentKind !== null && AGENT_KINDS.has(overrides.agentKind)
      ? (overrides.agentKind as 'claude-code' | 'codex' | 'pi')
      : defaults.agentKind;

  const models = deps.getModels(agentKind);
  const findModel = (id: string) => models.find((m) => m.id === id);

  // 2. model:显式且在可用清单 > 草稿默认(在清单) > 清单第一个 > 草稿默认裸值。
  // getModels 来自本次执行实时读取的 provider 目录；目录读取失败时 session-runner 会改用
  // maker capabilities，因此走到这里的非空清单就是可执行真相，失效 override 必须降级。
  let model: string;
  if (overrides.model !== null && findModel(overrides.model)) {
    model = overrides.model;
  } else {
    if (overrides.model !== null) {
      deps.log.warn(
        `hook override model '${overrides.model}' not available for ${agentKind}, falling back to desktop default`,
      );
    }
    const draft = defaults.agents[agentKind]?.model;
    if (draft && findModel(draft)) {
      model = draft;
    } else {
      model = models[0]?.id ?? draft ?? '';
    }
  }

  // 3. effort: 显式且该模型支持 > 草稿默认(该模型支持) > 模型默认档 > 不传
  const descriptor = findModel(model);
  let effort: string | undefined;
  if (descriptor === undefined || descriptor.efforts.length === 0) {
    effort = undefined; // descriptor 暂缺或模型不支持调档, 不传由 agent/backend 处理
  } else if (overrides.effort !== null && descriptor.efforts.includes(overrides.effort)) {
    effort = overrides.effort;
  } else {
    if (overrides.effort !== null) {
      deps.log.warn(
        `hook override effort '${overrides.effort}' not supported by ${model}, falling back`,
      );
    }
    const draftEffort = defaults.agents[agentKind]?.effort;
    if (draftEffort && descriptor.efforts.includes(draftEffort)) {
      effort = draftEffort;
    } else {
      effort = descriptor.defaultEffort ?? descriptor.efforts[0];
    }
  }

  // 4. providerId: 草稿默认(与 agentKind 同组), 无 override 通道(hook 协议
  //    v1 的 dispatch options 不携带来源字段); 空白串归一成 null
  const draftProviderId = defaults.agents[agentKind]?.providerId;
  const providerId = draftProviderId?.trim() ? draftProviderId.trim() : null;

  // 5. permissionMode: 显式且该 agent 支持 > 显式但不支持时回落该 agent **最严**档
  //    > 无显式偏好时 bypass(hook 无人值守历史默认)
  //
  //    「不支持时回落最严档」是安全方向的硬要求, 不能回落 bypass:
  //    用户填过显式档 = 明确表达过「不要默认的完全访问」。换 agent 后原档不被支持
  //    (如 Claude 的 acceptEdits / plan 在 Codex 上不存在)时若回落 bypassPermissions,
  //    等于用户选了更严的档反而被静默放宽成完全访问 —— 而这是无人值守的 IM 派发链路,
  //    没有人在旁边确认。capabilities 的 permissionModes 一律按**从严到宽**声明
  //    (claude-code: ask/acceptEdits/auto/bypassPermissions; codex: ask/auto/
  //    bypassPermissions), 故取 [0] 即最严档。
  //    只有「从未填过显式档」才走 bypass 历史默认, 该行为保持不变。
  let permissionMode = 'bypassPermissions';
  if (overrides.permissionMode !== null) {
    const supported = deps.getPermissionModes(agentKind);
    if (supported.includes(overrides.permissionMode)) {
      permissionMode = overrides.permissionMode;
    } else if (supported.length > 0) {
      permissionMode = supported[0];
      deps.log.warn(
        `hook override permissionMode '${overrides.permissionMode}' not supported by ${agentKind}, falling back to strictest supported '${permissionMode}'`,
      );
    } else {
      // agent 未声明任何档位(异常/测试桩)—— 与「有档位但不含显式值」是两种情况,
      // 日志分开写,免得排障时把「无档位声明」误读成「已收紧到最严档」。
      deps.log.warn(
        `hook override permissionMode '${overrides.permissionMode}' rejected: ${agentKind} declares no permission modes; using legacy default 'bypassPermissions'`,
      );
    }
  }

  return { agentKind, model, effort: effort as Effort | undefined, permissionMode, providerId };
}
