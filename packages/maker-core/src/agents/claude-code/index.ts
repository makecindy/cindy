/**
 * ClaudeCodeAgent — Claude Code 的 maker-core 一等公民实现。
 *
 * 设计来源：从 desktop apps/desktop/src/main/vendor/claude/runtime.ts 搬迁过来，
 * 去除了 desktop-only 的依赖（in-process MCP server、systemPromptLoader）。
 *
 * systemPrompt 三段:
 * - [1] cc preset (SDK 自带, 不可见)
 * - [2] MAKER_SYSTEM_PROMPT_APPEND (maker engine, system-prompt-append.md)
 * - [3] runtimeConfig.systemPrompt (host runtime, host 维护的 .md)
 *
 * Stage 2 B: 运行时切换 setModel / setEffort / setPermissionMode 已接通
 * (Query.setModel / applyFlagSettings({ effortLevel }) / Query.setPermissionMode)。
 *
 * 与 vendor/claude/runtime.ts 的差异：
 * - env 三段组装走 maker-core 的 AuthAdapter.getAuthEnv() + AgentRuntimeConfig
 * - mcpServers 字段由 host 注入的 mcpProviders 生成（具体 MCP 不在 maker-core 内）
 * - systemPrompt.append 由 maker-core 拼接四段(preset / engine / host产品级 / per-call)
 * - vendorOptions.source / forkSession / resumeSessionAt / extraSystemPrompt / onStderrLine
 *   仍然通过 vendorOptions 透传（与 vendor 版语义一致）
 *
 * 文件结构对标 codex/index.ts，方便对照阅读。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  query as sdkQuery,
  forkSession as sdkForkSession,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  CanUseTool,
  HookCallback,
  McpServerConfig,
  PermissionUpdate,
  PreToolUseHookInput,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';
import { discoverSubagentDefinitions } from './subagent-definitions.js';
import { spawnObservedClaudeProcess } from './local-process-spawn.js';
import {
  reportSubagentModelDiagnostics,
  resolveSubagentModelDefault,
  type ResolveSubagentModelDefaultResult,
} from './subagent-model-default.js';
import Anthropic, { APIError } from '@anthropic-ai/sdk';

import {
  BaseAgent,
  OneShotError,
  AgentNotAuthenticatedError,
  TurnPermissionPolicyUnsupportedError,
  type AgentSessionHandle,
  type AgentDeps,
  type StartSessionOptions,
  type OneShotOptions,
  type SendOptions,
  type TurnPermissionPolicy,
} from '../base-agent.js';
import { SYSTEM_PROMPT_APPEND as MAKER_SYSTEM_PROMPT_APPEND } from './system-prompt-append.js';
import { MAKER_MEMORY_RULES } from '../../memory/system-prompt.js';
import {
  CONTACTS_RULES_DISABLED,
  CONTACTS_RULES_ENABLED,
} from '../../contacts/system-prompt.js';
import { MemoryFlushController } from '../../memory/flush-controller.js';
import { buildMemoryScopeKey } from '../../memory/storage.js';
import type {
  Capabilities,
  EffortDescriptor,
  PermissionModeDescriptor,
} from '../../types/capabilities.js';
import type {
  AgentEvent,
  InteractionResolver,
  InteractionRequest,
  InteractionDecision,
  InteractionDismissedEvent,
  AskUserQuestionItem,
  UsageSnapshot,
  RewindFilesResult,
  ForkSdkSessionOptions,
  ForkSdkSessionResult,
} from '../../types/events.js';
import { isTerminalAgentErrorEvent } from '../../types/events.js';
import type { UserMessage } from '../../types/common.js';
import {
  capabilitySelectionAddedByPlanEdit,
  findClaudeMcpCapabilityRoute,
  isCapabilityRouteInvocationAllowed,
} from '../../types/capability-routing.js';
import { createAsyncQueue, type AsyncQueue } from '../shared/async-queue.js';
import { AutoCompactController } from '../shared/auto-compact-controller.js';
import { resolveMcpToolTarget } from '../shared/mcp-tool-target.js';
import { scanClaudeAtResources, scanClaudeSlashCommands } from '../shared/palette-scanner.js';
// scanClaudeSlashCommands 仍是 listAgentSkills 的实际数据源, 名字保留(它扫的是 commands+skills 两类)。
import { UsageTracker } from '../shared/usage-tracker.js';
import { getDefaultImageResizer } from '../shared/image-resizer.js';
import { pickTurnStartStatus, type OneShotState } from '../shared/turn-start-phrases.js';
import { ToolLoopGuard } from '../shared/loop-guard.js';
import {
  applyOAuthSpawnEntrypointGate,
  applySubagentModelEnv,
  buildClaudeEnv,
  REMOTE_ROUTE_OVERRIDE_ENV_KEYS,
} from './env-builder.js';
import { buildClaudeFlagSettings } from './flag-settings.js';
import {
  buildClaudeOrcaCallerProvenanceHooks,
  buildClaudeLocalToolGuardHooks,
  buildClaudeRemoteOrcaCallerGuards,
  buildClaudeRemoteToolGuards,
  mergeClaudeHookSets,
} from './capability-routing.js';
import { normalizeBuiltinToolForAutoReview } from './auto-review-policy.js';
import {
  composeAutoReviewIntentWithApprovedPlan,
  composeAutoReviewIntentWithClarification,
  createAutoReviewUnavailableNotice,
  extractAutoReviewUserIntent,
  resolveAutoReviewDecision,
  type AutoReviewDecision,
} from '../shared/auto-review-decision.js';
import type { ReviewableAction } from '../shared/auto-review.js';
import {
  resolveAgentCredentialMode,
  resolveEffectiveCredentialModeFromAuthSource,
} from '../credential-mode.js';
import { repairForkedClaudeSessionJsonl, type RepairForkedClaudeJsonlResult } from './fork-jsonl-repair.js';
import { ensureClaudeTranscriptInWorkingDir } from './transcript-relocation.js';
import { findClaudeSessionJsonl } from './claude-projects-fs.js';
import { normalizeClaudeSessionJsonlToolIds } from './jsonl-tool-id-normalize.js';
import { isClaudeResumeSessionNotFound } from './invalid-resume.js';
import { translateSdkMessage, newRuntimeState, type TurnState, type RuntimeState } from './translator.js';
import type { Effort, PermissionMode } from '../../types/common.js';
import type {
  ScanAtResourcesOptions,
  ScanAtResourcesResult,
  AgentBuiltinCommand,
  ListAgentSkillsOptions,
  ListAgentSkillsResult,
} from '../../types/palette.js';
import { CLAUDE_CODE_AGENT_COMMANDS } from './commands.js';
import type {
  ListCustomizationsOptions,
  ListCustomizationsResult,
} from '../../types/customizations.js';
import type {
  MemoryStatus,
  MemorySetResult,
  MemoryResetResult,
} from '../../types/memory.js';
import type { McpProviderContext } from '../../interfaces/mcp-provider.js';
import { scanClaudeCustomizations } from './customization-scanner.js';

type ClaudeSdkEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * 公开短 ID → Claude SDK 实际接受的字符串。
 * SDK 需要 [1m] beta 通道后缀，这是 SDK 细节，不外泄给调用方。
 *
 * haiku 不再重写成日期快照 id:目录短 id(claude-haiku-4-5)就是 Anthropic 官方别名,
 * 上游(订阅直连 / 网关)均接受;带版本号的别名不存在跨代漂移,同号新快照跟随即可。
 *
 * [1m] 后缀的唯一决策依据是目录(providers.json)的 contextWindow:
 *   - 窗口已知且 ≥1M → 带 [1m];已知且 <1M → 绝不带(已带的强制剥掉)。
 *     窗口 <1M 却带 [1m] 会让 cc-code 的 has1mContext 把窗口判成 1M,撑大
 *     auto-compact 阈值 → 对话冲过上游真实上限后空转,会话"假死"(折扣 GPT 实踩)。
 *     真实窗口口径已由 catalog 经 env-builder(XDT_MAKER_MODEL_CONTEXT_WINDOWS,
 *     id 与 id[1m] 双键)注入 cc,[1m] 不再承担窗口语义,只是 wire 串的一部分。
 *   - 窗口未知(目录外模型 / 未传窗口的老调用方)→ 回落下方硬编码映射链,行为不变。
 *     这样"新增模型要不要 [1m]"只改 OSS 目录即可,不必发版。
 *
 * 一律走显式版本号,不要用 'opus' / 'sonnet' 这类别名:
 * cc-code 二进制升级后别名指针会漂移到下一代模型(例如 'opus' 从 4.6 跳到 4.7),
 * 导致调用方明明选了 4.6 却实际命中 4.7,且只有"上一代"模型踩这个坑。
 */
export function toSdkModelString(model: string, contextWindow?: number | null): string {
  if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
    const bare = model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model;
    return contextWindow >= 1_000_000 ? `${bare}[1m]` : bare;
  }
  return legacyToSdkModelString(model);
}

/** 目录窗口未知时的兜底映射链(与窗口规则引入前一致;haiku 日期重写已移除,见函数头)。 */
function legacyToSdkModelString(model: string): string {
  if (model === 'claude-opus-5') return 'claude-opus-5[1m]';
  if (model.includes('opus-4-8')) return 'claude-opus-4-8[1m]';
  if (model.includes('opus-4-7')) return 'claude-opus-4-7[1m]';
  if (model.includes('opus-4-6')) return 'claude-opus-4-6[1m]';
  // fable-5 比照 Opus 走 1M beta 通道; 显式版本号, 不用别名。
  if (model === 'claude-fable-5') return 'claude-fable-5[1m]';
  // sonnet 同样必须显式版本号:曾经的裸 'sonnet[1m]' 在 Sonnet 5 上线后仍被二进制
  // 解析成 claude-sonnet-4-6,用户选 Sonnet 5 实际命中 4.6(2026-07 实踩)。
  // 目录内 sonnet 系列均为 1M 窗口(catalog providers.json),统一走 [1m] beta 通道。
  if (model === 'claude-sonnet-5') return 'claude-sonnet-5[1m]';
  if (model === 'claude-sonnet-4-6') return 'claude-sonnet-4-6[1m]';
  // 兜底:未来新增 sonnet 型号在此映射更新前,也透传显式 id 而非裸别名。
  if (model.includes('sonnet')) return `${model}[1m]`;
  // 官方 gpt-5.5 / gpt-5.4 真实支持 1M, 走 [1m] beta 通道。
  if (model === 'gpt-5.5' || model === 'gpt-5.4') return `${model}[1m]`;
  // 折扣GPT(codex/* 经折扣网关)真实上下文上限远低于 1M(catalog cc 侧 = 272k),
  // 绝不能带 [1m]: cc-code 的 has1mContext 只要在 model 串里见到 [1m] 就把窗口判成 1M
  // (getContextWindowForModel 直接 return 1_000_000), 撑大 auto-compact 阈值 →
  // 对话冲过折扣网关真实上限(~24 万 token)后空转, 用户侧表现为会话"假死"。
  // 路由不依赖 [1m]: isAnthropicWireModel 只按 claude-/sonnet/opus/haiku/fable 前缀判定,
  // codex/ 前缀始终走 provider 网关、不命中 Anthropic wire, 去掉 [1m] 不改变路由判定;
  // 真实窗口由 catalog 经 translator 窗口口径注入(=272k)。
  if (model === 'codex/gpt-5.5' || model === 'codex/gpt-5.4') return model;
  if (model === 'codex/gpt-5.6-sol' || model === 'codex/gpt-5.6-terra') return model;
  // DeepSeek 的 [1m] 是历史兼容路由后缀; 上下文大小另走 maker capabilities。
  if (model === 'deepseek/deepseek-v4-pro' || model === 'deepseek/deepseek-v4-flash') return `${model}[1m]`;
  if (model === 'z-ai/glm-5.2') return `${model}[1m]`;
  return model;
}

/**
 * ToolLoopGuard 必须基于 maker-core 对外暴露的 model id 判断。
 * SDK 字符串会被 toSdkModelString 改写(例如 Sonnet 5 变成 claude-sonnet-5[1m]),
 * 容易把 provider 细节和公开模型选择混在一起; host 注入的 DeepSeek id
 * 当前为 deepseek/deepseek-v4-pro 与 deepseek/deepseek-v4-flash。
 */
function isDeepSeekModel(model: string): boolean {
  return model.startsWith('deepseek/');
}

function isProviderRoutedModel(model: string): boolean {
  return !model.startsWith('claude-');
}

/** URL → host(路由决策日志用,失败返回 undefined,不抛)。 */
function hostOfUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * 已知的 Claude 内置只读工具白名单(纯读、无本地写 / 无命令执行 / 无外部发送副作用)。
 *
 * 仅用于 canUseTool 在**没有** interactionResolver 这一异常分支下做 fail-closed 判定:
 * 命中白名单才放行, 其它工具(含未知工具、写文件 / 跑命令 / MCP 外发类)一律 deny。
 * 用**白名单**而非黑名单是刻意的安全设计 —— 未知 / 未来新增的工具默认落到 deny,
 * 不会因为"忘记把新危险工具登记进黑名单"而退回 fail-open。
 *
 * 注意边界: 这只影响 resolver 缺失(misconfiguration / 裸 handle 直用)时的**运行时准入**,
 * 不改变正常流程下送进模型的工具定义 / 可用性声明, 也不参与 system prompt 组装。
 * WebFetch / WebSearch 虽只读但会发起外部网络请求, 保守起见不列入白名单(缺 resolver 时 deny)。
 */
const READ_ONLY_CLAUDE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
]);

/** canUseTool fail-closed 分支用: 判断工具是否属于已知只读工具(见上方白名单注释)。 */
function isReadOnlyClaudeTool(toolName: string): boolean {
  return READ_ONLY_CLAUDE_TOOLS.has(toolName);
}

/**
 * 把 maker-core 的 Effort clamp 到 Claude SDK 支持的档位 (ClaudeSdkEffort)。
 * Claude 没有 'minimal'(→ 'low') 与 'ultra'(→ 'max'; ultra 是 Codex GPT-5.6 专属档)。
 */
function isLoopbackEndpoint(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function clampEffortForClaude(e: Effort): ClaudeSdkEffort {
  if (e === 'minimal') return 'low';
  if (e === 'ultra') return 'max';
  return e;
}

function isUnsupportedClaudeEffortError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    /effort(?:Level|[ _-]level)/i.test(message) &&
    /\b(?:invalid|unsupported|not supported|unknown|unrecognized)\b/i.test(message)
  );
}

async function applyClaudeEffortFlagSettings(
  q: Query,
  effort: ClaudeSdkEffort,
  maxFallback: Exclude<ClaudeSdkEffort, 'max'>,
): Promise<ClaudeSdkEffort> {
  // Claude Code 2.1.219 accepts session-scoped `max` through apply_flag_settings.
  // Only an explicit effort-level rejection is compatibility evidence; transport
  // and process failures must keep their original failure semantics.
  try {
    await q.applyFlagSettings({ effortLevel: effort } as Settings);
    return effort;
  } catch (error) {
    if (effort !== 'max' || !isUnsupportedClaudeEffortError(error)) throw error;
    await q.applyFlagSettings({ effortLevel: maxFallback } as Settings);
    return maxFallback;
  }
}

function rawMentionText(block: { path: string; kind?: 'file' | 'dir' | 'agent' }): string {
  const suffix = block.kind === 'dir' && !block.path.endsWith('/') ? '/' : '';
  return `@${block.path}${suffix}`;
}

function quotedMentionText(block: { path: string; kind?: 'file' | 'dir' | 'agent' }): string {
  const suffix = block.kind === 'dir' && !block.path.endsWith('/') ? '/' : '';
  return `@"${(block.path + suffix).replace(/"/g, '\\"')}"`;
}

function hasMentionText(existingText: string, block: { path: string; kind?: 'file' | 'dir' | 'agent' }): boolean {
  return existingText.includes(rawMentionText(block)) || existingText.includes(quotedMentionText(block));
}

/**
 * 把 maker-core 的 UserMessage content 装配成 Claude SDK 接受的形式。
 *
 * Async 而非 sync —— image block 的 absPath 会先经过 image-resizer 透明替换为
 * 缩好的缓存副本路径(命中走缓存近乎 0ms, miss 后台 sharp 处理 ~200-500ms),
 * 再以 @"resizedAbsPath" 形态注入到 prefix。Claude SDK 后续读 mention 引用的
 * 就是缩好的文件, 显著节省 vision token。
 *
 * 失败 (sharp 不可用 / 文件不存在 / GIF / 超时) 安全降级回原 path, 不阻塞 send。
 */
export async function toClaudeSdkContent(
  content: UserMessage['content'],
): Promise<string | Array<{ type: string; [k: string]: unknown }>> {
  if (typeof content === 'string') return content;

  const textParts = content
    .filter((b) => b.type === 'text')
    .map((b) => b.text);
  const existingText = textParts.join('\n');
  const refs: string[] = [];

  // 先把所有 image block 的 path 收集出来批量 resize (并发由 resizer 内部 semaphore 控)。
  // 同 turn 多张图能并发处理, 不需要在这里串行 await。
  const resizer = getDefaultImageResizer();
  const imagePathPromises = new Map<number, Promise<string>>();
  content.forEach((block, idx) => {
    if (block.type === 'image') {
      imagePathPromises.set(idx, resizer.process(block.path));
    }
  });
  const resizedPaths = new Map<number, string>();
  for (const [idx, p] of imagePathPromises) {
    resizedPaths.set(idx, await p);
  }

  content.forEach((block, idx) => {
    if (block.type !== 'image' && block.type !== 'file' && block.type !== 'mention') return;
    let mentionBlock: { path: string; kind?: 'file' | 'dir' | 'agent' };
    if (block.type === 'mention') {
      mentionBlock = { path: block.path, kind: block.kind };
    } else if (block.type === 'image') {
      mentionBlock = { path: resizedPaths.get(idx) ?? block.path, kind: 'file' as const };
    } else {
      mentionBlock = { path: block.path, kind: 'file' as const };
    }
    if (!hasMentionText(existingText, mentionBlock)) {
      refs.push(quotedMentionText(mentionBlock));
    }
  });

  const prefix = refs.length > 0 ? `${refs.join(' ')} ` : '';
  const text = `${prefix}${textParts.join('\n')}`.trim();
  return text || prefix.trim();
}

function userMessageTextForCapabilityRouting(content: UserMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n');
}

function isUserSettingsMcpScope(scope: unknown): boolean {
  return scope === 'user' || scope === 'project' || scope === 'local';
}

/**
 * Anthropic Messages SDK 错误 → OneShotError 分类映射。
 * 参考自 apps/desktop/src/main/skillReview/claudeSdkReviewer.ts:mapApiError,
 * 收敛到 maker-core 后,所有 oneShot 调用方都按统一 reason 接错。
 */
/**
 * upstream-response-idle watchdog 阈值 — maker 侧端到端"最后一道兜底", 默认 30min
 * (1_800_000ms), 通过 env XDT_CC_SSE_IDLE_TIMEOUT_MS (毫秒, 历史命名沿用) 覆盖;
 * 设为 0 关闭。
 *
 * **分层 (2026-05 起)**: 上游网络层断流 (SSE 流中途静默) 现已交给 cc-code 子进程
 * 内置的原生 inactivity watchdog 透明自愈 —— 由 env-builder 注入
 * CLAUDE_ENABLE_STREAM_WATCHDOG=true (300s 无 chunk → 降级非流式) +
 * API_TIMEOUT_MS=900000 (兜底非流式 fallback 请求), cc 内部 withRetry 在同一个
 * SDK query 里恢复, 对 maker 完全无感, 不再中断 turn / 不再提示用户。
 * (详见 env-builder.ts buildClaudeEnv 与 cc-code claude.ts:1874/2310/2470)
 *
 * 因此 maker 这层 watchdog **退居二线**, 只兜 cc-code 结构上抓不到的场景:
 * cc 的 watchdog 活在子进程内、盯的是自己那条 HTTP socket; 若是**非网络层卡死**
 * (cc 子进程自身死锁 / SDK↔子进程 stdio 传输管道 wedge —— 整个子进程对 maker
 * 哑火), 只有活在外面的 maker 能发现。30min 阈值刻意设在 cc 恢复预算
 * (300s watchdog + 900s fallback ≈ 最多 20min) 之上, 保证正常自愈永远先发生、
 * 不被 maker 抢跑; 只有真的 30min 零进展才触发。
 *
 * **计时语义** (不变): 一次 turn 是 N 次上游 API 请求被工具调用隔开的。watchdog
 * 只在"客户端把 ball 交给上游、等上游回话"期间计时:
 *  - assistant message 含 tool_use → 客户端执行工具, 上游已交还 ball, 停 timer
 *  - tool_result 提交、pending 工具全部配对完 → ball 又交回上游, 立即起 timer
 *  - 期间 stream_event / assistant text → reset timer
 * 这避免 Bash 长 build / MCP 拉大表 / 子 agent / AskUserQuestion 发呆等本地操作
 * 被误伤 (这些场景 SDK 不发新 API 请求, 不算 idle 配额)。
 *
 * 历史背景: 无 watchdog 时上游 SSE 挂死实测可挂 57 分钟+
 * 旧默认 300s 现已下沉到 cc-code 原生 watchdog 承担。
 *
 * 触发后走 q.interrupt() (与用户手动 stop 同路径), 而不是 abortController.abort()
 * —— 后者会让整个 SDK Query 进黑洞 session, 后续 send 全部失败 (见 handle.abort)。
 */
function parseIdleTimeoutMs(raw: string | undefined): number {
  const DEFAULT = 1_800_000;
  if (raw === undefined || raw === '') return DEFAULT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT;
  return Math.floor(n);
}

/** upstream-response-idle 看门狗的计时分片长度(见 armUpstreamResponseIdleSlice)。 */
const CC_UPSTREAM_IDLE_SLICE_MS = 60_000;

/** 分片实际耗时超出片长这么多 → 判为进程被系统挂起过,该片不计入额度。 */
const CC_UPSTREAM_IDLE_SUSPEND_GAP_MS = 30_000;


function mapAnthropicError(err: unknown): OneShotError {
  if (err instanceof APIError) {
    if (err.status === 401 || err.status === 403) {
      return new OneShotError('auth', `Anthropic ${err.status}: ${err.message}`);
    }
    if (err.status === 408 || err.status === 504) {
      return new OneShotError('timeout', `Anthropic ${err.status}: ${err.message}`);
    }
    return new OneShotError('network', `Anthropic ${err.status}: ${err.message}`);
  }
  const msg = err instanceof Error ? err.message : String(err);
  if (
    msg.includes('fetch') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ENOTFOUND') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('network')
  ) {
    return new OneShotError('network', msg);
  }
  return new OneShotError('malformed', msg);
}

function isInvalidCompactPreservedSegmentForkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('invalid compact preservedSegment reference');
}

/**
 * 会持续调模型的后台任务类型(SDK task_started.task_type),用户 Stop 时需要
 * 连带 stopTask 的白名单 —— 与 renderer makerChatStore 的 WAKE_AGENT_TASK_TYPES
 * 折算口径保持一致。刻意排除:local_bash(不调模型,dev server 等长驻进程不能
 * 被 Stop 误杀)、remote_agent(云端生命周期不受本进程控制)、未知类型(宁可
 * 少停不误停,启发式后台活动检测兜底)。
 */
const WAKE_BACKGROUND_TASK_TYPES: ReadonlySet<string> = new Set(['local_agent', 'local_workflow']);

// ── 能力声明 ──────────────────────────────────────────────────────────────────

// 模型清单 SSoT 已迁至目录 packages/model-providers/catalog/providers.json。
// availableModels 起始为空,由 host 从 BUNDLED_CATALOG 派生后经 capabilityAdditions 注入
// (见 apps/desktop/src/main/maker-host/catalog-to-descriptors.ts)。

const CLAUDE_EFFORTS: EffortDescriptor[] = [
  { id: 'low',    displayName: 'Low',        description: 'Most efficient, with lower token use' },
  { id: 'medium', displayName: 'Medium',     description: 'Balanced capability and token use' },
  { id: 'high',   displayName: 'High',       description: 'High capability for complex work' },
  { id: 'xhigh',  displayName: 'Extra High', description: 'Extended capability for long-horizon work' },
  { id: 'max',    displayName: 'Max',        description: 'Maximum capability with unconstrained token use' },
];

// 注: plan 不再作为权限档暴露 —— 计划模式已独立成 Capabilities.planMode 一级开关
/**
 * Anthropic 模型清单动态发现的 host 捕获回调(2026-07-19 模型列表统一重构)。
 * host(apps/desktop maker-host/model-discovery/anthropic)注入监听器,agent 在
 * 每次会话首个 Query 建立后 fire-and-forget 调 SDK `supportedModels()` 上报。
 * 纯附加能力:不阻塞 send / 不进事件热路径 / 不改 prompt 组装(缓存前缀零影响);
 * 失败静默(发现通道有 HTTP + 磁盘缓存互补,见 host 侧)。
 */
let supportedModelsListener: ((models: unknown[]) => void) | null = null;

/** host 注入 SDK supportedModels 捕获回调;传 null 解除。 */
export function setClaudeSupportedModelsListener(
  listener: ((models: unknown[]) => void) | null,
): void {
  supportedModelsListener = listener;
}

/** fire-and-forget 捕获(远端 RemoteQuery 无 supportedModels 方法时静默跳过)。 */
function notifySupportedModels(q: Query): void {
  if (!supportedModelsListener) return;
  const fn = (q as { supportedModels?: () => Promise<unknown[]> }).supportedModels;
  if (typeof fn !== 'function') return;
  void fn.call(q).then(
    (models) => {
      try {
        if (Array.isArray(models)) supportedModelsListener?.(models);
      } catch {
        /* listener 异常不得外溢成 unhandled rejection */
      }
    },
    () => {
      /* 捕获失败静默:发现是附加能力,不影响会话 */
    },
  );
}

// (与目标模式同级的 UI 入口), agent 内部仍用 SDK permissionMode='plan' 实现。
const CLAUDE_PERMISSION_MODES: PermissionModeDescriptor[] = [
  { id: 'ask',               displayName: 'Ask permissions',     description: 'Always ask before making changes' },
  { id: 'acceptEdits',       displayName: 'Auto accept edits',   description: 'Automatically accept all file edits' },
  { id: 'auto',              displayName: 'Auto',                description: 'Auto-approve safe in-workspace actions; ask before out-of-workspace or risky ones' },
  { id: 'bypassPermissions', displayName: 'Bypass permissions',  description: 'Accepts all permissions' },
];

const CAPABILITIES: Capabilities = {
  // Stage 2 B: runtime 切换接通 (Query.setModel / applyFlagSettings / setPermissionMode)
  switchModel: { supported: true },
  availableModels: [],
  // Fast 模式由 cc 二进制经 flag settings `fastMode` + beta 头 fast-mode-2026-02-01 落地
  // (官方 only / Opus only / firstParty / org 级开关由二进制自身把关)。这里只声明 agent
  // 具备该能力;实际可用还要叠 per-(provider, model) 的 supportsFastMode(目录,唯一真相)。
  hasFastMode: true,
  effort: { supported: true },
  effortLevels: CLAUDE_EFFORTS,
  reasoningDisplay: ['off', 'summarized', 'full'],
  permissionModes: CLAUDE_PERMISSION_MODES,
  setPermissionModeMidSession: { supported: true },
  turnPermissionPolicy: {
    supported: { supported: true },
    // Both modes can execute mutations without invoking canUseTool. Reject the
    // combination instead of presenting a false forced-confirmation promise.
    unsupportedPermissionModes: ['acceptEdits', 'bypassPermissions'],
  },
  // 计划模式一级开关: SDK plan mode + ExitPlanMode → plan_review 审批, 批准后自动退出
  planMode: { supported: true },
  multimodal: {
    text: { supported: true },
    image: { supported: true },
    file: { supported: true },
  },
  fork: { supported: true },
  rewind: { supported: true },
  abort: { supported: true },
  sameTurnSteer: { supported: true },
  memory: {
    supported: { supported: true },
    displayName: 'Auto Memory',
    description: '自动从对话中沉淀长期记忆并在后续对话中召回 (后台 auto-dream 一并联动)',
    stage: 'stable',
    defaultEnabled: true,
    resettable: true,
    // applyFlagSettings 是 per-Query, BaseAgent 不追踪 active sessions 主动 push;
    // 所以 setMemory 只更新 memoryOverride, 影响下次 buildQuery, 当前 live Query 不受影响
    setEnabledMidSession: {
      supported: false,
      reason: 'not-implemented',
      message: 'setMemory 影响下次 startSession; 当前 live session 需 close 重起才生效',
    },
  },
  // SDK 原生 additionalDirectories 字段, buildQuery turn-by-turn 装配 → 改完下一 turn
  // 立即生效, 真正的 hot-reload 体验。
  extraDirs: { supported: true },
};

// ── Agent 实现 ────────────────────────────────────────────────────────────────

export class ClaudeCodeAgent extends BaseAgent {
  readonly kind = 'claude-code' as const;
  readonly capabilities: Capabilities;

  constructor(deps: AgentDeps) {
    super(deps);
    this.capabilities = this.buildCapabilities(CAPABILITIES);
  }

  private sdkEffortForModel(model: string, effort: Effort): ClaudeSdkEffort | undefined {
    const descriptor = this.capabilities.availableModels.find((m) => m.id === model);
    if (descriptor && descriptor.efforts.length === 0) return undefined;
    return clampEffortForClaude(effort);
  }

  private sdkMaxEffortFallbackForModel(model: string): Exclude<ClaudeSdkEffort, 'max'> {
    const descriptor = this.capabilities.availableModels.find((m) => m.id === model);
    if (!descriptor) return 'xhigh';
    const supported = new Set(descriptor.efforts.map(clampEffortForClaude));
    for (const candidate of ['xhigh', 'high', 'medium', 'low'] as const) {
      if (supported.has(candidate)) return candidate;
    }
    return 'high';
  }

  /**
   * catalog id → SDK wire 串,[1m] 由目录 contextWindow 驱动(见 toSdkModelString)。
   * 模型不在 capabilities(目录外/host 未注入)时窗口传 undefined → 走 legacy 兜底链。
   */
  private sdkModelFor(model: string): string {
    const descriptor = this.capabilities.availableModels.find((m) => m.id === model);
    const window =
      descriptor && Number.isFinite(descriptor.contextWindow) && descriptor.contextWindow > 0
        ? descriptor.contextWindow
        : undefined;
    return toSdkModelString(model, window);
  }

  /**
   * 订阅 token 401 强刷 —— 本地 SDK getOAuthToken 回调与远端 onOAuthRefresh 共用。
   *
   * env.CLAUDE_CODE_OAUTH_TOKEN 是该会话持有 token 的**单一事实源**:作为失败基线传给
   * host(库已被后台预续期换代时直接返回库值,不再消耗一次轮换);拿到新 token 后原地
   * 写回 env —— rewind/fork/重连重建复用同一 env 引用,新子进程直接以最新 token spawn,
   * 不会拿旧 token 起跑立即 401 再白白强刷一枚好 token。失败返回 null(cc 侧 surface
   * 鉴权错误),绝不上抛。
   */
  private async refreshSubscriptionTokenInPlace(env: Record<string, string>): Promise<string | null> {
    try {
      const fresh = await this.deps.auth.getFreshSubscriptionToken!(env.CLAUDE_CODE_OAUTH_TOKEN);
      if (fresh) env.CLAUDE_CODE_OAUTH_TOKEN = fresh;
      return fresh ?? null;
    } catch (e) {
      this.deps.logger
        .child('claude-code/oauth-refresh')
        .warn('subscription token refresh failed; returning null (cc will surface auth error)', {
          error: e instanceof Error ? e.message : String(e),
        });
      return null;
    }
  }

  /**
   * Agent 内置 command —— ChatInput palette 'agent-builtin' 类目数据源。
   * 是硬编码白名单(见 ./commands.ts), 不从 SDK 自动派生。
   * 当前 live: /compact。
   */
  override listAgentCommands(): AgentBuiltinCommand[] {
    return CLAUDE_CODE_AGENT_COMMANDS;
  }

  /**
   * Skill 扫描 —— 走 scanClaudeSlashCommands (扫 ~/.claude/{commands,skills}),
   * 包装成新的 AgentSkillCommand 形状(kind='agent-skill')。
   */
  override async listAgentSkills(opts: ListAgentSkillsOptions): Promise<ListAgentSkillsResult> {
    const raw = await scanClaudeSlashCommands(opts.workingDir);
    return {
      skills: raw.map((c) => ({
        kind: 'agent-skill' as const,
        name: c.name,
        description: c.description,
        source: c.source,
        path: c.path,
        scope: c.scope,
        enabled: c.enabled,
      })),
    };
  }

  async scanAtResources(opts: ScanAtResourcesOptions): Promise<ScanAtResourcesResult> {
    return scanClaudeAtResources(opts.workingDir, opts.cap, opts.query);
  }

  /**
   * 扫 Claude Code 的 skill / command / agent 三类 customization。
   * scanClaudeSlashCommands 是这条 pipeline 的"过滤视图"(只取 skill+command, drop agent,
   * 按 name 去重), 二者共享 ~/.claude/{...} 扫盘事实, 但消费者不同。
   */
  async listCustomizations(opts: ListCustomizationsOptions): Promise<ListCustomizationsResult> {
    return scanClaudeCustomizations(opts);
  }

  /**
   * 一次性 LLM 调用 —— 直连 Anthropic Messages API (复用 host 端的 proxy URL + API key)。
   *
   * 历史: 之前走 sdkQuery + Claude Code binary 子进程, spawn 1-3s + 大段 preset
   * system prompt, 起标题 / skillReview 这种 "纯文本 → 文本" 的轻任务严重浪费。
   * skillReview 已先行迁移成直连 (apps/desktop/src/main/skillReview/claudeSdkReviewer.ts),
   * 实测快 3-10 倍; 这里把同款方式收敛到 maker-core, 让 skillReview 也改成调 maker.oneShot。
   *
   * 鉴权: Claude AuthAdapter 是纯 API key 模式 (auth-adapters.ts), getAuthEnv() 只放
   * ANTHROPIC_API_KEY, 没有 OAuth 路径 —— 直接抠出来用即可。
   *
   * baseURL: 复用 runtimeConfig.endpoint (host 已经配成网关 endpoint),
   * 跟 startSession 同一接入点; 不另外硬编码。
   *
   * 失败: 抛 OneShotError (reason: timeout/auth/network/malformed); 宽容调用方
   * (如起标题 IPC) 自己 try/catch 返空串, 不在 agent 里 swallow。
   */
  async oneShot(prompt: string, opts?: OneShotOptions): Promise<string> {
    const log = this.deps.logger.child('claude-code/oneShot');
    const model = opts?.model ?? 'claude-haiku-4-5';
    const maxTokens = opts?.maxTokens ?? 100;
    const timeoutMs = opts?.timeoutMs ?? 30_000;

    // Auth gate:与 startSession 对齐 — 未授权直接拒,不让 Anthropic 请求带空 key 跑出去
    // (避免被 fallback 到用户系统级 ~/.claude/.credentials.json 之类的别处 OAuth)
    const authState = await this.deps.auth.getState();
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'claude-code',
        `claude-code not authenticated: ${authState.errorReason ?? 'no_key'}`,
      );
    }
    // oneShot 凭证优先走 getOneShotAuth()(host 侧直连专用,与子进程 env 正交):
    // Claude 'oauth' 模式下 getAuthEnv() 注入的是用户订阅 token,但 oneShot 无 system prompt、
    // 不能走订阅(会被 claude.ai OAuth 策略拒),host 通过 getOneShotAuth 固定回 gateway key +
    // gateway endpoint。不实现该方法的 adapter(或回 null)→ 回退旧逻辑(getAuthEnv 里的 key + runtimeConfig.endpoint)。
    let apiKey: string | undefined;
    let baseURL = this.deps.runtimeConfig.endpoint;
    const oneShotAuth = this.deps.auth.getOneShotAuth
      ? await this.deps.auth.getOneShotAuth()
      : null;
    if (oneShotAuth?.apiKey) {
      apiKey = oneShotAuth.apiKey;
      if (oneShotAuth.baseURL) baseURL = oneShotAuth.baseURL;
    } else {
      const authEnv = await this.deps.auth.getAuthEnv();
      apiKey = authEnv.ANTHROPIC_API_KEY;
    }
    if (!apiKey) {
      throw new OneShotError('auth', 'no API key available for oneShot (getOneShotAuth / getAuthEnv both empty)');
    }

    // 自家超时 controller —— 跟外部 signal 合并 (任一触发都 abort)
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);
    const onExternalAbort = () => timeoutController.abort();
    opts?.signal?.addEventListener('abort', onExternalAbort);

    const startedAt = Date.now();
    try {
      const client = new Anthropic({
        apiKey,
        baseURL,
        // 自家有 timeoutMs, 不让 SDK 内部重试再叠一倍
        maxRetries: 0,
      });

      const resp = await client.messages.create(
        {
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
        },
        { signal: timeoutController.signal },
      );

      const text = resp.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      log.info('oneShot done', {
        model,
        elapsedMs: Date.now() - startedAt,
        inputTokens: resp.usage?.input_tokens,
        outputTokens: resp.usage?.output_tokens,
        chars: text.length,
      });

      if (!text) {
        throw new OneShotError('malformed', 'Empty response from model');
      }
      return text;
    } catch (err) {
      log.error('oneShot failed', {
        model,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        externalAborted: opts?.signal?.aborted ?? false,
        error: String(err),
      });
      if (err instanceof OneShotError) throw err;
      // 自家超时优先, 不依赖 SDK 抛 abort 类型
      if (timedOut) {
        throw new OneShotError('timeout', `oneShot timed out after ${timeoutMs}ms`);
      }
      // 外部 abort: 不归类成 OneShotError, 直接把原 error 抛回 (调用方按自己 signal 判取消)
      if (opts?.signal?.aborted) throw err;
      throw mapAnthropicError(err);
    } finally {
      clearTimeout(timeoutId);
      opts?.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async startSession(opts: StartSessionOptions): Promise<AgentSessionHandle> {
    // scope 带完整 s:<sessionId> 前缀 → host logger 落盘时提取 business sessionId,
    // 路由到 sessions/<id>/<date>.ndjson (logger.ts extractSessionId / sessionAgentSlot)。
    const sid = opts.sessionId ?? '';
    const log = this.deps.logger.child(sid ? `s:${sid}/claude-code` : 'claude-code');
    // 开 debug 时让每个 session 的 cc 子进程写到各自 session 目录的 raw 文件 (host 注入
    // resolveCcDebugFile 拼路径 + mkdir); 没注入则回退全局 XDT_CC_DEBUG_FILE。
    const ccDebugFile = process.env.XDT_CC_DEBUG_NET === '1'
      ? (this.deps.resolveCcDebugFile?.(opts.sessionId) ?? process.env.XDT_CC_DEBUG_FILE)
      : undefined;

    // Auth gate(对齐 codex/index.ts:572): 未授权 → 拒绝 spawn,不让 CC CLI 子进程
    // 在 ANTHROPIC_API_KEY 为空时启动 — 否则 CC 会按它内部的鉴权回退链去找
    // process.env 里其他字段(已被 boot strip 兜底) / `~/.claude/.credentials.json`
    // (用户单独装过 Claude Code 时存在),用上别人的 OAuth 通道 → 既泄漏隔离,也
    // 让用户莫名其妙"用上了不属于本 app 的 key"。
    // renderer 接到 AgentNotAuthenticatedError 后据 reason 引导用户补齐当前来源的鉴权。
    // 远端路由 materialization(必须先于凭证形态推导):本地按模型分流的逻辑活在 loopback
    // proxy,远端够不到,由 host 在 spawn 前把「该会话真实上游 + 鉴权 + 定制头」解析成 cc
    // env(见 base-agent.ts AgentDeps.resolveRemoteClaudeRoute)。
    //   - 返回 route:native OAuth 订阅 / 自定义 Claude Code 供应商 —— 下方覆盖 endpoint + 鉴权;
    //   - 返回 null / resolver 未注入(旧 host):有效路由是 XD 网关 —— credentialMode 必须
    //     回落 'gateway-key'(与升级前「远端恒用网关」逐字节一致)。不回落的话,getAuthEnv
    //     会按本地 fallback 注入订阅 token / provider 占位 key,与 buildClaudeEnv 写入的网关
    //     endpoint 并存:订阅 token 被发往网关(凭证泄漏)或网关收到占位 key(401)。
    //   - throw:显式选定的供应商在远端无法表达(自定义 requestPath / modelIdRewrite 等),
    //     透传报错,不静默错路由。
    const remoteRoute =
      opts.remoteHostId && this.deps.resolveRemoteClaudeRoute
        ? await this.deps.resolveRemoteClaudeRoute({
            providerId: opts.providerId,
            model: opts.model,
          })
        : null;
    // 凭证形态:本地按会话来源推导;远端仅在 materialize 出 route 时用来源形态(route.env
    // 是远端鉴权的唯一事实源,来源形态只影响 auth gate 与 behaviorFlags),网关路径(route
    // 为 null / 旧 host)维持「远端恒用网关 key」。
    const credentialMode =
      opts.remoteHostId && !remoteRoute
        ? 'gateway-key'
        : resolveAgentCredentialMode({
            agentKind: 'claude-code',
            providerId: opts.providerId,
            model: opts.model,
          });
    const authOptions = credentialMode ? { credentialMode } : undefined;
    const authState = await this.deps.auth.getState(authOptions);
    if (!authState.authenticated) {
      throw new AgentNotAuthenticatedError(
        'claude-code',
        `claude-code not authenticated: ${authState.errorReason ?? 'no_key'}`,
      );
    }
    const effectiveCredentialMode = resolveEffectiveCredentialModeFromAuthSource(
      credentialMode,
      authState.authSource,
    );

    // 箭头别名捕获 this —— 下方 replayRuntimeDrift(普通 function)与 handle 对象
    // 字面量方法里没有类实例 this,统一经它取 wire 串。
    const sdkModelFor = (model: string): string => this.sdkModelFor(model);
    const resolveRemoteClaudeRoute = this.deps.resolveRemoteClaudeRoute?.bind(this.deps);
    const getAuthEnv = this.deps.auth.getAuthEnv.bind(this.deps.auth);
    const sdkModel = sdkModelFor(opts.model);
    const initialSdkEffort = this.sdkEffortForModel(opts.model, opts.effort ?? 'high');
    const binaryPath = this.deps.binaryPath;
    const providerRoutedModels = this.capabilities.availableModels.filter((model) =>
      isProviderRoutedModel(model.id),
    );
    const env = await buildClaudeEnv(this.deps.auth, this.deps.runtimeConfig, {
      credentialMode,
      modelContextWindows: providerRoutedModels,
      // 先按「不设」建好 env(顺带删掉可能从 process.env 继承来的残留),真正的判定在下面
      // 拿到这份 env 之后做 —— 扫描需要 env 里的 CLAUDE_CONFIG_DIR 才能找对目录。
      subagentModel: null,
    });

    // 「Subagent 模型」设置的默认值语义(见 subagent-model-default.ts):
    // 平台的 CLAUDE_CODE_SUBAGENT_MODEL 是最高优先级**强制覆盖**,会静默盖掉用户手写
    // agent 的 `model:`。这里先扫一遍用户手写定义再决定:没人声明 model → 照旧设 env
    // (内置 agent 也吃到默认值);有人声明 → 不设 env,让那些声明生效。
    //
    // 必须放在 buildClaudeEnv **之后**:dev 多实例把 cc 的配置目录重定向到
    // `<userData>/claude-home`,而那个 CLAUDE_CONFIG_DIR 只存在于**子进程 env**里
    // (boot 期已从 process.env 剥离)。拿 process.env 去扫会扫到 `~/.claude/agents`,
    // 和 cc 实际读的目录不是同一个 → 判定失真,声明照旧被覆盖。
    //
    // 只在会话启动时解析一次 —— env 要在 spawn 前定好,会话中途变动 tools/system 会破坏
    // prompt 缓存(见 docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
    // 诊断只落日志与 host 回调,**不进模型上下文**(理由见 subagent-model-default.ts 模块头)。
    // 扫描失败(含触发 IO 预算)一律降级成「照旧设 env」= 本改动前的行为,绝不阻断会话启动。
    //
    // 候选默认值从路由感知入口取:子代理请求跑在父会话来源上,覆写在**该来源**下不可
    // 路由(被停用)时 host 返回 undefined = 不注入(PR #744 review 第十九/二十轮)。
    // 缺席 subagentModelForRoute 时退回静态 subagentModel(旧 host / CLI 行为不变)。
    const configuredSubagentDefault =
      (this.deps.runtimeConfig.subagentModelForRoute
        ? this.deps.runtimeConfig.subagentModelForRoute(opts.providerId ?? null, credentialMode)
        : this.deps.runtimeConfig.subagentModel
      )?.trim() || undefined;
    let subagentDefault: ResolveSubagentModelDefaultResult = {
      envSubagentModel: configuredSubagentDefault,
      diagnostics: [],
    };
    // 远端(SSH)会话**不做**本地扫描:opts.workingDir 是远端机器上的路径(本地不存在),
    // `~/.claude/agents` 也是本地用户的而非远端的 —— 拿本地结果去决定远端行为会误判
    // 「有没有人声明 model」。远端因此沿用既有 env 语义(设置值照旧强制覆盖),
    // 即上面 subagentDefault 的初值。
    if (!opts.remoteHostId) {
      try {
        const discovered = await discoverSubagentDefinitions({
          workingDir: opts.workingDir,
          // 子进程真正会用的那份 env —— CLAUDE_CONFIG_DIR 在里面。
          env,
        });
        subagentDefault = resolveSubagentModelDefault({
          configuredDefault: configuredSubagentDefault,
          discovered,
          // 校验 agent 声明的 model 是否真的可用 —— 清单就是 host 从目录派生的那份。
          availableModelIds: this.capabilities.availableModels.map((m) => m.id),
        });
        for (const d of subagentDefault.diagnostics) {
          log.warn('subagent model diagnostic', { ...d });
        }
        // 同步 throw 与 async reject 都在里面接住(host 可能传 async 回调)。
        reportSubagentModelDiagnostics(
          this.deps.runtimeConfig.onSubagentModelDiagnostics,
          subagentDefault.diagnostics,
        );
      } catch (e) {
        log.warn('discover subagent definitions failed; falling back to env override', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // 判定落到 env(唯一写入点,见 env-builder.applySubagentModelEnv)。
    applySubagentModelEnv(env, subagentDefault.envSubagentModel ?? null);
    // 远端单独一份 env:用 'remote' 模式从空字典起(不继承 desktop OS env),否则
    // Windows HOME=C:\Users\Lizi 之类污染远端 cc CLI 的 ~ 展开(session/memory
    // 落怪路径)。详见 env-builder.ts buildClaudeEnv 文档。
    const remoteEnv = opts.remoteHostId
      ? await buildClaudeEnv(this.deps.auth, this.deps.runtimeConfig, {
          credentialMode,
          mode: 'remote',
          modelContextWindows: providerRoutedModels,
          // 远端不做本地扫描(见上),这里的值就是路由感知后的设置值 —— 保持 env 强制覆盖语义。
          subagentModel: subagentDefault.envSubagentModel ?? null,
        })
      : null;
    // 远端 route 覆盖(route 解析见上方 credentialMode 前的 remoteRoute):
    // 先剥掉 buildClaudeEnv 经 getAuthEnv/endpoint 写入的鉴权/上游字段(订阅 token /
    // provider-oauth 占位 key / 网关 endpoint),再让 route.env 成为唯一事实源,避免两套
    // 鉴权字段并存。route 为 null 时 credentialMode 已回落 'gateway-key',remoteEnv 保持
    // buildClaudeEnv 写入的网关 key + 网关 endpoint(remoteEndpoint),不进本块。
    if (remoteEnv && remoteRoute) {
      for (const key of REMOTE_ROUTE_OVERRIDE_ENV_KEYS) delete remoteEnv[key];
      Object.assign(remoteEnv, remoteRoute.env);
      remoteEnv.ANTHROPIC_BASE_URL = remoteRoute.endpoint;
      // 订阅 token 续命回调的 entrypoint 闸门:route 覆盖后才出现 CLAUDE_CODE_OAUTH_TOKEN
      // 的场景(如显式 anthropic 的 oauth-bearer 形态,buildClaudeEnv 期不注入 token)
      // 需要在这里补跑一次;规则单源在 env-builder。
      applyOAuthSpawnEntrypointGate(remoteEnv);
    }
    // 远端路由决策日志(排障还原「为什么这个会话走网关/直连/自定义上游」)。只打安全
    // 字段:endpoint 只取 host,凭证形态与接线布尔量;绝不打 token / header 值。
    if (remoteEnv) {
      log.info('remote claude route decision', {
        remoteHostId: opts.remoteHostId,
        providerId: opts.providerId?.trim() || null,
        routeMaterialized: remoteRoute !== null,
        credentialMode: credentialMode ?? null,
        endpointHost: hostOfUrl(remoteEnv.ANTHROPIC_BASE_URL),
        oauthRefreshWired: Boolean(
          remoteEnv.CLAUDE_CODE_OAUTH_TOKEN && this.deps.auth.getFreshSubscriptionToken,
        ),
      });
    }
    const hostSystemPrompt = this.deps.runtimeConfig.systemPrompt;
    const ghostRosterPrompt = opts.remoteHostId
      ? ''
      : (this.deps.getGhostRosterPrompt?.({ workingDir: opts.workingDir }) ?? '');

    // mutable closure — setVendorOptions 在 handle 上对外暴露,**原地合并** patch。
    // 关键: 不能用 `vo = {...vo, ...patch}` 重赋值 — Claude SDK 在 startSession 时
    // 一次性 buildQuery + buildMcpServers, MCP server instance 里 tool handler 闭包
    // 捕获的是当时构造的 ctx 对象 (ctx.vendorOptions 指向这个 vo)。若重赋值 vo,
    // 旧 ctx.vendorOptions 仍指向旧对象, MCP 工具永远读到老值 → 表现为"toggle 关
    // 再开后 Lead 工具仍指向第一次的 workflow / worker"的 bug。必须用 Object.assign
    // 原地改, 让所有持有这个 ref 的闭包共享同一份最新状态。
    const vo: Record<string, unknown> = { ...(opts.vendorOptions ?? {}) };

    log.info('startSession', {
      model: sdkModel,
      providerId: opts.providerId ?? null,
      credentialMode: credentialMode ?? 'fallback',
      effort: opts.effort ?? 'default',
      sdkEffort: initialSdkEffort ?? '<none>',
      workDir: opts.workingDir,
      resume: opts.resumeSessionId ?? 'new',
      resumeSessionAt: (vo.resumeSessionAt as string | undefined) ?? 'none',
      forkSession: (vo.forkSession as boolean | undefined) ?? false,
      claudeCodePath: binaryPath ?? 'default',
      mcpProvidersCount: this.deps.mcpProviders?.length ?? 0,
      // 网络排查标记: 让海外用户第一眼能确认 endpoint 和 debug 开关状态
      endpoint: env.ANTHROPIC_BASE_URL ?? '<sdk-default>',
      debugNet: env.ANTHROPIC_LOG ? `on (ANTHROPIC_LOG=${env.ANTHROPIC_LOG})` : 'off',
    });

    // ── Maker Memory: 启动时预拉 MEMORY.md 索引 + 写入规范段 ────────────────
    // 跟 userPrompt 同语义 — 启动时快照, rewind 重启时仍用本快照, 跨 session 不实时同步。
    // 失败 (manager 没注入 / store init 抛错) 静默跳过, agent 仍能跑。
    let makerMemoryRules = '';
    let makerMemoryIndex = '';
    let memoryFlushController: MemoryFlushController | null = null;
    const getAutoCompactThresholdPct = (): number | undefined =>
      this.deps.runtimeConfig.autoCompactThresholdPct;
    const autoCompactController =
      getAutoCompactThresholdPct() === undefined
        ? null
        : new AutoCompactController({
            logger: log.child('auto-compact'),
            workdir: opts.workingDir,
            agentKind: 'claude-code',
            getThresholdPct: getAutoCompactThresholdPct,
          });
    // opts.makerMemoryEnabled 优先 (per-session, renderer 透传); fallback 到 runtimeConfig
    // (host 静态配置, 一般 undefined)。manager 没注入视为禁用。
    const makerMemoryFlag =
      opts.makerMemoryEnabled ?? this.deps.runtimeConfig.makerMemoryEnabled ?? false;
    const makerMemory = this.deps.makerMemory;
    const makerMemoryEnabled = makerMemoryFlag === true && !!makerMemory;
    // SSH remote 的 workingDir 是远端路径 — store 定位统一经 scope key,
    // 键规则与理由见 buildMemoryScopeKey (memory/storage.ts)。
    const memoryScopeKey = buildMemoryScopeKey(opts.workingDir, opts.remoteHostId);
    // This per-session injection flag must not mutate the shared manager.
    if (makerMemoryEnabled && makerMemory) {
      try {
        const store = await makerMemory.getStore(memoryScopeKey);
        makerMemoryRules = MAKER_MEMORY_RULES;
        makerMemoryIndex = await store.getIndex();
        memoryFlushController = new MemoryFlushController({
          logger: log.child('memory-flush'),
          workdir: memoryScopeKey,
          agentKind: 'claude-code',
        });
        log.debug('maker memory loaded for session', {
          rulesBytes: makerMemoryRules.length,
          indexBytes: makerMemoryIndex.length,
        });
      } catch (e) {
        log.warn('maker memory load failed at session start (skipping injection)', {
          error: String(e),
        });
      }
    }

    const mcpProviders = this.deps.mcpProviders ?? [];
    // host-owned 只读白名单在 session 启动时快照; 与 hooks / MCP 注册同样保持整条
    // 会话稳定, 避免中途改数组导致 CLI 权限规则与 prompt cache 前缀漂移。
    const claudeAllowedTools = this.deps.claudeAllowedTools?.length
      ? [...this.deps.claudeAllowedTools]
      : undefined;
    /**
     * 本 session 实际注册进 SDK 的 MCP server 名, 由 buildMcpServers 写入。
     * canUseTool 用它把 `mcp__<server>__<tool>` 归属到唯一 server; 空集合时
     * 一律解析失败 → MCP 策略不参与判定, 维持原权限链。
     */
    let registeredMcpServerNames: ReadonlySet<string> = new Set();
    let hostMcpServerNames: ReadonlySet<string> = new Set();
    let nonHarnessMcpServerNames: ReadonlySet<string> = new Set();
    const noteSdkInitMcpServerNames = (message: unknown): boolean => {
      if (!message || typeof message !== 'object') return false;
      const record = message as Record<string, unknown>;
      if (
        record.type !== 'system' ||
        record.subtype !== 'init' ||
        !Array.isArray(record.mcp_servers)
      ) {
        return false;
      }
      const finalNames = record.mcp_servers
        .map((server) => {
          if (!server || typeof server !== 'object') return undefined;
          const serverRecord = server as Record<string, unknown>;
          if (serverRecord.status !== 'connected') return undefined;
          const name = serverRecord.name;
          return typeof name === 'string' && name.length > 0 ? name : undefined;
        })
        .filter((name): name is string => name !== undefined);
      // The init payload is the SDK's authoritative post-settings registry.
      // Replace instead of unioning so a query rebuild cannot retain a server
      // removed from user/project/local settings and disable a guard forever.
      registeredMcpServerNames = new Set(finalNames);
      return true;
    };
    const refreshSdkMcpProvenance = async (currentQ: Query): Promise<void> => {
      const fallbackNames = new Set(hostMcpServerNames);
      const queryWithStatus = currentQ as Query & {
        mcpServerStatus?: () => Promise<Array<{
          name: string;
          status: string;
          scope?: string;
        }>>;
      };
      if (typeof queryWithStatus.mcpServerStatus !== 'function') {
        if (currentQ === q) nonHarnessMcpServerNames = fallbackNames;
        return;
      }
      try {
        const statuses = await queryWithStatus.mcpServerStatus();
        const connectedNonHarnessNames = new Set<string>();
        for (const server of statuses) {
          if (
            server.status === 'connected' &&
            typeof server.name === 'string' &&
            server.name.length > 0 &&
            (
              hostMcpServerNames.has(server.name) ||
              isUserSettingsMcpScope(server.scope)
            )
          ) {
            connectedNonHarnessNames.add(server.name);
          }
        }
        if (currentQ === q) nonHarnessMcpServerNames = connectedNonHarnessNames;
        return;
      } catch (error) {
        // Init names have no provenance. On status failure, preserve only
        // host-injected MCPs and keep settings/plugin routing fail-closed.
        log.warn('failed to read scoped MCP status for capability routing', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (currentQ === q) nonHarnessMcpServerNames = fallbackNames;
    };
    const buildMcpServers = (): Record<string, McpServerConfig> | undefined => {
      const providers = mcpProviders;
      if (providers.length === 0) {
        hostMcpServerNames = new Set();
        registeredMcpServerNames = hostMcpServerNames;
        nonHarnessMcpServerNames = hostMcpServerNames;
        return undefined;
      }
      const context: McpProviderContext = {
        agentKind: 'claude-code' as const,
        workingDir: opts.workingDir,
        vendorOptions: vo,
        // business sessionId 由 maker.createSession 通过 opts.sessionId 注入
        // (见 maker.ts: agent.startSession({...opts, sessionId: id}))。MCP server
        // 工厂闭包绑定此值, 控制类工具 (如 start_team / create_worker) 用它把回调路由
        // 到对应 session 的业务函数。host 直接调 startSession 而没透 sessionId
        // 时此处为 undefined, 工具按"无 session 绑定"语义处理。
        sessionId: opts.sessionId,
        mcpCallerKind: 'root',
        mcpCallerAttested: true,
        ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
        getSessionContext: () => context,
      };
      // null-prototype: server 名来自用户可控的自定义 MCP id, 而 id 正则允许下划线,
      // `__proto__` 是合法 id。用普通 `{}` 时 `out['__proto__'] = config` 命中的是原型
      // 访问器 —— 不产生自有属性(hasOwnProperty / Object.keys 都看不见, 去重与归属判定
      // 一起失效), 反而把这个 map 的原型换成了 config。null-prototype 让这类名字退化成
      // 普通字符串键。
      const out: Record<string, McpServerConfig> = Object.create(null);
      for (const provider of providers) {
        // cindy_memory: per-session flag 关 → 不注册; remote → in-process sdk 实例
        // 不可序列化, 这里跳过, 由 host 的 remoteCcQueryFactory 按同一 flag 以
        // http 形态经 bridge 注入 (见 cc-remote-mcp.ts)。
        if (provider.name === 'cindy_memory' && (!makerMemoryEnabled || opts.remoteHostId)) continue;
        if (provider.isEnabled && !provider.isEnabled(context)) continue;
        // 同名 provider 先注册者胜 —— host 把用户自定义 MCP **追加**在内置之后, 后写
        // 覆盖会让一个 id 取名 `cindy_browser` 的自定义远程端点顶替内置 server:
        // 既悄悄换掉了内置能力, 又让审批策略(只看 serverName)把第三方端点的所有工具
        // 当第一方静默放行。host 侧也拦了这类保留名, 这里是纵深防御。
        if (Object.prototype.hasOwnProperty.call(out, provider.name)) {
          log.warn('duplicate MCP server name; keeping the first registration', {
            serverName: provider.name,
          });
          continue;
        }
        const config = provider.toClaudeSdkConfig?.(context);
        if (!config) continue;
        out[provider.name] = config as McpServerConfig;
      }
      // canUseTool 只认这批真实注册过的 server 名, 不靠 `mcp__` 工具名切分猜归属
      // (见 resolveMcpToolTarget: 自定义 server id 可以含 `__`, 盲切会被冒名顶替)。
      hostMcpServerNames = new Set(Object.keys(out));
      registeredMcpServerNames = hostMcpServerNames;
      nonHarnessMcpServerNames = hostMcpServerNames;
      // 交回普通对象: SDK / RPC 序列化路径按普通对象处理(有的实现会调 obj.hasOwnProperty)。
      // spread 走 CreateDataProperty, 不触发 `__proto__` setter, 所以这一步是安全的。
      return Object.keys(out).length > 0 ? { ...out } : undefined;
    };

    // ── userMessageStream + permission callback 准备 ────────────────────────
    // 类型对齐 Claude Code streaming-input 协议: 必须有 message: {role, content}
    // 包装层(老链路 agentManager.ts:850-867 makeUserMessage 同结构)。
    // uuid 字段可选 — 调用方传 sendOpts.messageUuid 时注入, SDK 透传当作 file
    // checkpoint snapshot 的 messageId (cli.js:7086382), rewind preview 反查同款 uuid。
    type SdkUserInput = {
      type: 'user';
      message: { role: 'user'; content: string | Array<{ type: string; [k: string]: unknown }> };
      parent_tool_use_id: null;
      uuid?: string;
    };
    // mutable 引用 — rewind 重启时整个换一份新的:
    //   - 老 abortController 在 q.close() 时被 SDK 标记为 aborted (虽然我们没显式调
    //     .abort(), 但 close() 内部会让信号变 aborted 状态), 复用它启动新 sdkQuery 会
    //     立刻被识别为 aborted → forward loop 抛 "aborted by user"。
    //   - 老 inputQueue 的 generator 在 q.close 后仍可能挂在 await waiter, 重建避免
    //     新 sdkQuery 跟老 generator 抢 push 进来的消息 (createAsyncQueue 是
    //     单消费者设计, 多 generator 会分摊事件)。
    // handle.send / abort / close 都通过 closure 引用最新的实例。
    let inputQueue = createAsyncQueue<SdkUserInput>();
    let abortController = new AbortController();
    let interactionResolver: InteractionResolver | null = null;
    // Keep the policy across Claude task_notification auto-continue turns,
    // which do not call handle.send again. The next explicit send replaces it.
    let activeTurnPermissionPolicy: TurnPermissionPolicy | null = null;
    let activeCapabilitySelectionText = '';
    const appendActiveCapabilitySelectionText = (text: string | undefined): void => {
      if (!text) return;
      activeCapabilitySelectionText = [activeCapabilitySelectionText, text]
        .filter(Boolean)
        .join('\n');
    };
    const turnChangeCaptureHook: HookCallback = async (input) => {
      const captureCwd = opts.workingDir;
      const captureSessionId = opts.sessionId;
      if (!this.deps.turnChangeCapture || !captureCwd || !captureSessionId) {
        return { continue: true };
      }
      if (input.hook_event_name === 'PreToolUse') {
        const pre = input as PreToolUseHookInput;
        const toolInput = pre.tool_input as Record<string, unknown> | undefined;
        const targetPath = ['file_path', 'path', 'notebook_path']
          .map((key) => toolInput?.[key])
          .find((value): value is string => typeof value === 'string' && value.length > 0);
        if (targetPath && ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(pre.tool_name)) {
          await this.deps.turnChangeCapture.beforeKnownFileWrite({
            sessionId: captureSessionId,
            provider: 'claude-code',
            cwd: captureCwd,
            targetPath,
            ...(opts.remoteHostId ? { remote: true } : {}),
          });
        }
      } else if (
        input.hook_event_name === 'PostToolUse'
        || input.hook_event_name === 'PostToolUseFailure'
      ) {
        const toolName = (input as { tool_name?: unknown }).tool_name;
        if (typeof toolName !== 'string' || (toolName !== 'Bash' && !toolName.startsWith('mcp__'))) {
          return { continue: true };
        }
        this.deps.turnChangeCapture.noteOpaqueWrite({
          sessionId: captureSessionId,
          provider: 'claude-code',
          cwd: captureCwd,
          ...(opts.remoteHostId ? { remote: true } : {}),
        });
      }
      return { continue: true };
    };
    const localClaudeHooks = mergeClaudeHookSets(
      buildClaudeLocalToolGuardHooks(
        this.deps.capabilityRouting,
        () => activeCapabilitySelectionText,
        (toolName, route) => {
          log.warn('downstream MCP source denied by host PreToolUse route', {
            toolName,
            capabilityId: route.capabilityId,
            replacement: route.replacement?.id,
          });
        },
        () => nonHarnessMcpServerNames,
      ),
      {
        PreToolUse: [{ hooks: [turnChangeCaptureHook] }],
        PostToolUse: [{ hooks: [turnChangeCaptureHook] }],
        PostToolUseFailure: [{ hooks: [turnChangeCaptureHook] }],
      },
      // Keep the existing local routing/capture hooks first: callers and tests
      // rely on their observable order. The exact-match Orca provenance guard
      // still runs for send_to_lead after those hooks and denies descendants.
      buildClaudeOrcaCallerProvenanceHooks(),
      this.deps.claudeHooks,
    );
    const deniedCapabilityRoute = (toolName: string) => {
      const route = findClaudeMcpCapabilityRoute(
        this.deps.capabilityRouting,
        toolName,
        nonHarnessMcpServerNames,
      );
      return route &&
        !isCapabilityRouteInvocationAllowed(route, activeCapabilitySelectionText)
        ? route
        : undefined;
    };
    const forceTurnConfirmation = (toolName: string, input: unknown): boolean => {
      const policy = activeTurnPermissionPolicy;
      if (!policy) return false;
      try {
        return policy.forceConfirmToolCall(toolName, input) === true;
      } catch (error) {
        // A safety classifier failure cannot become an approval bypass.
        log.error('turn permission policy threw -> force confirmation', {
          toolName,
          origin: policy.origin,
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
    };
    // 事件队列预先声明 —— canUseTool 路径要 push interaction_dismissed 事件
    const eventQueue = createAsyncQueue<AgentEvent>();
    // Cancellation closes a provider continuation with a queued terminal done.
    // Keep the handle busy until the single Session consumer has processed that
    // exact event, otherwise a new send can enter ahead of the queued boundary.
    const continuationTerminalBoundaryEvents = new WeakSet<AgentEvent>();
    let pendingContinuationTerminalBoundaries = 0;

    // ── Pending interaction 跟踪 ───────────────────────────────────────────
    // setPermissionMode 切换 / close session 时, 用此 Map 找到所有挂着的 interaction
    // 强制 resolve 它们 + emit interaction_dismissed, 以便 UI 关闭对话框。
    type PendingEntry = {
      kind: InteractionRequest['kind'];
      resolve: (d: InteractionDecision) => void;
      settled: boolean;
      /** prompt-each-time 高风险审批: 切到宽松模式时也不接受 dismissAllPending('allow')。 */
      forcePrompt?: boolean;
    };
    const pendingInteractions = new Map<string, PendingEntry>();

    function safeDefaultDecision(kind: InteractionRequest['kind'], reason: string): InteractionDecision {
      if (kind === 'ask_user_question') return { kind: 'ask_user_question', answers: {} };
      return { kind, behavior: 'deny', reason } as InteractionDecision;
    }

    /**
     * 把 InteractionRequest 派发给 host resolver, 同时登记进 pendingInteractions。
     * 任一时刻可由 dismissAllPending 强制提前 resolve(走 settled flag 防止 host 后续回调
     * 又 resolve 一次)。
     */
    async function dispatchInteraction(
      req: InteractionRequest,
      opts?: { forcePrompt?: boolean },
    ): Promise<InteractionDecision> {
      if (!interactionResolver) {
        return safeDefaultDecision(req.kind, 'no_resolver_attached');
      }
      const resolver = interactionResolver;
      return new Promise<InteractionDecision>((resolve) => {
        const entry: PendingEntry = {
          kind: req.kind,
          resolve,
          settled: false,
          ...(opts?.forcePrompt ? { forcePrompt: true } : {}),
        };
        pendingInteractions.set(req.requestId, entry);
        const finalize = (d: InteractionDecision) => {
          if (entry.settled) return;
          entry.settled = true;
          pendingInteractions.delete(req.requestId);
          resolve(d);
        };
        resolver(req)
          .then(finalize)
          .catch((e) => {
            log.warn('interaction resolver threw', { kind: req.kind, requestId: req.requestId, error: String(e) });
            finalize(safeDefaultDecision(req.kind, 'resolver_threw'));
          });
      });
    }

    /**
     * 强制 resolve 所有 pending interaction + emit dismissed 事件。
     * 用于 setPermissionMode 切换(Phase B)/ close session。resolveAs 决定剩余 pending 怎么处理:
     * - 'allow' 用于切到 bypassPermissions 时, ask 类自动放过
     * - 'deny' 用于切到更严的 mode / 关闭时
     */
    function dismissAllPending(reason: string, resolveAs: 'allow' | 'deny'): void {
      if (pendingInteractions.size === 0) return;
      const entries = Array.from(pendingInteractions.entries());
      for (const [requestId, entry] of entries) {
        if (entry.settled) continue;
        // forcePrompt(prompt-each-time 高风险审批)不接受"切到宽松模式"的批量放行 ——
        // 没拿到用户对这一次调用的明确确认就 fail-closed 拒绝, 与 Codex 侧同名逻辑
        // 一致。否则用户在 pending 期间切到 auto / bypassPermissions, 一个破坏性的
        // contacts 调用就被自动 allow 了。
        const effectiveResolveAs: 'allow' | 'deny' =
          resolveAs === 'allow' && entry.forcePrompt === true ? 'deny' : resolveAs;
        const decision = effectiveResolveAs === 'allow' && entry.kind !== 'ask_user_question'
          ? ({ kind: entry.kind, behavior: 'allow' } as InteractionDecision)
          : safeDefaultDecision(entry.kind, reason);
        entry.settled = true;
        pendingInteractions.delete(requestId);
        entry.resolve(decision);
        const dismissedPayload: InteractionDismissedEvent = {
          requestId,
          reason,
          resolvedAs: effectiveResolveAs,
        };
        eventQueue.push({ type: 'interaction_dismissed', data: dismissedPayload, source: 'claude-code' });
      }
    }

    function dismissSinglePending(requestId: string, reason: string): void {
      const entry = pendingInteractions.get(requestId);
      if (!entry || entry.settled) return;
      entry.settled = true;
      pendingInteractions.delete(requestId);
      entry.resolve(safeDefaultDecision(entry.kind, reason));
      const resolvedAs = entry.kind === 'ask_user_question' ? 'allow' : 'deny';
      eventQueue.push({ type: 'interaction_dismissed', data: { requestId, reason, resolvedAs }, source: 'claude-code' });
    }

    /**
     * MCP 工具的 host 审批档位 —— 与 Codex 的 mcpServerElicitation 同一个
     * deps.getMcpToolApprovalPolicy 真源。两端共用后, 同一个第一方 MCP 不会出现
     * "Codex 静默执行 / Claude 每次调用都弹窗"的分叉(浏览器自动化这类高频 server
     * 一次调研能攒出上百个权限请求)。
     *   auto-approve      → 静默放行, 不打扰用户
     *   prompt-each-time  → 照常弹窗, 且全程禁止持久化授权(suggestion 不下发、
     *                       decision 带回来的 permissionUpdates 也丢弃、切到宽松
     *                       模式时 pending 请求 fail-closed)
     *   prompt / 未注入   → 完全维持原有权限链
     * 策略抛错或返回非法值时按最保守的 prompt-each-time 处理(与 Codex 侧一致)。
     *
     * 本地 canUseTool 与远端 onApprovalRequest 都走这里 —— 否则同一套 MCP 配置在
     * SSH 会话里又会退回"逐次弹窗 + 没有 forced prompt 保护"的老行为。
     *
     * **已知差异(bypassPermissions)**: 该档位下 SDK 直接跳过全部权限检查
     * (allowDangerouslySkipPermissions, 见 SDK PermissionMode 文档), canUseTool 根本
     * 不会被调用, 所以这里的 prompt-each-time 拦不住 Full access 会话 —— 那是该档位
     * 本身的语义("Accepts all permissions"), 不是本函数的兜底范围。Codex 侧的
     * forcePrompt 走自己的 approval 通道, 在 Full access 下仍会弹, 两端在这一档不等价。
     *
     * 抹平它的两条路都不便宜(结论来自 cc 2.1.219 的 cli.js 权限判定 `zd8`):
     *  - PreToolUse hook: hook 无条件执行(先于权限判定), 且 hook 返回 deny 会在 `zd8`
     *    首个分支直接阻断、不看 permissionMode —— 所以 hook 能在 Full access 下**拒绝**;
     *    但 hook 返回 ask 会落到正常权限管线, 而该管线在 bypass 下就是放行, 所以做不到
     *    Codex 那样的"仍然弹窗询问"。只能把高风险 action 变成硬拒绝, 用户在自己选了
     *    Full access 之后反而做不了这些操作, 体验上不可接受。
     *  - 让 Full access 停在可回调档(default) + canUseTool 里模拟放行普通工具: 能拿到
     *    真 parity, 但 Full access 的判定语义会整体改变(settings 的 deny 规则、沙箱网络
     *    等不经 canUseTool 的检查都会重新生效), 必须实机验证后才能上。
     * 因此本轮如实保留差异, 不做半吊子拦截。
     */
    const classifyMcpApprovalPolicy = (
      toolName: string,
      input: unknown,
    ): 'auto-approve' | 'prompt' | 'prompt-each-time' => {
      const target = resolveMcpToolTarget(toolName, registeredMcpServerNames);
      const classifier = this.deps.getMcpToolApprovalPolicy;
      if (!target || !classifier) return 'prompt';
      try {
        const policy = classifier({
          serverName: target.serverName,
          toolName: target.toolName,
          toolParams: input,
        });
        if (policy === 'auto-approve' || policy === 'prompt' || policy === 'prompt-each-time') {
          if (policy === 'auto-approve') {
            log.debug('mcp tool auto-approved by host policy', {
              serverName: target.serverName,
              toolName: target.toolName,
            });
          }
          return policy;
        }
        log.error('invalid MCP approval policy -> prompt each time', {
          serverName: target.serverName,
          policy,
        });
      } catch (error) {
        log.error('MCP approval policy threw -> prompt each time', {
          serverName: target.serverName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return 'prompt-each-time';
    };

    // canUseTool dispatcher —— 三路分支(参考 agentManager.ts:1054-1162):
    //  1. AskUserQuestion: 模型问问题, 转 ask_user_question kind, decision.answers 拼回 updatedInput
    //  2. ExitPlanMode:   plan 模式提交计划, 转 plan_review kind, decision.editedPlan 覆盖 plan
    //  3. 其他工具:        转 permission kind, allow/deny + 可选 updatedInput
    // 注: destructive guard(agentManager.ts:1054-1065)只在 feishuBot session 启用; chat 默认 OFF,
    // 本轮不在 maker-core 实现; 若未来需要按 session opt-in, 通过 vendorOptions 传入 guard 函数。
    const canUseTool: CanUseTool = async (toolName, input, options) => {
      // SDK 不保证 assistant message 先于 canUseTool yield, 冗余 add (Set 幂等),
      // 顺便覆盖 AskUserQuestion / ExitPlanMode 等用户交互期间不计 idle 配额。
      if (typeof options.toolUseID === 'string' && options.toolUseID.length > 0) {
        pendingToolIds.add(options.toolUseID);
        clearUpstreamResponseIdle();
      }

      // ── 1. AskUserQuestion 分支 ──
      if (toolName === 'AskUserQuestion') {
        const questions = (input as { questions?: AskUserQuestionItem[] }).questions;
        if (!questions || questions.length === 0) {
          return { behavior: 'allow', updatedInput: input };
        }
        const decision = await dispatchInteraction({
          kind: 'ask_user_question',
          requestId: options.toolUseID,
          questions,
        });
        if (decision.kind !== 'ask_user_question') {
          log.warn('AskUserQuestion got mismatched decision', { decKind: decision.kind });
          return { behavior: 'deny', message: 'resolver kind mismatch' };
        }
        // 澄清答案同样改变本轮授权范围(用户把范围从 src/ 收窄到 build/ 后,后续 `rm -rf src` 必须按
        // 澄清后的意图裁决)→ 并入有界 review intent 并清空决策缓存,否则 reviewer 仍按原含糊请求
        // 裁决、可能静默 allow(codex 报)。
        setAutoReviewIntent(composeAutoReviewIntentWithClarification(
          currentAutoReviewIntent,
          Object.entries(decision.answers ?? {}).map(([question, answer]) => ({ question, answer })),
        ));
        // 把用户回答拼回 SDK 让模型读 (老链路 agentManager.ts:1097-1106 把 answers 当 updatedInput.answers)
        return {
          behavior: 'allow',
          updatedInput: { ...(input as Record<string, unknown>), answers: decision.answers } as Record<string, unknown>,
        };
      }

      // ── 2. ExitPlanMode 分支 ──
      if (toolName === 'ExitPlanMode') {
        const planInput = input as { plan?: string; planFilePath?: string };
        const plan = typeof planInput.plan === 'string' ? planInput.plan : '';
        const planFilePath = typeof planInput.planFilePath === 'string' ? planInput.planFilePath : undefined;
        if (!plan.trim()) {
          // 空 plan 直接放过(老链路 agentManager.ts:1118-1120 同样处理)
          return { behavior: 'allow', updatedInput: input };
        }
        // 计划审批期间用户可能继续发消息(currentAutoReviewIntent 会被覆盖);实施阶段的审查意图
        // 必须是"发起计划时的原始请求 + 最终获批计划",不能掺进审批期间的内部跟进消息(codex 报)。
        const planRequestAutoReviewIntent = currentAutoReviewIntent;
        const decision = await dispatchInteraction({
          kind: 'plan_review',
          requestId: options.toolUseID,
          plan,
          planFilePath,
        });
        if (decision.kind !== 'plan_review') {
          log.warn('ExitPlanMode got mismatched decision', { decKind: decision.kind });
          return { behavior: 'deny', message: 'resolver kind mismatch' };
        }
        if (decision.behavior === 'deny') {
          if (!decision.dismissed) {
            appendActiveCapabilitySelectionText(decision.reason);
          }
          return { behavior: 'deny', message: decision.reason ?? 'plan rejected by user' };
        }
        appendActiveCapabilitySelectionText(
          capabilitySelectionAddedByPlanEdit(
            this.deps.capabilityRouting,
            'claude-code',
            plan,
            decision.editedPlan,
          ),
        );
        // 计划批准 → 本轮 plan 循环结束: SDK 切回底层权限档。武装态正常已在 send
        // 消耗(plan_mode_changed 已广播), 这里兜底处理"未经 send 直接批准"的路径。
        // 不能在 canUseTool 里 await SDK 控制请求(SDK 正等本回调返回),
        // fire-and-forget 即可 —— CLI 在 ExitPlanMode 批准后本来就会离开 plan mode,
        // 这里只是把落点确定性地钉在用户所选档位。
        if (mutablePlanMode || planTurnActive) {
          planTurnActive = false;
          if (mutablePlanMode) {
            mutablePlanMode = false;
            eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'claude-code' });
          }
          sdkInPlanMode = false;
          void q.setPermissionMode(effectiveSdkPermissionMode()).catch((e) => {
            log.warn('post-plan-approval setPermissionMode failed', { error: String(e) });
          });
        }
        const finalPlan = decision.editedPlan ?? plan;
        // 计划获批后,后续实施动作要按"原始意图 + 获批计划"审查 —— 否则轻量 reviewer 仍按批准前的
        // 过期意图裁决,计划里明确授权的动作会被误 block(或反之)。
        setAutoReviewIntent(composeAutoReviewIntentWithApprovedPlan(
          planRequestAutoReviewIntent,
          finalPlan,
        ));
        return {
          behavior: 'allow',
          updatedInput: { ...(input as Record<string, unknown>), plan: finalPlan } as Record<string, unknown>,
        };
      }

      // ── 3. 其他工具 → permission kind ──
      const capabilityRoute = deniedCapabilityRoute(toolName);
      if (capabilityRoute) {
        log.warn('downstream MCP source denied by host capability route', {
          toolName,
          capabilityId: capabilityRoute.capabilityId,
          replacement: capabilityRoute.replacement?.id,
        });
        return {
          behavior: 'deny',
          message: capabilityRoute.replacement
            ? `This downstream source was not selected. Use Cindy capability ${capabilityRoute.replacement.id}.`
            : 'This downstream source was not selected.',
        };
      }
      // 没接 resolver → 普通档与 MCP 工具继续 fail-closed；Auto 的内置工具例外，
      // 因为 allow/block 可以由本地规则或轻量 reviewer 完成，并不需要 UI。只有最终
      // `ask` 才会落到 dispatchInteraction，在无 resolver 时自然 deny。
      // 正常流程里 Session 构造时**必定**注入 resolver(见 session.ts:
      // setInteractionResolver, 且 host 没接 listener 时该 resolver 自身返回 deny),
      // 故这里 interactionResolver 为 null 只可能是 misconfiguration / 裸 handle 直用。
      // 此时对已知只读内省工具(Read/Glob/Grep/...)放行, 对会改文件 / 跑命令 / 发外部
      // 消息的工具及一切未知工具一律 deny —— 不再依赖 SDK permissionMode 兜底。
      //
      // 这道闸必须在 MCP 审批策略**之前**: host 策略描述的是"这个工具值不值得打扰
      // 用户", 不代表"没有用户在场也可以跑"。裸 handle 场景下没有任何人能撤销误判,
      // 可信 MCP 同样落到 deny。
      const canReviewWithoutUi =
        mutablePermissionMode === 'auto' && !toolName.startsWith('mcp__');
      if (!interactionResolver && !canReviewWithoutUi) {
        if (isReadOnlyClaudeTool(toolName)) {
          return { behavior: 'allow', updatedInput: input };
        }
        log.warn('canUseTool without interactionResolver → fail-closed deny', { tool: toolName });
        return { behavior: 'deny', message: 'no interaction resolver attached; denying non-read-only tool (fail-closed)' };
      }

      // 3a. MCP 工具过 host 审批策略(本地与远端会话共用 classifyMcpApprovalPolicy)。
      const turnPolicyForcePrompt = forceTurnConfirmation(toolName, input);
      const mcpApprovalPolicy = classifyMcpApprovalPolicy(toolName, input);
      let forcePrompt = turnPolicyForcePrompt;
      if (mutablePermissionMode === 'auto' && !toolName.startsWith('mcp__')) {
        const workspaceRoots = [opts.workingDir, ...mutableExtraDirs].filter(
          (d): d is string => typeof d === 'string' && d.length > 0,
        );
        const autoDecision = await reviewAutoAction(
          normalizeBuiltinToolForAutoReview(toolName, input),
          workspaceRoots,
          opts.remoteHostId ? 'linux' : process.platform,
        );
        // 热切换收口:reviewAutoAction 是 async,期间 setPermissionMode 可能收紧(Auto→Ask)
        // 或放宽(→Full)。必须按**最新**档位决策,否则进入审查前的旧 auto 档 allow 会绕过用户
        // 刚通过 setPermissionMode 要求的确认(codex review P1;与已修复的 Pi 线程同口径)。
        // cast 破 TS 收窄:TS 不建模 await 期间经 setPermissionMode 闭包的重赋值,会把此处
        // mutablePermissionMode 仍视为 'auto';运行期它确实可能已变,故按 union 类型现读。
        const modeAfterReview = mutablePermissionMode as PermissionMode;
        if (modeAfterReview === 'bypassPermissions') {
          return { behavior: 'allow', updatedInput: input };
        }
        if (modeAfterReview !== 'auto') {
          // 已收紧到 Ask/更严:不吃 auto 裁决,强制走用户确认(下方 forcePrompt 流程)。
          forcePrompt = true;
        } else if (!turnPolicyForcePrompt && autoDecision.verdict === 'allow') {
          return { behavior: 'allow', updatedInput: input };
        } else if (!turnPolicyForcePrompt && autoDecision.verdict === 'block') {
          // 审阅器没跑起来 ≠ 模型判定危险:前者是基础设施故障,用户有权知道并接管,
          // 后者按 Auto 本意保持静默(只把 reason 喂给模型)。动作两种都仍然 deny。
          if (autoDecision.unavailable) autoReviewUnavailableNotice.notify();
          return {
            behavior: 'deny',
            message: autoDecision.reason ?? 'Cindy Auto Review blocked this action. Choose a safer alternative.',
          };
        } else {
          // AI `ask` and deterministic red-line verdicts are never persisted.
          forcePrompt = true;
        }
      } else {
        if (mcpApprovalPolicy === 'auto-approve' && !turnPolicyForcePrompt) {
          return { behavior: 'allow', updatedInput: input };
        }
        forcePrompt = forcePrompt || mcpApprovalPolicy === 'prompt-each-time';
      }
      const decision = await dispatchInteraction({
        kind: 'permission',
        requestId: options.toolUseID,
        toolName,
        input: input as Record<string, unknown>,
        title: options.title,
        displayName: options.displayName,
        description: options.description,
        // prompt-each-time 的语义是"每次都要人过目", 因此不把会话级 suggestion 交给
        // UI —— 否则用户点一次"总是允许"就把逐次确认的高风险 action 永久放行了。
        suggestions: forcePrompt
          ? undefined
          : this.normalizeSessionPermissionSuggestions(options.suggestions),
        metadata: {
          ...(options.blockedPath ? { blockedPath: options.blockedPath } : {}),
          ...(options.decisionReason ? { decisionReason: options.decisionReason } : {}),
          ...(options.agentID ? { agentID: options.agentID } : {}),
        },
      }, { forcePrompt });
      if (decision.kind !== 'permission') {
        log.warn('permission got mismatched decision', { tool: toolName, decKind: decision.kind });
        return { behavior: 'deny', message: 'resolver kind mismatch' };
      }
      if (decision.behavior === 'allow') {
        const out: {
          behavior: 'allow';
          updatedInput: Record<string, unknown>;
          updatedPermissions?: PermissionUpdate[];
        } = {
          behavior: 'allow',
          updatedInput: (decision.updatedInput ?? input) as Record<string, unknown>,
        };
        // Pass-through vendor-specific permission rule updates. BaseAgent owns
        // the session-scope normalization; Claude SDK validates the final shape.
        // PermissionUpdate shapes; we don't validate — SDK throws on bad shape.
        //
        // forcePrompt 下必须在**消费决策**这一侧丢弃, 不能只靠不下发 suggestion:
        // hook-control/interactions.ts 与 IM 卡片流会自己拼 permissionUpdates(不看
        // request.suggestions), 原样转给 SDK 就等于给逐次确认的高风险 action 落了
        // 一条会话规则, 之后的 canUseTool 全被跳过。本次调用仍按用户意愿放行。
        if (forcePrompt) {
          if (decision.permissionUpdates && decision.permissionUpdates.length > 0) {
            log.warn('dropping session permission grant for prompt-each-time MCP tool', {
              tool: toolName,
            });
          }
        } else if (decision.permissionUpdates && decision.permissionUpdates.length > 0) {
          out.updatedPermissions = decision.permissionUpdates as PermissionUpdate[];
        }
        return out;
      }
      return { behavior: 'deny', message: decision.reason ?? 'denied by user' };
    };

    // ── thinking display 配置（与 vendor/claude/runtime.ts:121-126 等价） ─────
    const thinkingOpts = opts.displayReasoning === 'summarized'
      ? { thinking: { type: 'adaptive', display: 'summarized' } as unknown as { type: 'adaptive' } }
      : {};
    const showThinkingSummaries = opts.displayReasoning === 'summarized';

    // SDK settings 对象 (优先级最高, 覆盖 user/project/local 文件层) — 本地分支
    // 和远端分支必须**保持一致** , 否则同 session setting 跨本地 / 远端表现不同
    // (eg. summarized reasoning UI 本地有 remote 没)。getter 让 memOverride /
    // mutableFastMode 读最新值 (setMemory / setFastMode 运行时改) 而不是 buildQuery
    // 时快照。装配逻辑(含 apiKeyHelper 恒置空的鉴权防线)在 flag-settings.ts。
    const buildSettings = (): Settings =>
      buildClaudeFlagSettings({
        showThinkingSummaries,
        // availableModels is the SDK's highest-priority allowlist. Convert the
        // whole current catalog and the selected model through the one
        // catalog-id → wire-string mapper so startup and live switches share
        // the same [1m] and legacy conversion rules. Keep the selected model
        // even when it is temporarily outside the catalog.
        availableModels: [
          ...new Set([
            ...this.capabilities.availableModels.map(({ id }) => sdkModelFor(id)),
            sdkModelFor(mutableModel),
          ]),
        ],
        // Do not carry the local manager's native-memory suppression across the
        // SSH boundary: the remote host retains its own Claude memory
        // configuration. Maker Memory on remote sessions is injected via the
        // host bridge (prompt + http MCP), which coexists with — but does not
        // rewrite — the remote machine's native memory settings.
        memoryOverride: opts.remoteHostId ? undefined : this.memoryOverride,
        // Fast 模式:进 flag settings 层(= --settings),解锁 cc 二进制在 Agent SDK 通道下的
        // fast(否则二进制按 "Agent SDK 不可用" 拒绝)。是否 Opus/官方/firstParty 由二进制把关,
        // agent 层不重复硬判(规则 9:确定性逻辑就近,但 fast 的最终门槛是二进制 + 配置门控)。
        fastMode: mutableFastMode,
        capabilityRouting: this.deps.capabilityRouting,
      });

    // file checkpointing 与 capability 强绑定 —— 声明 rewind 能力时必须开此开关,
    // 否则 SDK rewindFiles() 报 "no checkpoint"。
    const enableFileCheckpointing = this.capabilities.rewind.supported;
    const getSdkEffortForModel = (model: string, effort: Effort) =>
      this.sdkEffortForModel(model, effort);
    const getSdkMaxEffortFallbackForModel = (model: string) =>
      this.sdkMaxEffortFallbackForModel(model);

    // memoryOverride 闭包以前抽过 getter, buildSettings 接管后直接读 this.memoryOverride。

    // ── 运行时切换状态 (Stage 2 B) ──────────────────────────────────────────
    // model / effort / permissionMode 在 setX 后会变, handle 通过 getter 读 mutable 引用;
    // translator ctx 也通过 getter 读, 让 turn start/end 日志反映"当前真实值"而不是创建时的值。
    // 必须在 buildQuery / forward loop 之前声明, 否则 ctx getter 会捕获到 TDZ。
    let mutableModel = opts.model;
    let mutableProviderId = opts.providerId ?? null;
    let mutableAutoReviewCredentialMode = effectiveCredentialMode;
    let nativeAutoReviewUnavailable = false;
    let currentAutoReviewIntent = '';
    const autoReviewDecisionCache = new Map<string, Promise<AutoReviewDecision>>();
    // Claude's native OAuth Auto classifier bypasses canUseTool entirely. Once a host MCP
    // is registered, that would also bypass Cindy's trusted-server and prompt policies,
    // leaving permission requests with no Cindy interaction surface. Keep native Auto for
    // MCP-free sessions, but route host-MCP sessions through SDK default so canUseTool owns
    // the decision.
    const hasRegisteredMcpServers = (): boolean => registeredMcpServerNames.size > 0;
    const usesNativeClaudeAutoReview = (): boolean =>
      !nativeAutoReviewUnavailable
      && mutableAutoReviewCredentialMode === 'oauth-bearer'
      && !hasRegisteredMcpServers();
    const setAutoReviewIntent = (content: UserMessage['content']): void => {
      currentAutoReviewIntent = extractAutoReviewUserIntent(content);
      autoReviewDecisionCache.clear();
    // 每条新用户消息 = 新一轮,提示重新武装。ErrorBanner 那份只活到下一条非 error 事件
    // (renderer 的 handleStreamEvent 会清 recoverableError),所以「整个会话只说一次」
    // 会让用户在后续轮次里完全看不到;改为每轮至多一条 —— 不刷屏,又保证每一轮遇到时
    // 都有机会看见。持久呈现需要一条真正的会话级 notice 通道,见 issue 外推。
      autoReviewUnavailableNotice.reset();
    };
    // 「自动审核不可用」的会话级一次性提示(issue #1574)。走既有的非终止 error 事件 +
    // `[CODE]` 约定,不新增事件类型;逐条提示会把 Auto 退化成比 Ask 更烦的东西,所以去重。
    const autoReviewUnavailableNotice = createAutoReviewUnavailableNotice((message) => {
      eventQueue.push({
        type: 'error',
        data: { message, isTerminal: false },
        source: 'claude-code',
      });
    });
    const reviewAutoAction = (
      action: ReviewableAction,
      workspaceRoots: string[],
      platform: NodeJS.Platform,
    ): Promise<AutoReviewDecision> => {
      const request = {
        sessionId: opts.sessionId,
        agentKind: 'claude-code' as const,
        providerId: mutableProviderId,
        model: mutableModel,
        userIntent: currentAutoReviewIntent,
        action,
        workspaceRoots,
        platform,
      };
      const key = JSON.stringify(request);
      const cached = autoReviewDecisionCache.get(key);
      if (cached) return cached;
      const pending = resolveAutoReviewDecision(
        request,
        this.deps.reviewAutoPermissionAction,
      );
      autoReviewDecisionCache.set(key, pending);
      return pending;
    };
    let toolLoopGuard: ToolLoopGuard | null = isDeepSeekModel(mutableModel)
      ? new ToolLoopGuard()
      : null;
    let mutableEffort: Effort = opts.effort ?? 'high';
    let mutablePermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    // 计划模式(与 permissionMode 正交, **一次性选择**): mutablePlanMode 是 UI 勾选的
    // "武装"态 —— send 消耗它并立即 emit plan_mode_changed(false) 让勾选熄灭;
    // 本轮 plan turn 由 planTurnActive 承载(SDK 保持 plan 档): ExitPlanMode 批准
    // 提前切回底层档, 否则(取消 / 模型没提交计划)在 turn 结束时收尾。
    let mutablePlanMode = opts.planMode === true;
    let planTurnActive = false;
    // SDK 当前是否处于 plan 档(跟踪我们最后一次 push / buildQuery 的档位)。
    // setPlanMode 在 turn 流式中递延 push(避免改写 in-flight turn 的工具权限),
    // send 消耗武装态时据此判断是否需要补推。
    let sdkInPlanMode = false;
    // SDK PermissionMode union 没有 'ask' (我们对 ChatInput 暴露的统一名字), SDK 侧当 default。
    type SdkPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';
    // 官方 Claude OAuth 路由保留 CC 原生 Auto classifier。第三方/网关路由及原生
    // classifier 故障后的会话映射到 default，使 canUseTool 回调进入 Cindy 轻量 fallback。
    const toSdkPermissionMode = (mode: PermissionMode): SdkPermissionMode => {
      if (mode === 'auto') return usesNativeClaudeAutoReview() ? 'auto' : 'default';
      return (mode === 'ask' ? 'default' : mode) as SdkPermissionMode;
    };
    /**
     * SDK 实际起 turn 时应用的权限档: 计划模式武装中(下一 turn arm)或本轮 plan turn
     * 进行中都恒为 plan, 否则跟随底层权限档。**含 arm 态**, 用于 buildQuery 起 turn。
     */
    const effectiveSdkPermissionMode = (): SdkPermissionMode =>
      mutablePlanMode || planTurnActive ? 'plan' : toSdkPermissionMode(mutablePermissionMode);
    // Only queries that actually started in native Auto need the post-init
    // downgrade. A host MCP can already have made a query start in `default`;
    // retrying that no-op and treating a transport failure as fatal would close
    // an otherwise safe session.
    const nativeAutoQueries = new WeakSet<Query>();

    /**
     * **本次 turn** 目标 SDK 权限档: 只看 `planTurnActive`(本轮是否 plan turn), **不含**
     * `mutablePlanMode` arm 态 — arm 态表示"下一次 send 应该以 plan turn 起", 与本轮无关。
     * rebuild 竞态重放要用这个而非 effectiveSdkPermissionMode(), 否则 `await buildQuery` 期间
     * 到达的 setPlanMode(true) 会漂移本 turn 的 SDK 档到 'plan', 让不是 plan turn 的普通 send
     * 意外跑成 plan turn (Codex review 3535660068)。
     */
    const currentTurnSdkPermissionMode = (): SdkPermissionMode =>
      planTurnActive ? 'plan' : toSdkPermissionMode(mutablePermissionMode);
    // Fast 模式运行时态:启动取 opts.fastMode 快照,setFastMode 覆盖。buildSettings 每次读最新值;
    // host 只在「该 model 支持 + 走官方供应商」时才传 true(renderer 配置门控),agent 忠实消费。
    let mutableFastMode = opts.fastMode === true;
    // 附加只读引用目录: 启动时取 opts.extraDirs 快照, setExtraDirs 覆盖, buildQuery
    // 每 turn 读最新值传给 SDK options.additionalDirectories — 即时生效。
    let mutableExtraDirs: string[] = Array.isArray(opts.extraDirs) ? [...opts.extraDirs] : [];
    const modelContextWindows = new Map(
      this.capabilities.availableModels.map((model) => [model.id, model.contextWindow] as const),
    );

    // ── Usage tracker (Stage 2 B') ──────────────────────────────────────────
    // 单 session 共享的 mutable usage state. translator 通过 ctx 注入访问.
    // handle.getUsageSnapshot 也读它, 形成"SDK 原始 usage → tracker → status event / handle snapshot"
    // 单一可信源.
    const usageTracker = new UsageTracker();
    usageTracker.setContextWindow(modelContextWindows.get(mutableModel) ?? 0);

    // ── 跨 turn 共享状态 ───────────────────────────────────────────────────
    let configuredResumeSessionId: string | undefined = opts.resumeSessionId;
    let sdkSessionId: string | undefined = configuredResumeSessionId;
    // 只在首次 resume 尚未被真实内容证明成功前允许自愈；成功一轮后即关闭分类窗口，
    // 避免后续普通 turn 中碰巧出现同文案时误清上下文。
    let resumeValidationPending = !!configuredResumeSessionId;
    let freshSessionValidationPending = !configuredResumeSessionId;
    let resumeRecoveryAttempted = false;
    // 当前 turn 已经交给 SDK 的精确输入。invalid-resume fresh rebuild 只重放这一份，
    // 不重新经过 Session.send/onAccepted，因此不会重复持久化用户消息或渠道 ack。
    let replayableUserInput: SdkUserInput | null = null;
    // 仅用于诊断日志: 调用方 (register.ts) 在每次 send 前从 storage 取最新 title 透传进来,
    // translator 打 SDK ▷ token usage 等行时会一起带上, 不参与任何业务逻辑。
    let lastSendTitle: string | undefined;
    let closed = false;
    // 远端 cc 分支专用 — 记下当前 buildQuery 返的 RemoteQuery, 让 handle.close /
    // U2 兜底能调它的 close() 走 query/close RPC → 远端 cc-mgr SessionRegistry
    // 释放 SDK Query → close ssh exec / nc / RpcClient。漏调这一步会让远端
    // session 继续跑(空耗 token), reattach 时还能撞到 alive 状态。本地 SDK
    // 分支不需要 — sdkQuery 是子进程, abortController.abort() 已经够。
    let activeRemoteQuery: { close: () => Promise<void>; detach?: () => Promise<void> } | null = null;
    // 跨消息累积:一个 turn 内 SDK 会发多个 assistant message,这里把 text 拼起来,
    // 在 result 缺少正文时作为 finalText 兜底。
    const turnState: TurnState = {
      text: '',
      toolUses: 0,
      apiCalls: 0,
      sawCompactBoundary: false,
      hasEmittedText: false,
      uiEmittedText: '',
      pendingApiError: null,
      interruptRequested: false,
      generation: 0,
      interruptGeneration: 0,
      lastAssistantMsgHadSubstance: true,
    };
    const runtimeState: RuntimeState = newRuntimeState();
    const beginNewTurn = (): void => {
      // usageTracker.beginTurn() 只清 usage 桶；translator 的 turnState 也要在新 turn
      // 开始时清掉，避免上一轮 abnormal/abort 没走 result 时污染下一轮状态。
      usageTracker.beginTurn();
      turnState.text = '';
      turnState.toolUses = 0;
      turnState.apiCalls = 0;
      turnState.sawCompactBoundary = false;
      turnState.hasEmittedText = false;
      turnState.uiEmittedText = '';
      turnState.pendingApiError = null;
      turnState.lastAssistantRequestId = undefined;
      turnState.lastAssistantMsgHadSubstance = true;
      // 代际前进: 迟到的被打断 result 据此被 translator 识别为已被本 send 接管。
      turnState.generation += 1;
      // interruptRequested **刻意不在这里清**: watchdog / tool-loop guard 先置
      // turnInFlight=false 再 q.interrupt(), 用户立刻 send 会让 beginNewTurn 抢在
      // 被打断的 ResultMessage(error_during_execution) drain 之前执行 —— 在此清掉
      // 唯一的抑制位, 旧 result 会被 translator 当成新 turn 的终态失败双发 banner
      // (PR #485 review)。标记的生命周期: interrupt 置位 → translator 的
      // resetTurnState 随 result 消费清除;q 换代(startForwardLoop)时兜底清
      // (旧 q 的 result 不可能到达新 q)。
    };

    // ── Rewind 状态机 ──────────────────────────────────────────────────────
    // commitRewindFiles 设此标记, 下一次 send 检测到 → close 老 q + buildQuery 拼三件套
    // (resume + resumeSessionAt + forkSession) + startForwardLoop 接到老 eventQueue 上。
    // 对外 (Session / desktop / renderer) 完全透明, 只看到一个 send 调用。
    let pendingRewindTo: string | undefined;
    // turn-in-flight 标记: send 入口设 true, translator 的 result 事件回调清 false。
    // SSE idle watchdog 触发时也会主动清, 防止 SDK drain 期间又起 timer。
    // rewind preview/commit 业务层用 isTurnRunning() 前置守卫, 不在 turn 跑时操作 SDK。
    let turnInFlight = false;
    // send() 处于 beginNewTurn→userInputAccepted 之间时置 true。
    // abort() 在此期间跳过 turnInFlight 清除:并发 send 负责在错误路径上
    // (finishSendBeforeUserInput) 自行清 turnInFlight 并 emit boundary,
    // abort 抢清会让 boundary 丢失、acceptingRebuiltSend 残留(review #485)。
    let sendInAcceptPhase = false;
    /**
     * "桥接 turn"计数器: rebuild 尾部注入的 /compact 是 SDK 独立 turn, 但产品层视角
     * 它是"用户 turn 的一部分" — 该 /compact 的 done / end-status 不能让上层做 turn
     * finalization (idle 调度 / IM handleTurnDoneAsync / snapshot 收尾), 也不能清
     * turnInFlight 让 isTurnRunning 报 false。
     *
     * 之前用 `inputQueue.pending > 0` 反推"是否还有排队 turn", 但 pending 有两个漏窗:
     *  (a) send 里 push /compact 后 `await toClaudeSdkContent(...)` 是 async 空窗
     *      (图片 resize 几百 ms), 期间 SDK 可能已 drain /compact → pending 提前归 0
     *  (b) SDK prompt 是 AsyncIterable, 消费模式无法保证 backpressure — 有 eager
     *      drain 场景 (两条 push 后 SDK 一次性拉完), pending 归 0 但两 turn 都在跑
     * 反馈原型: Codex review 3535259132 / 3535293200 (2026-07-07)。
     *
     * 改用显式计数: 注入 /compact 时 +1 → middle turn 边界事件全程 suppress、
     * turnInFlight 保持;该 /compact turn 的 onTurnEnd 消费 -1;归 0 后下一个真 turn 结束
     * 的边界事件正常放行、清 turnInFlight。计数 = "已注入但 SDK 还没跑完的桥接 turn 数"。
     */
    let queuedBridgeTurns = 0;
    type ActiveBridgeKind = 'rewind' | 'cancellation';
    let activeBridgeKind: ActiveBridgeKind | null = null;
    // Bridge /compact 由 rewind 或 cancellation rebuild 尾部注入。若用户 Stop 打在该 bridge turn
    // 上, 已被 SDK eager-drain 的后续真实用户输入无法再从 inputQueue.clear() 追回;
    // 必须 close 当前 Query, 并在下一次 send 用同一个 resume point 重建, 才能从 SDK
    // 侧取消整条 compact → user 序列。
    let activeBridgeRewindResumeAt: string | undefined;
    let bridgeCompactUsageSnapshot: ReturnType<AutoCompactController['getLatestSnapshot']> = null;
    const bridgeStateActive = (): boolean =>
      queuedBridgeTurns > 0 || activeBridgeKind !== null || activeBridgeRewindResumeAt !== undefined;
    let q: Query;
    function restoreBridgeAutoCompactSnapshot(reason: string): void {
      const snapshot = bridgeCompactUsageSnapshot;
      bridgeCompactUsageSnapshot = null;
      if (!snapshot || !autoCompactController) return;
      autoCompactController.onUsageUpdate(snapshot.contextTokens, snapshot.contextWindow);
      log.debug('bridge rollback restored auto-compact usage snapshot', {
        reason,
        ratio: Number(snapshot.ratio.toFixed(3)),
        contextTokens: snapshot.contextTokens,
        contextWindow: snapshot.contextWindow,
      });
    }

    // ── upstream-response-idle watchdog (按上游 API 请求级) ─────────────────
    // 上游 API 单次响应静默超过阈值 → emit 一条结构化 error 事件 + 调 q.interrupt() 主动
    // 中断当前 turn (与用户手动 stop 同路径)。不调 abortController.abort() —— 那会把
    // 整个 SDK Query 打成黑洞 session, 后续 send 全失败 (见 handle.abort 段注释)。
    //
    // 阈值默认 30min (端到端最后兜底) —— 上游网络断流已由 cc-code 原生 watchdog
    // (env-builder 注入 CLAUDE_ENABLE_STREAM_WATCHDOG, 300s) + 非流式 fallback 透明自愈,
    // 这层只兜 cc 抓不到的非网络卡死 (子进程死锁 / stdio 传输 wedge)。阈值刻意 > cc
    // 恢复预算 (≈20min) 以免抢跑。env XDT_CC_SSE_IDLE_TIMEOUT_MS (历史命名; ms) 覆盖,
    // 设 0 关闭。详见 parseIdleTimeoutMs 上方文档。
    //
    // **timer 只在客户端"等上游回话"期间在走** —— 工具执行 / canUseTool 用户交互期间
    // 上游已交回 ball, 不算 idle 配额。pendingToolIds.size>0 时 arm 短路不起 timer,
    // Bash 长 build / MCP 拉大表 / 子 agent / AskUserQuestion 发呆都不会被误伤; 只有
    // tool_result 全部配对完 (set 归零, ball 回到上游) 之后, 上游真的挂死才触发。
    const upstreamResponseIdleTimeoutMs = parseIdleTimeoutMs(process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS);
    let upstreamResponseIdleTimer: NodeJS.Timeout | null = null;
    let upstreamResponseLastEventType: string | null = null;
    let upstreamResponseLastEventAt = 0;
    /** 还需要"清醒地"静默多久才判上游哑火;按分片递减(见 armUpstreamResponseIdleSlice)。 */
    let upstreamResponseIdleRemainingMs = 0;
    /** 当前分片的起始壁钟时刻;片尾据此识别系统挂起。 */
    let upstreamResponseIdleSliceStartedAt = 0;
    const pendingToolIds: Set<string> = new Set();
    function clearUpstreamResponseIdle(): void {
      if (upstreamResponseIdleTimer) {
        clearTimeout(upstreamResponseIdleTimer);
        upstreamResponseIdleTimer = null;
      }
      upstreamResponseIdleRemainingMs = 0;
      upstreamResponseIdleSliceStartedAt = 0;
    }
    function armUpstreamResponseIdle(): void {
      clearUpstreamResponseIdle();
      if (upstreamResponseIdleTimeoutMs <= 0) return;
      if (closed || !turnInFlight) return;
      // 工具执行 / 用户交互 in-flight 期间 ball 不在上游, 不计 idle 配额。
      if (pendingToolIds.size > 0) return;
      upstreamResponseIdleRemainingMs = upstreamResponseIdleTimeoutMs;
      armUpstreamResponseIdleSlice();
    }
    /**
     * 分片计时,片尾核对真实耗时(壁钟差 ≠ 清醒时间,分层自愈不变量第 6 处;
     * 与 codex 的 armUpstreamIdleSlice、Session 层的 armTurnStallSlice /
     * armAbortRecoverySlice、scheduler 的 absorbSuspendGap、scheduler-host runner
     * 的排队派发上限同源)。不能用一个 30 分钟的长定时器直接判定 —— Electron 被
     * 系统挂起(合盖睡眠)期间没有任何事件,定时器一旦在唤醒后到期就立刻开火,
     * 一次午休就能让看门狗中断一条其实还健康的 turn(SDK 连接可能仍活着)。
     * 片尾判定被冻结过时走**完整重判**(armUpstreamResponseIdle)而不是直接续片:
     * 唤醒后 turn / 工具 / 交互状态可能已经变了。
     */
    function armUpstreamResponseIdleSlice(): void {
      const slice = Math.min(upstreamResponseIdleRemainingMs, CC_UPSTREAM_IDLE_SLICE_MS);
      upstreamResponseIdleSliceStartedAt = Date.now();
      upstreamResponseIdleTimer = setTimeout(() => {
        upstreamResponseIdleTimer = null;
        const elapsed = Date.now() - upstreamResponseIdleSliceStartedAt;
        if (elapsed > slice + CC_UPSTREAM_IDLE_SUSPEND_GAP_MS) {
          log.info('upstream-response-idle watchdog skipped a suspended slice', {
            sdkSessionId,
            sliceMs: slice,
            elapsedMs: elapsed,
          });
          armUpstreamResponseIdle();
          return;
        }
        upstreamResponseIdleRemainingMs -= Math.max(0, elapsed);
        if (upstreamResponseIdleRemainingMs > 0) {
          armUpstreamResponseIdleSlice();
          return;
        }
        onUpstreamResponseIdleTimeout();
      }, slice);
      (upstreamResponseIdleTimer as unknown as { unref?: () => void }).unref?.();
    }
    function onUpstreamResponseIdleTimeout(): void {
      if (closed || !turnInFlight) return;
      const idleMs = upstreamResponseIdleTimeoutMs;
      const msSinceLast = upstreamResponseLastEventAt > 0
        ? Date.now() - upstreamResponseLastEventAt
        : null;
      log.warn('upstream-response-idle watchdog tripped — interrupting current turn', {
        idleMs,
        sdkSessionId,
        lastEventType: upstreamResponseLastEventType,
        msSinceLastEvent: msSinceLast,
        pendingToolIdsSize: pendingToolIds.size,
        turnInFlight,
      });
      // Bridge 消费兜底 (Codex review 3535664420 / 3536509277): 若 watchdog 在
      // bridge /compact turn 内触发(大上下文压缩容易超 idle 阈值), 语义与用户 Stop
      // 一致:取消整条 "compact → real user message" 序列。只 inputQueue.clear()
      // 不够,因为 SDK 可能已经 eager-drain 了后续真实用户输入;只 q.interrupt()
      // 也可能只中断当前 /compact turn,让已 drain 的真实消息继续跑。这里走与
      // abort() 相同的 close-and-rebuild 路径,并保留 rewind resume point 给下一次
      // send 重建。
      if (bridgeStateActive()) {
        const timedOutBridgeKind = activeBridgeKind;
        const timedOutRewindResumeAt = activeBridgeRewindResumeAt;
        log.warn('upstream-idle watchdog fired during bridge — closing query and preserving rewind resume point', {
          queuedBridgeTurns,
          queuedInput: inputQueue.pending,
          activeBridgeRewindResumeAt,
        });
        eventQueue.push({
          type: 'error',
          data: {
            message:
              `上游 API 单次响应已静默 ${Math.round(idleMs / 1000)}s, ` +
              `已自动中断当前 turn 防止卡死。可以直接发下一条消息继续 ` +
              `(已完成的 tool result 都保留)。`,
            isTerminal: true,
            reason: 'upstream_response_idle_timeout',
            idleMs,
            sdkSessionId,
            lastEventType: upstreamResponseLastEventType,
            msSinceLastEvent: msSinceLast,
          },
          source: 'claude-code',
        });
        restoreBridgeAutoCompactSnapshot('upstream_response_idle_timeout');
        autoCompactController?.onCompactCanceled('upstream_response_idle_timeout');
        const suppressedDoneData = takeBridgeSuppressedDoneData();
        clearBridgeState();
        inputQueue.clear();
        try {
          inputQueue.end();
        } catch (e) {
          log.warn('upstream-idle watchdog during bridge: inputQueue.end threw', { error: String(e) });
        }
        canceledBridgeQueries.add(q);
        recordCanceledQueryClose(q, 'upstream idle watchdog during bridge');
        turnInFlight = false;
        turnState.interruptRequested = false;
        pendingToolIds.clear();
        preserveBridgeRetryTarget(timedOutBridgeKind, timedOutRewindResumeAt);
        emitTurnBoundary('upstream_response_idle_timeout', suppressedDoneData);
        return;
      }
      eventQueue.push({
        type: 'error',
        data: {
          message:
            `上游 API 单次响应已静默 ${Math.round(idleMs / 1000)}s, ` +
            `已自动中断当前 turn 防止卡死。可以直接发下一条消息继续 ` +
            `(已完成的 tool result 都保留)。`,
          isTerminal: true,
          reason: 'upstream_response_idle_timeout',
          idleMs,
          sdkSessionId,
          lastEventType: upstreamResponseLastEventType,
          msSinceLastEvent: msSinceLast,
        },
        source: 'claude-code',
      });
      // 先关 turn-in-flight + 清 pending 再 interrupt: 这样 SDK drain 出 ResultMessage 时,
      // translator 的 onTurnEnd 还会再清一次 (幂等), 但中间任何 message 都不会重新 arm timer。
      turnInFlight = false;
      pendingToolIds.clear();
      // watchdog 上面已推过带 reason 的 terminal error, interrupt 后 drain 出的
      // is_error result 不能再触发 translator 的失败兜底(双 error banner)。
      turnState.interruptRequested = true;
      turnState.interruptGeneration = turnState.generation;
      void q.interrupt().catch((e) => {
        // interrupt 没发出去 → 不会有被打断的 result 来消费标记, 残留会错误
        // 抑制下一真实 turn 的 is_error 兜底 —— 立即回收。
        turnState.interruptRequested = false;
        log.warn('upstream-response-idle watchdog: interrupt threw', { error: String(e) });
      });
    }
    function noteUpstreamResponseActivity(eventType: string): void {
      upstreamResponseLastEventType = eventType;
      upstreamResponseLastEventAt = Date.now();
      armUpstreamResponseIdle();
    }
    function isCurrentQuery(currentQ: Query): boolean {
      return currentQ === q;
    }

    /**
     * 检查是否需要 auto-compact, 需要时把 /compact push 到 inputQueue。返回是否实际 push。
     * 调用方在 rebuild 尾部的 "compact→user 桥接场景" 中据此把 queuedBridgeTurns++,
     * 让后续中间 turn 边界事件被 suppress、turnInFlight 跨排队 turn 保持。
     */
    function triggerAutoCompactIfNeeded(): boolean {
      if (closed || turnInFlight) return false;
      if (!autoCompactController?.shouldCompactNow()) return false;
      const snapshot = autoCompactController.getLatestSnapshot();
      const threshold = autoCompactController.getCurrentThresholdPct();
      log.info('auto-compact triggered', {
        threshold,
        ratio: snapshot ? Number(snapshot.ratio.toFixed(3)) : undefined,
        contextTokens: snapshot?.contextTokens,
        contextWindow: snapshot?.contextWindow,
        sdkSessionId,
      });
      beginNewTurn();
      toolLoopGuard?.resetTurn();
      turnInFlight = true;
      inputQueue.push({
        type: 'user',
        message: { role: 'user', content: '/compact' },
        parent_tool_use_id: null,
      });
      armUpstreamResponseIdle();
      return true;
    }

    // Rewind preview/commit intentionally skip injecting /compact because they
    // are control operations, not product turns. If a blocked model/window
    // switch crossed the threshold while the old Query was retired, leave the
    // cancellation rebuild tombstone armed so the next send can inject the
    // compact bridge on a fresh Query before accepting user input.
    function shouldRearmAutoCompactAfterRewindControl(): boolean {
      const snapshot = autoCompactController?.getLatestSnapshot();
      const threshold = autoCompactController?.getCurrentThresholdPct();
      return snapshot !== null && snapshot !== undefined &&
        threshold !== undefined && snapshot.ratio >= threshold / 100;
    }

    function queueAutoCompactBridge(kind: ActiveBridgeKind, resumeAt?: string): boolean {
      const queued = triggerAutoCompactIfNeeded();
      if (!queued) return false;
      bridgeCompactUsageSnapshot = autoCompactController?.getLatestSnapshot() ?? null;
      activeBridgeKind = kind;
      if (kind === 'rewind') activeBridgeRewindResumeAt = resumeAt;
      queuedBridgeTurns += 1;
      log.debug('rebuild: bridge /compact injected', {
        bridgeKind: kind,
        queuedBridgeTurns,
        activeBridgeRewindResumeAt,
      });
      return true;
    }

    function preserveBridgeRetryTarget(
      kind: ActiveBridgeKind | null,
      rewindResumeAt: string | undefined,
    ): void {
      if (kind === 'rewind' && rewindResumeAt !== undefined) {
        pendingRewindTo = rewindResumeAt;
      } else if (kind === 'cancellation') {
        continuationCancellationRequiresQueryRebuild = true;
      }
      // Caller may preserve a retry target before clearing this state.
    }

    // 当前 session 的 one-shot tip 状态 (turn-start status 用):
    //  - displayed: id → 已展示次数 (≥ 该 tip 的 guarantees.length 时退出抽样池)
    //  - pity:      id → 自上次展示以来候选轮次 (pickTurnStartStatus 内部自增 / 触发保底)
    // /clear 等价于开新 session → 重建 handle → 状态自然清零, 无需额外重置。
    const oneShotTipState: OneShotState = { displayed: new Map(), pity: new Map() };

    // ── sdkQuery 装配 (可被 rewind 重复调用) ──────────────────────────────────
    // 三件套 (resume + resumeSessionAt + forkSession) 通过 extra 注入。
    // startSession 首次调 buildQuery() 不传 extra, 走 vendorOptions.resumeSessionAt /
    // forkSession 透传 (老链路兼容); rewind 重启时传 extra, 强制三件套。
    const buildQuery = async (extra?: {
      resumeSessionAt?: string;
      forkSession?: boolean;
      permissionMode?: SdkPermissionMode;
      fresh?: boolean;
    }): Promise<Query> => {
      const currentSdkModel = sdkModelFor(mutableModel);
      const currentSdkEffort = getSdkEffortForModel(mutableModel, mutableEffort);
      const baseResumeAt = vo.resumeSessionAt as string | undefined;
      const baseFork = vo.forkSession as boolean | undefined;
      const finalResumeAt = extra?.fresh ? undefined : (extra?.resumeSessionAt ?? baseResumeAt);
      const finalFork = extra?.fresh ? false : (extra?.forkSession ?? baseFork);
      const mcpServers = buildMcpServers();
      // ── 智能通讯录两态段: 紧跟 buildMcpServers 求值, prompt 状态与本次 build
      // 实际生效的工具面对齐(rewind/fresh 重建同步跟随), 三种去向:
      //   host 有效状态 enabled 且 cindy_contacts 真的注册了 → 使用规范段;
      //   disabled(功能未开) → 可选功能告示段(邀请开启);
      //   其余(unavailable/工作区覆盖禁用/注册被跳过/remote/未接线) → 不注入 —
      //   既不指挥模型调不可达工具, 也不邀请用户去开一个已开着的开关。
      const contactsRules = (() => {
        if (opts.remoteHostId) return '';
        const state = this.deps.getContactsPromptState?.({ workingDir: opts.workingDir });
        if (state === 'disabled') return CONTACTS_RULES_DISABLED;
        if (state !== 'enabled') return '';
        return registeredMcpServerNames.has('cindy_contacts') ? CONTACTS_RULES_ENABLED : '';
      })();
      // resume 优先用当前的 sdkSessionId (rewind 重启时它指向上一轮 SDK 给的 id);
      // 缺省回到 startSession 入参的 resumeSessionId (新会话首次起 query 时用)。
      let resumeSdkSid = sdkSessionId ?? configuredResumeSessionId;

      // ── 远端 cc 分支 (Phase 4.3) ──
      // session 标了 remoteHostId 且 host 注入了 remoteCcQueryFactory → 走远端
      // cc-mgr daemon (NDJSON RPC + RemoteQuery 包装), 而非本地 sdkQuery 起子进程。
      // 详见 AgentDeps.remoteCcQueryFactory 文档 (base-agent.ts)。
      //
      // 关键设计:
      //  - 整套 sdkQuery options (除 callback/path/hooks 等不可序列化字段) 透传给
      //    daemon 端 SDK; JSON.stringify 自动 strip callback, daemon 端默认走
      //    acceptEdits permissionMode (cc-mgr SessionRegistry 默认值)
      //  - inputQueue (maker-core push 的 user 消息) 没法直接给 RemoteQuery
      //    (它走 send RPC 而非 AsyncIterable consume), 这里启动一个 fire-and-forget
      //    forwarder 把 inputQueue 转成 remoteQuery.send 调用
      //  - rewind/fork 字段 MVP 不支持；fresh rebuild 只换 Query + 不带 resume，
      //    沿用普通 start 语义，可用于 invalid-resume 自愈
      if (opts.remoteHostId && this.deps.remoteCcQueryFactory) {
        if (extra?.resumeSessionAt || extra?.forkSession) {
          throw new Error(
            'rewind / forkSession are not supported on remote Claude Code sessions yet (MVP)',
          );
        }
        if (!opts.sessionId) {
          throw new Error('cc remote requires opts.sessionId for cc-mgr SessionRegistry routing');
        }
        log.info('claude-code: routing session to remote cc-mgr daemon', {
          remoteHostId: opts.remoteHostId,
          sessionId: opts.sessionId,
        });
        // 已知覆盖缺口(codex-connector review P1):远端会话的转录在远端 daemon
        // 磁盘、CLI 流量直连远端 endpoint(remoteEnv.ANTHROPIC_BASE_URL),本地
        // jsonl 归一化钩子与本地 compat-proxy 响应流改写都拦不到。remote cc 是
        // MVP(rewind/fork 均 throw,撞车主触发路径在远端不可用),但远端 kimi
        // 会话一旦撞车(如中断后可见数回落)将无法自愈,持续腐蚀到会话结束。
        // 修复需扩展 cc-mgr wire protocol + 跨包共享归一化逻辑,列为 follow-up。
        if (resumeSdkSid) {
          log.warn(
            'claude-code: remote cc session not covered by kimi tool-id normalize/rewrite defenses (transcript on remote daemon, CLI bypasses local proxy); a kimi mint collision on this session cannot self-heal',
            { remoteHostId: opts.remoteHostId, sessionId: opts.sessionId, resumeSdkSid },
          );
        }
        // 网关路径(remoteRoute 为 null,即会话有效路由是 XD 网关)才依赖
        // runtimeConfig.remoteEndpoint:host 定义了该字段但值为空 = 网关凭据尚未就绪 /
        // 已失效,env-builder 会回落到本地 endpoint(下面 loopback guard 虽能拦,但错误
        // 归因成「内部错误」误导排查),这里先按真实原因拒绝。(`!== undefined` 区分未注入
        // 该字段的旧 host,保持其原有回落行为。)
        // route 路径(native OAuth / 自定义供应商)的 endpoint 已由 resolveRemoteClaudeRoute
        // 覆盖成供应商真上游,与网关 endpoint 就绪与否无关,跳过本判。
        if (
          !remoteRoute &&
          this.deps.runtimeConfig.remoteEndpoint !== undefined &&
          !this.deps.runtimeConfig.remoteEndpoint.trim()
        ) {
          throw new Error(
            '[REMOTE_GATEWAY_ENDPOINT_UNAVAILABLE] Remote Claude Code sessions need the XD gateway endpoint issued after sign-in; gateway credentials are not ready on this desktop yet.',
          );
        }
        // Defense-in-depth: a remote machine can't reach the host's local loopback
        // compat-proxy. The host guarantees remote env uses the real upstream gateway
        // via runtimeConfig.remoteEndpoint (see desktop runtime-configs.ts +
        // env-builder.ts remote branch), so this should never fire — if it does, the
        // remote env was assembled wrong; reject rather than let remote cc dial a
        // loopback URL it can't reach.
        if (isLoopbackEndpoint(remoteEnv?.ANTHROPIC_BASE_URL)) {
          throw new Error('[REMOTE_COMPAT_MODE_UNSUPPORTED] Remote Claude Code sessions cannot route through the local compat proxy.');
        }
        // startParams shape 跟 sdkQuery options 同源 (cwd / model / env / mcpServers /
        // permissionMode / systemPrompt / additionalDirectories), JSON 序列化时
        // canUseTool / pathToClaudeCodeExecutable / stderr / hooks 等 callback/path
        // 字段不能序列化。权限回调由反向 RPC 承接；host capability route 则转成
        // 下方 JSON-safe toolGuards，由 daemon 重建 PreToolUse hook，避免远端
        // settings allow 规则或 bypassPermissions 绕过来源选择。
        //
        // mcpServers: 远端 cc MVP 只支持 stdio / sse / http 三种 process-transport
        // server (plain JSON 可跨进程)。in-process SDK MCP (type='sdk' + 闭包 instance)
        // 不可序列化 — instance 里藏 ajv SchemaEnv 循环引用, JSON.stringify 会爆栈。
        // 直接 filter 掉, 让远端 daemon 用 stdio/sse/http MCP 跑; 本地 lizi-* 全套
        // in-process MCP 在远端会话里不可用(远端 cc MVP 的已知限制)。
        const remoteMcpServers = mcpServers
          ? Object.fromEntries(
              Object.entries(mcpServers).reduce<Array<[string, unknown]>>((acc, [name, cfg]) => {
                const c = cfg as { type?: string; command?: unknown };
                const t = c.type;
                if (t === undefined && typeof c.command === 'string') {
                  acc.push([name, { ...cfg, type: 'stdio' }]);
                } else if (t === 'stdio' || t === 'sse' || t === 'http') {
                  acc.push([name, cfg]);
                }
                return acc;
              }, []),
            )
          : undefined;
        if (mcpServers && remoteMcpServers && Object.keys(mcpServers).length !== Object.keys(remoteMcpServers).length) {
          const dropped = Object.keys(mcpServers).filter((k) => !(k in remoteMcpServers));
          log.warn('cc remote: dropping in-process MCP servers (MVP not supported)', { dropped });
        }
        // 远端会话的 server 基线是 remoteMcpServers (被 filter 掉的 in-process server
        // 在远端不存在); 但 factory 还可能注入 host 侧 http server (协同恢复通道),
        // 所以审批归属快照不在此处定稿, 挪到 factory 调用后按 startParams 重算。
        // 计划模式开启时远端 SDK 同样跑 plan; 读 mutable 值让 rewind 重建也拿到当前档。
        const requestedRemotePermissionMode = extra?.permissionMode ?? effectiveSdkPermissionMode();
        const remoteHasMcpServers = Object.keys(remoteMcpServers ?? {}).length > 0;
        // effectiveSdkPermissionMode() is computed from the local registration snapshot,
        // which still includes in-process SDK MCPs that were just filtered out above.
        // Restore native OAuth Auto when the remote query has no serializable MCP surface;
        // the Desktop factory will still downgrade it before opening the query if it later
        // injects a host HTTP MCP (for example the collaboration bridge).
        const remotePermissionMode =
          requestedRemotePermissionMode === 'default'
          && mutablePermissionMode === 'auto'
          && !mutablePlanMode
          && !planTurnActive
          && !nativeAutoReviewUnavailable
          && mutableAutoReviewCredentialMode === 'oauth-bearer'
          && !remoteHasMcpServers
            ? 'auto'
            : requestedRemotePermissionMode;
        sdkInPlanMode = remotePermissionMode === 'plan';
        const remoteToolGuards = [
          ...buildClaudeRemoteToolGuards(this.deps.capabilityRouting),
          ...buildClaudeRemoteOrcaCallerGuards(vo.orcaRole === 'worker'),
        ];

        const startParams: Record<string, unknown> = {
          cwd: opts.workingDir,
          model: currentSdkModel,
          // 关键: 远端必须用 remoteEnv (零 process.env 继承), 不能用本地分支的
          // env。否则 desktop 的 HOME / PATH / APPDATA 等会污染远端 SDK spawn 的
          // cc CLI(典型: Windows HOME=C:\Users\Lizi 透到 mac, 远端 cc CLI
          // 把 ~ 展开成 <cwd>/C:\Users\Lizi/.claude/, session 全落怪目录)。
          // remoteEnv 在 startSession 顶部已经 build (opts.remoteHostId 非空时
          // 才 build), 这里 ! 是合理的 — 走到这分支 remoteCcQueryFactory 也已经
          // gate 过 remoteHostId 非空。
          env: remoteEnv ?? env,
          permissionMode: remotePermissionMode,
          // cc-manager 的 QueryStartParams 已原生支持 allowedTools; 传副本避免 RPC
          // 序列化前后任一侧原地改写 session 快照。
          ...(claudeAllowedTools ? { allowedTools: [...claudeAllowedTools] } : {}),
          ...(remoteToolGuards.length > 0
            ? { toolGuards: remoteToolGuards }
            : {}),
          systemPrompt: (() => {
            const appendText = [
              MAKER_SYSTEM_PROMPT_APPEND,
              makerMemoryRules,
              contactsRules,
              ghostRosterPrompt,
              hostSystemPrompt,
              makerMemoryIndex,
              opts.userPrompt,
            ]
              .filter((s): s is string => !!s && s.trim().length > 0)
              .join('\n\n');
            return {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              ...(appendText ? { append: appendText } : {}),
            };
          })(),
          // **不透传 extraDirs 到远端**: mutableExtraDirs 由 desktop session/draft
          // 提供, 路径基于 desktop 本地文件系统 (用户拖进来的文件夹), 跟远端机器
          // 上的路径毫无关系。SDK 把 additionalDirectories 当 cwd 之外的允许范围,
          // 用 desktop 路径只会让远端 SDK 报"路径不存在 / 不在允许范围"或者更糟,
          // 误把同名远端路径加进允许范围。远端 cwd 在 startParams.cwd 已传, 别处
          // 想加额外目录要由远端用户在远端机器上配置, 不在本 PR scope。
          ...(remoteMcpServers && Object.keys(remoteMcpServers).length > 0 ? { mcpServers: remoteMcpServers } : {}),
          ...(resumeSdkSid ? { resumeSdkSessionId: resumeSdkSid } : {}),
          // includePartialMessages 必须跟本地分支保持一致 — 否则 daemon 端 SDK
          // 不发 stream_event / message_delta, UsageTracker 拿不到 per-turn cache
          // 数据 (cache hit rate 永远 n/a, 违反规则 19), renderer 也失去增量打字
          // 动效。cache 实际是热的, 只是观测链路断了。
          //
          // 走 extraOptions 通道: QueryStartParams 顶层枚举字段没列 it, daemon
          // destructure 拿不到; 但 daemon 末尾 spread `...extraOptions` 进 SDK
          // options (cc-mgr.ts:106), 所以 extraOptions 是任意 SDK 字段的统一透传出口。
          extraOptions: {
            includePartialMessages: true,
            ...thinkingOpts,
            ...(currentSdkEffort ? { effort: currentSdkEffort } : {}),
            // settings 对象跟本地分支同源 — 不透传则远端 SDK 拿不到
            // showThinkingSummaries / autoMemoryEnabled, 远端行为跟本地分歧。
            settings: buildSettings(),
            // settingSources 跟本地分支同源透传:远端 cc CLI 会读用户在远端机器
            // 上的 ~/.claude / 项目 .claude / cwd-local 三层 settings 文件 (slash
            // commands / output styles / hooks / per-project model 等)。不透传
            // SDK 默认不读, 远端会丢用户配置, 跟本地行为分歧。
            settingSources: ['user', 'project', 'local'],
          },
        };

        const remoteQuery = await this.deps.remoteCcQueryFactory({
          remoteHostId: opts.remoteHostId,
          sessionId: opts.sessionId,
          ...(opts.sessionInstanceId ? { sessionInstanceId: opts.sessionInstanceId } : {}),
          startParams,
          // 协同身份以 session 自己的 vendorOptions 为准 (worker 首次创建时
          // DB 标记尚未写入, host 现场查库会拿到空角色)。见 base-agent.ts
          // remoteCcQueryFactory 的 vendorOptions 注释。
          vendorOptions: vo,
          // per-session Maker Memory 开关 — host 据此决定是否把 cindy_memory
          // 以 http 形态注进远端 startParams.mcpServers (cc-remote-mcp.ts)。
          makerMemoryEnabled,
          onApprovalRequest: async (rawParams: unknown) => {
            // 110s timeout — must respond before daemon's 120s server-request timeout.
            // On timeout, dismiss the pending interaction (clears UI) and reject to
            // let cc-manager-client return deny to daemon.
            const REMOTE_APPROVAL_TIMEOUT_MS = 110_000;
            async function dispatchWithTimeout(
              req: InteractionRequest,
              dispatchOpts?: { forcePrompt?: boolean },
            ): Promise<InteractionDecision> {
              let timer: NodeJS.Timeout | undefined;
              try {
                return await new Promise<InteractionDecision>((resolve, reject) => {
                  timer = setTimeout(() => {
                    dismissSinglePending(req.requestId, 'approval_timeout');
                    reject(new Error('approval timed out'));
                  }, REMOTE_APPROVAL_TIMEOUT_MS);
                  dispatchInteraction(req, dispatchOpts).then(resolve, reject);
                });
              } finally {
                if (timer) clearTimeout(timer);
              }
            }
            const params = rawParams as {
              sessionId: string;
              requestId: string;
              kind: 'permission' | 'ask_user_question' | 'plan_review';
              toolName?: string;
              input?: Record<string, unknown>;
              title?: string;
              displayName?: string;
              description?: string;
              suggestions?: unknown[];
              metadata?: Record<string, unknown>;
              questions?: unknown[];
              plan?: string;
              planFilePath?: string;
            };
            if (params.kind === 'ask_user_question') {
              const askInput = (params.input ?? {}) as { questions?: unknown[] };
              const decision = await dispatchWithTimeout({
                kind: 'ask_user_question',
                requestId: params.requestId,
                questions: (params.questions ?? askInput.questions ?? []) as AskUserQuestionItem[],
              });
              if (decision.kind !== 'ask_user_question') {
                return { kind: 'ask_user_question', answers: {} };
              }
              // 远端澄清同样改变本轮授权范围(用户把范围从 src/ 收窄到 build/)→ 与本地 AskUserQuestion
              // 分支一致地并入有界 review intent 并清空裁决缓存,否则后续工具仍按澄清前的意图裁决、
              // 越界操作可能被静默允许(codex 报)。
              setAutoReviewIntent(composeAutoReviewIntentWithClarification(
                currentAutoReviewIntent,
                Object.entries(decision.answers ?? {}).map(([question, answer]) => ({ question, answer })),
              ));
              return { kind: 'ask_user_question', answers: decision.answers };
            }
            if (params.kind === 'plan_review') {
              const planInput = (params.input ?? {}) as { plan?: string; planFilePath?: string };
              const plan = params.plan ?? planInput.plan ?? '';
              // 审批等待期间用户可能继续发消息(setAutoReviewIntent 会覆盖 currentAutoReviewIntent),
              // 实施阶段的审查意图必须锚在**发起计划时**的原始请求上,不能掺进审批期间的内部跟进
              // (copilot 报;与本地 ExitPlanMode 分支的 planRequestAutoReviewIntent 同款)。
              const planRequestAutoReviewIntent = currentAutoReviewIntent;
              const decision = await dispatchWithTimeout({
                kind: 'plan_review',
                requestId: params.requestId,
                plan,
                planFilePath: params.planFilePath ?? planInput.planFilePath,
              });
              if (decision.kind !== 'plan_review') {
                return { kind: 'plan_review', behavior: 'deny', reason: 'resolver kind mismatch' };
              }
              if (decision.behavior === 'allow') {
                appendActiveCapabilitySelectionText(
                  capabilitySelectionAddedByPlanEdit(
                    this.deps.capabilityRouting,
                    'claude-code',
                    plan,
                    decision.editedPlan,
                  ),
                );
                // 远端计划获批同样要把审查意图更新成"原始意图 + 最终获批计划"—— 与本地 ExitPlanMode 分支
                // 一致,否则后续实施工具的轻量 reviewer 仍按批准前的过期意图裁决(codex 报)。
                setAutoReviewIntent(composeAutoReviewIntentWithApprovedPlan(
                  planRequestAutoReviewIntent,
                  decision.editedPlan ?? plan,
                ));
              } else if (!decision.dismissed) {
                appendActiveCapabilitySelectionText(decision.reason);
              }
              return {
                kind: 'plan_review',
                behavior: decision.behavior,
                editedPlan: decision.editedPlan,
                reason: decision.reason,
                dismissed: decision.dismissed,
              };
            }
            // permission kind
            const remoteToolName = params.toolName ?? '';
            // Remote cc-manager checks the route with authoritative scoped MCP
            // provenance before forwarding canUseTool. Old managers do not add
            // this attestation, so retain the desktop-side fail-closed fallback.
            const capabilityRoute = params.metadata?.capabilityRoutingChecked === true
              ? undefined
              : deniedCapabilityRoute(remoteToolName);
            if (capabilityRoute) {
              log.warn('cc remote: downstream MCP source denied by host capability route', {
                toolName: remoteToolName,
                capabilityId: capabilityRoute.capabilityId,
                replacement: capabilityRoute.replacement?.id,
              });
              return {
                kind: 'permission',
                behavior: 'deny',
                reason: capabilityRoute.replacement
                  ? `This downstream source was not selected. Use Cindy capability ${capabilityRoute.replacement.id}.`
                  : 'This downstream source was not selected.',
              };
            }
            // 没接 resolver 时，Auto 的内置工具仍可由本地规则/轻量 reviewer 完成
            // allow 或 block；只有真正 ask 才需要 UI。非 Auto 与 MCP 保持 fail-closed。
            const canReviewRemoteWithoutUi =
              mutablePermissionMode === 'auto' && !remoteToolName.startsWith('mcp__');
            if (!interactionResolver && !canReviewRemoteWithoutUi) {
              if (isReadOnlyClaudeTool(remoteToolName)) {
                return { kind: 'permission', behavior: 'allow' };
              }
              log.warn('cc remote: approval without interactionResolver → fail-closed deny', {
                tool: remoteToolName || 'unknown',
              });
              return {
                kind: 'permission',
                behavior: 'deny',
                reason: 'no interaction resolver attached; denying non-read-only tool (fail-closed)',
              };
            }
            if (mutablePermissionMode === 'bypassPermissions') {
              return { kind: 'permission', behavior: 'allow' };
            }
            // 远端会话走同一份 host MCP 策略 —— 否则 SSH 会话里可信 server 又要逐次
            // 弹窗, prompt-each-time 的"禁止持久化授权"保护也整套缺失。
            const remoteTurnPolicyForcePrompt = forceTurnConfirmation(
              remoteToolName || 'unknown',
              params.input ?? {},
            );
            const remoteMcpPolicy = classifyMcpApprovalPolicy(remoteToolName, params.input ?? {});
            let remoteForcePrompt = remoteTurnPolicyForcePrompt;
            if (
              mutablePermissionMode === 'auto'
              && remoteToolName
              && !remoteToolName.startsWith('mcp__')
            ) {
              const autoDecision = await reviewAutoAction(
                normalizeBuiltinToolForAutoReview(remoteToolName, params.input ?? {}),
                [opts.workingDir].filter(
                  (d): d is string => typeof d === 'string' && d.length > 0,
                ),
                'linux',
              );
              if (!remoteTurnPolicyForcePrompt && autoDecision.verdict === 'allow') {
                return { kind: 'permission', behavior: 'allow' };
              }
              if (!remoteTurnPolicyForcePrompt && autoDecision.verdict === 'block') {
                // 与本地分支同口径:审阅器故障要提示一次,模型判定保持静默。
                if (autoDecision.unavailable) autoReviewUnavailableNotice.notify();
                return {
                  kind: 'permission',
                  behavior: 'deny',
                  reason: autoDecision.reason ?? 'Cindy Auto Review blocked this action. Choose a safer alternative.',
                };
              }
              remoteForcePrompt = true;
            } else {
              if (remoteMcpPolicy === 'auto-approve' && !remoteTurnPolicyForcePrompt) {
                return { kind: 'permission', behavior: 'allow' };
              }
              remoteForcePrompt = remoteForcePrompt || remoteMcpPolicy === 'prompt-each-time';
            }
            const decision = await dispatchWithTimeout({
              kind: 'permission',
              requestId: params.requestId,
              toolName: params.toolName ?? 'unknown',
              input: params.input ?? {},
              title: params.title,
              displayName: params.displayName,
              description: params.description,
              suggestions: remoteForcePrompt
                ? undefined
                : this.normalizeSessionPermissionSuggestions(params.suggestions),
              metadata: params.metadata ?? {},
            }, { forcePrompt: remoteForcePrompt });
            if (decision.kind !== 'permission') {
              return { kind: 'permission', behavior: 'deny', reason: 'resolver kind mismatch' };
            }
            if (remoteForcePrompt && decision.permissionUpdates && decision.permissionUpdates.length > 0) {
              log.warn('dropping session permission grant for prompt-each-time MCP tool (remote)', {
                tool: params.toolName,
              });
            }
            return {
              kind: 'permission',
              behavior: decision.behavior,
              updatedInput: decision.updatedInput,
              permissionUpdates: remoteForcePrompt ? undefined : decision.permissionUpdates,
              reason: decision.reason,
            };
          },
          // 订阅 token 到期续命(远端版,对齐本地 SDK options 的 getOAuthToken 回调,
          // 见 buildQuery 本地分支):远端 cc 中途 401 → daemon 发 oauth/refresh 反向
          // RPC → 这里向 host 要新 token。接线条件与本地同款:env 实际带订阅 token 且
          // host 实现了强刷 —— 网关 key / 自定义供应商会话绝不接,避免 API-key 401 被
          // 误引导去刷订阅 token。刷新语义(失败基线 / 原地写回单一事实源)与本地共用
          // refreshSubscriptionTokenInPlace。
          ...(remoteEnv?.CLAUDE_CODE_OAUTH_TOKEN && this.deps.auth.getFreshSubscriptionToken
            ? {
                onOAuthRefresh: async (): Promise<unknown> => ({
                  token: await this.refreshSubscriptionTokenInPlace(remoteEnv),
                }),
              }
            : {}),
        });
        // factory 可能注入 host 侧 http server (远端 cc 协同恢复通道的
        // cindy_orca / orca_worker_bridge, 见 maker-host remoteCcQueryFactory),
        // 审批归属快照必须按注入后的最终清单定稿, 否则 canUseTool 的
        // resolveMcpToolTarget 认不出 orca server 名, 归属判定缺失。
        hostMcpServerNames = new Set(
          Object.keys((startParams as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}),
        );
        registeredMcpServerNames = hostMcpServerNames;
        nonHarnessMcpServerNames = hostMcpServerNames;
        // The factory may inject host HTTP MCPs and downgrade OAuth Auto to
        // default before opening cc-manager. Track the post-factory mode so a
        // later SDK init cannot repeat that downgrade and turn a harmless
        // control-RPC failure into a fatal close.
        const finalRemotePermissionMode =
          (startParams.permissionMode as SdkPermissionMode | undefined) ?? remotePermissionMode;
        sdkInPlanMode = finalRemotePermissionMode === 'plan';
        // 记入 closure: handle.close / U2 兜底需要 await remoteQuery.close()。
        activeRemoteQuery = remoteQuery as unknown as { close: () => Promise<void>; detach?: () => Promise<void> };

        // Bridge inputQueue (maker-core push) → remoteQuery.send (RPC)。
        // 失败处理 (round-16 fix #2 P2): 之前只 warn → user message 永远不到
        // daemon, 但 handle.send 已经 armed streaming state, renderer 卡在
        // "thinking..." 直到 idle watchdog (默认数分钟) 才解套。改成主动调
        // activeRemoteQuery.close() 关闭 RemoteQuery → close subscription
        // 让 RemoteQuery iterator 自然结束 → maker-core 主循环 for-await 退出
        // → 复用 U2 兜底 (本文件 line ~1418-1471) emit error + done +
        // dismissAllPending + inputQueue.end + abort, 用户立即看到 "远端连接
        // 中断" 错误能重发, 不再卡 watchdog 时长。break for-await 防后续
        // inputQueue msg 又调死掉的 send 触发同款 warn。
        (async (): Promise<void> => {
          for await (const msg of inputQueue) {
            try {
              await (remoteQuery as unknown as {
                send: (m: unknown) => Promise<void>;
              }).send(msg);
            } catch (e) {
              log.warn('cc remote: forwarding inputQueue → remoteQuery.send failed; closing remote query to surface aborted-turn', {
                error: String((e as Error)?.message ?? e),
              });
              if (activeRemoteQuery) {
                void activeRemoteQuery.close().catch((err) => {
                  log.warn('cc remote: remoteQuery.close after send failure threw (best-effort)', {
                    error: String((err as Error)?.message ?? err),
                  });
                });
              }
              break;
            }
          }
        })().catch(() => undefined);

        if (finalRemotePermissionMode === 'auto') nativeAutoQueries.add(remoteQuery);
        return remoteQuery;
      }

      // ── 本地 SDK 分支 ──
      // resume 转录就位兜底:CLI 只按当前 cwd 的转码目录查找转录,而转录可能因
      // CLI 运行中 cd(worktree 工作流)、rewind fork(新 jsonl 落在源文件旁)等
      // 场景落在其它转码目录(见 transcript-relocation.ts)。spawn 前把 jsonl 归位;
      // projectsRoot 按子进程实际可见的 CLAUDE_CONFIG_DIR 解析(SDK spawn 时
      // {...process.env, ...env} 合并,env 覆盖优先)。best-effort:已在位只花一次
      // stat,失败/缺失只记日志不阻断——CLI 找不到时仍按原行为报错。
      if (resumeSdkSid && opts.workingDir) {
        try {
          const claudeConfigDir =
            env.CLAUDE_CONFIG_DIR ??
            process.env.CLAUDE_CONFIG_DIR ??
            path.join(os.homedir(), '.claude');
          const outcome = await ensureClaudeTranscriptInWorkingDir({
            sdkSessionId: resumeSdkSid,
            workingDir: opts.workingDir,
            projectsRoot: path.join(claudeConfigDir, 'projects'),
          });
          if (outcome === 'restored') {
            log.info('resume transcript restored into cwd project dir', {
              resumeSdkSid,
              workingDir: opts.workingDir,
            });
          }
          // kimi 系 tool_call id 归一化: moonshot 按可见历史铸造 `${name}_${index}`
          // id, rewind/中断造成的可见数回落会让新铸 id 与历史撞车, CLI 的
          // ensureToolResultPairing 随即将重复 id 的 tool exchange 整段丢弃并以
          // "(no content)" 占位 user 消息 —— 模型看到"自己的工具调用被阻止 +
          // 用户连发空消息"进入空转(2026-07-31 kimi-k3 实测)。转录就位后、spawn
          // 前做一次幂等归一化(重复 id 去重 + 数字后缀移出铸造空间), 纯 Anthropic
          // 会话预扫不命中、零解析开销。详见 jsonl-tool-id-normalize.ts 头注。
          // 'target-key-inexact' 时 relocation 无法定位 CLI 转码目录, 但全局扫描
          // 找到的最新副本大概率正是 CLI 要读的转录, 归一化它同样是正收益。
          if (outcome !== 'missing' && resumeSdkSid) {
            const transcriptFile = await findClaudeSessionJsonl(
              resumeSdkSid,
              opts.workingDir,
              path.join(claudeConfigDir, 'projects'),
            );
            if (transcriptFile) {
              const normalized = await normalizeClaudeSessionJsonlToolIds(transcriptFile);
              if (normalized.changed) {
                log.info('resume transcript tool ids normalized', {
                  resumeSdkSid,
                  dedupedBlocks: normalized.dedupedBlockCount,
                  offsetBlocks: normalized.offsetBlockCount,
                  duplicateIds: normalized.duplicateIdCount,
                  backupPath: normalized.backupPath,
                });
              }
            }
          }
          if (outcome === 'missing') {
            const cleared = await clearInvalidResumeSession(resumeSdkSid, 'transcript_preflight');
            if (cleared) {
              // 本地 CLI 没有转录就不可能恢复。spawn 前转 fresh，当前用户消息尚未
              // dispatch，不需要运行期 replay，也不会产生任何失败边界事件。
              // 重置 recovery 标记：后续全新会话是独立生命周期,若首 turn 产生幽灵 id
              // 仍需 runtime 路径清理,不应被 preflight 的一次性消耗阻塞。
              resumeRecoveryAttempted = false;
              freshSessionValidationPending = true;
              resumeSdkSid = undefined;
            } else {
              log.warn('resume transcript not found in any project dir (CLI resume may fail)', {
                resumeSdkSid,
                workingDir: opts.workingDir,
              });
            }
          }
        } catch (e) {
          log.warn('resume transcript bootstrap failed (continuing)', {
            resumeSdkSid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      // 计划模式开启时 SDK 跑 plan; 读 mutable 值让 rewind/fork 重建拿到当前档而非创建时快照。
      const sdkStartPermissionMode = extra?.permissionMode ?? effectiveSdkPermissionMode();
      sdkInPlanMode = sdkStartPermissionMode === 'plan';
      const query = sdkQuery({
        prompt: inputQueue as unknown as Parameters<typeof sdkQuery>[0]['prompt'],
        options: {
          abortController,
          cwd: opts.workingDir,
          // 附加只读引用目录 — 每 turn buildQuery 读最新 closure 值, setExtraDirs 改完
          // 下一 turn 立即生效 (turn-by-turn 装配)。空数组省略字段, 让 SDK 走默认。
          ...(mutableExtraDirs.length > 0 ? { additionalDirectories: mutableExtraDirs } : {}),
          model: currentSdkModel,
          ...(currentSdkEffort ? { effort: currentSdkEffort } : {}),
          permissionMode: sdkStartPermissionMode,
          includePartialMessages: true,
          ...thinkingOpts,
          pathToClaudeCodeExecutable: binaryPath,
          // systemPrompt 七段拼接(含 SDK 内嵌 preset)— SDK 先输出 preset, 再追加 append 字段。
          //   [1] cc preset                  — Claude SDK 自带 (内嵌不可见)
          //   [2] MAKER_SYSTEM_PROMPT_APPEND — maker engine (system-prompt-append.md)
          //   [3] makerMemoryRules           — maker memory 写入规范 (条件式: makerMemoryEnabled
          //                                    且 manager 注入成功才注入)
          //   [4] contactsRules              — 智能通讯录两态段 (条件式: host 注入了
          //                                    getContactsPromptState 才有, 开/关各一份静态文案)
          //   [5] hostSystemPrompt           — host runtime (runtimeConfig.systemPrompt)
          //   [6] makerMemoryIndex           — 当前 workdir MEMORY.md 内容 (条件式, 紧邻 userPrompt
          //                                    高优先级, 启动时快照 — 跟 userPrompt 同语义)
          //   [7] opts.userPrompt            — per-call 用户级 (renderer 本地 storage,
          //                                    每次 startSession 透传, 优先级最高)
          // 空段被 .filter 跳过 (.md 文件为空 / userPrompt 为空 = 不 append).
          systemPrompt: (() => {
            const appendText = [
              MAKER_SYSTEM_PROMPT_APPEND,
              makerMemoryRules,
              contactsRules,
              ghostRosterPrompt,
              hostSystemPrompt,
              makerMemoryIndex,
              opts.userPrompt,
            ]
              .filter((s): s is string => !!s && s.trim().length > 0)
              .join('\n\n');
            return {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              ...(appendText ? { append: appendText } : {}),
            };
          })(),
          ...(resumeSdkSid ? { resume: resumeSdkSid } : {}),
          enableFileCheckpointing,
          ...(finalResumeAt ? { resumeSessionAt: finalResumeAt } : {}),
          ...(finalFork ? { forkSession: true } : {}),
          env,
          ...(this.deps.registerLocalAgentProcess
            ? {
                spawnClaudeCodeProcess: (spawnOptions) =>
                  spawnObservedClaudeProcess({
                    spawnOptions,
                    registerProcess: (pid) =>
                      this.deps.registerLocalAgentProcess?.({
                        pid,
                        kind: 'claude',
                        role: 'task-host',
                      }),
                    onStderr: vo.onStderrLine as ((line: string) => void) | undefined,
                  }),
              }
            : {}),
          // 订阅 token 到期续命回调 —— 仅当本次 spawn 实际注入了订阅 OAuth token
          // (oauth-spawn, 见 desktop auth-adapters getAuthEnv)且 host 实现了强刷时接线。
          // cc 侧 turn 中途 401 会发 oauth_token_refresh control 请求, SDK 调本回调向
          // host 要新 token (SDK 检测到回调存在时自动注入 CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH=1
          // 告知 CLI)。gateway-key 模式 env 里没有 CLAUDE_CODE_OAUTH_TOKEN, 不接 —— 避免
          // API-key 401 被误引导去刷订阅 token。回调字段 SDK Options 类型未声明但运行时
          // 支持 (sdk.mjs oauth_token_refresh 分支), 经 spread 注入绕过 excess property 检查。
          // ⚠️ 本回调生效有两个前提, 缺一即静默失效: (a) SDK 注入的 SDK_HAS_OAUTH_REFRESH;
          // (b) CLAUDE_CODE_ENTRYPOINT 在 cc 的白名单内 —— 由 env-builder 在 oauth-spawn
          // 时强制设为 claude-vscode。cc 的 401 恢复有两条路: 先走本回调
          // (tengu_oauth_401_sdk_callback_refreshed), 回调超时/失败后还会直接重读系统
          // 凭证库兜底 (tengu_oauth_401_recovered_from_disk) —— host 刷新总是写回凭证库,
          // 所以即使回调超时返回 null, 第二条路仍能捡到新 token, 排障时两条都要看。
          ...(env.CLAUDE_CODE_OAUTH_TOKEN && this.deps.auth.getFreshSubscriptionToken
            ? {
                getOAuthToken: (): Promise<string | null> =>
                  this.refreshSubscriptionTokenInPlace(env),
              }
            : {}),
          // 第一方只读工具由 host 精确列名, 直接走 SDK public allowlist, 避免
          // permissionMode=auto 时再调用远程安全分类器。动态聚合入口不在列表中。
          ...(claudeAllowedTools ? { allowedTools: [...claudeAllowedTools] } : {}),
          canUseTool,
          settingSources: ['user', 'project', 'local'],
          // Settings (SDK "flag settings" 层, 优先级最高 — 覆盖 user/project/local 文件层):
          //  - showThinkingSummaries        : reasoning summary 展示开关
          //  - autoMemoryEnabled / autoDream: memory 联动 (host 通过 runtimeConfig.memoryEnabled 或
          //    BaseAgent.setMemory 控制; this.memoryOverride === undefined 时不传, 让 SDK 走默认)
          // **同一对象远端分支也透传 (extraOptions.settings)**, 别在两边漂移。
          settings: buildSettings(),
          allowDangerouslySkipPermissions: true,
          stderr: vo.onStderrLine as ((line: string) => void) | undefined,
          // SDK debug 等同 --debug CLI flag, 让 cc 子进程吐 verbose 日志。
          // - debug: true 触发 verbose 模式
          // - debugFile (可选): 直接写到指定文件, 绕过 stderr 这条对 SEA 二进制不一定通的路
          // host 在开 debug 时通过 resolveCcDebugFile 把 debugFile 指到该 session 的
          // sessions/<id>/cc-debug.raw.log (见上 ccDebugFile); 没注入则回退全局
          // XDT_CC_DEBUG_FILE, 都没有就只开 debug:true 走 stderr 兜底。
          ...(process.env.XDT_CC_DEBUG_NET === '1'
            ? {
                debug: true,
                ...(ccDebugFile ? { debugFile: ccDebugFile } : {}),
              }
            : {}),
          ...(mcpServers ? { mcpServers } : {}),
          // Host hooks keep their normal behavior, while the harness adapter
          // prepends its narrow capability-route guard. Both run in-process
          // before Claude's permission mode (including Full access).
          ...(Object.keys(localClaudeHooks).length > 0
            ? { hooks: localClaudeHooks }
            : {}),
        },
      });
      if (sdkStartPermissionMode === 'auto') nativeAutoQueries.add(query);
      return query;
    };

    // ── 死 handle 终结器 —— U2 (远端 daemon 突死) 与 crash (SDK 流异常) 共用 ──
    // 底层 query 已死且不会有新 q 接管时, 必须执行等同 handle.close() 的全套副作用,
    // 否则 handle 对外装活: closed 不置位 → finally 不 end eventQueue → Session.runEventLoop
    // 挂着不退出 → session.ts 的自然结束兜底 setStatus('closed') 永不触发 → Maker
    // activeSessions 一直复用死 Session → 下次 send 把消息 push 进无消费者的 inputQueue,
    // 用户看到"排队但无运行态、无法停止"的黑洞会话 (2026-07-05 fork resume 失败实踩)。
    // closed=true 后 finally 的 eventQueue.end() 收尾 → Session 自动 close → 下次 send
    // 走 IPC lazy create-session 重建 handle。
    function teardownDeadHandle(logLabel: string): void {
      // Provider death is not a successful user cancellation. Session status
      // and the queued terminal error/done must decide observer settlement.
      discardActiveContinuation(logLabel);
      turnInFlight = false;
      // handle 死透 → 后续没有排队 turn 可跑, counter 归零避免残留污染下一 handle 重建
      // (虽然 closed=true + inputQueue.end 已经让新消息进不来, 归零是防御性一致)
      clearBridgeState();
      pendingToolIds.clear();
      runningBackgroundTasks.clear();
      terminalBackgroundTaskIds.clear();
      closed = true;
      try { dismissAllPending('session_closed', 'deny'); } catch (e) {
        log.warn(`${logLabel}: dismissAllPending threw`, { error: String(e) });
      }
      try { inputQueue.end(); } catch (e) {
        log.warn(`${logLabel}: inputQueue.end threw`, { error: String(e) });
      }
      try { abortController.abort(); } catch (e) {
        log.warn(`${logLabel}: abortController.abort threw`, { error: String(e) });
      }
      // remoteQuery.close 是 async + 可能已经死了 (RpcClient closed), 调它会走
      // 兜底 catch (best-effort)。fire-and-forget 不 await — startForwardLoop
      // 里同步路径不能阻塞 finally。
      if (activeRemoteQuery) {
        void (activeRemoteQuery.detach ?? activeRemoteQuery.close)().catch((e) => {
          log.warn(`${logLabel}: remoteQuery.detach threw (best-effort)`, {
            error: String(e),
          });
        });
      }
    }

    let bridgeSuppressedDoneData: Record<string, unknown> | undefined;
    function clearBridgeState(): void {
      queuedBridgeTurns = 0;
      activeBridgeKind = null;
      activeBridgeRewindResumeAt = undefined;
      bridgeCompactUsageSnapshot = null;
      bridgeSuppressedDoneData = undefined;
    }
    function takeBridgeSuppressedDoneData(): Record<string, unknown> | undefined {
      const data = bridgeSuppressedDoneData;
      bridgeSuppressedDoneData = undefined;
      return data;
    }
    function rememberBridgeSuppressedDoneData(data: unknown): void {
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;
      bridgeSuppressedDoneData = { ...(data as Record<string, unknown>) };
    }

    function emitTurnBoundary(
      reason: string,
      doneData?: Record<string, unknown>,
      trackContinuationTerminal = false,
    ): boolean {
      eventQueue.push({
        type: 'status',
        data: { status: 'Done', ...usageTracker.snapshot(), isRunning: false },
        source: 'claude-code',
      });
      const doneEvent: AgentEvent = {
        type: 'done',
        data: { ...(doneData ?? {}), reason },
        source: 'claude-code',
      };
      if (trackContinuationTerminal) {
        continuationTerminalBoundaryEvents.add(doneEvent);
        pendingContinuationTerminalBoundaries += 1;
      }
      const accepted = eventQueue.push(doneEvent);
      if (trackContinuationTerminal) {
        if (!accepted) {
          continuationTerminalBoundaryEvents.delete(doneEvent);
          pendingContinuationTerminalBoundaries = Math.max(
            0,
            pendingContinuationTerminalBoundaries - 1,
          );
        }
      }
      return accepted;
    }

    const canceledBridgeQueries = new WeakSet<Query>();
    // RemoteQuery.close() is asynchronous. User Stop records the in-flight
    // close promise here so an immediate send/rewind can wait for the remote
    // session to become dead before creating its replacement Query.
    const canceledQueryClosePromises = new WeakMap<Query, Promise<void>>();
    function recordCanceledQueryClose(query: Query, reason: string): void {
      let closePromise: Promise<void>;
      try {
        closePromise = Promise.resolve(query.close());
      } catch (error) {
        log.warn(`${reason}: q.close threw`, { error: String(error) });
        closePromise = Promise.reject(error);
      }
      canceledQueryClosePromises.set(query, closePromise);
      // Attach a handler immediately so a remote close rejection cannot
      // become unhandled before rebuild awaits the recorded promise.
      void closePromise.catch((error) => {
        log.warn(`${reason}: q.close rejected`, { error: String(error) });
      });
    }
    // Despite the historical name, this per-query fence also marks an old
    // Query closed after user Stop cancels an awaiting continuation. Its
    // forward loop must silently discard any buffered tail until the next
    // fresh Query is installed.
    // Rewind commit 会 close 当前 Query,但它的 forward loop 可能晚于下一次 send 的
    // rebuild 完成才退出。pendingRewindTo 是共享状态,会在新 q 接管后清掉;旧 q 自身仍
    // 需要一个 per-query 标记,否则迟到的 stream_end/abort 会被误判为当前新 q 的崩溃。
    const rewindTransitionQueries = new WeakSet<Query>();

    // ── 后台任务追踪(用户 Stop 的确定性全停,2026-07-16 Lizi 拍板)──────────
    // 产品语义:用户点 Stop = 本会话所有模型调用停止,不允许残留。q.interrupt()
    // 只中断当前 turn;跨 turn 存活的后台 wake 任务(subagent / workflow)会继续
    // 调模型烧用量(2026-07-13 事故形态),abort 时必须逐个 q.stopTask()。
    // 数据源:translator 产出的 agent_task_update(running 进表 / 终态出表)。
    // taskType 只保证在 task_started 携带,后续 task_updated 补丁可能缺失 ——
    // 一旦见过 wake 型就锁存,补丁不会把 wake 降级。
    // 只停 wake 型(local_agent / local_workflow,与 renderer 折算口径一致):
    // local_bash 不调模型(dev server 等长驻进程不能被 Stop 误杀);remote_agent
    // 生命周期不在本进程。q.close() 会连 CLI 子进程一起杀(任务随之死亡),
    // 换代 / teardown / close 时清表。
    // 元数据(taskType / toolUseId / title)与 wake 同口径锁存:task_started 全量携带,
    // 后续 task_updated 补丁可能缺失,补丁不得把已知字段冲掉 —— listBackgroundTasks
    // 快照(renderer 挂载/重载后重新水合任务卡)依赖这些字段还原展示。
    const runningBackgroundTasks = new Map<
      string,
      { wake: boolean; taskType?: string; toolUseId?: string; title?: string }
    >();
    // SDK task progress can race behind its terminal notification. Once a task
    // is terminal within the current Query generation, a late running/progress
    // patch must not resurrect it into runningBackgroundTasks and manufacture
    // a fresh continuation claim at the next done.
    const terminalBackgroundTaskIds = new Set<string>();
    const ignoredLateTerminalTaskEvents = new WeakSet<AgentEvent>();

    type ContinuationTaskState = 'running' | 'completed' | 'failed' | 'stopped';
    type ContinuationClaim = {
      id: number;
      tasks: Map<string, ContinuationTaskState>;
      state: 'awaiting' | 'active' | 'cancelled';
      /** Number of claim-bearing done events not yet processed by Session. */
      pendingBoundaryEvents: number;
      /** A later natural/synthetic done has closed the product turn. */
      settled: boolean;
    };
    // Claims are created synchronously when the provider enqueues a `done`.
    // The id is attached to that exact event, so a fast task_notification or
    // result-only continuation cannot change what the host later observes.
    let nextContinuationId = 1;
    let activeContinuationId: number | null = null;
    // User Stop can close an awaiting product continuation while the provider
    // still has buffered activity. Suppress that cancelled tail until its
    // Query is replaced before the next explicit user turn.
    let continuationCancellationGeneration: number | null = null;
    /**
     * 本次 Stop 已经发过终态 boundary 的那一代。
     *
     * accept 阶段的 foreground 终态归 send 的 finishSendBeforeUserInput 发, 但
     * abort 若同时取消了一个 awaiting continuation, 它已经先发过
     * turn_continuation_cancelled —— 同一次 Stop 再补一个 done 就是双终态,
     * Session 不按 generation 去重, 所有监听方都会收到两条。
     *
     * 单独记一个代次而不是复用 continuationCancellationGeneration: 后者在关
     * query 分支里**无条件**设置(哪怕那一轮根本没发 boundary), 拿它当去重依据
     * 会把 send 该发的那个终态一起吞掉。
     */
    let stopTerminalEmittedGeneration: number | null = null;
    let continuationCancellationRequiresQueryRebuild = false;
    const continuationClaims = new Map<number, ContinuationClaim>();
    const continuationListeners = new Set<(
      continuationId: number,
      state: 'awaiting' | 'active' | 'cancelled',
    ) => void>();
    const emitContinuationState = (
      continuationId: number,
      state: 'awaiting' | 'active' | 'cancelled',
    ): void => {
      for (const listener of [...continuationListeners]) {
        try {
          listener(continuationId, state);
        } catch (e) {
          log.warn('turn continuation listener threw', { error: String(e) });
        }
      }
    };
    const activeContinuationClaim = (): ContinuationClaim | null =>
      activeContinuationId === null
        ? null
        : continuationClaims.get(activeContinuationId) ?? null;
    const releaseSettledContinuationClaim = (claim: ContinuationClaim): void => {
      if (!claim.settled || claim.pendingBoundaryEvents > 0) return;
      continuationClaims.delete(claim.id);
    };
    const retireContinuationTasks = (claim: ContinuationClaim): void => {
      for (const taskId of claim.tasks.keys()) {
        runningBackgroundTasks.delete(taskId);
        terminalBackgroundTaskIds.add(taskId);
      }
    };
    const cancelActiveContinuation = (reason: string): ContinuationClaim | null => {
      const claim = activeContinuationClaim();
      if (!claim || claim.state !== 'awaiting') return null;
      claim.state = 'cancelled';
      claim.settled = true;
      activeContinuationId = null;
      log.info('turn continuation cancelled', { reason, continuationId: claim.id });
      emitContinuationState(claim.id, 'cancelled');
      releaseSettledContinuationClaim(claim);
      return claim;
    };
    const settleActiveContinuation = (reason: string): void => {
      const claim = activeContinuationClaim();
      if (!claim || claim.state !== 'active') return;
      claim.settled = true;
      activeContinuationId = null;
      log.info('turn continuation settled without a follow-up turn', {
        reason,
        continuationId: claim.id,
      });
      releaseSettledContinuationClaim(claim);
    };
    const discardActiveContinuation = (reason: string, forceRelease = false): void => {
      if (continuationClaims.size > 0) {
        log.debug('discarding turn continuation claims', {
          reason,
          continuationIds: [...continuationClaims.keys()],
        });
      }
      activeContinuationId = null;
      for (const claim of continuationClaims.values()) {
        claim.settled = true;
        releaseSettledContinuationClaim(claim);
      }
      if (forceRelease) continuationClaims.clear();
    };
    const consumeTaskNotificationsForActiveSegment = (claim: ContinuationClaim): void => {
      // The SDK may merge several task notifications that arrived before the
      // first continuation activity into one automatic segment. Consume that
      // whole terminal snapshot at activation; notifications arriving after
      // the claim becomes active remain for the following segment.
      for (const [taskId, state] of claim.tasks) {
        if (state === 'completed' || state === 'failed') claim.tasks.delete(taskId);
      }
    };
    const captureContinuationBoundary = (event: AgentEvent): boolean => {
      if (event.type !== 'done') return false;
      const existing = activeContinuationClaim();
      const interruptedGeneration =
        turnState.interruptRequested &&
        turnState.interruptGeneration === turnState.generation;
      if (interruptedGeneration && existing?.state === 'awaiting') {
        // A real provider terminal can beat the interrupt ACK. It is the
        // product terminal for this Stop, so retire the snapshotted awaiting
        // claim instead of attaching it (or minting a successor) to this done.
        retireContinuationTasks(existing);
        existing.settled = true;
        activeContinuationId = null;
        releaseSettledContinuationClaim(existing);
        return true;
      }
      if (existing?.state === 'awaiting') {
        // Defensive duplicate done for the same boundary: preserve the same
        // claim instead of letting the duplicate terminate host observers.
        event.turnContinuationId = existing.id;
        existing.pendingBoundaryEvents += 1;
        return false;
      }
      const wasActiveContinuation = existing?.state === 'active';
      const carriedTasks = existing?.state === 'active'
        ? new Map(
            [...existing.tasks].filter(([, state]) => state !== 'stopped'),
          )
        : new Map<string, ContinuationTaskState>();
      if (existing?.state === 'active') {
        // This is the automatic continuation's own done. It closes the product
        // turn, so the old claim is no longer needed once its first done has
        // been observed by the host.
        existing.settled = true;
        activeContinuationId = null;
        releaseSettledContinuationClaim(existing);
        // The continuation turn may itself launch another wake task. Preserve
        // the original behavior by scanning the current task table below and
        // attaching a fresh claim to this done when another automatic turn is
        // now expected.
      }
      // A result produced by the generation being interrupted is already a
      // terminal boundary. Even if a wake task remains in the provider table,
      // user Stop has revoked the right to create another automatic segment.
      if (
        interruptedGeneration ||
        continuationCancellationGeneration === turnState.generation
      ) {
        if (interruptedGeneration && existing) retireContinuationTasks(existing);
        return wasActiveContinuation;
      }
      const wakeTasks = [...runningBackgroundTasks.entries()].filter(([, info]) => info.wake);
      for (const [taskId] of wakeTasks) {
        if (!carriedTasks.has(taskId)) carriedTasks.set(taskId, 'running');
      }
      if (carriedTasks.size === 0) return wasActiveContinuation;
      const claim: ContinuationClaim = {
        id: nextContinuationId++,
        state: 'awaiting',
        tasks: carriedTasks,
        pendingBoundaryEvents: 1,
        settled: false,
      };
      continuationClaims.set(claim.id, claim);
      activeContinuationId = claim.id;
      event.turnContinuationId = claim.id;
      // 探针:claim 创建是「continuation 悬挂」vs「done 未到达」的关键区分点。
      // 只记 id / taskId / state 枚举,不记消息文本与 task prompt(脱敏红线)。
      log.info('turn continuation claim created', {
        continuationId: claim.id,
        carriedTasks: [...carriedTasks.entries()].map(([taskId, state]) => ({
          taskId,
          state,
        })),
        wasActiveContinuation,
      });
      return false;
    };
    const reconcileActiveContinuation = (): ContinuationClaim | null => {
      const claim = activeContinuationClaim();
      if (!claim || claim.state !== 'awaiting') return null;
      const states = [...claim.tasks.values()];
      // A completed/failed wake task still has the SDK continuation contract;
      // only an all-stopped group proves that a second `done` cannot arrive.
      // Authority model: q.interrupt ACK is required when user Stop has no
      // provider confirmation and must revoke a completed/failed continuation
      // contract itself. An all-stopped snapshot is already provider-confirmed
      // fact: every tracked task can no longer continue, while an awaiting
      // claim has no foreground turn. It therefore settles independently of a
      // concurrent interrupt resolving or rejecting; waiting for that control
      // result would leak the claim when no further provider event can exist.
      if (
        states.length > 0 &&
        states.every((state) => state === 'stopped')
      ) {
        return cancelActiveContinuation('all wake tasks stopped');
      }
      return null;
    };
    const markWakeTasksStopped = (
      taskIds: readonly string[],
      reason: string,
    ): ContinuationClaim | null => {
      const claim = activeContinuationClaim();
      for (const taskId of taskIds) {
        const info = runningBackgroundTasks.get(taskId);
        const claimTracksWakeTask =
          (claim?.state === 'awaiting' || claim?.state === 'active') &&
          claim.tasks.has(taskId);
        if (!info?.wake && !claimTracksWakeTask) continue;
        runningBackgroundTasks.delete(taskId);
        terminalBackgroundTaskIds.add(taskId);
        if (claim?.state === 'awaiting' || claim?.state === 'active') {
          claim.tasks.set(taskId, 'stopped');
        }
      }
      const cancelledClaim = reconcileActiveContinuation();
      if (taskIds.length > 0) {
        log.info('marked wake tasks stopped before provider notification', { reason, taskIds });
      }
      return cancelledClaim;
    };
    function noteBackgroundTaskEvent(e: AgentEvent): ContinuationClaim | null {
      if (e.type !== 'agent_task_update') return null;
      const data = e.data as
        | {
            taskId?: unknown;
            status?: unknown;
            taskType?: unknown;
            parentToolUseId?: unknown;
            title?: unknown;
          }
        | null
        | undefined;
      const taskId = typeof data?.taskId === 'string' ? data.taskId : undefined;
      if (!taskId) return null;
      const status = data?.status;
      if (status === 'running') {
        if (continuationCancellationGeneration !== null) {
          log.debug('ignoring task activity after user-cancelled continuation', {
            taskId,
            cancellationGeneration: continuationCancellationGeneration,
          });
          ignoredLateTerminalTaskEvents.add(e);
          return null;
        }
        if (terminalBackgroundTaskIds.has(taskId)) {
          log.debug('ignoring late running update for terminal background task', { taskId });
          ignoredLateTerminalTaskEvents.add(e);
          return null;
        }
        const prev = runningBackgroundTasks.get(taskId);
        const wake =
          prev?.wake === true ||
          (typeof data?.taskType === 'string' && WAKE_BACKGROUND_TASK_TYPES.has(data.taskType));
        runningBackgroundTasks.set(taskId, {
          wake,
          taskType: typeof data?.taskType === 'string' && data.taskType ? data.taskType : prev?.taskType,
          toolUseId:
            typeof data?.parentToolUseId === 'string' && data.parentToolUseId
              ? data.parentToolUseId
              : prev?.toolUseId,
          title: typeof data?.title === 'string' && data.title ? data.title : prev?.title,
        });
        const claim = activeContinuationClaim();
        if ((claim?.state === 'awaiting' || claim?.state === 'active') && wake) {
          claim.tasks.set(taskId, 'running');
        }
        return null;
      } else if (status === 'completed' || status === 'failed' || status === 'stopped') {
        const prev = runningBackgroundTasks.get(taskId);
        runningBackgroundTasks.delete(taskId);
        terminalBackgroundTaskIds.add(taskId);
        const claim = activeContinuationClaim();
        if (
          (claim?.state === 'awaiting' || claim?.state === 'active') &&
          (prev?.wake || claim.tasks.has(taskId))
        ) {
          claim.tasks.set(taskId, status);
          if (claim.state === 'awaiting') return reconcileActiveContinuation();
        }
      }
      return null;
    }
    const emitCancelledContinuationBoundary = (
      claim: ContinuationClaim,
      reason: string,
    ): void => {
      log.info('emitting terminal boundary for cancelled turn continuation', {
        reason,
        continuationId: claim.id,
      });
      if (emitTurnBoundary('turn_continuation_cancelled', undefined, true)) {
        // 这一代的终态已经出去了 —— accept 阶段的 send 醒来后不要再补一个。
        stopTerminalEmittedGeneration = turnState.generation;
        // Install the cancelled-tail fence at the same enqueue boundary as
        // the synthetic product terminal. stopTask can win before interrupt
        // resolves, so waiting for the interrupt ACK leaves a double-terminal
        // window for a late provider result. A live Query that owns local_bash
        // is always retired by global Stop; the fence remains as a defensive
        // guard until the replacement Query is installed.
        continuationCancellationGeneration = turnState.generation;
        continuationCancellationRequiresQueryRebuild = true;
      }
    };

    const releaseEventAccounting = (event: AgentEvent): void => {
      if (event.turnContinuationId !== undefined) {
        const claim = continuationClaims.get(event.turnContinuationId);
        if (claim) {
          claim.pendingBoundaryEvents = Math.max(0, claim.pendingBoundaryEvents - 1);
          releaseSettledContinuationClaim(claim);
        }
      }
      if (continuationTerminalBoundaryEvents.delete(event)) {
        pendingContinuationTerminalBoundaries = Math.max(
          0,
          pendingContinuationTerminalBoundaries - 1,
        );
      }
    };
    const pushForwardedEvent = (event: AgentEvent): boolean => {
      const accepted = eventQueue.push(event);
      if (!accepted) releaseEventAccounting(event);
      return accepted;
    };

    const consumedEventStream = async function* (): AsyncGenerator<AgentEvent> {
      try {
        for await (const event of eventQueue) {
          try {
            yield event;
          } finally {
            // Code after yield runs when Session asks for the next event, i.e.
            // after its synchronous fan-out (including Hook/Scheduler queries).
            releaseEventAccounting(event);
          }
        }
      } finally {
        activeContinuationId = null;
        continuationClaims.clear();
        continuationListeners.clear();
        pendingContinuationTerminalBoundaries = 0;
      }
    };
    // 逐个发起 stopTask,但不在这里等待 RPC:interrupt 必须先按控制通道顺序发出。
    // 返回每个 RPC 的 promise,供 interrupt ACK 后只退休真正成功的任务;失败任务
    // 仍留在本地账中,等待 provider 的真实 completed/stopped 事件继续记账。
    function stopRunningWakeBackgroundTasks(
      reason: string,
    ): Array<{ taskId: string; promise: Promise<void> }> {
      if (runningBackgroundTasks.size === 0) return [];
      const wakeIds: string[] = [];
      for (const [taskId, info] of runningBackgroundTasks) {
        if (info.wake) wakeIds.push(taskId);
      }
      if (wakeIds.length === 0) return [];
      // 远端老 daemon / 老 SDK 没有 stopTask:退化为原行为(interrupt-only),
      // proxy 活动检测 + 「全部停止」兜底仍在。
      if (typeof q.stopTask !== 'function') {
        log.warn('stopTask unavailable on current query; background wake tasks left running', {
          reason,
          wakeIds,
        });
        return [];
      }
      log.info('stopping running background wake tasks', { reason, wakeIds });
      const requests: Array<{ taskId: string; promise: Promise<void> }> = [];
      for (const taskId of wakeIds) {
        let stopTaskPromise: Promise<void>;
        try {
          stopTaskPromise = Promise.resolve(q.stopTask(taskId));
        } catch (error) {
          stopTaskPromise = Promise.reject(error);
        }
        const promise = stopTaskPromise.then(
          () => {
            log.debug('background wake task stop acknowledged', {
              reason,
              taskId,
            });
          },
          (e: unknown) => {
            // 两类预期失败:任务恰好已自然结束;远端老 daemon 不认识 query/stopTask
            // (RemoteQuery 恒有本地方法,老 daemon 差异只会在这里以 RPC 错误暴露)。
            log.warn('stopTask failed (task already finished, or remote daemon predates query/stopTask)', {
              taskId,
              error: String(e),
            });
            throw e;
          },
        );
        // The rejection handler above preserves the rejected status needed by
        // Promise.allSettled, while this immediate noop handler prevents an
        // unhandled-rejection report before interrupt ACK attaches allSettled.
        void promise.catch(() => undefined);
        requests.push({ taskId, promise });
      }
      return requests;
    }

    // ── Middle-turn 事件过滤 (Codex review 3534925347 / 3535259132 / 3535293200) ──
    // rewind rebuild 尾部注入的 /compact 是 SDK 独立 turn, 但从产品层看它是"用户 turn
    // 的一部分" (预压缩) — 该 turn 的 done / status(isRunning=false) 不能让 register.ts
    // 上层做 turn finalization (idle 调度 / turn 结束回写 / IM handleTurnDoneAsync /
    // snapshot 收尾), 否则用户回答会被上游当作"第二个 turn"。
    //
    // 判定用显式 `queuedBridgeTurns` 计数, 不用 `inputQueue.pending`:
    //  - pending 只反映 maker-core 侧未被消费者取走的 item 数, SDK 侧一旦拉走 pending 就
    //    归 0, 但对应 turn 可能还在 SDK 内部跑; 而且 send 中的 `await toClaudeSdkContent(...)`
    //    是几百 ms 的 async 空窗, /compact push 之后到 user message push 之前, pending 已经
    //    可能被 SDK drain 变 0 → 靠 pending 的判定会漏窗。
    //  - 显式计数在"push /compact"时 +1, 在对应 result 的 onTurnEnd 里 -1, 严格反映"还有
    //    多少已注入的桥接 turn 没跑完"。
    //
    // 只拦截 turn 边界事件 (done + isRunning=false 的 status + terminal error), 内容事件
    // (text / thinking / tool_use / running-status 等) 全部放行 — UI 看到就是一个连贯 turn。
    // 计数归 0 后真正的用户 turn 结束时事件正常放行, 下游做一次 finalization。
    //
    // Terminal error 也必须 suppress (Codex review 3535545481):
    //  bridge /compact turn 内部 SDK 失败 (API 错 / 上下文超限 / empty-response 等) 会走 is_error
    //  result → translator push `type:'error', isTerminal:true`。register.ts 上层拿 isTerminal
    //  做 turn finalization / abort 副作用, 泄漏出去会和 done 泄漏一样把用户消息当作"第二 turn"。
    //  UI 上损失一次错误提示可接受: 若 SDK 真死, 后续用户 turn 也会失败并走真正的错误路径;
    //  bridge 期间的 compact 失败静默恢复(warn 日志保留供排查)是最安全的语义。
    // CLI 的 missing-conversation 事故形态可能是「先给无详情 is_error result，紧接着
    // iterator 抛带详情的 exit error」。首个 resumed turn 对这种 result 暂存 50ms，
    // 给紧随其后的精确错误一个关联窗口；只延迟失败边界，不碰正常 token 热路径。
    const RESUME_ERROR_CORRELATION_MS = 50;
    let deferResumeFailureBoundary = false;
    let deferredResumeFailureEvents: AgentEvent[] = [];
    let deferredResumeTurnEnd = false;
    let deferredResumeFailureTimer: NodeJS.Timeout | null = null;
    function flushDeferredResumeFailure(): void {
      if (deferredResumeFailureTimer) {
        clearTimeout(deferredResumeFailureTimer);
        deferredResumeFailureTimer = null;
      }
      const events = deferredResumeFailureEvents;
      const shouldFinishTurn = deferredResumeTurnEnd;
      deferredResumeFailureEvents = [];
      deferredResumeTurnEnd = false;
      deferResumeFailureBoundary = false;
      for (const event of events) forwardEventSink.push(event);
      if (shouldFinishTurn) completeTranslatedTurnEnd();
    }
    function discardDeferredResumeFailure(): void {
      if (deferredResumeFailureTimer) {
        clearTimeout(deferredResumeFailureTimer);
        deferredResumeFailureTimer = null;
      }
      deferredResumeFailureEvents = [];
      deferredResumeTurnEnd = false;
      deferResumeFailureBoundary = false;
    }
    let pendingTerminalStatusEvent: AgentEvent | undefined;
    const forwardEventSink: AsyncQueue<AgentEvent> = {
      // Claude's translator emits `status(isRunning=false)` immediately before
      // the matching `done`. Hold that status long enough to copy the
      // provider continuation claim from `done`; otherwise every generic
      // consumer sees an unclaimed idle event and finalizes the product turn
      // before the continuation starts.
      push(e: AgentEvent) {
        if (deferResumeFailureBoundary) {
          deferredResumeFailureEvents.push(e);
          return true;
        }
        // 后台任务表旁路观察(O(1) type check,task 事件低频,不碰热路径逻辑)。
        const cancelledContinuation = noteBackgroundTaskEvent(e);
        if (ignoredLateTerminalTaskEvents.delete(e)) return true;
        if (queuedBridgeTurns > 0) {
          if (e.type === 'done') {
            rememberBridgeSuppressedDoneData(e.data);
            log.debug('suppress middle-turn done event (bridge turn active)', {
              reason: (e.data as { reason?: unknown } | null | undefined)?.reason,
              queuedBridgeTurns,
            });
            return true;
          }
          if (e.type === 'status') {
            const running = (e.data as { isRunning?: unknown } | null | undefined)?.isRunning;
            if (running === false) {
              log.debug('suppress middle-turn end-status (bridge turn active)', {
                queuedBridgeTurns,
              });
              return true;
            }
          }
          if (e.type === 'error' && isTerminalAgentErrorEvent(e)) {
            log.warn('suppress middle-turn terminal error (bridge /compact turn failed, user turn will continue)', {
              reason: (e.data as { reason?: unknown } | null | undefined)?.reason,
              message: (e.data as { message?: unknown } | null | undefined)?.message,
              queuedBridgeTurns,
            });
            restoreBridgeAutoCompactSnapshot('bridge_compact_failed');
            autoCompactController?.onCompactCanceled('bridge_compact_failed');
            return true;
          }
        }
        if (e.type === 'status') {
          const data = e.data as { isRunning?: unknown } | null | undefined;
          if (data?.isRunning === false) {
            if (pendingTerminalStatusEvent) {
              pushForwardedEvent(pendingTerminalStatusEvent);
            }
            pendingTerminalStatusEvent = e;
            return true;
          }
        }
        if (e.type !== 'done' && pendingTerminalStatusEvent) {
          pushForwardedEvent(pendingTerminalStatusEvent);
          pendingTerminalStatusEvent = undefined;
        }
        const continuationBeforeCapture = activeContinuationClaim();
        const isContinuationTerminalDone = captureContinuationBoundary(e);
        const continuationAfterCapture = activeContinuationClaim();
        const createdContinuationClaim =
          e.type === 'done' &&
          e.turnContinuationId !== undefined &&
          continuationAfterCapture?.id === e.turnContinuationId &&
          continuationBeforeCapture?.id !== continuationAfterCapture.id
            ? continuationAfterCapture
            : null;
        if (e.type === 'done' && pendingTerminalStatusEvent) {
          const statusEvent = pendingTerminalStatusEvent;
          pendingTerminalStatusEvent = undefined;
          if (e.turnContinuationId !== undefined) {
            statusEvent.turnContinuationId = e.turnContinuationId;
            const claim = continuationClaims.get(e.turnContinuationId);
            if (claim) claim.pendingBoundaryEvents += 1;
          }
          pushForwardedEvent(statusEvent);
        }
        if (isContinuationTerminalDone) {
          continuationTerminalBoundaryEvents.add(e);
          pendingContinuationTerminalBoundaries += 1;
        }
        const accepted = pushForwardedEvent(e);
        if (!accepted && createdContinuationClaim) {
          // A claim minted for a boundary that the host can never observe has
          // no continuation contract. Retire it after rolling back the done's
          // own ledger entry; an accepted paired status keeps the claim object
          // alive only until that status is acknowledged.
          createdContinuationClaim.settled = true;
          if (activeContinuationId === createdContinuationClaim.id) {
            activeContinuationId = null;
          }
          releaseSettledContinuationClaim(createdContinuationClaim);
        }
        // A stopped notification is part of the visible turn history. Preserve
        // its order, then append a real product-turn boundary so Session can
        // close the current generation even though the SDK will not emit a
        // second result for a cancelled wake continuation.
        if (accepted && cancelledContinuation) {
          emitCancelledContinuationBoundary(cancelledContinuation, 'task_notification_stopped');
        }
        return accepted;
      },
      end: () => {
        if (pendingTerminalStatusEvent) {
          eventQueue.push(pendingTerminalStatusEvent);
          pendingTerminalStatusEvent = undefined;
        }
        eventQueue.end();
      },
      clear: () => {
        pendingTerminalStatusEvent = undefined;
        eventQueue.clear();
      },
      get pending() { return eventQueue.pending; },
      [Symbol.asyncIterator]: () => eventQueue[Symbol.asyncIterator](),
    };

    // ── 事件 forward loop（SDK 原始事件 → maker-core AgentEvent） ─────────────
    // (eventQueue 已在上方 canUseTool 段提前声明, 用于 emit interaction_dismissed)
    // !! 关键: 仅在 closed=true 时才 end eventQueue。rewind 路径下旧 q.close() 会让
    //         本 loop 退出, 但 eventQueue 不能关 —— 新 buildQuery 后还要继续 push 事件。
    //
    // 每条 SDK message 都通知 watchdog (受 pendingToolIds 守卫不起 timer 那段见上方注释)。
    const registerClaudeSubagentTask = this.deps.registerClaudeSubagentTask;
    const getClaudeSubagentTaskUsage = this.deps.getClaudeSubagentTaskUsage;
    function completeTranslatedTurnEnd(): void {
      pendingToolIds.clear();
      if (queuedBridgeTurns > 0) {
        queuedBridgeTurns -= 1;
        log.debug('onTurnEnd: consumed one bridge turn, keeping turnInFlight + plan state', {
          queuedBridgeTurns,
          planTurnActive,
          sdkInPlanMode,
        });
        armUpstreamResponseIdle();
        return;
      }
      resumeValidationPending = false;
      freshSessionValidationPending = false;
      replayableUserInput = null;
      if (planTurnActive) {
        planTurnActive = false;
        if (!mutablePlanMode) {
          sdkInPlanMode = false;
          void q.setPermissionMode(effectiveSdkPermissionMode()).catch((e) => {
            log.warn('plan turn end setPermissionMode failed', { error: String(e) });
          });
        }
      }
      turnInFlight = false;
      clearUpstreamResponseIdle();
      triggerAutoCompactIfNeeded();
    }
    function startForwardLoop(currentQ: Query): void {
      // q 换代: 上一代 q 的 pending interrupted result 不可能从新 q drain 出来,
      // 残留的 interruptRequested 会错误抑制新 q 首个真实 is_error 终态 —— 兜底清。
      turnState.interruptRequested = false;
      continuationCancellationGeneration = null;
      // Any successfully installed replacement Query isolates the cancelled
      // provider tail. This also covers rewind / invalid-resume rebuilds, so a
      // later send must not create a redundant intermediate Query.
      continuationCancellationRequiresQueryRebuild = false;
      discardActiveContinuation('query_replaced');
      // q 换代 = 旧 CLI 子进程已死,其后台任务全部随之终止 —— 清表防 stale 条目
      // 让下次 abort 对不存在的任务空发 stopTask。
      runningBackgroundTasks.clear();
      terminalBackgroundTaskIds.clear();
      void (async () => {
        try {
          for await (const rawMsg of currentQ) {
            if (closed) break;
            const rawType = (rawMsg as { type?: string } | null)?.type;
            const rawSubtype = (rawMsg as { subtype?: string } | null)?.subtype;
            const rawStatus = (rawMsg as { status?: string } | null)?.status;
            const isTerminalTaskNotification =
              rawType === 'system' &&
              rawSubtype === 'task_notification' &&
              (rawStatus === 'completed' || rawStatus === 'failed' || rawStatus === 'stopped');
            if (
              (canceledBridgeQueries.has(currentQ) || rewindTransitionQueries.has(currentQ)) &&
              !(canceledBridgeQueries.has(currentQ) && isTerminalTaskNotification)
            ) {
              continue;
            }
            if (activeBridgeKind !== null && queuedBridgeTurns === 0) {
              log.debug('bridge follow-up turn started — clearing bridge rewind resume point', {
                bridgeKind: activeBridgeKind,
                activeBridgeRewindResumeAt,
              });
              clearBridgeState();
            }
            if (
              continuationCancellationGeneration !== null &&
              (rawType === 'assistant' || rawType === 'stream_event' || rawType === 'result')
            ) {
              log.debug('ignoring provider activity from cancelled continuation query', {
                rawType,
                cancellationGeneration: continuationCancellationGeneration,
              });
              continue;
            }
            if (noteSdkInitMcpServerNames(rawMsg)) {
              // User/project/local settings MCPs are only revealed by the SDK init
              // payload, after the query has already started. Native OAuth Auto skips
              // canUseTool, so immediately hand later turns back to Cindy when that
              // payload reports any connected MCP server. Do this before the optional
              // provenance RPC below: a slow status call must not prolong native Auto.
              if (
                mutablePermissionMode === 'auto'
                && !mutablePlanMode
                && !planTurnActive
                && mutableAutoReviewCredentialMode === 'oauth-bearer'
                && hasRegisteredMcpServers()
                && nativeAutoQueries.has(currentQ)
              ) {
                try {
                  await currentQ.setPermissionMode(effectiveSdkPermissionMode());
                  nativeAutoQueries.delete(currentQ);
                } catch (error) {
                  // Keeping this query alive would leave connected MCP tools under the
                  // native classifier, which bypasses Cindy's canUseTool policy. Close
                  // and surface a terminal stream failure instead of failing open.
                  log.error('failed to downgrade native Auto after SDK settings MCP init', {
                    error: String(error),
                  });
                  try {
                    await currentQ.close();
                  } catch (closeError) {
                    log.warn('failed to close query after native Auto downgrade failure', {
                      error: String(closeError),
                    });
                  }
                  throw new Error(
                    `[MCP_APPROVAL_MODE_DOWNGRADE_FAILED] ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              await refreshSdkMcpProvenance(currentQ);
            }
            const expectedResumeSessionId = resumeValidationPending ? configuredResumeSessionId : undefined;
            const inBandInvalidConversationId =
              expectedResumeSessionId ?? (freshSessionValidationPending ? sdkSessionId : undefined);
            const rawRecord = rawMsg as { type?: unknown; is_error?: unknown; error?: unknown } | null;
            const isResumeErrorCandidate =
              (rawType === 'result' && rawRecord?.is_error === true) ||
              (rawType === 'assistant' && typeof rawRecord?.error === 'string');
            if (inBandInvalidConversationId && isResumeErrorCandidate &&
                isClaudeResumeSessionNotFound(rawMsg, inBandInvalidConversationId)) {
              if (await recoverInvalidResume(currentQ, inBandInvalidConversationId, rawMsg)) return;
              surfaceUnrecoverableInvalidResume(rawMsg);
              return;
            }
            if (deferredResumeFailureEvents.length > 0 || deferredResumeTurnEnd) {
              flushDeferredResumeFailure();
            }
            // 自动续跑 turn 的 in-flight 补登记:后台 subagent 完成后 SDK 经
            // task_notification 自动续跑新 turn,**不经过 handle.send**,turnInFlight
            // 停留在 false → isTurnRunning() 误报空闲,session.send 的 SESSION_RUNNING
            // 守卫失守(scheduler 心跳曾借此把 prompt 注入运行中的 turn)、tool-loop
            // guard / upstream-idle watchdog 也整段失效。这里以"turn 内才会出现的
            // 消息"(assistant / stream_event)为证据补登记；若 provider 已给上一
            // done 锁存 continuation claim，result-only 也能证明自动续 turn 已开始。
            // 随后镜像 send 入口的
            // per-turn 状态重置(beginNewTurn + toolLoopGuard.resetTurn),否则 guard
            // 会带着上一轮的陈旧计数误判。
            // 排除两种非新 turn 场景:
            //  - interruptRequested:watchdog / tool-loop 已 q.interrupt(),SDK 残留
            //    的 assistant 消息仍会 drain 到这里;此时 beginNewTurn 的 generation++
            //    会让 translator 把随后的 interrupted result 当作"已被新 send 接管"
            //    而吞掉终态,turn 永远收不了尾。
            //  - queuedBridgeTurns > 0:桥接 /compact 序列里 turnInFlight 本就被
            //    onTurnEnd 保持,不会走进本分支;计数守卫只是防御性一致。
            // 子 Agent 的 sidechain assistant/stream_event 也会穿过同一 Query，且
            // 常在它自己的 task_notification 之前到达。它只证明后台任务仍在跑，
            // 不能证明顶层自动 continuation 已开始；否则会过早把 awaiting claim
            // 转 active，随后同一任务的 completed 会被误当成“active 段期间完成的
            // 下一任务”，让第二个顶层 result 再铸造一个永远等不到后续活动的 claim。
            const rawParentToolUseId = (
              rawMsg as { parent_tool_use_id?: unknown } | null
            )?.parent_tool_use_id;
            const isTopLevelProviderActivity =
              typeof rawParentToolUseId !== 'string' || rawParentToolUseId.length === 0;
            if (
              !turnInFlight &&
              !turnState.interruptRequested &&
              queuedBridgeTurns === 0 &&
              (
                ((rawType === 'assistant' || rawType === 'stream_event') &&
                  isTopLevelProviderActivity) ||
                (activeContinuationClaim()?.state === 'awaiting' && rawType === 'result')
              )
            ) {
              const claim = activeContinuationClaim();
              if (claim?.state === 'awaiting') {
                // Each task notification queues one SDK continuation segment.
                // Consume only the notification that activated this segment;
                // other terminal tasks must keep the next boundary claimed.
                consumeTaskNotificationsForActiveSegment(claim);
                claim.state = 'active';
                emitContinuationState(claim.id, 'active');
              }
              log.debug('SDK ▶ turn activity without send — marking auto-continued turn in-flight', {
                rawType,
                sdkSessionId,
              });
              beginNewTurn();
              toolLoopGuard?.resetTurn();
              turnInFlight = true;
            }
            noteUpstreamResponseActivity(typeof rawType === 'string' ? rawType : 'unknown');
            const shouldCorrelateResumeFailure =
              rawType === 'result' && (rawMsg as { is_error?: unknown } | null)?.is_error === true &&
              (resumeValidationPending ||
                (freshSessionValidationPending && !!sdkSessionId && isClaudeResumeSessionNotFound(rawMsg, sdkSessionId)));
            if (shouldCorrelateResumeFailure) deferResumeFailureBoundary = true;
            translateSdkMessage(rawMsg, forwardEventSink, {
              rt: runtimeState,
              turn: turnState,
              log,
              getModel: () => mutableModel,
              getModelContextWindow: () => modelContextWindows.get(mutableModel),
              getEffort: () => mutableEffort,
              getPermissionMode: () => mutablePermissionMode,
              getSdkSessionId: () => sdkSessionId,
              getLogTitle: () => lastSendTitle,
              tracker: usageTracker,
              onSessionId: (sid) => {
                if (sid && sid !== sdkSessionId) {
                  sdkSessionId = sid;
                  eventQueue.push({ type: 'session_id', data: sid, source: 'claude-code' });
                }
              },
              onSubagentTaskLaunched: (task) => {
                registerClaudeSubagentTask?.(task);
              },
              getSubagentTaskUsage: (taskId) => {
                const usage = getClaudeSubagentTaskUsage?.(taskId);
                return usage ? { totalTokens: usage.totalTokens } : undefined;
              },
              onTurnEnd: () => {
                if (deferResumeFailureBoundary) {
                  deferredResumeTurnEnd = true;
                  return;
                }
                completeTranslatedTurnEnd();
              },
              onToolUseStart: (id: string, toolName?: unknown, input?: unknown) => {
                pendingToolIds.add(id);
                toolLoopGuard?.onToolUse(id, toolName, input);
                clearUpstreamResponseIdle();
              },
              onToolResultDone: (id: string, output: string) => {
                pendingToolIds.delete(id);
                if (turnInFlight) {
                  const verdict = toolLoopGuard?.onToolResult(id, output);
                  if (verdict?.kind === 'hard') {
                    const loopHint = verdict.reason === 'consecutive'
                      ? `连续 ${verdict.count} 次发起完全相同的 ${verdict.toolName} 调用`
                      : `最近 ${verdict.count} 次工具调用一直在极少数几种(含 ${verdict.toolName})之间反复打转`;
                    // 与 upstream-idle watchdog 同款兜底: tool-loop 中断 = "整个 turn 序列已死",
                    // bridge counter 归零避免 filter 吞掉本条 error / counter 永久停在 >0。
                    // 实践上 bridge /compact turn 不用 tool, 该分支难以触发, 归零是防御性一致。
                    if (bridgeStateActive()) {
                      const interruptedBridgeKind = activeBridgeKind;
                      const interruptedRewindResumeAt = activeBridgeRewindResumeAt;
                      log.warn('tool-loop hard interrupt fired during bridge — clearing bridge state', {
                        queuedBridgeTurns,
                        activeBridgeKind,
                        activeBridgeRewindResumeAt,
                      });
                      restoreBridgeAutoCompactSnapshot('tool_loop_hard_interrupt');
                      autoCompactController?.onCompactCanceled('tool_loop_hard_interrupt');
                      clearBridgeState();
                      preserveBridgeRetryTarget(interruptedBridgeKind, interruptedRewindResumeAt);
                    }
                    eventQueue.push({
                      type: 'error',
                      data: {
                        message:
                          `上游模型 ${mutableModel} ${loopHint},疑似陷入死循环,` +
                          `已自动中断当前 turn。可以直接发下一条消息继续,` +
                          `已完成的 tool result 都保留。`,
                        isTerminal: true,
                        reason: 'tool_use_loop_detected',
                        loopKind: verdict.reason,
                        loopCount: verdict.count,
                        model: mutableModel,
                      },
                      source: 'claude-code',
                    });
                    turnInFlight = false;
                    pendingToolIds.clear();
                    // 上面已推过带 reason 的 terminal error, interrupt 后 SDK drain 出的
                    // is_error result 不能再触发 translator 的失败兜底(双 error banner),
                    // 与 watchdog / abort 的置位对齐。
                    turnState.interruptRequested = true;
                    turnState.interruptGeneration = turnState.generation;
                    void q.interrupt().catch((e) => {
                      // interrupt 失败 → 无 result 消费标记, 回收防误抑制(同 watchdog)。
                      turnState.interruptRequested = false;
                      log.warn('tool loop guard: interrupt threw', { error: String(e) });
                    });
                    return;
                  }
                }
                // 归零立即 arm: ball 回上游, 不等下一条 SDK message 起表 (会留 idle 窗口)。
                if (pendingToolIds.size === 0) armUpstreamResponseIdle();
              },
              ...(memoryFlushController || autoCompactController
                ? {
                    onUsageUpdate: (used, window) => {
                      memoryFlushController?.onUsageUpdate(used, window);
                      autoCompactController?.onUsageUpdate(used, window);
                    },
                    onCompactBoundary: () => {
                      memoryFlushController?.onCompactBoundary();
                      autoCompactController?.onCompactBoundary();
                    },
                  }
                : {}),
            });
            if (shouldCorrelateResumeFailure) {
              deferResumeFailureBoundary = false;
              deferredResumeFailureTimer = setTimeout(
                flushDeferredResumeFailure,
                RESUME_ERROR_CORRELATION_MS,
              );
            }
          }
          flushDeferredResumeFailure();
          log.debug('event loop done (stream_end)');
          if (closed) {
            eventQueue.push({ type: 'done', data: { reason: 'stream_end' }, source: 'claude-code' });
          } else if (pendingRewindTo || rewindTransitionQueries.has(currentQ) || canceledBridgeQueries.has(currentQ)) {
            // 非 closed 退出 = rewind/bridge cancel 期间旧 q 被 close, 不发 done (新 q 即将接管,
            // 或 bridge cancel 已由 abort/watchdog 直接推过 terminal 事件)。
            if (isCurrentQuery(currentQ) && queuedBridgeTurns > 0 && canceledBridgeQueries.has(currentQ)) {
              log.warn('event loop stream_end during canceled bridge — clearing bridge counter', {
                queuedBridgeTurns,
                pendingRewindTo,
                activeBridgeRewindResumeAt,
                rewindTransition: rewindTransitionQueries.has(currentQ),
                canceledBridge: canceledBridgeQueries.has(currentQ),
              });
              clearBridgeState();
            }
            if (isCurrentQuery(currentQ)) {
              pendingToolIds.clear();
            }
          } else if (activeBridgeKind !== null) {
            // Bridge /compact query 自发结束(非 Stop/watchdog 主动 close)说明底层 SDK
            // stream 已死;不能当 rewind transition 静默,否则 queuedBridgeTurns/turnInFlight
            // 会污染下一条真实用户 turn。
            log.warn('event loop ended unexpectedly during bridge turn');
            clearBridgeState();
            eventQueue.push({
              type: 'error',
              data: {
                message: 'Claude Code stream ended during bridge turn. Turn ended — please resend.',
                reason: 'bridge_stream_closed',
                isTerminal: true,
              },
              source: 'claude-code',
            });
            if (turnInFlight) {
              emitTurnBoundary('bridge_stream_closed');
            }
            teardownDeadHandle('bridge stream_end teardown');
          } else {
            // U2: stream 自然结束但 ClaudeCodeAgent 自己没主动 close, 也不是 rewind →
            // 远端 cc-mgr daemon 主动关 (用户点了升级 / daemon SIGTERM / 网络断 /
            // 用户手动 pkill daemon)。
            //
            // 之前只 push events + set closed, 但 inputQueue 没 end / abortController
            // 没 abort / remoteQuery 没 close —— forwarder loop (for await msg of
            // inputQueue) 还在跑, maker session.status 也保持 'active' (runEventLoop
            // 自然退出不切 status, 见 session.ts), 导致下次 user 发消息 maker 还
            // 复用老 Session → handle.send → inputQueue.push → forwarder 拿到后
            // 调死 remoteQuery.send 报 "RemoteQuery is closed" → 只 warn 吞掉 →
            // 用户看到"发了没反应"。
            //
            // 现在 U2 兜底等同 handle.close() 全套: end inputQueue + abort + close
            // 远端 query + dismiss pending interactions。U5a 在 session.ts 加了
            // runEventLoop 自然结束兜底 setStatus('closed'), 二者合起来让 maker
            // activeSessions 自动 delete, 下次 send 走 IPC lazy create-session
            // 重建新 handle / RemoteQuery / ssh channel。
            //
            // 本地 SDK Query 路径不会跑到这里 (本地 SDK iterator 正常结束必有 result
            // event, closed 才会主动 set; 本地无远端 SESSION_CLOSED 概念), 所以只
            // 影响远端 cc 场景, 不影响缓存率 / 性能 (规则 19)。
            log.warn('event loop ended unexpectedly (likely remote daemon shutdown)');
            eventQueue.push({
              type: 'error',
              data: {
                message: '[REMOTE_DAEMON_CLOSED] Remote connection interrupted (daemon may be upgrading/restarting). Turn ended — please resend.',
                reason: 'remote_daemon_closed',
              },
              source: 'claude-code',
            });
            eventQueue.push({ type: 'done', data: { reason: 'remote_daemon_closed' }, source: 'claude-code' });
            // 完整 close 副作用 — 跟 handle.close() 保持一致 (见 teardownDeadHandle 文档)。
            teardownDeadHandle('U2 fallback');
          }
        } catch (e) {
          // 三种 abort 路径都会让 for-await 抛 "Claude Code process aborted by user":
          //   ① handle.close() → closed=true        — push done + end queue
          //   ② commitRewindFiles → pendingRewindTo — 静音, 新 q 即将接管同一个 eventQueue
          //   ③ 真异常 (子进程崩 / SDK bug 等)       — push error 给 UI
          //
          // 注: upstream-response-idle watchdog 触发走的是 q.interrupt(), 不会让 for-await
          // 抛 abort — SDK 会继续 drain 出 ResultMessage(error_during_execution), 走正常
          // result 路径进 translator.onTurnEnd; 不在这里识别 watchdog 状态。
          const expectedResumeSessionId = resumeValidationPending ? configuredResumeSessionId : undefined;
          // fresh-session self-reference:全新会话(无 resume)首个 turn 在转录落盘前就崩,
          // CLI 会把 SDK 刚回填、已落库的 sdk_session_id 报成 "No conversation found"。此时
          // expectedResumeSessionId 为空,若不识别就会 surface 原始终态报错、并把这个幽灵 id
          // 留在库里,下一次 send resume 同一死会话反复失败(把 Codex 会话切成全新 Claude 会话
          // 即触发此路径)。只在首个 turn 尚未成功前兜底匹配自身 sdkSessionId,成功一轮后关
          // 闭窗口,避免已建立的会话中途丢失时被静默重建而丢上下文。
          const invalidConversationId =
            expectedResumeSessionId ??
            (freshSessionValidationPending ? sdkSessionId : undefined);
          if (!closed && invalidConversationId &&
              isClaudeResumeSessionNotFound(e, invalidConversationId)) {
            if (await recoverInvalidResume(currentQ, invalidConversationId, e)) return;
            surfaceUnrecoverableInvalidResume(e);
          } else if (closed) {
            flushDeferredResumeFailure();
            log.debug('event loop exited (closed)', { reason: String(e) });
          } else if (pendingRewindTo || rewindTransitionQueries.has(currentQ) || canceledBridgeQueries.has(currentQ)) {
            flushDeferredResumeFailure();
            log.debug('event loop exited (rewind/canceled bridge transition)', {
              reason: String(e),
              pendingRewindTo,
              activeBridgeRewindResumeAt,
              rewindTransition: rewindTransitionQueries.has(currentQ),
              canceledBridge: canceledBridgeQueries.has(currentQ),
            });
            if (isCurrentQuery(currentQ) && queuedBridgeTurns > 0 && canceledBridgeQueries.has(currentQ)) {
              log.warn('event loop exited during canceled bridge — clearing bridge counter', {
                queuedBridgeTurns,
                pendingRewindTo,
                activeBridgeRewindResumeAt,
                rewindTransition: rewindTransitionQueries.has(currentQ),
                canceledBridge: canceledBridgeQueries.has(currentQ),
              });
              clearBridgeState();
            }
            // rewind/bridge cancel 过渡: 老 q 留下的 pending tool_use_id 不能跨到新 q, 否则新 turn
            // 起来 armUpstreamResponseIdle 被旧 id 短路, watchdog 永久失效。
            if (isCurrentQuery(currentQ)) {
              pendingToolIds.clear();
            }
          } else if (activeBridgeKind !== null) {
            flushDeferredResumeFailure();
            log.error('event loop crashed during bridge turn', {
              error: String(e),
              activeBridgeRewindResumeAt,
              queuedBridgeTurns,
            });
            clearBridgeState();
            eventQueue.push({
              type: 'error',
              data: { message: String(e), isTerminal: true, reason: 'bridge_sdk_stream_crashed' },
              source: 'claude-code',
            });
            if (turnInFlight) {
              emitTurnBoundary('bridge_sdk_stream_crashed');
            }
            teardownDeadHandle('bridge crash teardown');
          } else {
            flushDeferredResumeFailure();
            // ③ 真异常: SDK 流抛错 = 底层 q 已死且没有新 q 接管。本地路径也会走到这里 ——
            // 典型: resume 失败时 CLI 先吐 is_error result 再以非零码退出, SDK readMessages
            // 把 exit error 替换成 "Claude Code returned an error result: ..." 抛进流里。
            // 此前只推 error + 清 turnInFlight, 不置 closed / 不 end inputQueue → handle
            // 对外装活, 下次 send 进无消费者的 inputQueue 黑洞 (2026-07-05 fork resume 实踩),
            // 现在与 U2 同款走 teardownDeadHandle 全套收尾。
            log.error('event loop crashed', { error: String(e) });
            // teardownDeadHandle 会清 turnInFlight, 先快照: turn 是否还没收尾
            // (translator 已 drain 过 result 正常收尾时为 false, 不重复补收尾事件)。
            const turnWasInFlight = turnInFlight;
            eventQueue.push({
              type: 'error',
              data: { message: String(e), isTerminal: true, reason: 'sdk_stream_crashed' },
              source: 'claude-code',
            });
            if (turnWasInFlight) {
              // turn 中途崩 (没有 result 走 translator 收尾) → 补齐与 translator 失败
              // 序列同构的收尾 (error → status Done → done), renderer 的 running 态和
              // main 的 turn 终止链路才能闭合。done 不带 usage 字段, 记账 sink 读不到
              // 数不会双计 (与 U2 的 done data 同款语义)。
              emitTurnBoundary('sdk_stream_crashed');
            }
            teardownDeadHandle('crash teardown');
          }
        } finally {
          if (closed || isCurrentQuery(currentQ)) {
            clearUpstreamResponseIdle();
            pendingToolIds.clear();
          }
          if (closed) eventQueue.end();
        }
      })();
    }

    async function clearInvalidResumeSession(
      expectedResumeSessionId: string,
      source: 'transcript_preflight' | 'sdk_runtime',
    ): Promise<boolean> {
      if (resumeRecoveryAttempted || !opts.onInvalidResumeSession) return false;
      try {
        const cleared = await opts.onInvalidResumeSession(expectedResumeSessionId);
        if (!cleared) {
          log.warn('invalid resume CAS did not match; refusing to overwrite concurrent session id', {
            expectedResumeSessionId, source,
          });
          return false;
        }
        resumeRecoveryAttempted = true;
        resumeValidationPending = false;
        freshSessionValidationPending = false;
        configuredResumeSessionId = undefined;
        sdkSessionId = undefined;
        log.warn('invalid resume id cleared; switching to a fresh Claude conversation', {
          expectedResumeSessionId, source,
        });
        return true;
      } catch (error) {
        log.error('invalid resume CAS failed', {
          expectedResumeSessionId, source,
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    }
    async function recoverInvalidResume(
      currentQ: Query,
      expectedResumeSessionId: string,
      evidence: unknown,
    ): Promise<boolean> {
      // gate 必须在任何 await 之前装上:CAS(onInvalidResumeSession)可能很慢,期间新进入
      // 的 send 若不被拦在入口,消息会在 Session.send 的 onAccepted 持久化后撞进稍后的
      // 队列交替窗口(desktop 只对 SESSION_RUNNING 前缀 requeue → 已落库但从未送达)。
      // 两个分支都持有 gate 直到重建完成或放弃;所有出口 releaseGate。
      let releaseIdleResumeGate: (() => void) | undefined;
      idleResumeRebuildGate = new Promise<void>((resolve) => { releaseIdleResumeGate = resolve; });
      const releaseGate = (): void => {
        if (!releaseIdleResumeGate) return;
        idleResumeRebuildGate = null;
        releaseIdleResumeGate();
        releaseIdleResumeGate = undefined;
      };
      // 先停 deferred-failure 定时器,再进慢速 CAS:两步失败形态(先 is_error result 后精确
      // throw)下 50ms 计时器可能在 CAS await 期间先到,把本该被静默恢复吞掉的终态错误漏给
      // UI。CAS 失败放弃恢复时由 surfaceUnrecoverableInvalidResume 推全新终态错误,不丢反馈。
      discardDeferredResumeFailure();
      // 清失效 resume id 优先于一切:无论有没有可重放的 turn,不存在的 sdk_session_id
      // 都必须清掉,否则下一次 send 仍会 resume 同一个死会话反复失败。CAS 不匹配
      // (并发改了 id)才放弃并交回调用方 surface。
      if (!(await clearInvalidResumeSession(expectedResumeSessionId, 'sdk_runtime'))) {
        releaseGate();
        return false;
      }
      // replayableUserInput 为空 = resume 失败发生在任何用户 turn 之前(eager bootstrap /
      // 重启恢复 / agent 切换后的立即重建:CLI 在收到首条消息前就判定 resume 会话不存在)。
      // 此时没有任何 turn 会因此失败,surface 终态错误只会让用户看到一条无谓红条并被迫
      // 手动重试(切到 Claude 的偶发 "No conversation found" 即源于此)。与 spawn 前 'missing'
      // 预检同一取向:静默重建全新会话,让用户的首条真实消息直接在新会话上跑。
      const replayInput = replayableUserInput;
      log.warn(
        replayInput
          ? 'recovering invalid resume with one fresh retry'
          : 'recovering invalid resume before any user turn; rebuilding fresh idle session',
        {
          expectedResumeSessionId,
          evidence: evidence instanceof Error ? evidence.message : String(evidence),
        },
      );
      clearUpstreamResponseIdle();
      pendingToolIds.clear();
      // A fresh invalid-resume recovery must not inherit a half-consumed
      // compact bridge from the dead query. There is no rewind target to
      // preserve here: the replacement query intentionally starts fresh.
      restoreBridgeAutoCompactSnapshot('invalid_resume_recovery');
      autoCompactController?.onCompactCanceled('invalid_resume_recovery');
      clearBridgeState();
      try { inputQueue.end(); } catch (error) {
        log.debug('invalid resume recovery: old input queue end failed', { error: String(error) });
      }
      try { await Promise.resolve(currentQ.close()); } catch (error) {
        log.debug('invalid resume recovery: old query close failed', { error: String(error) });
      }
      if (closed) {
        // close 赢了竞态:handle.close 已 end 队列 / abort controller,这里不能再重建,
        // 否则会留下无 handle 管理的本地 CLI 进程或远端 cc-manager 会话(空耗 + 下次
        // attach 误连)。失效 id 已清,直接收手;forward loop 的 finally 会按 closed
        // end 掉 eventQueue。
        releaseGate();
        log.debug('invalid resume recovery aborted: handle closed while old query was closing');
        return true;
      }
      inputQueue = createAsyncQueue<SdkUserInput>();
      abortController = new AbortController();
      runtimeState.lastResultUsageAggregate = null;
      // 快照 rebuild 起点档位 — 与 rewind rebuild 同款:await buildQuery 期间到达的
      // runtime setter 会被 controlRequestsBlocked() 短路成只改闭包(远端分支的
      // remoteCcQueryFactory RPC 往返是真实窗口),重建后按快照 diff 回放漂移,
      // 避免新 query 带旧 model/flags 起跑而 handle getter 报新值。
      const runtimeSnapshot: QueryRuntimeSnapshot = {
        model: mutableModel,
        effort: mutableEffort,
        fastMode: mutableFastMode,
        sdkPermissionMode: currentTurnSdkPermissionMode(),
      };
      // 只有真正重放一个 turn 时才登记 turn 状态;idle 重建(无 replay)绝不能置
      // turnInFlight,否则 isTurnRunning() 会在没有 turn 运行时误报为忙。无 replay 的
      // 全新 query + startForwardLoop 等价于 startSession 首次起 q 的空闲态。
      if (replayInput) {
        beginNewTurn();
        toolLoopGuard?.resetTurn();
        turnInFlight = true;
      }
      try {
        q = await buildQuery({ permissionMode: runtimeSnapshot.sdkPermissionMode, fresh: true });
        if (closed) {
          // close 在 buildQuery 期间赢了竞态:teardown 只拆得到当时存在的 query,刚建的
          // 替换 query 必须在这里立即关掉,不 startForwardLoop。
          releaseGate();
          try { inputQueue.end(); } catch (endError) {
            log.debug('invalid resume recovery: replacement queue end after close failed', { error: String(endError) });
          }
          try { q.close(); } catch (closeError) {
            log.warn('invalid resume recovery: closing replacement query after handle close failed', { error: String(closeError) });
          }
          log.debug('invalid resume recovery aborted: handle closed during rebuild');
          return true;
        }
        startForwardLoop(q);
        await replayRuntimeDrift(runtimeSnapshot, 'invalid resume rebuild');
        releaseGate();
        if (replayInput) {
          if (!inputQueue.push(replayInput)) throw new Error('fresh retry input queue rejected replay');
          armUpstreamResponseIdle();
        }
        return true;
      } catch (error) {
        releaseGate();
        log.error('invalid resume fresh retry failed to start', {
          expectedResumeSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        eventQueue.push({
          type: 'error',
          data: {
            message: `Claude 会话已失效，自动创建新会话时失败：${error instanceof Error ? error.message : String(error)}`,
            isTerminal: true,
            reason: 'resume_session_recovery_failed',
          },
          source: 'claude-code',
        });
        if (turnInFlight) emitTurnBoundary('resume_session_recovery_failed');
        teardownDeadHandle('invalid resume recovery failed');
        return true;
      }
    }
    function surfaceUnrecoverableInvalidResume(evidence: unknown): void {
      discardDeferredResumeFailure();
      eventQueue.push({
        type: 'error',
        data: {
          message: evidence instanceof Error
            ? evidence.message
            : 'Claude 会话已失效，且本地会话 ID 已被并发更新，未执行自动覆盖。请重试。',
          isTerminal: true,
          reason: 'resume_session_not_found',
        },
        source: 'claude-code',
      });
      if (turnInFlight) emitTurnBoundary('resume_session_not_found');
      teardownDeadHandle('unrecoverable invalid resume');
    }

    // ── 首次起 q + 启动 forward loop ─────────────────────────────────────────
    q = await buildQuery();
    startForwardLoop(q);
    // Anthropic 清单动态发现:init 后 fire-and-forget 捕获 supportedModels(见文件顶注)。
    notifySupportedModels(q);

    // ── AgentSessionHandle 包装 ─────────────────────────────────────────────
    // Rewind rebuild 已创建新 q、但本次 send 尚未登记 turnInFlight / bridge state 的短窗口。
    // 这个窗口里的 runtime setter 只能更新闭包,不能直接写新 q:否则 plan arm / auto-compact
    // 可能污染当前正在接受的普通 send。send 登记 turn state 后再解除。
    let acceptingRebuiltSend = false;
    // invalid-resume 恢复期间的门禁(从 CAS 清 id 起、到重建完成或放弃为止):这段
    // 窗口里旧 inputQueue 会被 end、q 被替换,send 会把消息推进死队列或未连接的新队列。
    // 非 null = 恢复进行中。send / rewind 入口 await 它而不是抛错 —— Session.send 的
    // onAccepted 已持久化/ack 消息,抛普通 Error 会把瞬时重建变成孤儿用户消息(desktop
    // 只对 SESSION_RUNNING 前缀 requeue)。恢复结束(成功或失败)后 resolve 放行。
    let idleResumeRebuildGate: Promise<void> | null = null;
    // Idle-resume recovery and cancelled-continuation rebuilds have independent gates.
    let cancellationRebuildGate: Promise<void> | null = null;
    // runtime control request 可写性判定: commitRewindFiles 后旧 Query 已 close、新 Query
    // 等下一次 send 重建;或 bridge Stop/watchdog 已 close 当前 Query、等待下一次
    // send 从同一 rewind point 重建。这些窗口里对 q 发 control request 会抛
    // "ProcessTransport is not ready for writing"。
    //
    // 注意: activeBridgeRewindResumeAt **单独存在**不代表 q 不可写。正常 bridge
    // /compact 运行期间当前 Query 仍然活着,运行时设置必须继续发给 q,否则长 compact
    // 窗口里用户切模型/权限档只会改闭包,不会影响当前和后续 turn。只有当前 q 已被
    // 主动 close 并登记到 canceledBridgeQueries 时才阻塞 control request。
    const controlRequestsBlocked = (): boolean =>
      pendingRewindTo !== undefined ||
      acceptingRebuiltSend ||
      idleResumeRebuildGate !== null ||
      continuationCancellationRequiresQueryRebuild ||
      canceledBridgeQueries.has(q);
    type QueryRuntimeSnapshot = {
      model: string;
      effort: Effort;
      fastMode: boolean;
      sdkPermissionMode: SdkPermissionMode;
    };
    async function replayRuntimeDrift(snapshot: QueryRuntimeSnapshot, label: string): Promise<void> {
      for (let pass = 0; pass < 5; pass += 1) {
        let replayed = false;
        if (mutableModel !== snapshot.model) {
          replayed = true;
          const targetModel = mutableModel;
          try {
            await q.setModel(sdkModelFor(targetModel));
            snapshot.model = targetModel;
            log.debug(`${label}: replayed setModel`, { model: targetModel });
          } catch (e) {
            log.warn(`${label}: replay setModel failed`, { error: String(e) });
          }
        }
        if (mutableEffort !== snapshot.effort) {
          replayed = true;
          const targetEffort = mutableEffort;
          const sdkEffort = getSdkEffortForModel(mutableModel, targetEffort);
          if (sdkEffort) {
            try {
              const appliedEffort = await applyClaudeEffortFlagSettings(
                q,
                sdkEffort,
                getSdkMaxEffortFallbackForModel(mutableModel),
              );
              log.debug(`${label}: replayed setEffort`, {
                effort: targetEffort,
                sdk: appliedEffort,
                downgraded: appliedEffort !== sdkEffort,
              });
            } catch (e) {
              log.warn(`${label}: replay setEffort failed`, { error: String(e) });
            }
          }
          snapshot.effort = targetEffort;
        }
        if (mutableFastMode !== snapshot.fastMode) {
          replayed = true;
          const targetFastMode = mutableFastMode;
          try {
            await q.applyFlagSettings({ fastMode: targetFastMode });
            log.debug(`${label}: replayed setFastMode`, { fastMode: targetFastMode });
          } catch (e) {
            log.warn(`${label}: replay setFastMode failed`, { error: String(e) });
          }
          snapshot.fastMode = targetFastMode;
        }
        const sdkMode = currentTurnSdkPermissionMode();
        if (sdkMode !== snapshot.sdkPermissionMode) {
          replayed = true;
          const targetSdkMode = sdkMode;
          try {
            await q.setPermissionMode(targetSdkMode);
            sdkInPlanMode = targetSdkMode === 'plan';
            snapshot.sdkPermissionMode = targetSdkMode;
            log.debug(`${label}: replayed setPermissionMode`, { sdkMode: targetSdkMode });
          } catch (e) {
            log.warn(`${label}: replay setPermissionMode failed`, { error: String(e) });
          }
        }
        if (!replayed) return;
      }
      log.warn(`${label}: runtime drift kept changing while replaying; leaving remaining drift to the next setter/rebuild`);
    }
    async function rebuildCancelledContinuationQuery(
      signal?: AbortSignal,
      options?: { queueCompactBridge?: boolean },
    ): Promise<boolean> {
      while (cancellationRebuildGate) {
        await cancellationRebuildGate;
      }
      if (!continuationCancellationRequiresQueryRebuild) return false;

      let releaseCancellationRebuildGate: (() => void) | undefined;
      cancellationRebuildGate = new Promise<void>((resolve) => {
        releaseCancellationRebuildGate = resolve;
      });
      try {
        const staleQuery = q;
        const runtimeSnapshot: QueryRuntimeSnapshot = {
          model: mutableModel,
          effort: mutableEffort,
          fastMode: mutableFastMode,
          sdkPermissionMode: currentTurnSdkPermissionMode(),
        };
        acceptingRebuiltSend = true;
        inputQueue.end();
        inputQueue = createAsyncQueue<SdkUserInput>();
        abortController = new AbortController();
        runtimeState.lastResultUsageAggregate = null;
        rewindTransitionQueries.add(staleQuery);
        const recordedClose = canceledQueryClosePromises.get(staleQuery);
        if (recordedClose) {
          try {
            await recordedClose;
          } catch (error) {
            log.warn('cancelled continuation query close rejected before rebuild', { error: String(error) });
          }
        } else {
          try {
            await Promise.resolve(staleQuery.close());
          } catch (e) {
            log.warn('cancelled continuation query close threw before rebuild', { error: String(e) });
          }
        }
        try {
          q = await buildQuery({
            permissionMode: runtimeSnapshot.sdkPermissionMode,
            fresh: true,
          });
          if (signal?.aborted) {
            inputQueue.end();
            rewindTransitionQueries.add(q);
            try {
              await Promise.resolve(q.close());
            } catch (e) {
              log.warn('cancelled continuation rebuild close threw after send cancellation', {
                error: String(e),
              });
            }
            throw new Error('Claude send cancelled before acceptance');
          }
          startForwardLoop(q);
          notifySupportedModels(q);
          await replayRuntimeDrift(runtimeSnapshot, 'cancelled continuation rebuild');
          // Cancellation rebuilds used by send need the compact→user bridge for deferred
          // model/window drift. Rewind preview/commit use the same fresh-query isolation but
          // must not start a product turn or inject /compact before rewindFiles runs.
          const skipCompactBridge = options?.queueCompactBridge === false;
          const bridgeCompactQueued = skipCompactBridge
            ? false
            : queueAutoCompactBridge('cancellation');
          // Preview/commit must not generate, but a deferred compact caused by a
          // blocked model/window switch must survive until the next send. Keep
          // the tombstone only for that case; otherwise the fresh Query is ready
          // and the cancellation rebuild state can be cleared normally.
          continuationCancellationRequiresQueryRebuild = skipCompactBridge
            ? shouldRearmAutoCompactAfterRewindControl()
            : false;
          return bridgeCompactQueued;
        } finally {
          acceptingRebuiltSend = false;
        }
      } finally {
        cancellationRebuildGate = null;
        releaseCancellationRebuildGate?.();
      }
    }
    const handle: AgentSessionHandle = {
      get id() { return sdkSessionId ?? '<pending>'; },
      agentKind: 'claude-code',
      get model() { return mutableModel; },

      validateSendOptions(sendOpts: SendOptions) {
        if (
          sendOpts.turnPermissionPolicy &&
          (mutablePermissionMode === 'acceptEdits' ||
            mutablePermissionMode === 'bypassPermissions')
        ) {
          throw new TurnPermissionPolicyUnsupportedError(
            'claude-code',
            mutablePermissionMode,
          );
        }
      },

      async send(message: UserMessage, sendOpts?: SendOptions) {
        // idle resume fallback 正在重建(亚秒窗):等它完成再走正常受理。重建成功时
        // 消息透明跑在新会话上;重建失败/close 竞态时 push 撞上已 end 的队列,由下方
        // userInputAccepted 兜底干净收尾。不抛错 —— 见 idleResumeRebuildGate 声明处。
        while (idleResumeRebuildGate) {
          await idleResumeRebuildGate;
        }
        if (sendOpts?.signal?.aborted) {
          throw new Error('Claude send cancelled before acceptance');
        }
        if (sendOpts) handle.validateSendOptions?.(sendOpts);
        let bridgeCompactQueued = false;
        // 保持普通 send / rewind send 原有的同步前置语义：即使 async helper 立即
        // return，裸 await 也会让出一个 microtask，导致调用方在 Query rebuild 真正
        // 开始前观察到半初始化窗口。只有确实存在 cancellation tombstone 时才进入
        // 异步重建。
        if (
          continuationCancellationRequiresQueryRebuild &&
          pendingRewindTo === undefined &&
          activeBridgeRewindResumeAt === undefined
        ) {
          bridgeCompactQueued = await rebuildCancelledContinuationQuery(sendOpts?.signal);
        }
        activeTurnPermissionPolicy = sendOpts?.turnPermissionPolicy ?? null;
        // 仅用于诊断日志: 调用方每次 send 都可以带 logTitle (取自 storage 的最新值);
        // 缺省时保留上一次的值 (没传不等于"清空")。
        if (sendOpts?.logTitle !== undefined) lastSendTitle = sendOpts.logTitle;
        // 计划模式一次性语义: send 消耗武装态 → 本轮 plan turn 开始(SDK 已在 plan 档),
        // UI 勾选立即熄灭(host 收 plan_mode_changed 持久化 false + 广播)。
        // 若上一轮 planTurnActive 异常残留(事件循环崩溃没走 onTurnEnd), 这里先收尾。
        if (planTurnActive) {
          planTurnActive = false;
          if (!mutablePlanMode) {
            sdkInPlanMode = false;
            // rewind 窗口期旧 q 不可写, 跳过 — 档位由下方重建的 buildQuery 决定。
            if (!controlRequestsBlocked()) {
              void q.setPermissionMode(effectiveSdkPermissionMode()).catch((e) => {
                log.warn('stale plan turn cleanup setPermissionMode failed', { error: String(e) });
              });
            }
          }
        }
        // 本条消息的计划意图:sendOpts.planMode 是点击发送瞬间的快照(排队行透传),
        // 对已存活会话是权威;undefined 走旧语义(消耗当前武装态)。见 SendOptions.planMode。
        const requestedPlanTurn = sendOpts?.planMode ?? mutablePlanMode;
        if (requestedPlanTurn) {
          planTurnActive = true;
          if (mutablePlanMode && sendOpts?.planMode !== false) {
            mutablePlanMode = false;
            eventQueue.push({ type: 'plan_mode_changed', data: { enabled: false }, source: 'claude-code' });
          }
          // 武装发生在上一 turn 流式中(setPlanMode 递延了 SDK 切档)或该行意图来自
          // 排队快照(武装态已被改走) → 此刻补推。失败降级为普通 turn(warn 留痕)。
          // control request 被阻塞时旧 q 已 close, 跳过补推 — 下方重建的 buildQuery 会以
          // effectiveSdkPermissionMode()(planTurnActive 已置 true → 'plan') 起档。
          if (!sdkInPlanMode && !controlRequestsBlocked()) {
            try {
              await q.setPermissionMode('plan');
              sdkInPlanMode = true;
            } catch (e) {
              log.warn('deferred plan-mode SDK switch failed — sending as a normal turn', { error: String(e) });
            }
          }
        } else if (sdkInPlanMode) {
          // 显式普通消息(排队快照 false)但 SDK 还停在 plan 档(idle 武装时推过):
          // 本 turn 需要底层档;武装态保留给未来消息(下次消耗时经 !sdkInPlanMode 补推)。
          // control request 被阻塞时同上: 只改本地标记, 档位由重建的 buildQuery 决定。
          sdkInPlanMode = false;
          if (!controlRequestsBlocked()) {
            try {
              await q.setPermissionMode(toSdkPermissionMode(mutablePermissionMode));
            } catch (e) {
              log.warn('plan-armed SDK downgrade for explicit normal turn failed', { error: String(e) });
            }
          }
        }
        // turn 入口先打一行参数快照, 让日志能从一句 "send" 看清这轮是用哪个 model/effort/mode 跑的;
        // 不打消息全文 (Session.send 已经打过 summary 了, 这里只补 runtime params)
        log.debug('send ▶ user message', {
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          sdkSessionId,
          logTitle: lastSendTitle,
          pendingRewindTo: pendingRewindTo ?? '<none>',
          activeBridgeRewindResumeAt: activeBridgeRewindResumeAt ?? '<none>',
        });

        // ── Rewind 三件套重启 ──────────────────────────────────────────────
        // commitRewindFiles 只设标记, 真正的 SDK Query 重起延迟到这里 —— 老 agentManager
        // 同款设计 (CLI 拿到 input 才会发 init, 避免"无 input → 30s timeout"死锁)。
        let runtimeReplaySnapshot: QueryRuntimeSnapshot | undefined;
        const finishSendBeforeUserInput = (reason: string, error?: unknown): void => {
          if (
            bridgeCompactQueued &&
            !canceledBridgeQueries.has(q) &&
            bridgeStateActive()
          ) {
            log.warn('send failed after bridge /compact injection — canceling bridge query and preserving rewind resume point', {
              error: error === undefined ? undefined : String(error),
              queuedBridgeTurns,
              activeBridgeRewindResumeAt,
            });
            const abandonedBridgeKind = activeBridgeKind;
            const abandonedRewindResumeAt = activeBridgeRewindResumeAt;
            restoreBridgeAutoCompactSnapshot('bridge_send_abandoned');
            autoCompactController?.onCompactCanceled('bridge_send_abandoned');
            const suppressedDoneData = takeBridgeSuppressedDoneData();
            clearBridgeState();
            inputQueue.clear();
            try {
              inputQueue.end();
            } catch (endError) {
              log.warn('send failed after bridge /compact injection: inputQueue.end threw', { error: String(endError) });
            }
            canceledBridgeQueries.add(q);
            recordCanceledQueryClose(q, 'bridge send abandoned');
            turnInFlight = false;
            sendInAcceptPhase = false;
            turnState.interruptRequested = false;
            pendingToolIds.clear();
            acceptingRebuiltSend = false;
            preserveBridgeRetryTarget(abandonedBridgeKind, abandonedRewindResumeAt);
            emitTurnBoundary('bridge_send_abandoned', suppressedDoneData);
            return;
          }
          if (!turnInFlight) return;
          log.debug('send cancelled before user input was accepted — closing synthetic turn', {
            reason,
            error: error === undefined ? undefined : String(error),
          });
          turnInFlight = false;
          sendInAcceptPhase = false;
          turnState.interruptRequested = false;
          pendingToolIds.clear();
          acceptingRebuiltSend = false;
          clearUpstreamResponseIdle();
          // 同一次 Stop 只发一个终态: abort 若已为被取消的 continuation 发过
          // turn_continuation_cancelled(同一代), 这里只清状态、不再补 done。
          if (stopTerminalEmittedGeneration !== turnState.generation) {
            emitTurnBoundary(reason);
          }
        };
        if (pendingRewindTo || activeBridgeRewindResumeAt) {
          const resumeAt = pendingRewindTo ?? activeBridgeRewindResumeAt;
          if (!resumeAt) {
            throw new Error('Claude rewind rebuild missing resume target');
          }
          log.debug('send ▶ pendingRewindTo detected — rebuilding sdkQuery with 三件套', {
            resumeSessionAt: resumeAt,
            resumeSdkSid: sdkSessionId,
          });
          // 关键: 重建 abortController + inputQueue。老的两个在 q.close() 时已经污染
          // (controller 进 aborted 状态, queue 的 generator 还在等 waiter), 复用会让
          // 新 sdkQuery 立刻报 aborted 或抢不到新 push 的消息。先 end 老 queue 让老
          // generator 退出, 再整体换新。
          inputQueue.end();
          inputQueue = createAsyncQueue<SdkUserInput>();
          abortController = new AbortController();
          // QueryEngine 的 result.usage 是单个 SDK query 内的累计值。rewind 会重建
          // query 并从 0 重新累计, 因此必须清掉旧 query 的 aggregate 基线。
          runtimeState.lastResultUsageAggregate = null;
          // 快照 rebuild 起点的运行时档位 — buildQuery 的同步头部读的就是此刻的
          // 闭包值; await 期间若有切换到达(被 controlRequestsBlocked() 短路成"只更新闭包"),
          // 下方 diff 重放据此识别漂移项。
          const snapModel = mutableModel;
          const snapEffort = mutableEffort;
          const snapFastMode = mutableFastMode;
          // 用 turn-scoped 档快照 (planTurnActive + mutablePermissionMode), 不含 mutablePlanMode
          // arm 态。await buildQuery 期间到达的 setPlanMode(arm) 不会影响本 turn — arm 是下一次
          // send 的意图, 本 send 已在头部按 requestedPlanTurn 决定了自己的 SDK 档 (Codex review
          // 3535660068 / 3535801840)。该快照既用于 replay diff,也会显式传给 buildQuery 作为
          // 新 Query 的起档 permissionMode,避免 buildQuery 再读包含 arm 态的 effectiveSdkPermissionMode()。
          const snapSdkPermissionMode = currentTurnSdkPermissionMode();
          // 将 turn-scoped permissionMode 显式传给 buildQuery: send 头部已经按
          // sendOpts.planMode / mutablePlanMode 决定了**本 turn**的 plan 意图, rebuild 起档
          // 不能再读包含 arm 态的 effectiveSdkPermissionMode()。否则 rewind 窗口里用户 arm
          // 了下一 turn 的 plan,但当前排队行显式 planMode:false 时,新 Query 会先以 plan
          // 起跑且 replay 看不到 diff,导致普通 turn 误跑成 plan turn (Codex review 3535801840)。
          q = await buildQuery({
            resumeSessionAt: resumeAt,
            forkSession: true,
            permissionMode: snapSdkPermissionMode,
          });
          if (sendOpts?.signal?.aborted) {
            inputQueue.end();
            canceledBridgeQueries.add(q);
            try {
              q.close();
            } catch (e) {
              log.warn('rewind rebuild cancellation: q.close threw', { error: String(e) });
            }
            throw new Error('Claude send cancelled before acceptance');
          }
          startForwardLoop(q);
          acceptingRebuiltSend = true;
          // 标记必须等 q 替换完才清 (不能在 await buildQuery 之前):
          //  - await 期间 runtime 切换 IPC 仍可能到达, controlRequestsBlocked()
          //    提前变 false 会让 setModel / setPermissionMode 打到旧的已 close Query, 复现
          //    "ProcessTransport is not ready for writing" (Codex review P2)。
          //  - buildQuery 抛错时标记保留, 下一次 send 重试 rebuild, 而不是把
          //    后续消息推进已死旧 q 的黑洞。
          // 新 forward loop 是 async 任务, 在本同步段之后才起跑, 不会误读到 true。
          pendingRewindTo = undefined;
          clearBridgeState();
          runtimeReplaySnapshot = {
            model: snapModel,
            effort: snapEffort,
            fastMode: snapFastMode,
            sdkPermissionMode: snapSdkPermissionMode,
          };
          await replayRuntimeDrift(runtimeReplaySnapshot, 'rewind rebuild');
          if (sendOpts?.signal?.aborted) {
            pendingRewindTo = resumeAt;
            clearBridgeState();
            acceptingRebuiltSend = false;
            inputQueue.end();
            canceledBridgeQueries.add(q);
            try {
              q.close();
            } catch (e) {
              log.warn('rewind rebuild replay cancellation: q.close threw', { error: String(e) });
            }
            throw new Error('Claude send cancelled before acceptance');
          }
          // 补触发 auto-compact (Codex review P2):
          // 窗口期 setModel 大窗 → 小窗切换时跳过了 triggerAutoCompactIfNeeded (旧
          // inputQueue 会被丢, 触发无意义)。此刻 inputQueue / q 都已换新, 且用户消息
          // 还没 push, 是补触发的正确时机 — 未越阈值时 controller.shouldCompactNow()
          // 返回 false, 完全 no-op。触发时 /compact 会先于用户消息进新 inputQueue,
          // SDK 先压缩再处理用户消息, 与 idle setModel 的语义等价, 避免小窗切换后首
          // 轮直接撞上下文上限。
          // 桥接 turn 计数: 实际 push /compact 时 +1, 让后续 middle-turn suppress /
          // onTurnEnd 保持 turnInFlight 靠精确计数, 不受 SDK prompt 消费模式影响。
          bridgeCompactQueued = queueAutoCompactBridge('rewind', resumeAt);
          // 本次 send 的 bridge state 已注册;guard 继续保持到下面 turnInFlight=true,
          // 防止 runtime setter 在 user turn 尚未登记时把 /compact 注入成未标记 turn。
        }

        // 兜底重置 currentTurn —— 上一 turn 异常 / abort 时 endTurn 可能没跑,
        // 防止 currentTurn 残留累加到下一 turn (lastApi / contextWindow / cost 跨 turn 保留)
        beginNewTurn();
        toolLoopGuard?.resetTurn();
        // 标记 turn 进入 in-flight 态 (translator.onTurnEnd 在 result 事件回调时清);
        // rewind preview/commit 守卫读 isTurnRunning() 决定能否操作。
        sendInAcceptPhase = true;
        turnInFlight = true;
        // 对齐老 agentManager.ts:1623 — send 入口立刻 emit "Thinking...", 让 renderer 的
        // RunningStatusBar 一发就亮; 否则从 send 到 SDK message_start 之间的几百 ms~几秒 gap
        // statusbar 一直 hidden, 用户体感上"只有 Done 才闪一下"。SDK 回 message_start 时
        // translator 会自动覆盖成 Generating...
        // 数值带 tracker.snapshot() —— contextTokens/contextWindow 跨 turn 保留, costUsd 累计;
        // tokenUsage 此时已被 beginTurn 清零, 0 是正确值。
        // status 文案带用户名 — 从 phrase 池抽样 (含 one-shot 引导 + 阶梯 pity 保底)。
        // 命中 one-shot 后推进展示次数, 并清 pity 计数让下一档保底独立累计。
        const turnStartPick = pickTurnStartStatus(sendOpts?.userName, oneShotTipState);
        if (turnStartPick.oneShotId) {
          const id = turnStartPick.oneShotId;
          oneShotTipState.displayed.set(id, (oneShotTipState.displayed.get(id) ?? 0) + 1);
          oneShotTipState.pity.delete(id);
        }
        eventQueue.push({
          type: 'status',
          data: {
            status: turnStartPick.text,
            ...usageTracker.snapshot(),
            isRunning: true,
          },
          source: 'claude-code',
        });
        if (acceptingRebuiltSend) {
          acceptingRebuiltSend = false;
          if (runtimeReplaySnapshot) {
            await replayRuntimeDrift(runtimeReplaySnapshot, 'rewind accept');
          }
          if (sendOpts?.signal?.aborted) {
            finishSendBeforeUserInput('send_cancelled_before_acceptance');
            throw new Error('Claude send cancelled before acceptance');
          }
        }
        let userInputAccepted = false;
        try {
          const content = await toClaudeSdkContent(message.content);
          if (sendOpts?.signal?.aborted) {
            throw new Error('Claude send cancelled before acceptance');
          }
          // **Remote attachment guard (MVP)**: 远端 session 走 cc 进程在 SSH host 上跑,
          // 本地图片/文件附件转出来的 `@"<desktop-local-path>"` 引用在远端找不到文件,
          // 模型看不见 → silent context loss。完整修法是 upload 文件到远端 (follow-up),
          // 这里 MVP 检测到附件就 emit warn event 让用户知道,实际请求里把附件 ref 留着
          // (daemon 端 SDK 读不到就跳过, 不会 crash)。
          if (opts.remoteHostId && Array.isArray(message.content)) {
            const hasAttachment = message.content.some(
              (b) => b.type === 'image' || b.type === 'file' || b.type === 'mention',
            );
            if (hasAttachment) {
              log.warn('cc remote: local file/image attachment not accessible on remote session', {
                sessionId: opts.sessionId,
                hostId: opts.remoteHostId,
              });
              eventQueue.push({
                type: 'error',
                data: {
                  message: '[REMOTE_LOCAL_ATTACHMENT_UNSUPPORTED] Local file/image attachments are not accessible on remote sessions. Paste content directly instead.',
                  isTerminal: false,
                },
                source: 'claude-code',
              });
            }
          }
          // Claude Code streaming-input 协议要求 message 包装层,漏掉会 exit code 1。
          // sendOpts.messageUuid 注入到 SDK input.uuid — SDK 透传当作 file checkpoint
          // snapshot 的 messageId, rewind preview 拿同款 uuid 调 rewindFiles dryRun。
          const sdkInput: SdkUserInput = {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
            ...(sendOpts?.messageUuid ? { uuid: sendOpts.messageUuid } : {}),
          };
          const accepted = inputQueue.push(sdkInput);
          if (!accepted) {
            // close() can win while content conversion is still preparing files or
            // images. Renderer now treats send resolve as "agent accepted"; so a
            // closed input queue must reject just like steer, otherwise queue rows
            // get persisted and removed even though Claude never received them.
            throw new Error('Claude input queue is closed');
          }
          userInputAccepted = true;
          activeCapabilitySelectionText = userMessageTextForCapabilityRouting(message.content);
          setAutoReviewIntent(message.content);
          replayableUserInput = sdkInput;
          sendInAcceptPhase = false;
          // upstream-response-idle watchdog 起表 — 放在 inputQueue.push 之后, 避免把
          // client 端的 toClaudeSdkContent (多模态 image-resizer 同步等几秒) 算进上游
          // 响应配额。否则 warn 日志里 lastEventType=null + msSinceLast=null 会指错方向
          // (看上去像"上游一句话没回", 实际是 send 还没真发出去)。
          armUpstreamResponseIdle();
        } catch (e) {
          if (
            bridgeCompactQueued &&
            !canceledBridgeQueries.has(q) &&
            bridgeStateActive()
          ) {
            finishSendBeforeUserInput('bridge_send_abandoned', e);
          } else if (sendOpts?.signal?.aborted) {
            finishSendBeforeUserInput('send_cancelled_before_acceptance', e);
          } else if (!userInputAccepted) {
            // 用户输入从未进入队列(附件转换失败,或 push 撞上 invalid-resume 无 replay
            // 重建「旧队列已 end、新队列未替换」的交替窗口返回 false):必须回收本 send
            // 已登记的 turn 状态。否则 turnInFlight 悬置 true 且永无终态事件,Session 层
            // 后续 send 一律 SESSION_RUNNING、renderer 静默排队重试,会话被永久卡成 busy。
            finishSendBeforeUserInput('send_failed_before_user_input', e);
          }
          throw e;
        }
      },
      async steer(message: UserMessage, sendOpts?: SendOptions) {
        if (sendOpts?.signal?.aborted) {
          throw new Error('Claude steer cancelled before acceptance');
        }
        if (sendOpts?.logTitle !== undefined) lastSendTitle = sendOpts.logTitle;
        if (!turnInFlight) {
          throw new Error('No active Claude turn to steer');
        }
        log.debug('steer ▶ user message', {
          model: mutableModel,
          effort: mutableEffort,
          permissionMode: mutablePermissionMode,
          sdkSessionId,
          logTitle: lastSendTitle,
        });

        const content = await toClaudeSdkContent(message.content);
        if (sendOpts?.signal?.aborted) {
          throw new Error('Claude steer cancelled before acceptance');
        }
        if (!turnInFlight) {
          // Image resizing can take long enough for a fast turn to finish. Do not
          // silently route a stale "插话" into the next send path; the renderer
          // keeps the original queue/composer content and lets the user retry.
          throw new Error('No active Claude turn to steer');
        }
        // Same-turn steering deliberately does NOT call beginTurn(), reset the
        // tool-loop guard, or emit a new running status. Those are turn-start
        // side effects; doing them here would corrupt usage attribution and make
        // the UI believe a fresh turn started even though Claude is still inside
        // the existing streaming-input query.
        const accepted = inputQueue.push({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          ...(sendOpts?.messageUuid ? { uuid: sendOpts.messageUuid } : {}),
        });
        if (!accepted) {
          // close() ends the streaming input queue. Before push returned a
          // delivery signal this race looked successful to IPC, so renderer
          // removed the queued row / optimistic bubble even though Claude never
          // received it.
          throw new Error('No active Claude turn to steer: input queue is closed');
        }
        appendActiveCapabilitySelectionText(
          userMessageTextForCapabilityRouting(message.content),
        );
        setAutoReviewIntent(message.content);
        armUpstreamResponseIdle();
      },

      async abort() {
        // 只 interrupt 当前 turn, 不能 abortController.abort() ——
        // 那会杀掉整个 SDK Query, 让 streaming-input 流断开 (for await 抛
        // 'aborted by user' → eventQueue.end()), 后续 send 进黑洞 session 卡死。
        // abortController 只在 close() 里打。
        // 先清 pending 避免后续 message 被旧 id 短路 arm (onTurnEnd 会再清一次, 幂等)。
        clearUpstreamResponseIdle();
        pendingToolIds.clear();
        if (canceledBridgeQueries.has(q)) {
          log.debug('abort ignored because bridge query was already canceled');
          return;
        }
        // 用户主动 Stop 若发生在 rebuild 注入的 bridge /compact turn 中,语义是取消整条
        // "compact → real user message"序列,不是只停 /compact 后继续跑真实消息。
        // inputQueue.clear() 只能丢 maker-core 本地尚未被拉取的 item;SDK 可能已经 eager-drain
        // 了真实用户消息。此时必须 close 当前 Query 并保留 activeBridgeRewindResumeAt,让下一次
        // send 从同一个 rewind resume point 重建,从 SDK 侧取消已 drain 的后续输入。
        if (turnInFlight && bridgeStateActive()) {
          const abortedBridgeKind = activeBridgeKind;
          const abortedRewindResumeAt = activeBridgeRewindResumeAt;
          log.info('abort during bridge turn — closing query and preserving rewind resume point', {
            queuedBridgeTurns,
            queuedInput: inputQueue.pending,
            activeBridgeRewindResumeAt,
          });
          restoreBridgeAutoCompactSnapshot('bridge_aborted');
          autoCompactController?.onCompactCanceled('bridge_aborted');
          const suppressedDoneData = takeBridgeSuppressedDoneData();
          clearBridgeState();
          inputQueue.clear();
          try {
            inputQueue.end();
          } catch (e) {
            log.warn('abort during bridge turn: inputQueue.end threw', { error: String(e) });
          }
          canceledBridgeQueries.add(q);
          recordCanceledQueryClose(q, 'bridge aborted');
          // close 本地会连 CLI 子进程一起杀(远端为 daemon 侧 interrupt + 输入流收口,
          // SDK 退出前有极窄残留窗口,由下次 q 换代清表兜底),后台任务随之终止,清表即可。
          const cancelledContinuation = cancelActiveContinuation('bridge_aborted');
          if (!cancelledContinuation) settleActiveContinuation('bridge_aborted');
          runningBackgroundTasks.clear();
          terminalBackgroundTaskIds.clear();
          turnInFlight = false;
          // 本分支自己发 bridge_aborted 终态, send 的收尾责任就此交接完毕 ——
          // 一并清 sendInAcceptPhase。不清的话: send 醒来走进
          // finishSendBeforeUserInput, 入口守卫见 turnInFlight=false 直接返回,
          // sendInAcceptPhase 悬置 true, 后续每次 abort 都被 accept 让位守卫
          // 错误短路。boundary 只从这里发一次, send 那侧早退不再补发。
          sendInAcceptPhase = false;
          turnState.interruptRequested = false;
          preserveBridgeRetryTarget(abortedBridgeKind, abortedRewindResumeAt);
          emitTurnBoundary(
            'bridge_aborted',
            suppressedDoneData,
            cancelledContinuation !== null,
          );
          return;
        }
        // 用户主动停止: SDK 被 interrupt 后会 drain 出 error_during_execution 的
        // is_error result, 打标记让 translator turn-end 跳过"失败兜底 error",
        // 否则用户点停止会被误报成"执行失败"通知。
        // 前台仍在跑或 provider continuation 正在 awaiting 时都要锁定本代 Stop。
        // 后者的 turnInFlight 已经是 false，但 interrupt ACK 前的迟到 result 同样
        // 不得重新铸造 continuation claim。
        const awaitingContinuationAtUserStop = activeContinuationClaim();
        if (turnInFlight || awaitingContinuationAtUserStop?.state === 'awaiting') {
          turnState.interruptRequested = true;
          turnState.interruptGeneration = turnState.generation;
        }
        // 保持 turnInFlight 为 true 直到 interrupt 返回(或超时关 query)：
        // 提前清掉会让 Session.isTurnRunning() 报 idle，并发 send 通过守卫后
        // 把用户消息推进旧 q 的 inputQueue，然后在 interrupt 返回后被
        // inputQueue.clear() 抹掉 → 用户消息丢失(review P1-A)。
        // 5s 超时 + catch 兜底保证 turnInFlight 最终一定被清除，不会造成
        // SESSION_RUNNING 永拒。generation 守卫(translator handleResult)保证
        // 旧 q 的迟到 error_during_execution result 被丢弃、不污染新 turn。
        // sendInAcceptPhase 守卫: 并发 send 处于 accept 阶段时, 由 send 自己的
        // finishSendBeforeUserInput 负责清 turnInFlight + emit boundary,
        // abort 不能抢清, 否则 boundary 丢失(review 3541310178)。
        // 快照 turnInFlight 用于后续 close-query 分支判定(下方 foregroundNeedsTerminal
        // 需要旧值)。
        const foregroundWasInFlight = turnInFlight;
        if (!sendInAcceptPhase) {
          pendingToolIds.clear();
        }
        // 用户 Stop 的产品语义 = 本会话所有模型调用停止:先发 stopTask 再 interrupt
        // (同一控制通道按序处理)。interrupt 用 5s 超时防止 SDK retry backoff 死等；
        // 超时或失败时关 query 让下次 send 走 lazy rebuild。
        const stopRequests = stopRunningWakeBackgroundTasks('user_stop');
        const ABORT_INTERRUPT_TIMEOUT_MS = 5_000;
        try {
          await Promise.race([
            q.interrupt(),
            new Promise<void>((_, reject) =>
              setTimeout(() => reject(new Error('INTERRUPT_TIMEOUT')), ABORT_INTERRUPT_TIMEOUT_MS),
            ),
          ]);
          // stopTask and interrupt share an ordered control channel: an
          // interrupt ACK guarantees these earlier stop requests have settled,
          // so allSettled intentionally has no extra timeout here.
          const settledStops = await Promise.allSettled(stopRequests.map(({ promise }) => promise));
          const fulfilledWakeIds = stopRequests
            .filter((_, index) => settledStops[index]?.status === 'fulfilled')
            .map(({ taskId }) => taskId);
          // interrupt ACK authorizes retiring only wake tasks whose stop RPC
          // also succeeded. Rejected stops remain tracked for provider events,
          // preserving their continuation contract instead of creating an
          // unaccounted auto-continue.
          const stoppedClaim = markWakeTasksStopped(fulfilledWakeIds, 'user_stop');
          // Stop is the authoritative cancellation boundary. An awaiting
          // continuation may already have lost every task from the running
          // table, so neither stopTask nor an idle interrupt is guaranteed to
          // produce another provider result. A rejected stop is likewise
          // unconfirmed even when a completed notification already removed
          // that task from the local table; the old Query must still be closed
          // to prevent a queued automatic continuation from escaping Stop.
          const cancelledContinuation = stoppedClaim ?? cancelActiveContinuation('user_stop');
          const hasUnconfirmedWakeTasks = [...runningBackgroundTasks.values()].some((info) => info.wake);
          // Once Stop has dispatched stopTask for any wake task, the provider
          // Query must be retired regardless of RPC outcome. A fulfilled RPC
          // only acknowledges the cancellation request; it cannot prove that
          // an automatic continuation was not already queued in the provider.
          // Closing the Query is therefore the only boundary that guarantees
          // no later model call. Mixed local_bash tasks intentionally die with
          // this Query; preserving them would reopen the unsafe same-Query path.
          const shouldRetireQuery =
            stopRequests.length > 0 ||
            cancelledContinuation ||
            hasUnconfirmedWakeTasks;
          if (shouldRetireQuery) {
            // All cancellation sources share one terminal state: a cancelled
            // continuation claim, an unconfirmed wake task, or a rejected stop
            // means this Query must be retired. The provider tail is fenced by
            // the per-query marker, then the next send/rewind installs a fresh
            // Query.
            const cancelledQuery = q;
            // 用 Stop 之前的 turnInFlight 快照判定 foreground 是否需要终态。
            // close-query 分支需要旧值决定是否补 boundary。
            canceledBridgeQueries.add(cancelledQuery);
            // Query retirement always leaves a rebuild tombstone, even if the
            // synthetic boundary is rejected because the event queue is
            // already closing. The next explicit send/rewind must never push
            // into this retired query.
            continuationCancellationGeneration = turnState.generation;
            continuationCancellationRequiresQueryRebuild = true;
            if (cancelledContinuation) {
              // The successful Stop revokes the continuation contract. Retire
              // its task ledger before closing the provider process.
              retireContinuationTasks(cancelledContinuation);
              emitCancelledContinuationBoundary(cancelledContinuation, 'user_stop');
            } else {
              log.info('closing Query after user Stop with unconfirmed wake tasks', {
                generation: turnState.generation,
              });
              // close() prevents the interrupted result from arriving. If the
              // foreground turn has not already produced a terminal, replace
              // it with one synthetic boundary; a raced natural result leaves
              // foregroundWasInFlight=false and therefore does not get a duplicate.
              // accept 阶段的 foreground 终态归 send 的 finishSendBeforeUserInput:
              // 它醒来后按 signal.aborted / push 失败走到自己的 boundary。这里
              // 抢发会重复——一次 Stop 冒出两个终态。
              if (foregroundWasInFlight && !sendInAcceptPhase) {
                emitTurnBoundary('user_stop_unconfirmed_wake_tasks');
              }
            }
            inputQueue.clear();
            try {
              inputQueue.end();
            } catch (e) {
              log.warn('user_stop cancellation: inputQueue.end threw', { error: String(e) });
            }
            recordCanceledQueryClose(cancelledQuery, 'user_stop cancellation');
            runningBackgroundTasks.clear();
            terminalBackgroundTaskIds.clear();
            // main 上 #2151 已给 interrupt 成功分支挂了同一守卫; 本 PR 的差异是
            // close-query / 超时 / 抛错 / bridge 分支也一并纳入同一契约。
            if (!sendInAcceptPhase) turnInFlight = false;
          } else {
            // interrupt 成功且无后台任务需要清：被中断的 turn 会收到
            // error_during_execution result → translator 在 onTurnEnd 清
            // turnInFlight。这里显式补清以防 SDK 未 drain result 的极端
            // 情况(确保不会 SESSION_RUNNING 永拒)。
            //
            // accept 阶段除外——finishSendBeforeUserInput 的入口守卫是
            // `if (!turnInFlight) return`,abort 抢清会让它以为已被收口而直接
            // 返回,send_cancelled_before_acceptance 的终态 boundary 从此丢失,
            // isTurnRunning 悬置(review 3541310178 的反馈原型用例钉的就是它)。
            if (!sendInAcceptPhase) turnInFlight = false;
          }
        } catch (e) {
          const errMsg = e instanceof Error ? e.message : String(e);
          if (errMsg === 'INTERRUPT_TIMEOUT') {
            // SDK 长时间不响应 interrupt(在 retry backoff 中) → 关 query 让
            // 下次 send 走 lazy rebuild。
            log.warn('interrupt timed out during user stop — closing query', {
              sdkSessionId,
            });
            const cancelledContinuation = cancelActiveContinuation('user_stop');
            if (cancelledContinuation) {
              retireContinuationTasks(cancelledContinuation);
              emitCancelledContinuationBoundary(cancelledContinuation, 'user_stop');
            }
            continuationCancellationGeneration = turnState.generation;
            continuationCancellationRequiresQueryRebuild = true;
            canceledBridgeQueries.add(q);
            inputQueue.clear();
            try {
              inputQueue.end();
            } catch (ee) {
              log.warn('user_stop cancellation: inputQueue.end threw', { error: String(ee) });
            }
            recordCanceledQueryClose(q, 'user_stop interrupt timeout');
            runningBackgroundTasks.clear();
            terminalBackgroundTaskIds.clear();
            // accept 阶段同上——终态与清理归 send 自己(query 已被关闭, send 的
            // push 会失败并走 finishSendBeforeUserInput)。
            if (!sendInAcceptPhase) turnInFlight = false;
          } else {
            // interrupt 真正抛错(非超时)，回收标记防误抑制(同 watchdog)。
            turnState.interruptRequested = false;
            if (!sendInAcceptPhase) turnInFlight = false;
            log.warn('abort threw', { error: String(e) });
          }
        }
      },

      async stopBackgroundTask(taskId: string) {
        // 精确停单个后台任务(UI 对着具体任务卡点停)。与 abort 的全停语义不同:
        // 不碰当前 turn、不限 wake 型 —— local_bash 也允许(用户明确指着它停,
        // 不存在 abort 误杀 dev server 的顾虑)。
        // 幂等:任务已终态 / 未知(UI 点击与 task_notification 天然竞态)→ 静默成功。
        if (closed) return;
        if (!runningBackgroundTasks.has(taskId)) return;
        // 远端老 daemon / 老 SDK 没有 stopTask:明确失败(按钮不该假装成功)。
        if (typeof q.stopTask !== 'function') {
          throw new Error('stopTask is not supported by the current Claude SDK or remote daemon');
        }
        // The foreground `done` may arrive while stopTask is in flight. That is
        // safe: observers first enter provider continuation wait, then this
        // successful stop cancels it. Do not mark before the RPC resolves — a
        // rejected stop must leave the still-running task visible and pending.
        await q.stopTask(taskId);
        // Some older SDK/daemon pairs acknowledge stopTask without echoing a
        // task_notification(stopped). The accepted control action is already
        // authoritative enough to cancel the provider continuation wait.
        const cancelledClaim = markWakeTasksStopped([taskId], 'user_stop_task');
        if (cancelledClaim) {
          emitCancelledContinuationBoundary(cancelledClaim, 'user_stop_task');
        }
      },

      listBackgroundTasks() {
        // 当前仍在运行的后台任务快照(renderer 挂载 / reloadMessages 后重新水合
        // 任务卡与状态栏信号)。事件流才是实时源,这里只补「订阅之前已启动」的存量。
        if (closed) return [];
        return Array.from(runningBackgroundTasks, ([taskId, info]) => ({
          taskId,
          ...(info.taskType ? { taskType: info.taskType } : {}),
          ...(info.toolUseId ? { toolUseId: info.toolUseId } : {}),
          ...(info.title ? { title: info.title } : {}),
        }));
      },

      beginTurnContinuationWait(continuationId?: number) {
        if (continuationId === undefined) return null;
        return continuationClaims.get(continuationId)?.state ?? null;
      },

      onTurnContinuationChange(
        listener: (
          continuationId: number,
          state: 'awaiting' | 'active' | 'cancelled',
        ) => void,
      ) {
        continuationListeners.add(listener);
        return () => continuationListeners.delete(listener);
      },

      async close() {
        if (closed) return;
        // Closing/dead sessions settle through Session status (or their queued
        // terminal event), never through the successful task-stop path.
        discardActiveContinuation('session_closed');
        clearUpstreamResponseIdle();
        pendingToolIds.clear();
        turnInFlight = false;
        clearBridgeState();
        closed = true;
        try {
          // 任何挂着的 interaction 强制 deny + emit dismissed, 防止 host 卡住等永远不会来的回应
          dismissAllPending('session_closed', 'deny');
          inputQueue.end();
          abortController.abort();
          // close 会终结 CLI 子进程(本地)/ 远端 session,后台任务随之死亡。
          runningBackgroundTasks.clear();
          terminalBackgroundTaskIds.clear();
        } catch (e) {
          log.warn('close threw', { error: String(e) });
        }
        // 远端分支额外清理 — 走 query/close RPC 释放远端 cc-mgr SessionRegistry,
        // RemoteQuery.close 内部还会 unsubscribe + dispose ssh exec / nc / RpcClient
        // (经 openCcManagerSession 的 dispose hook 走完整链)。漏调会导致远端 daemon
        // 上 session 一直 alive, 既空耗 token, 也会让下次 attach 误连到旧 session。
        // 本地 SDK 分支不触发 (activeRemoteQuery 为 null)。
        if (activeRemoteQuery) {
          try {
            await activeRemoteQuery.close();
          } catch (e) {
            log.warn('remoteQuery.close threw (best-effort)', { error: String(e) });
          }
        }
      },

      ...(opts.remoteHostId
        ? {
            async detach() {
              if (closed) return;
              discardActiveContinuation('session_detached', true);
              clearUpstreamResponseIdle();
              pendingToolIds.clear();
              turnInFlight = false;
              clearBridgeState();
              closed = true;
              try {
                dismissAllPending('session_closed', 'deny');
                inputQueue.end();
                abortController.abort();
                runningBackgroundTasks.clear();
                terminalBackgroundTaskIds.clear();
              } catch (e) {
                log.warn('detach threw', { error: String(e) });
              }
              if (activeRemoteQuery) {
                try {
                  await (activeRemoteQuery.detach ?? activeRemoteQuery.close)();
                } catch (e) {
                  log.warn('remoteQuery.detach threw (best-effort)', { error: String(e) });
                }
              }
            },
          }
        : {}),

      events(): AsyncIterable<AgentEvent> {
        return consumedEventStream();
      },

      getUsageSnapshot(): UsageSnapshot {
        // 走 tracker —— translator 在 message_delta 时 ingest, result 时 endTurn 锁定;
        // 这里读到的就是最新值 (mid-turn 反映累加, turn end 后 reset 前是 turn aggregate,
        // 下一 turn beginTurn 后 reset 为 0)。
        return usageTracker.snapshot();
      },

      async getContextUsage() {
        const getContextUsage = (q as {
          getContextUsage?: () => Promise<unknown>;
        }).getContextUsage;
        if (!getContextUsage) {
          throw new Error('Claude Code SDK does not support getContextUsage');
        }
        return await getContextUsage.call(q) as import('../../types/context-usage.js').ContextUsageData;
      },

      setInteractionResolver(resolver: InteractionResolver) {
        interactionResolver = resolver;
      },

      // ── 运行时切换 (Stage 2 B) ─────────────────────────────────────────────
      // 三者都桥到 SDK Query 的 control request, 失败让上层抛 (Session 层会包成
      // NotSupportedError 不会到这, 只剩 SDK 自己的 transport / state 错误)。
      //
      // rewind 窗口期例外: commitRewindFiles 会 close 旧 Query 并设 pendingRewindTo,
      // 新 Query 延迟到下一次 send 才重建 (见 send 的"Rewind 三件套重启")。这个窗口里
      // 对旧 q 发 control request 必抛 "ProcessTransport is not ready for writing"
      // (renderer 端表现为"设置切换失败,未生效" toast)。窗口内只更新闭包状态即可:
      // buildQuery 重建时读的就是 mutableModel / mutableEffort / mutableFastMode /
      // effectiveSdkPermissionMode() 的最新值, 新设置会自然带上。

      async setModel(newModel: string, setModelOpts?: { providerId?: string | null }) {
        const targetProviderId = setModelOpts?.providerId !== undefined
          ? setModelOpts.providerId
          : mutableProviderId;
        // 远端会话切换模型/来源:远端 env 在 spawn 时已烤进 daemon,无法热改。若新
        // 模型/来源解析出的路由与当前不一致(路由类型或 env 内容变化),继续用旧
        // env 会以错误 endpoint/凭证打新模型(401/404/错租户)。重新解析比对,
        // 不一致则拒绝并提示重建会话;完全一致才放行。
        // providerId 用调用方给的目标来源(可能正在切 provider),缺省回落会话启动值。
        if (opts.remoteHostId && resolveRemoteClaudeRoute) {
          const nextRoute = await resolveRemoteClaudeRoute({
            providerId: targetProviderId,
            model: newModel,
          });
          const routeChanged =
            (nextRoute === null) !== (remoteRoute === null) ||
            (nextRoute !== null &&
              remoteRoute !== null &&
              (() => {
                // 与「当前生效的 remoteEnv」比对,而不是 spawn 时冻结的 remoteRoute.env:
                // refreshSubscriptionTokenInPlace 会原地写回 remoteEnv,因此它始终是最新
                // 凭证;nextRoute 也是现解析的最新值。
                //
                // 比对规则(四轮 review 的折中):
                // - endpoint + 非 token env 值:任一变化 → 拒绝(真路由/定制头变化);
                // - CLAUDE_CODE_OAUTH_TOKEN(订阅 token,有 oauth/refresh 通道)的**值**:
                //   不比对 —— 后台刷新先更新 nextRoute、远端 daemon 尚未 401 的轮换
                //   窗口会误拒;daemon 撞 401 时经 refresh 拿最新值。
                // - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN(自定义供应商 key,**无**
                //   refresh 通道)的**值**:仍比对 —— 用户改 key 后远端 daemon 会持续
                //   401,必须拒绝(Greptile 六轮)。存在性(在/不在)同样比对(路由类型)。
                const SUBSCRIPTION_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';
                const PROVIDER_KEY_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
                // 订阅身份元数据(scopes/subscriptionType/rateLimitTier)与 token 同源,
                // 会在用户零操作下漂移(登录后 backfill 补齐 / 订阅计划变更刷新)——
                // 与 token 同组按存在性比对,不按值(Fable 5 评估 B1:值比对会误拒)。
                const SUBSCRIPTION_METADATA_KEYS = new Set([
                  'CLAUDE_CODE_OAUTH_TOKEN',
                  'CLAUDE_CODE_OAUTH_SCOPES',
                  'CLAUDE_CODE_SUBSCRIPTION_TYPE',
                  'CLAUDE_CODE_RATE_LIMIT_TIER',
                ]);
                const routeKeys = new Set([
                  ...Object.keys(remoteRoute.env),
                  ...Object.keys(nextRoute.env),
                ]);
                // 非订阅字段的值(含自定义供应商 key + 定制头)按全并集比对;
                // 订阅字段(token + 元数据)只按「spawn 时声明过的字段」(remoteRoute.env
                // 的 key 集)比存在性 —— nextRoute 新增的元数据字段(backfill 后才有)
                // 不算变化,remoteEnv 烤的是 spawn 时快照(Fable 5 B1 修正)。
                const nonSubscriptionPick = (env: Record<string, string>): Record<string, string> =>
                  Object.fromEntries(
                    [...routeKeys]
                      .filter((k) => !SUBSCRIPTION_METADATA_KEYS.has(k) && env[k] !== undefined)
                      .map((k) => [k, env[k]]),
                  );
                const spawnDeclares = new Set(Object.keys(remoteRoute.env));
                const subscriptionPresenceOf = (env: Record<string, string>): string[] =>
                  [...spawnDeclares]
                    .filter((k) => SUBSCRIPTION_METADATA_KEYS.has(k) && env[k] !== undefined)
                    .sort();
                return (
                  nextRoute.endpoint !== remoteRoute.endpoint ||
                  JSON.stringify(nonSubscriptionPick(nextRoute.env)) !==
                    JSON.stringify(nonSubscriptionPick(remoteEnv ?? {})) ||
                  JSON.stringify(subscriptionPresenceOf(nextRoute.env)) !==
                    JSON.stringify(subscriptionPresenceOf(remoteEnv ?? {}))
                );
              })()) ||
            // 网关路径(route null):切模时重新读当前网关 key,与 remoteEnv 里 spawn 时
            // 烤进的比对——用户在设置里更新网关 key 后,远端 daemon 仍带旧 key,继续
            // 切模会放行到 401(Greptile 三轮)。
            (nextRoute === null &&
              remoteRoute === null &&
              (async () => {
                const currentAuthEnv = await getAuthEnv({ credentialMode: 'gateway-key' });
                return currentAuthEnv.ANTHROPIC_API_KEY !== remoteEnv?.ANTHROPIC_API_KEY;
              })());
          if (await routeChanged) {
            throw new Error(
              `[REMOTE_MODEL_SWITCH_ROUTE_CHANGE] switching to "${newModel}" requires a different remote route; close and recreate the remote session to apply it`,
            );
          }
          // 放行后**不**更新 remoteRoute:它是「spawn 时的路由指纹」,spawnDeclares
          // 永远用初次 spawn 的 key 集 —— nextRoute 新增的元数据字段(backfill 后
          // 才有)若被当成 spawn 声明,下次切模会与仍烤着旧快照的 remoteEnv 比对
          // 误拒(codex P2 #1035)。
        }
        const sdkModel = sdkModelFor(newModel);
        const isControlBlocked = controlRequestsBlocked();
        log.debug('setModel', { from: mutableModel, to: newModel, sdk: sdkModel, controlRequestsBlocked: isControlBlocked });
        if (!isControlBlocked) {
          await q.setModel(sdkModel);
        }
        const usedNativeAutoReview = usesNativeClaudeAutoReview();
        mutableProviderId = targetProviderId ?? null;
        mutableAutoReviewCredentialMode = resolveEffectiveCredentialModeFromAuthSource(
          resolveAgentCredentialMode({
            agentKind: 'claude-code',
            providerId: mutableProviderId,
            model: newModel,
          }),
          authState.authSource,
        );
        mutableModel = newModel;
        autoReviewDecisionCache.clear();
        // 换模型 / 换路由可能正好修掉了审阅器不可用的原因(目录解析失败、provider 被停用
        // 等);若换完又不可用,值得再提醒一次。
        autoReviewUnavailableNotice.reset();
        if (
          !isControlBlocked
          && mutablePermissionMode === 'auto'
          && usedNativeAutoReview !== usesNativeClaudeAutoReview()
        ) {
          // 切模(主操作)已生效、mutableModel/mutableProviderId/credentialMode 已同步为新值。
          // 这里的 auto 审查重配是附带的二次 apply:若它因 transport/SDK 失败仍抛,会把整个
          // setModel 报成失败、上层保留旧持久配置,而运行态其实已在新模型/路由 → 计费/凭证
          // 路由错配。与其它 post-hoc setPermissionMode 调用点(plan 审批后 / plan turn 结束)
          // 同款 best-effort:失败只 warn,不回退已成功的切模,让持久配置与运行态保持一致
          // (codex review)。
          await q.setPermissionMode(toSdkPermissionMode('auto')).catch((e) => {
            log.warn('setModel: auto-review permission-mode reapply failed; model switch kept', {
              model: newModel,
              error: String(e),
            });
          });
        }
        const newContextWindow = modelContextWindows.get(mutableModel);
        if (newContextWindow === undefined) {
          // setContextWindow(0) 是 no-op —— tracker 会静默沿用旧模型窗口直到下一个
          // result 的 modelUsage 修正。UI 环 / auto-compact 期间按旧窗口算(偏乐观),
          // 打一条 warn 让排查"切模型后窗口不对"时能看出来源陈旧。
          log.warn('setModel: target model contextWindow unknown in capabilities; tracker keeps previous window until next result', {
            model: newModel,
          });
        }
        usageTracker.setContextWindow(newContextWindow ?? 0);
        if (newContextWindow !== undefined) {
          // 大窗口 → 小窗口切换: 用新窗口重算 auto-compact ratio 并立即判定一次,
          // 已越阈值时空闲即触发静默 /compact, 不等下一轮 send 撞小窗口上限。
          // (turnInFlight 时 triggerAutoCompactIfNeeded 内部 no-op, 不打扰 in-flight turn。)
          autoCompactController?.onContextWindowChanged(newContextWindow);
          // control request 被阻塞时的 inputQueue 会在下一次 send 重建时被丢弃, 此时不能注入
          // /compact 或置 turnInFlight; 重建后 forward loop 的 usage 更新会重新判定。
          if (!isControlBlocked) {
            triggerAutoCompactIfNeeded();
          }
        }
        toolLoopGuard = isDeepSeekModel(mutableModel) ? new ToolLoopGuard() : null;
      },

      async setEffort(newEffort: Effort) {
        // maker 的 minimal / ultra 先归一成 Claude 的 low / max；2.1.219 起
        // applyFlagSettings 可原样接收 max，不能再静默降成 xhigh。
        const sdkEffort = getSdkEffortForModel(mutableModel, newEffort);
        const isControlBlocked = controlRequestsBlocked();
        log.debug('setEffort', { from: mutableEffort, to: newEffort, sdk: sdkEffort, controlRequestsBlocked: isControlBlocked });
        if (!sdkEffort) {
          mutableEffort = newEffort;
          return;
        }
        if (!isControlBlocked) {
          const appliedEffort = await applyClaudeEffortFlagSettings(
            q,
            sdkEffort,
            getSdkMaxEffortFallbackForModel(mutableModel),
          );
          if (appliedEffort !== sdkEffort) {
            log.warn('setEffort: runtime rejected max; applied model-compatible fallback', {
              model: mutableModel,
              requested: sdkEffort,
              applied: appliedEffort,
            });
          }
        }
        mutableEffort = newEffort;
      },

      async setFastMode(enabled: boolean) {
        // 与 setEffort 同款:走 SDK applyFlagSettings 改 flag settings 层 `fastMode`。
        // cc 二进制的 sticky-on latch 负责缓存安全(header 一旦发出整 session 保持,中途 toggle
        // 不破 server 端 cache key)—— 所以这里直接切、不做缓存兜底。是否 Opus/官方/firstParty
        // 由二进制把关(不支持时优雅 no-op),agent 不重复硬判(规则 9 留给配置 + 二进制)。
        const isControlBlocked = controlRequestsBlocked();
        log.debug('setFastMode', { from: mutableFastMode, to: enabled, controlRequestsBlocked: isControlBlocked });
        if (!isControlBlocked) {
          await q.applyFlagSettings({ fastMode: enabled });
        }
        mutableFastMode = enabled;
      },

      getFastMode() {
        return mutableFastMode;
      },

      async setPermissionMode(newMode) {
        // 用户自己动过权限档之后,「自动审核不可用」这条一次性提示重新武装:再回到 Auto
        // 又不可用时,他有权再看到一次(否则一个会话里只提示一次会显得像偶发)。
        // 档位变了 → 连**裁决缓存**一起清。缓存 key 不含 permissionMode,切离 Auto 再切回时
        // 会命中先前那条 `unavailable` block —— 审阅器早就恢复了,同一个动作还是被拒
        // (greptile P1 of #1574)。一次性提示同步重新武装:用户既然接管过,之后又不可用
        // 值得再提醒一次。
        if (newMode !== mutablePermissionMode) {
          autoReviewDecisionCache.clear();
          autoReviewUnavailableNotice.reset();
        }
        // 计划模式武装中 / 本轮 plan turn 进行中 SDK 恒在 plan 档: 只记录底层权限档
        // (循环收尾切回时生效), 不 push SDK、不动挂起交互(挂着的多半是 plan_review)。
        if (mutablePlanMode || planTurnActive) {
          log.debug('setPermissionMode (deferred, plan mode active)', { from: mutablePermissionMode, to: newMode });
          mutablePermissionMode = newMode;
          return;
        }
        // 老 agentManager.ts:1850-1893 的"切到更宽松 mode 时挂着的 ask 自动 allow,
        // 切到更严 mode 时 deny" 行为, 复用 dismissAllPending 钩子。
        // **auto 不再算"更宽松"**:Auto-review 语义已从"全放行"变成"区内放行、越界升级",
        // 挂起的授权请求本就是被升级的越界/风险动作,切到 auto 时应 fail-closed(deny),
        // 否则等于把待确认的越界动作橡皮图章掉。只有 bypassPermissions(Full access)才是
        // 真"全开"。与 Codex 侧 #767"切档时挂起请求统一拒绝"对称。
        const moreOpen = newMode === 'bypassPermissions';
        dismissAllPending(`permission_mode_changed_to_${newMode}`, moreOpen ? 'allow' : 'deny');
        // SDK PermissionMode union 没有 'ask' (我们对 ChatInput 暴露的统一名字),
        // SDK 侧把 ask 当 default —— 与 startSession 的处理一致。
        const sdkMode = toSdkPermissionMode(newMode);
        const isControlBlocked = controlRequestsBlocked();
        log.debug('setPermissionMode', { from: mutablePermissionMode, to: newMode, sdk: sdkMode, dismissedAs: moreOpen ? 'allow' : 'deny', controlRequestsBlocked: isControlBlocked });
        if (!isControlBlocked) {
          await q.setPermissionMode(sdkMode);
        }
        mutablePermissionMode = newMode;
      },

      async useCindyAutoReviewFallback() {
        if (nativeAutoReviewUnavailable) return;
        nativeAutoReviewUnavailable = true;
        autoReviewDecisionCache.clear();
        if (
          mutablePermissionMode === 'auto'
          && !mutablePlanMode
          && !planTurnActive
          && !controlRequestsBlocked()
        ) {
          await q.setPermissionMode('default');
        }
        log.warn('Claude native Auto reviewer unavailable; keeping Auto with Cindy fallback', {
          providerId: mutableProviderId,
          model: mutableModel,
        });
      },

      async setPlanMode(enabled: boolean) {
        if (mutablePlanMode === enabled) return;
        mutablePlanMode = enabled;
        // turn 流式中(含 plan turn 本身)只记账武装态、递延 SDK 切档:立即 push 会
        // 改写 in-flight turn 的工具权限,而武装态语义只作用于下一条消息。
        // 补推时机:send 消耗武装态时(!sdkInPlanMode → push plan);disarm 则无需
        // 补推(SDK 本就不在 plan 档,或由 plan turn 收尾逻辑统一切回)。
        if (turnInFlight || planTurnActive) {
          log.debug('setPlanMode (deferred, turn in flight)', { enabled });
          return;
        }
        // 进计划模式 = 收紧(deny 挂起授权); 退出按底层档宽松度决定 —— 与
        // setPermissionMode 的 moreOpen 语义一致(auto 不再算"更宽松",挂起的越界请求
        // 退出 plan 回到 auto 时仍 fail-closed;只有 bypassPermissions 是真"全开")。
        const moreOpen = !enabled && mutablePermissionMode === 'bypassPermissions';
        dismissAllPending(`plan_mode_${enabled ? 'enabled' : 'disabled'}`, moreOpen ? 'allow' : 'deny');
        const sdkMode = effectiveSdkPermissionMode();
        log.debug('setPlanMode', { enabled, sdk: sdkMode, underlying: mutablePermissionMode, controlRequestsBlocked: controlRequestsBlocked() });
        if (controlRequestsBlocked()) {
          // 重建时 buildQuery 以 effectiveSdkPermissionMode() 起档并回写 sdkInPlanMode
          return;
        }
        await q.setPermissionMode(sdkMode);
        sdkInPlanMode = sdkMode === 'plan';
      },

      getPlanMode() {
        return mutablePlanMode;
      },

      async setExtraDirs(newDirs: string[]) {
        // 只覆盖 closure。SDK 没有运行时 setAdditionalDirectories 入口, 但 buildQuery
        // 是 turn-by-turn 装配的 (rewind 重启 / fork 都走 buildQuery), 改完下一 turn
        // 自动用新值。当前 in-flight turn 不会变 (允许的 — 用户在 turn 中加目录
        // 通常意图是"下一 turn 让你看到新目录")。
        log.debug('setExtraDirs', { from: mutableExtraDirs.length, to: newDirs.length });
        mutableExtraDirs = [...newDirs];
      },

      async setVendorOptions(patch: Record<string, unknown>) {
        // 必须 **in-place 合并**, 见 startSession 里 `const vo` 注释。
        // buildQuery 在 startSession 时跑一次, MCP server 的 tool handler 闭包
        // 捕获了 ctx 引用 (ctx.vendorOptions === 此 vo 对象), 重赋值 vo 会让闭包
        // 永远停留在旧值上。Object.assign 让所有持有 ref 的闭包共享同一份。
        // 当前 in-flight turn 不影响 (与 setExtraDirs 同语义); 后续 turn / 异步
        // tool 调用立即看到新字段。
        const before = JSON.stringify(vo);
        Object.assign(vo, patch);
        log.debug('setVendorOptions', { patch: Object.keys(patch), changed: JSON.stringify(vo) !== before });
      },

      // ── Rewind (Stage 2 C2) ────────────────────────────────────────────────

      isTurnRunning(): boolean {
        // 前台 result/done 到后台 wake 任务自动续 turn 之间，SDK 会短暂把
        // turnInFlight 清成 false，但从产品/Session 视角 Agent 仍未执行结束。
        // 把 provider 已锁存的 continuation claim 纳入权威 busy 判据，统一阻止
        // 新 send、rewind 与 closeIfIdle 插入该窗口。
        return (
          turnInFlight ||
          activeContinuationClaim()?.state === 'awaiting' ||
          pendingContinuationTerminalBoundaries > 0
        );
      },

      async previewRewindFiles(userUuid: string): Promise<RewindFilesResult> {
        // invalid-resume 重建期间 q 是死掉/半替换的旧 query:与 send 同款等待门禁,
        // 替换 query 就绪后再操作(dryRun 在全新会话上自然返回 canRewind:false 软拒绝)。
        while (idleResumeRebuildGate) {
          await idleResumeRebuildGate;
        }
        if (continuationCancellationRequiresQueryRebuild) {
          // Stop may have already closed the old Query while leaving the
          // cancellation rebuild tombstone for the next explicit turn. A
          // rewind preview is also a valid next control action: install an
          // isolated fresh Query first, but do not inject the send-only
          // /compact bridge or start a product turn.
          await rebuildCancelledContinuationQuery(undefined, { queueCompactBridge: false });
        }
        log.info('previewRewindFiles', { userUuid, sdkSessionId });
        try {
          const result = await q.rewindFiles(userUuid, { dryRun: true });
          log.info('previewRewindFiles result', {
            canRewind: result.canRewind,
            filesCount: result.filesChanged?.length ?? 0,
            insertions: result.insertions,
            deletions: result.deletions,
            error: result.error ?? null,
          });
          return result;
        } catch (err) {
          // SDK 抛错 (老 session 没开 checkpointing 等) 包成软拒绝, UI 走 Empty/Error 态。
          // 业务层 (Dialog) 仍可让用户继续 commit, 由 forkSession=true 兜底。
          const errMsg = err instanceof Error ? err.message : String(err);
          log.warn('previewRewindFiles SDK threw', { error: errMsg });
          return {
            canRewind: false,
            error: errMsg,
            filesChanged: [],
            insertions: 0,
            deletions: 0,
          };
        }
      },

      async commitRewindFiles(userUuid: string, priorAssistantUuid: string): Promise<undefined> {
        // 同 previewRewindFiles:重建窗口内不得对死掉/半替换的 q 做 rewindFiles/close,
        // 否则 pendingRewindTo 会指向一个已不存在的会话时点。等替换 query 就绪再走。
        while (idleResumeRebuildGate) {
          await idleResumeRebuildGate;
        }
        if (continuationCancellationRequiresQueryRebuild) {
          // See previewRewindFiles: rebuild the fenced Query without the
          // compact bridge so rewindFiles retains its checkpoint semantics.
          await rebuildCancelledContinuationQuery(undefined, { queueCompactBridge: false });
        }
        log.info('commitRewindFiles ▶', { userUuid, priorAssistantUuid, sdkSessionId });
        // ① 立即把文件回滚到 target 时点 (失败 warn + 继续, forkSession=true 兜底)
        try {
          await q.rewindFiles(userUuid, { dryRun: false });
          log.debug('commitRewindFiles: SDK rewindFiles ok');
        } catch (err) {
          log.warn('commitRewindFiles: rewindFiles failed, continuing (forkSession on next send will retry)', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // ② **先**设 rewind transition 再 close —— q.close() 会让正在跑的 forward loop
        //    for-await 抛 "Claude Code process aborted by user", 这是预期行为不是错误。
        //    pendingRewindTo 是共享标记,会在新 q 接管后清掉;因此还要把当前 q 放进
        //    per-query transition 集合,确保旧 forward loop 迟到退出时仍静音,不误关新 q。
        //    顺序很重要 —— catch 是 microtask, q.close() 同步触发, 标记必须先设上。
        pendingRewindTo = priorAssistantUuid;
        rewindTransitionQueries.add(q);
        try {
          q.close();
          log.debug('commitRewindFiles: q.close() ok');
        } catch (err) {
          log.warn('commitRewindFiles: q.close() threw', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        // turn 没在跑了, 清守卫标记 (rewind 必然在 idle 时调, 但兜底一把)
        turnInFlight = false;
        // bridge counter 兜底: rewind idle 时应该已经归零, 但如果上一轮 bridge 中途异常
        // (SDK 崩 / abort 未 drain result) counter 可能残留, 会污染 rebuild 后的第一 turn。
        clearBridgeState();
        log.info('commitRewindFiles ◀ pendingRewindTo set, awaiting next send to rebuild');
        return undefined;
      },
    };

    return handle;
  }

  // ── Memory 实现 ────────────────────────────────────────────────────────
  // 范围: SDK auto-memory (autoMemoryEnabled) + auto-dream (autoDreamEnabled, 联动)。
  // 数据落盘 ~/.claude/projects/<sanitized-cwd>/memory/ — per-cwd 子目录。
  // 开关本身是全局的 (Settings layer), 所以 reset 也按全局语义清所有项目下的 memory/。
  //
  // applyFlagSettings 是 per-Query 的, BaseAgent 不追踪 active session 引用,
  // 所以 setMemory 只更新 memoryOverride, 影响下次 buildQuery (新 session / rewind 重启);
  // 当前 live Query 仍按旧值跑 — 与 capabilities.memory.setEnabledMidSession.supported=false 对齐。

  async getMemoryStatus(): Promise<MemoryStatus> {
    const stats = await this.collectClaudeMemoryStats().catch((e) => {
      this.deps.logger.warn('getMemoryStatus: stats fs scan failed', { error: String(e) });
      return undefined;
    });
    return {
      // SDK 默认 autoMemoryEnabled=true; 没人覆盖时按默认报真值
      enabled: this.memoryOverride ?? true,
      source: this.memoryOverride === undefined ? 'agent-default' : 'host-runtime',
      ...(stats ? { stats } : {}),
    };
  }

  async setMemory(enabled: boolean): Promise<MemorySetResult> {
    this.deps.logger.info('claude-code: setMemory', { from: this.memoryOverride, to: enabled });
    this.memoryOverride = enabled;
    // 不主动 push 到 live Query (不追踪 active sessions); 下次 buildQuery 自动用新值
    return { effective: 'next-session' };
  }

  /**
   * 全局 reset: 遍历 ~/.claude/projects/*\/memory/ 全删。
   *
   * 与开关的全局语义对称 — autoMemoryEnabled 是 ~/.claude/settings.json 全局设置,
   * 影响所有 cwd, 所以 reset 也清所有 cwd 的 memory 子目录, 不止当前项目。
   *
   * 安全护栏: 严格只删 projectsRoot/<entry>/memory/ 子目录, 不动同级 *.jsonl session 历史,
   * 不递归到 projectsRoot 自己 (那是 Claude SDK 的多项目根)。
   */
  async resetMemory(): Promise<MemoryResetResult> {
    const log = this.deps.logger.child('claude-code/resetMemory');
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    // 安全 assertion: 路径必须落在 ~/.claude/ 下
    const claudeRoot = path.join(os.homedir(), '.claude') + path.sep;
    if (!projectsRoot.startsWith(claudeRoot) || projectsRoot === claudeRoot.slice(0, -1)) {
      throw new Error(`refuse to reset: unsafe projects root "${projectsRoot}"`);
    }

    let removedEntries = 0;
    let removedBytes = 0;
    const projects = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    log.info('resetMemory ▶', { projectsRoot, projectCount: projects.length });

    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memoryDir = path.join(projectsRoot, proj.name, 'memory');
      const stat = await fs.stat(memoryDir).catch(() => null);
      if (!stat?.isDirectory()) continue;

      const dirStat = await statMemoryDir(memoryDir).catch(() => ({ entryCount: 0, sizeBytes: 0 }));
      try {
        await fs.rm(memoryDir, { recursive: true, force: true });
        removedEntries += dirStat.entryCount;
        removedBytes += dirStat.sizeBytes;
      } catch (e) {
        log.warn('failed to remove memory dir, skipping', {
          memoryDir,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    log.info('resetMemory ◀', { removedEntries, removedBytes });
    return { removedEntries, removedBytes };
  }

  /**
   * 扫所有 ~/.claude/projects/*\/memory/ 汇总 stats。
   * 失败/不存在 → 返回 0,0 而不是 throw, getMemoryStatus 自己 catch 兜底。
   */
  private async collectClaudeMemoryStats() {
    const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
    let entryCount = 0;
    let sizeBytes = 0;
    const projects = await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => []);
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const memoryDir = path.join(projectsRoot, proj.name, 'memory');
      const sub = await statMemoryDir(memoryDir).catch(() => null);
      if (!sub) continue;
      entryCount += sub.entryCount;
      sizeBytes += sub.sizeBytes;
    }
    return {
      entryCount,
      sizeBytes,
      storagePath: projectsRoot,
    };
  }

  /**
   * Fork 一条已有的 Claude SDK session: 文件级 jsonl 截断 + remap uuid。
   * 不依赖 live session, 直接调 SDK 静态函数。
   *
   * 业务流 (调用方 desktop agentFork.ts 编排):
   *   1. 反向找 prior assistant uuid (跳 subagent / 跳 rewind 软删) → 传 upToMessageId
   *   2. 调本方法 → 拿到 newSdkSessionId + uuidMap
   *   3. SQLite 事务: insert 新 sessions row + bulk copy messages (用 uuidMap remap agentMeta)
   *
   * uuidMap 必要性: forkSession 会 remap 新 jsonl 里所有 uuid (SDK sdk.d.ts:539-543);
   * 若不修正 messages.agentMeta 列, 从 fork 出来的会话再 fork (B → C) 时 SDK
   * upToMessageId 拿的是 A 的旧 uuid, 在新 jsonl 找不到 → SDK 报错。
   */
  async forkSdkSession(opts: ForkSdkSessionOptions): Promise<ForkSdkSessionResult> {
    const log = this.deps.logger.child('claude-code/fork');
    const logRepairResult = (
      phase: 'source-preflight' | 'source-retry' | 'forked-post',
      sessionId: string,
      result: RepairForkedClaudeJsonlResult,
    ) => {
      if (result.compactMetadataRepairs.length === 0) return;
      log.warn('forkSdkSession Claude JSONL repair', {
        phase,
        sessionId,
        filePath: result.filePath,
        backupPath: result.backupPath ?? '<none>',
        compactBoundaryCount: result.compactBoundaryCount,
        remappedCompactRefCount: result.remappedCompactRefCount,
        unresolvedCompactRefCount: result.unresolvedCompactRefCount,
        clearedInvalidPreservedSegmentRefCount: result.clearedInvalidPreservedSegmentRefCount,
        compactMetadataRepairs: result.compactMetadataRepairs.map((repair) => ({
          boundaryUuid: repair.boundaryUuid ?? '<missing>',
          invalidRefs: repair.invalidRefs,
          removedPreservedSegment: repair.removedPreservedSegment,
          removedPreservedMessages: repair.removedPreservedMessages,
        })),
      });
    };
    const forkOnce = () => sdkForkSession(opts.sourceSdkSessionId, {
      upToMessageId: opts.upToMessageId,
      title: opts.title,
    });
    log.info('forkSdkSession ▶', {
      sourceSdkSessionId: opts.sourceSdkSessionId,
      upToMessageId: opts.upToMessageId,
      title: opts.title,
      workingDir: opts.workingDir ?? '<none>',
    });
    const sourceRepairResult = await repairForkedClaudeSessionJsonl({
      sessionId: opts.sourceSdkSessionId,
      workingDir: opts.workingDir,
    });
    logRepairResult('source-preflight', opts.sourceSdkSessionId, sourceRepairResult);
    if (sourceRepairResult.invalidPreservedSegmentRefCount > 0) {
      throw new Error(
        `source Claude JSONL has ${sourceRepairResult.invalidPreservedSegmentRefCount} invalid compact preservedSegment reference(s) before fork`,
      );
    }
    let newSdkSessionId: string;
    try {
      ({ sessionId: newSdkSessionId } = await forkOnce());
    } catch (error) {
      if (!isInvalidCompactPreservedSegmentForkError(error)) throw error;
      log.warn('forkSdkSession Claude SDK fork failed; repairing source JSONL and retrying once', {
        sourceSdkSessionId: opts.sourceSdkSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      const retryRepairResult = await repairForkedClaudeSessionJsonl({
        sessionId: opts.sourceSdkSessionId,
        workingDir: opts.workingDir,
      });
      logRepairResult('source-retry', opts.sourceSdkSessionId, retryRepairResult);
      if (retryRepairResult.invalidPreservedSegmentRefCount > 0) {
        throw new Error(
          `source Claude JSONL has ${retryRepairResult.invalidPreservedSegmentRefCount} invalid compact preservedSegment reference(s) after retry repair`,
        );
      }
      try {
        ({ sessionId: newSdkSessionId } = await forkOnce());
        log.info('forkSdkSession Claude SDK fork retry succeeded', {
          sourceSdkSessionId: opts.sourceSdkSessionId,
          newSdkSessionId,
        });
      } catch (retryError) {
        log.warn('forkSdkSession Claude SDK fork retry failed', {
          sourceSdkSessionId: opts.sourceSdkSessionId,
          error: retryError instanceof Error ? retryError.message : String(retryError),
        });
        throw retryError;
      }
    }
    const repairResult = await repairForkedClaudeSessionJsonl({
      sessionId: newSdkSessionId,
      workingDir: opts.workingDir,
    });
    logRepairResult('forked-post', newSdkSessionId, repairResult);
    if (repairResult.invalidPreservedSegmentRefCount > 0) {
      throw new Error(
        `forked Claude JSONL has ${repairResult.invalidPreservedSegmentRefCount} invalid compact preservedSegment reference(s) after uuid remap`,
      );
    }

    // fork 转录归位:SDK forkSession 把新 jsonl 写在**源转录旁边**,源若因 CLI
    // 运行中 cd 落在别的转码目录(典型:已删除 worktree 的孤儿目录),fork 也会
    // 落在那里,下一次按 workingDir resume 就找不到(2026-07-05 实测事故)。这里
    // 主动复制到 workingDir 的转码目录;projectsRoot 缺省与上方 repair 同源
    // (resolveClaudeProjectsRoot)。best-effort:失败只 warn,resume 侧(buildQuery)
    // 另有同款就位兜底。
    if (opts.workingDir) {
      try {
        const outcome = await ensureClaudeTranscriptInWorkingDir({
          sdkSessionId: newSdkSessionId,
          workingDir: opts.workingDir,
        });
        if (outcome === 'restored') {
          log.info('forkSdkSession transcript relocation', {
            newSdkSessionId,
            workingDir: opts.workingDir,
            outcome,
          });
        } else if (outcome === 'missing' || outcome === 'target-key-inexact') {
          // repair 刚确认过文件存在,这里 missing 意味着 projectsRoot 不一致或竞态,
          // 是异常信号;超长路径放弃归位同理——都走 warn 让生产告警能拦到。
          log.warn('forkSdkSession transcript relocation incomplete (resume-side bootstrap will retry)', {
            newSdkSessionId,
            workingDir: opts.workingDir,
            outcome,
          });
        }
      } catch (e) {
        log.warn('forkSdkSession transcript relocation failed (resume-side bootstrap will retry)', {
          newSdkSessionId,
          workingDir: opts.workingDir,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    log.info('forkSdkSession ◀', {
      newSdkSessionId,
      uuidMapSize: repairResult.uuidMap.size,
      jsonlLineCount: repairResult.lineCount,
      initialContextTokens: repairResult.initialContextTokens,
      compactBoundaryCount: repairResult.compactBoundaryCount,
      remappedCompactRefCount: repairResult.remappedCompactRefCount,
      unresolvedCompactRefCount: repairResult.unresolvedCompactRefCount,
    });
    return {
      newSdkSessionId,
      uuidMap: repairResult.uuidMap,
      ...(repairResult.initialContextTokens > 0
        ? { initialContextTokens: repairResult.initialContextTokens }
        : {}),
    };
  }
}

// SDKMessage → AgentEvent 翻译已搬到 ./translator.ts (translateSdkMessage)。
// 本文件只剩 agent 装配 + 事件 forward loop + canUseTool dispatch。

/**
 * 浅扫一个 memory 目录的 .md 文件数 + 总字节数。
 * - 不递归子目录 (Claude memory dir 是扁平结构: MEMORY.md + *.md)
 * - 不存在/读不到 → throw, 调用方自己 catch 兜默认值
 */
async function statMemoryDir(dir: string): Promise<{ entryCount: number; sizeBytes: number }> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  let entryCount = 0;
  let sizeBytes = 0;
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.md')) continue;
    entryCount += 1;
    const stat = await fs.stat(path.join(dir, ent.name)).catch(() => null);
    if (stat) sizeBytes += stat.size;
  }
  return { entryCount, sizeBytes };
}
