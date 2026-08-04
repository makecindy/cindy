/**
 * Bash 命令并发闸门 hooks —— 把 command-concurrency-gate 接到 Claude SDK 的
 * in-process hook 事件上。
 *
 * 事件分工:
 *   - PreToolUse('Bash')          : acquire —— 满员时在这里挂起排队,命令启动被推迟
 *   - PostToolUse('Bash')         : release —— 命令正常结束
 *   - PostToolUseFailure('Bash')  : release —— 命令失败/被打断
 *   - PermissionDenied('Bash')    : release —— 审批被拒,命令没跑
 *   - SessionEnd                  : releaseSession —— 会话收尾清扫(防漏)
 *   进程被杀等所有事件都收不到的情况,由 gate 内部 TTL 兜底回收。
 *
 * 关键保证:
 *   - **只挂起,不决策**: PreToolUse 永远不返回 permissionDecision,排队结束后
 *     照常进入原 permission 流程(canUseTool / 审批 UI / auto 分类器),不打穿
 *     Orca / 协同模式那套审批链路。
 *   - **fail-open**: gate 异常、toolUseID 缺失、等待被中止(hook 超时 / 用户打断)
 *     一律放行;本 hook 永远不能成为命令被卡死的原因。
 *   - matcher 是正则语义,'Bash' 也会命中 BashOutput 等工具名,hook 内一律做
 *     tool_name 严格等值判断(与 read-image-hook 同模式)。
 *
 * 已知边界(有意为之,v1 不处理):
 *   - run_in_background 的命令在 spawn 后立即返回 PostToolUse,槽位随即释放,
 *     后台常驻进程不受并发上限约束(否则 dev server 会永久占槽)。
 *   - ask 档下等待用户审批期间槽位不释放;被它挤住的其它命令最多等
 *     queueWaitMaxMs 后 fail-open 放行。目标场景(auto / Full access 并行跑测试)
 *     无此问题。
 *
 * 位置说明: 本文件在 host 层 (apps/desktop/src/main/maker-host/claude-hooks/),
 *           maker-core 不感知具体业务 hook —— 只暴露 AgentDeps.claudeHooks 注入点。
 */

import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { Logger } from '@cindy/maker-core';

import type { CommandConcurrencyGate } from '../command-concurrency-gate.js';

const BASH_TOOL_NAME = 'Bash';

/**
 * PreToolUse matcher 超时(秒)。必须显著大于 gate 的排队上限(默认 120s),
 * 否则 SDK 会先于 fail-open 把 hook 掐掉;留 3 倍余量。
 */
const PRE_TOOL_USE_TIMEOUT_SEC = 360;

/** 释放类 hook 输入的公共字段(PostToolUse / PostToolUseFailure / PermissionDenied)。 */
interface ReleaseHookFields {
  tool_name?: string;
  tool_use_id?: string;
}

/**
 * 工厂函数: 绑定 gate + logger,返回可直接并入 AgentDeps.claudeHooks 的事件表。
 * 注册侧用 mergeClaudeHooks 与其它 hook(如 read-image-hook)合并。
 */
export function createBashConcurrencyHooks(
  gate: CommandConcurrencyGate,
  logger: Logger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const log = logger.child('hook/bash-concurrency');

  const preToolUse: HookCallback = async (input, toolUseID, options) => {
    if (input.hook_event_name !== 'PreToolUse') {
      return { continue: true };
    }
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== BASH_TOOL_NAME) {
      return { continue: true };
    }
    if (!toolUseID) {
      // 没有 id 就无法配对释放,宁可放行也不能占一个永远还不掉的槽。
      log.debug('bash gate skipped: missing toolUseID', { sessionId: pre.session_id });
      return { continue: true };
    }
    try {
      const admission = await gate.acquire({
        toolUseId: toolUseID,
        sessionId: pre.session_id,
        signal: options.signal,
      });
      if (admission === 'queued' || admission === 'wait-timeout') {
        log.info('bash command admitted after queueing', {
          toolUseId: toolUseID,
          sessionId: pre.session_id,
          admission,
        });
      }
    } catch (err) {
      // gate.acquire 设计上不 reject,这里是兜底防御:任何异常都放行。
      log.warn('bash gate acquire threw, fail-open', {
        toolUseId: toolUseID,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { continue: true };
  };

  const releaseFor = (reason: string): HookCallback => {
    return async (input) => {
      const fields = input as unknown as ReleaseHookFields;
      if (fields.tool_name === BASH_TOOL_NAME && typeof fields.tool_use_id === 'string') {
        gate.release(fields.tool_use_id, reason);
      }
      return { continue: true };
    };
  };

  const sessionEnd: HookCallback = async (input) => {
    gate.releaseSession(input.session_id, 'session-end');
    return { continue: true };
  };

  return {
    PreToolUse: [
      {
        matcher: BASH_TOOL_NAME,
        hooks: [preToolUse],
        timeout: PRE_TOOL_USE_TIMEOUT_SEC,
      },
    ],
    PostToolUse: [{ matcher: BASH_TOOL_NAME, hooks: [releaseFor('post-tool-use')] }],
    PostToolUseFailure: [{ matcher: BASH_TOOL_NAME, hooks: [releaseFor('post-tool-use-failure')] }],
    PermissionDenied: [{ matcher: BASH_TOOL_NAME, hooks: [releaseFor('permission-denied')] }],
    SessionEnd: [{ hooks: [sessionEnd] }],
  };
}

/**
 * 合并多份 claudeHooks 事件表:同事件的 matcher 数组按序拼接。
 * SDK 对同事件多 matcher 逐个匹配执行,拼接不改变各自语义。
 */
export function mergeClaudeHooks(
  ...tables: Array<Partial<Record<HookEvent, HookCallbackMatcher[]>>>
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const table of tables) {
    for (const [event, matchers] of Object.entries(table) as Array<
      [HookEvent, HookCallbackMatcher[] | undefined]
    >) {
      if (!matchers || matchers.length === 0) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}
