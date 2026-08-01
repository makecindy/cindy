/**
 * Claude Code flag settings 层(= `--settings` CLI flag / SDK options.settings)的统一装配。
 *
 * flag settings 是 cc 设置体系里**用户可控层中优先级最高**的一层,覆盖
 * user(~/.claude/settings.json) / project / local 三个文件层。startSession 的本地
 * sdkQuery 分支与远端 cc-mgr 分支共用本函数产出的同一对象 —— 两边绝不能漂移
 * (同 session setting 跨本地 / 远端表现必须一致)。
 *
 * ## apiKeyHelper 恒置空 —— 鉴权防线的一部分
 *
 * cc 的鉴权优先级: env(ANTHROPIC_API_KEY 等) > settings.apiKeyHelper > claude.ai
 * OAuth 凭证库。用户级 ~/.claude/settings.json 若配了 apiKeyHelper(个人终端 claude
 * 走第三方网关的常见配法),会在 **oauth-spawn**(子进程不注入任何鉴权 env、期望 cc
 * 原生用 Claude.ai 订阅 OAuth)下抢在 OAuth 之前生效 —— cc 拿 helper 吐的第三方 key
 * 当 x-api-key 直打 api.anthropic.com,必然 401 invalid x-api-key("Invalid API key
 * · Fix external API key")。
 *
 * 既有防线都拦不住它: CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1 只过滤 settings 来源的
 * **env 字段**,apiKeyHelper 是 settings 顶层字段不在其列; boot 期
 * stripSensitiveAnthropicEnv 只清 process.env。唯一确定性出路是在优先级更高的
 * flag settings 层把它覆盖成空字符串(cc 对空值跳过 helper,回落 OAuth 凭证库)。
 *
 * 恒置空对三种 spawn 形态都安全(经 2.1.186 二进制实测):
 * - oauth-spawn:  helper 被禁用,cc 回落 claude.ai OAuth → Bearer token,修复本体。
 * - gateway-spawn: env ANTHROPIC_API_KEY 优先级高于 settings 层,行为不变。
 * - 远端 daemon:   远端机器用户的 apiKeyHelper 同样被屏蔽(远端也是 host 托管路由)。
 * 运行时 q.applyFlagSettings() 是 merge 语义(只并入传入字段),中途 toggle
 * fastMode / effort 不会丢掉本覆盖。
 */

import type { Settings } from '@anthropic-ai/claude-agent-sdk';
import type { CapabilityRoutingPolicy } from '../../types/capability-routing.js';
import { buildClaudeSkillOverrides } from './capability-routing.js';

export interface ClaudeFlagSettingsInput {
  /** reasoning summary 展示开关(displayReasoning === 'summarized')。 */
  showThinkingSummaries: boolean;
  /**
   * memory 联动 override(host 经 runtimeConfig.memoryEnabled 或 BaseAgent.setMemory
   * 控制)。undefined = 不传字段,让 SDK 走默认。
   */
  memoryOverride?: boolean;
  /**
   * Fast 模式。仅 true 时落字段(解锁 cc 二进制在 Agent SDK 通道下的 fast);false /
   * 缺省时整字段不出现 → 与未升级行为逐字节一致,零缓存影响。
   */
  fastMode: boolean;
  /** Host-owned policy for colliding downstream skills. */
  capabilityRouting?: CapabilityRoutingPolicy;
}

/** 装配 startSession 注入的 flag settings 对象。纯函数 —— 每次调用读最新输入值。 */
export function buildClaudeFlagSettings(input: ClaudeFlagSettingsInput): Settings {
  const skillOverrides = buildClaudeSkillOverrides(input.capabilityRouting);
  return {
    showThinkingSummaries: input.showThinkingSummaries,
    // 屏蔽用户级 apiKeyHelper,防止它劫持 oauth-spawn 的订阅鉴权(见文件头注释)。
    apiKeyHelper: '',
    ...(input.memoryOverride !== undefined && {
      autoMemoryEnabled: input.memoryOverride,
      autoDreamEnabled: input.memoryOverride,
    }),
    ...(input.fastMode && { fastMode: true }),
    ...(Object.keys(skillOverrides).length > 0 && { skillOverrides }),
  };
}
