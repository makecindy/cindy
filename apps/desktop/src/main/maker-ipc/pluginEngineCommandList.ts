/**
 * 插件引擎在 `/` 面板里的命令清单。
 *
 * 内置引擎的命令是 agent 级别的静态白名单（Claude Code / Codex / Pi）；插件引擎
 * （ACP）的命令是**会话级别**的广播：引擎在握手里（以及命令增删后）用
 * `available_commands_update` 报出自己认识的 `/…`，带描述。因此这份清单只能按会话读，
 * 且读的是那个会话当前在跑的引擎 —— 引擎重播整份清单时它整份替换，重播空清单即清空。
 */

import { PLUGIN_ENGINE_AGENT_KIND } from '../../shared/pluginEngines.js';
import type { AgentBuiltinCommand } from '@cindy/maker-core';

export type CommandListAgentKind =
  | 'claude-code'
  | 'codex'
  | 'pi'
  | typeof PLUGIN_ENGINE_AGENT_KIND;

/**
 * 命令清单入口放行的引擎。
 *
 * 插件引擎放行在内置引擎之后：它的命令来自会话，不是 agent 级别的静态清单，
 * 调用方必须同时给出 sessionId（入口处校验，见 register.ts）。
 */
export function parseCommandListAgentKind(value: unknown): CommandListAgentKind | null {
  if (value === 'claude-code' || value === 'codex' || value === 'pi') return value;
  if (value === PLUGIN_ENGINE_AGENT_KIND) return PLUGIN_ENGINE_AGENT_KIND;
  return null;
}

export interface PluginEngineCommandListDeps {
  /** 持久化的任务行；找不到就是 null。 */
  sessionMeta: { agentKind: string } | null;
  /** 在跑会话里引擎最新广播的命令清单（含描述，整份替换）。 */
  listSessionCommands: (sessionId: string) => AgentBuiltinCommand[];
}

/**
 * 插件引擎任务的命令清单。
 *
 * 任务不存在、或不是插件引擎，都是空清单 —— 面板就只留桌面命令。这不是错误：
 * 会话行还没落库、或任务换过引擎时都会这样。引擎还没广播过命令时同样是空清单，
 * 广播之后下一次读取即可见。
 */
export function pluginEngineCommandList(
  sessionId: string,
  deps: PluginEngineCommandListDeps,
): AgentBuiltinCommand[] {
  if (deps.sessionMeta?.agentKind !== PLUGIN_ENGINE_AGENT_KIND) return [];
  return deps.listSessionCommands(sessionId);
}
