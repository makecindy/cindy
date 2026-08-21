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

export function normalizeClaudeSubagentModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  return normalized.endsWith('[1m]')
    ? normalized.slice(0, -'[1m]'.length)
    : normalized;
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
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (!resolveAccess) return {};

  const guard: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    const model = effectiveClaudeSubagentModel(forcedModel, pre.tool_name, pre.tool_input);
    if (!model) return { continue: true };

    let access: ClaudeSubagentModelAccessResult;
    try {
      access = await resolveAccess(model);
    } catch {
      return { continue: true };
    }
    if (access.status !== 'denied') return { continue: true };

    onDeny?.(model);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: claudeSubagentModelDenialReason(model, access.reason),
      },
    };
  };

  return { PreToolUse: [{ hooks: [guard] }] };
}
