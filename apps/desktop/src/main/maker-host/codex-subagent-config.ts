/**
 * Codex 子代理设置 → spawn 时 `-c agents.*` overrides 的纯函数映射。
 *
 * 键名与语义以 bundled codex(0.145.x)的 `[agents]` 配置段为准:
 * - `agents.enabled=false` 是唯一能压住 Sol/Terra(模型元数据强制 MultiAgent V2)的
 *   配置闸——它在版本裁决链里排在模型元数据之前;`features.multi_agent_v2=false`
 *   会被模型元数据无视。
 * - `agents.max_concurrent_threads_per_session=N` 语义 = 同时 N 个子代理;V2 后端
 *   自动解析为 N+1 总线程(根+子)。**并发数绝不写 `features.multi_agent_v2.*`**:
 *   features 段的同名键语义是总线程(=N+1)且解析优先级更高,双写会静默盖掉本段
 *   注入并产生差 1 的双重语义;两个配置 struct 都 deny_unknown_fields。
 * - 例外:`multi_agent_mode_hint_text` 与 `expose_spawn_agent_model_overrides` 只
 *   存在于 features 段(resolve_multi_agent_v2_config 仅从该段读取,无 agents 段
 *   等价键)。前者仅在用户启用 Cindy 自定义策略时注入,见
 *   CODEX_ON_DEMAND_DELEGATION_HINT;后者保持开启,让模型可显式选择子代理模型,
 *   不改变上游何时委托的调度策略。
 * - `agents.max_depth` 仅旧版多代理(V1)生效,V2 忽略(UI hint 已注明)。
 * - 刻意不注入 `agents.default_subagent_model` 与
 *   `agents.default_subagent_reasoning_effort`:这两个默认值是共享 app-server 的
 *   进程级配置,而设置中保存的 providerId 是会话级客户端偏好。Codex 0.145 的
 *   model/list 又不公开当前 turn 的 Multi-Agent 版本或 provider/account 权限,
 *   Cindy 无法在 spawn 前证明某个默认模型既通过原生目录校验又可实际执行。
 *   fail-closed 保留 Codex 原生选择,避免未知模型错误或随后发生 403。
 *
 * TOML 值形态与 mcp-integrations/codexEnvironment.ts 一致:字符串带双引号,
 * 数字/布尔裸写。
 */

import type { SubagentModelSettings } from '../../shared/subagentModelSettings.js';

/**
 * 按需委托策略(Claude Code 式):替换上游按 effort 推导的内置 multi-agent 模式
 * (非 ultra 档一律 explicitRequestOnly——模型被明确禁止自发 spawn 子代理)。设置
 * 本文案后上游走 MultiAgentMode::Custom,任意 effort 档都按此策略自主委托探索。
 *
 * 上游以 <multi_agent_mode> developer 段逐 turn 注入,截断上限 400 token
 * (MULTI_AGENT_MODE_MAX_TOKENS),增改内容时须留在限内。文案属于进入模型上下文
 * 的提示词,改动前须按 docs/dev-rules/maker-core-and-agent-behavior.md 取得维护者
 * 确认。
 *
 * 文案本身仍是内部常量;是否注入由 codexUseCindySubagentPolicy 单独控制。
 * 总开关 codexSubagentsEnabled 关闭时本段与其它子代理配置都不注入。
 */
const CODEX_ON_DEMAND_DELEGATION_HINT =
  'Delegate on demand: for exploration whose intermediate output does not need to stay in ' +
  'this thread — reading rule or design docs, surveying large or unfamiliar files, broad ' +
  'code searches — spawn a sub-agent with a narrow task (state exactly what to read and ' +
  'which question to answer; report conclusions only, no full-text quoting) and keep only ' +
  'its findings here. Prefer delegating the initial repository-rules reading at task ' +
  'start. Do implementation, code edits, and final verification yourself in the main ' +
  'thread. Skip delegation for quick single-file lookups.';

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
  // 自定义策略关闭时不设置 multi_agent_mode_hint_text,由上游按 effort 选择原生
  // multi-agent 模式。显式 spawn 参数能力与进程级默认正交,仍保持暴露。
  if (settings.codexUseCindySubagentPolicy) {
    args.push(
      '-c',
      `features.multi_agent_v2.multi_agent_mode_hint_text=${tomlString(CODEX_ON_DEMAND_DELEGATION_HINT)}`,
    );
  }
  args.push('-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true');
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
