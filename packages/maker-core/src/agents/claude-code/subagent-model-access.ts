import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSubagentModelAccessStatus = 'allowed' | 'denied' | 'unknown';

export interface ClaudeSubagentModelAccessResult {
  status: ClaudeSubagentModelAccessStatus;
  /** 可选的 host 诊断；只有 denied 会展示给用户。 */
  reason?: string;
}

export type ResolveClaudeSubagentModelAccess = (
  model: string,
) => ClaudeSubagentModelAccessResult | Promise<ClaudeSubagentModelAccessResult>;

export type ResolveClaudeSubagentModelContextWindow = (
  model: string,
) => number | undefined;

export function normalizeClaudeSubagentModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith('[1m]')
    ? normalized.slice(0, -'[1m]'.length)
    : normalized;
}

/** Add or remove Claude Code's explicit 1M context wire suffix for a known model. */
export function claudeSubagentModelWithContextWindow(
  model: string,
  contextWindow: number | undefined,
): string {
  const trimmed = model.trim();
  if (
    !trimmed
    || typeof contextWindow !== 'number'
    || !Number.isFinite(contextWindow)
    || contextWindow <= 0
  ) {
    return trimmed;
  }
  const bare = trimmed.replace(/\[1m\]$/i, '');
  return contextWindow >= 1_000_000 ? `${bare}[1m]` : bare;
}

/**
 * 返回 Agent/Task 实际会用的显式模型。平台 env 覆写优先于 tool input；
 * 缺省和 inherit 都交给 Claude 自己解析，不对无法证明的隐式默认值做拦截。
 */
export function effectiveClaudeSubagentModel(
  forcedModel: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  if (toolName !== 'Agent' && toolName !== 'Task') return undefined;
  const input = typeof toolInput === 'object' && toolInput !== null
    ? toolInput as Record<string, unknown>
    : {};
  const requested = typeof input.model === 'string' ? input.model : '';
  const effective = normalizeClaudeSubagentModel(forcedModel ?? requested);
  return !effective || effective === 'inherit' ? undefined : effective;
}

export function claudeSubagentModelDenialReason(model: string, detail?: string): string {
  return detail?.trim()
    || `Subagent model "${model}" is not available from the current account and provider. Choose an available model, or remove the unavailable override from the Agent call or Subagent Model setting.`;
}

/**
 * PreToolUse 先于权限模式执行，因此 Full access 也无法绕过。resolver 每次调用都
 * 现场读取 host 的当前账号/路由状态；缺失、异常或 unknown 一律放行，防止静态目录
 * 或旧快照被误当成权限拒绝。
 */
export function buildClaudeSubagentModelGuardHooks(
  resolveAccess: ResolveClaudeSubagentModelAccess | undefined,
  forcedModel?: string,
  onDeny?: (model: string) => void,
  resolveContextWindow?: ResolveClaudeSubagentModelContextWindow,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!resolveAccess && !resolveContextWindow) return {};

  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    const model = effectiveClaudeSubagentModel(forcedModel, pre.tool_name, pre.tool_input);
    const toolInput = typeof pre.tool_input === 'object' && pre.tool_input !== null
      ? pre.tool_input as Record<string, unknown>
      : undefined;
    const requestedModel = typeof toolInput?.model === 'string' ? toolInput.model : undefined;
    const modelToRewrite = requestedModel ?? forcedModel;
    let wireModel: string | undefined;
    if (modelToRewrite && resolveContextWindow) {
      try {
        wireModel = claudeSubagentModelWithContextWindow(
          modelToRewrite,
          resolveContextWindow(normalizeClaudeSubagentModel(modelToRewrite)),
        );
      } catch {
        // Context metadata is advisory; an unavailable live resolver must not
        // block an otherwise valid Agent/Task invocation.
        wireModel = undefined;
      }
    }
    const updatedInput = requestedModel && wireModel && wireModel !== requestedModel
      ? { ...toolInput, model: wireModel }
      : undefined;
    const continueWithUpdatedInput = updatedInput
      ? {
          continue: true as const,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            updatedInput,
          },
        }
      : { continue: true as const };

    if (!model) return continueWithUpdatedInput;

    if (resolveAccess) {
      let access: ClaudeSubagentModelAccessResult;
      try {
        access = await resolveAccess(model);
      } catch {
        return continueWithUpdatedInput;
      }
      if (access.status === 'denied') {
        onDeny?.(model);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: claudeSubagentModelDenialReason(model, access.reason),
          },
        };
      }
    }
    return continueWithUpdatedInput;
  };

  return {
    PreToolUse: [
      { matcher: 'Agent', hooks: [guard] },
      { matcher: 'Task', hooks: [guard] },
    ],
  };
}
