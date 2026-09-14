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
    if (pre.tool_name !== CLAUDE_ASK_USER_QUESTION_TOOL_NAME) return { continue: true };
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
  return { PreToolUse: [{ matcher: CLAUDE_ASK_USER_QUESTION_TOOL_NAME, hooks: [guardTool] }] };
}

function isClaudeSkillDirective(directive: CapabilityRouteOverride): boolean {
  return (
    directive.source.surface === 'skill' &&
    directive.source.harness === CLAUDE_CODE_HARNESS_ID &&
    (directive.source.kind === 'harness-builtin' ||
      directive.source.kind === 'harness-plugin')
  );
}

/**
 * Translate host routing policy into Claude Code's native per-skill listing
 * controls. `user-invocable-only` removes a skill from implicit model context
 * while preserving exact `/name` invocation. User and project skills are never
 * overridden here, even if a host policy accidentally names one.
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
  return [{
    toolNamePrefix: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
    sourceServerId: 'claude-code',
    invocation: 'root-only',
    denialMessage: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
  }];
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
      !isHarnessOwnedCapabilitySource(directive.source) ||
      directive.source.harness !== CLAUDE_CODE_HARNESS_ID ||
      directive.source.surface !== 'mcp' ||
      directive.invocation === 'auto'
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
        isHarnessOwnedCapabilitySource(directive.source) &&
        directive.source.harness === CLAUDE_CODE_HARNESS_ID &&
        directive.source.surface === 'mcp' &&
        directive.invocation !== 'auto',
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
