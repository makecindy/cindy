import type {
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  PreToolUseHookInput,
  Settings,
} from '@anthropic-ai/claude-agent-sdk';

import type {
  CapabilityRouteOverride,
  CapabilityRoutingPolicy,
} from '../../types/capability-routing.js';
import {
  claudeMcpToolPrefix,
  findClaudeMcpCapabilityRoute,
  isHarnessOwnedCapabilitySource,
  isCapabilityRouteInvocationAllowed,
} from '../../types/capability-routing.js';
import { ORCA_NESTED_REPORT_DENIAL_REASON } from '../shared/orca-report-policy.js';

const CLAUDE_CODE_HARNESS_ID = 'claude-code';
export const ORCA_SEND_TO_LEAD_TOOL_NAME = 'mcp__orca_worker_bridge__send_to_lead';
export const CLAUDE_ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion';
export const CINDY_ASYNC_QUESTION_TOOL_NAME = 'mcp__cindy_helper__ask_user_question_async';
const USER_QUESTION_TOOLS = [CLAUDE_ASK_USER_QUESTION_TOOL_NAME, CINDY_ASYNC_QUESTION_TOOL_NAME];
export const CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON =
  'NATIVE_SUBAGENT_USER_INPUT_NOT_ALLOWED: report the question to the parent agent, which can decide whether to ask the user.';

/** Claude root calls have no agent_id; native subagents always carry one. */
export function buildClaudeOrcaCallerProvenanceHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guardTool: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (pre.tool_name !== ORCA_SEND_TO_LEAD_TOOL_NAME) return { continue: true };
    if (typeof pre.agent_id !== 'string' || pre.agent_id.length === 0) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: ORCA_NESTED_REPORT_DENIAL_REASON,
      },
    };
  };
  return { PreToolUse: [{ matcher: ORCA_SEND_TO_LEAD_TOOL_NAME, hooks: [guardTool] }] };
}

/** Native Claude subagents must report questions to the root agent. */
export function buildClaudeAskUserQuestionCallerProvenanceHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const guardTool: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    if (!USER_QUESTION_TOOLS.includes(pre.tool_name)) return { continue: true };
    if (typeof pre.agent_id !== 'string' || pre.agent_id.length === 0) return { continue: true };
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
      },
    };
  };
  return { PreToolUse: USER_QUESTION_TOOLS.map((matcher) => ({ matcher, hooks: [guardTool] })) };
}

function isClaudeSkillDirective(directive: CapabilityRouteOverride): boolean {
  return (
    directive.source.surface === 'skill' &&
    isClaudeCapabilityRouteEnforced(directive)
  );
}

/**
 * Translate host routing policy into Claude Code's native per-skill listing
 * controls. `user-invocable-only` removes a skill from implicit model context
 * while preserving exact `/name` invocation.
 *
 * Claude matches `skillOverrides` by name only and cannot tell a harness Skill
 * from a user or project Skill of the same name. Host policy therefore names
 * only harness-specific Skills (namespaced plugin Skills or vendor-specific
 * built-in names), never generic names such as `design`.
 */
export function buildClaudeSkillOverrides(
  policy: CapabilityRoutingPolicy | undefined,
): NonNullable<Settings['skillOverrides']> {
  const overrides: NonNullable<Settings['skillOverrides']> = {};
  if (!policy) return overrides;

  for (const directive of policy.overrides) {
    if (!isClaudeSkillDirective(directive)) continue;
    switch (directive.invocation) {
      case 'auto':
        overrides[directive.source.id] = 'on';
        break;
      case 'explicit-only':
        overrides[directive.source.id] = 'user-invocable-only';
        break;
      case 'disabled':
        overrides[directive.source.id] = 'off';
        break;
    }
  }
  return overrides;
}

/**
 * Whether this adapter turns a host route into a Claude Code control. The
 * builders below select routes through this same predicate, so the route
 * support check cannot drift from what is actually applied.
 */
export function isClaudeCapabilityRouteEnforced(
  directive: CapabilityRouteOverride,
): boolean {
  if (
    !isHarnessOwnedCapabilitySource(directive.source) ||
    directive.source.harness !== CLAUDE_CODE_HARNESS_ID
  ) {
    return false;
  }
  switch (directive.source.surface) {
    case 'skill':
      return true;
    case 'mcp':
      return directive.invocation !== 'auto';
    case 'tool':
      // Claude can only remove a built-in tool outright; plugin tools are MCP.
      return (
        directive.source.kind === 'harness-builtin' &&
        directive.invocation === 'disabled'
      );
    default:
      return false;
  }
}

function isDisabledClaudeSource(
  directive: CapabilityRouteOverride,
  surface: 'tool' | 'mcp',
): boolean {
  return (
    isClaudeCapabilityRouteEnforced(directive) &&
    directive.source.surface === surface &&
    directive.invocation === 'disabled'
  );
}

/**
 * Disabled Claude built-in tools, passed as SDK `disallowedTools`. Claude Code
 * drops a disallowed tool and its description from the model-facing list.
 */
export function buildClaudeDisallowedTools(
  policy: CapabilityRoutingPolicy | undefined,
): string[] {
  return (policy?.overrides ?? [])
    .filter((directive) => isDisabledClaudeSource(directive, 'tool'))
    .map((directive) => directive.source.id);
}

/**
 * Disabled MCP servers, passed as flag-settings `deniedMcpServers`. Denying
 * only the server's tools would leave its server instructions in the prompt;
 * a denied server is never connected. Claude merges this list with the user's
 * own deny list instead of replacing it.
 *
 * Like `skillOverrides`, the deny matches by server name only, so host policy
 * names only harness-specific servers such as `claude.ai ` account connectors.
 */
export function buildClaudeDeniedMcpServers(
  policy: CapabilityRoutingPolicy | undefined,
): Array<{ serverName: string }> {
  return (policy?.overrides ?? [])
    .filter((directive) => isDisabledClaudeSource(directive, 'mcp'))
    .map((directive) => ({ serverName: directive.source.id }));
}

export interface ClaudeRemoteToolGuard {
  toolNamePrefix: string;
  sourceServerId: string;
  invocation: 'auto' | 'explicit-only' | 'disabled' | 'root-only';
  explicitSelectors?: string[];
  denialMessage?: string;
}

export function buildClaudeRemoteOrcaCallerGuards(isOrcaWorker: boolean): ClaudeRemoteToolGuard[] {
  if (!isOrcaWorker) return [];
  return [{
    toolNamePrefix: ORCA_SEND_TO_LEAD_TOOL_NAME,
    sourceServerId: 'orca_worker_bridge',
    invocation: 'root-only',
    denialMessage: ORCA_NESTED_REPORT_DENIAL_REASON,
  }];
}

/** JSON-safe remote equivalent of the native subagent user-input guard. */
export function buildClaudeRemoteRootOnlyToolGuards(): ClaudeRemoteToolGuard[] {
  return USER_QUESTION_TOOLS.map((toolNamePrefix) => ({
    toolNamePrefix,
    sourceServerId: toolNamePrefix === CLAUDE_ASK_USER_QUESTION_TOOL_NAME ? 'claude-code' : 'cindy_helper',
    invocation: 'root-only' as const,
    denialMessage: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
  }));
}

/**
 * Build the JSON-safe routing guards enforced by the remote cc-manager as
 * daemon-side PreToolUse hooks. Local callback hooks cannot cross the RPC
 * boundary, so leaving this to canUseTool would let remote settings allow
 * rules or bypassPermissions short-circuit the host route. Pre-init MCP
 * configuration cannot suppress a guard: the daemon resolves normalized-name
 * collisions from the SDK's authoritative connected registry after init.
 */
export function buildClaudeRemoteToolGuards(
  policy: CapabilityRoutingPolicy | undefined,
): ClaudeRemoteToolGuard[] {
  if (!policy) return [];
  return policy.overrides.flatMap((directive) => {
    if (
      directive.source.surface !== 'mcp' ||
      !isClaudeCapabilityRouteEnforced(directive)
    ) {
      return [];
    }
    return [
      {
        toolNamePrefix: claudeMcpToolPrefix(directive.source.id),
        sourceServerId: directive.source.id,
        invocation: directive.invocation,
        ...(directive.explicitSelectors
          ? { explicitSelectors: [...directive.explicitSelectors] }
          : {}),
        denialMessage: directive.replacement
          ? `This downstream source was not explicitly selected. Use Cindy capability ${directive.replacement.id}.`
          : 'This downstream source was not explicitly selected.',
      },
    ];
  });
}

/**
 * Build the local in-process PreToolUse guard. The selection text comes from
 * maker-core's accepted send/steer state, so failed sends and turn boundaries
 * cannot leave stale explicit selectors behind.
 */
export function buildClaudeLocalToolGuardHooks(
  policy: CapabilityRoutingPolicy | undefined,
  getSelectionText: () => string,
  onDeny?: (toolName: string, route: CapabilityRouteOverride) => void,
  getNonHarnessServerIds: () => ReadonlySet<string> = () => new Set(),
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  if (
    !policy?.overrides.some(
      (directive) =>
        directive.source.surface === 'mcp' &&
        isClaudeCapabilityRouteEnforced(directive),
    )
  ) {
    return {};
  }

  const guardTool: HookCallback = async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    const pre = input as PreToolUseHookInput;
    const route = findClaudeMcpCapabilityRoute(
      policy,
      pre.tool_name,
      getNonHarnessServerIds(),
    );
    if (
      !route ||
      isCapabilityRouteInvocationAllowed(route, getSelectionText())
    ) {
      return { continue: true };
    }

    onDeny?.(pre.tool_name, route);
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: route.replacement
          ? `This downstream source was not explicitly selected. Use Cindy capability ${route.replacement.id}.`
          : 'This downstream source was not explicitly selected.',
      },
    };
  };

  return {
    PreToolUse: [{ hooks: [guardTool] }],
  };
}

export function mergeClaudeHookSets(
  ...sets: Array<
    Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined
  >
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {};
  for (const set of sets) {
    if (!set) continue;
    for (const [event, matchers] of Object.entries(set) as Array<
      [HookEvent, HookCallbackMatcher[] | undefined]
    >) {
      if (!matchers || matchers.length === 0) continue;
      merged[event] = [...(merged[event] ?? []), ...matchers];
    }
  }
  return merged;
}
