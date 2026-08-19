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
 *   CODEX_ON_DEMAND_DELEGATION_HINT。未指定个性化模型时后者保持开启；一旦用户
 *   指定模型则关闭覆盖字段，让 Codex 走“继承父模型创建”的免目录校验路径，实际
 *   模型、Provider 与 effort 由 loopback proxy 对已确认的子线程强制应用。
 * - `agents.max_depth` 仅旧版多代理(V1)生效,V2 忽略(UI hint 已注明)。
 * - 用户未指定个性化 Codex 模型时，隐藏配置中的 effort 仍按原生 agents.* 语义注入。
 *   用户指定模型时不写 `agents.default_subagent_model` / effort：只要两项都不覆盖，
 *   Codex 0.145 会让子线程继承父模型并跳过 spawn_agent 的模型目录校验。
 *
 * TOML 值形态与 mcp-integrations/codexEnvironment.ts 一致:字符串带双引号,
 * 数字/布尔裸写。
 */

import {
  effectiveSourceIdForModel,
  type ProviderView,
} from '@cindy/model-providers';

import type {
  CodexSubagentEffort,
  SubagentModelSettings,
} from '../../shared/subagentModelSettings.js';

export interface CodexSubagentRouteSnapshot {
  providerId: string;
  catalogModel: string;
  reasoningEffort: CodexSubagentEffort | 'none' | 'minimal' | null;
}

export interface CodexSubagentHostCredentialPlan {
  forceDisableSubagents: boolean;
  requiredSpawnCredentialMode?: 'oauth-bearer';
}

/**
 * OpenAI/ChatGPT 路由依赖 Codex 原生 OAuth passthrough。父任务可能使用另一家
 * Provider OAuth，因此锁定子代理必须要求带 ChatGPT OAuth 的 app-server；不能接受
 * 只有占位 key 的 provider-oauth host，再等 Proxy 在请求期拒绝。
 */
export function resolveCodexSubagentHostCredentialPlan(
  route: CodexSubagentRouteSnapshot | undefined,
  providerViews: ProviderView[] | undefined,
  credentialMode: 'gateway-key' | 'oauth-bearer' | 'provider-oauth',
  hasCodexOAuthLogin: boolean,
): CodexSubagentHostCredentialPlan {
  if (!route) return { forceDisableSubagents: false };
  const routing = providerViews
    ?.find((provider) => provider.id === route.providerId)
    ?.routing.codex;
  if (routing?.authStrategy !== 'oauth-passthrough') {
    return { forceDisableSubagents: false };
  }
  if (!hasCodexOAuthLogin) {
    return { forceDisableSubagents: true };
  }
  return credentialMode === 'oauth-bearer'
    ? { forceDisableSubagents: false }
    : { forceDisableSubagents: false, requiredSpawnCredentialMode: 'oauth-bearer' };
}

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

export function resolveCodexSubagentRouteSnapshot(
  settings: SubagentModelSettings,
  remoteHostId?: string,
  providerViews?: ProviderView[],
): CodexSubagentRouteSnapshot | undefined {
  if (remoteHostId || !settings.codexSubagentsEnabled) return undefined;
  const catalogModel = settings.codex?.trim();
  const explicitProviderId = settings.codexProviderId?.trim();
  // 有运行期目录时，显式来源也必须做严格校验：断连、删除模型或变成非聊天端点时不得
  // 静默回落到另一个来源。未显式选来源则沿用标准模型选择器的原生默认优先级。
  const resolvedProviderId = catalogModel && providerViews
    ? effectiveSourceIdForModel(providerViews, explicitProviderId ?? null, catalogModel, 'codex')
    : null;
  const providerId = providerViews
    ? explicitProviderId
      ? resolvedProviderId === explicitProviderId ? explicitProviderId : null
      : resolvedProviderId
    : explicitProviderId || null;
  if (!catalogModel || !providerId) return undefined;
  return {
    providerId,
    catalogModel,
    reasoningEffort: settings.codexEffort,
  };
}

/**
 * 本地普通 host 配置了锁定子代理模型时，必须同时冻结它的 Provider 路由。
 *
 * Provider 未显式保存时会从当前可用目录隐式解析；目录读取失败或没有可用来源时，
 * 不能让 Codex 继承父任务 Provider 后继续运行，否则会静默跑错上游。remote host 使用
 * 自己隔离的配置，review host 不启用子代理，两者不受本地路由解析约束。
 */
export function codexSubagentRouteResolutionFailed(
  settings: SubagentModelSettings,
  resolvedRoute: CodexSubagentRouteSnapshot | undefined,
  opts: { remoteHostId?: string; isReview?: boolean } = {},
): boolean {
  if (opts.remoteHostId || opts.isReview || !settings.codexSubagentsEnabled) return false;
  return Boolean(settings.codex?.trim()) && !resolvedRoute;
}

export function buildCodexSubagentSpawnArgs(
  settings: SubagentModelSettings,
  resolvedRoute?: CodexSubagentRouteSnapshot,
  opts: { forceDisableSubagents?: boolean } = {},
): string[] {
  const args: string[] = [];
  const forcedModel = settings.codex?.trim();
  const hasForcedRoute = Boolean(
    forcedModel && resolvedRoute?.catalogModel === forcedModel,
  );
  if (
    !settings.codexSubagentsEnabled
    || opts.forceDisableSubagents
    || (forcedModel && !hasForcedRoute)
  ) {
    // 总开关或运行期 fail-closed 关死后其余键无意义,不再注入。
    args.push('-c', 'agents.enabled=false');
    return args;
  }
  // 自定义策略关闭时不设置 multi_agent_mode_hint_text,由上游按 effort 选择原生
  // multi-agent 模式。
  if (settings.codexUseCindySubagentPolicy) {
    args.push(
      '-c',
      `features.multi_agent_v2.multi_agent_mode_hint_text=${tomlString(CODEX_ON_DEMAND_DELEGATION_HINT)}`,
    );
  }
  args.push(
    '-c',
    `features.multi_agent_v2.expose_spawn_agent_model_overrides=${hasForcedRoute ? 'false' : 'true'}`,
  );
  // 锁定模型时 model / effort 两项都不交给 Codex：这会走继承父模型的创建路径，
  // 不触发 spawn_agent 模型目录校验。Proxy 只对登记过的子线程应用冻结配置。
  if (!hasForcedRoute && settings.codexEffort) {
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

/**
 * A display fallback is truthful only for the local app-server whose descendant
 * requests are locked by the matching proxy route. SSH remote daemons use their
 * own isolated CODEX_HOME, so the local setting must not be shown as if it were
 * the remote thread's actual model.
 */
export function resolveCodexSubagentModelFallback(
  settings: SubagentModelSettings,
  remoteHostId?: string,
): string | undefined {
  if (remoteHostId || !settings.codexSubagentsEnabled) return undefined;
  return settings.codex?.trim() || undefined;
}
