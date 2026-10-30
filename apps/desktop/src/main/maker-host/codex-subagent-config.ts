/**
 * Codex Subagent 的两档运行模式。
 *
 * 默认模式不注入任何 `agents.*` 或 multi-agent 提示，完整保留 Codex 原生的
 * Sol/Terra 调配。用户显式开启「智能调配」后，Desktop 才把一份扩展模型目录交给
 * Codex，并让模型按任务选择其中的 Subagent；每个子线程的真实 Provider 路由由
 * loopback proxy 根据该子线程请求里的 model 决定。
 */

import type { SubagentModelSettings } from '../../shared/subagentModelSettings.js';

export interface CodexSubagentRouteSnapshot {
  providerId: string;
  catalogModel: string;
  /** undefined = 保留 spawn_agent 选择的档位；null = 显式删除 effort。 */
  reasoningEffort?:
    'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null;
}

export interface CodexSmartSubagentConfig {
  catalogPath: string;
  /** Exact in-memory catalog written to catalogPath, retained for race-free custom-window patching. */
  modelCatalog: {
    models: Array<Record<string, unknown> & { slug: string }>;
  };
  routes: CodexSubagentRouteSnapshot[];
  routingSignature: string;
}

/** TOML basic string 转义。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function smartRoutingHint(routes: readonly CodexSubagentRouteSnapshot[]): string {
  const models = routes.map((route) => route.catalogModel).join(', ');
  return (
    'Delegate independent exploration when it saves time. Choose the least expensive capable ' +
    'Subagent model and report conclusions back to the parent; keep implementation and final ' +
    `verification in the parent. Additional available models: ${models}.`
  );
}

/**
 * 这个 app-server 是否套用「智能调配」(扩展目录、spawn 可指定模型、逐模型 Provider 路由)。
 * 控制面与 Review 不用；供应商分享受邀者的任务也不用：它的子代理只能沿用会话模型，留在分享的
 * 供应商内(扩展目录里是本机用户其它供应商的模型)。
 */
export function codexHostUsesSmartSubagentRouting(
  settings: SubagentModelSettings,
  ctx: {
    hostPurpose?: 'control-plane' | 'review' | 'custom-context';
    deviceHostedGuestProviderId?: string;
  },
): boolean {
  return settings.codexSmartSubagentRouting === true
    && ctx.hostPurpose !== 'control-plane'
    && ctx.hostPurpose !== 'review'
    && !ctx.deviceHostedGuestProviderId;
}

export function buildCodexSubagentSpawnArgs(
  settings: SubagentModelSettings,
  smartConfig?: CodexSmartSubagentConfig,
): string[] {
  if (!settings.codexSmartSubagentRouting || !smartConfig || smartConfig.routes.length === 0) {
    return [];
  }
  return [
    '-c',
    `model_catalog_json=${tomlString(smartConfig.catalogPath)}`,
    '-c',
    'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
    '-c',
    `features.multi_agent_v2.multi_agent_mode_hint_text=${tomlString(smartRoutingHint(smartConfig.routes))}`,
  ];
}

export function resolveCodexSubagentRoutingProfile(
  settings: SubagentModelSettings,
  smartConfig?: CodexSmartSubagentConfig,
): 'default' | 'smart' {
  return settings.codexSmartSubagentRouting && smartConfig && smartConfig.routes.length > 0
    ? 'smart'
    : 'default';
}
