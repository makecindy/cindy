/**
 * Codex 子代理设置 → spawn 时 `-c agents.*` overrides 的纯函数映射。
 *
 * 键名与语义以 bundled codex(0.145.x)的 `[agents]` 配置段为准:
 * - `agents.enabled=false` 是唯一能压住 Sol/Terra(模型元数据强制 MultiAgent V2)的
 *   配置闸——它在版本裁决链里排在模型元数据之前;`features.multi_agent_v2=false`
 *   会被模型元数据无视。
 * - `agents.max_concurrent_threads_per_session=N` 语义 = 同时 N 个子代理;V2 后端
 *   自动解析为 N+1 总线程(根+子)。**绝不写 `features.multi_agent_v2.*` 键**:
 *   两个配置 struct 都 deny_unknown_fields,且同时写两段会产生双重语义。
 * - `agents.max_depth` 仅旧版多代理(V1)生效,V2 忽略(UI hint 已注明)。
 * - `agents.default_subagent_model` 是兜底默认,模型仍可在 spawn 参数里显式覆盖。
 *   注入 Cindy 存储的 model id 原文:codex vendor 候选只有原生 slug 与 `codex/`
 *   折扣路由 id,`codex/` 前缀由 loopback proxy 在 HTTP 边界分流(decideCodexRoute),
 *   剥前缀反而会把折扣路由静默改道。
 *
 * TOML 值形态与 mcp-integrations/codexEnvironment.ts 一致:字符串带双引号,
 * 数字/布尔裸写。
 */

import type { SubagentModelSettings } from '../../shared/subagentModelSettings.js';

/** TOML basic string 转义(model id 理论上不含这些字符,防御性处理)。 */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function buildCodexSubagentSpawnArgs(settings: SubagentModelSettings): string[] {
  const args: string[] = [];
  if (!settings.codexSubagentsEnabled) {
    // 总开关关死后其余键无意义,不再注入。
    args.push('-c', 'agents.enabled=false');
    return args;
  }
  if (settings.codex) {
    args.push('-c', `agents.default_subagent_model=${tomlString(settings.codex)}`);
  }
  if (settings.codexEffort) {
    args.push('-c', `agents.default_subagent_reasoning_effort=${tomlString(settings.codexEffort)}`);
  }
  if (settings.codexMaxConcurrentSubagents !== null) {
    args.push(
      '-c',
      `agents.max_concurrent_threads_per_session=${settings.codexMaxConcurrentSubagents}`,
    );
  }
  if (settings.codexAllowNestedSubagents) {
    args.push('-c', 'agents.max_depth=2');
  }
  return args;
}
