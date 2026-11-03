import { describe, expect, it } from 'vitest';

import type { CapabilityRoutingPolicy } from '../../../types/capability-routing.js';
import { withoutUserMcpRoutes } from '../../../types/capability-routing.js';
import {
  buildClaudeAskUserQuestionCallerProvenanceHooks,
  buildClaudeDeniedMcpServers,
  buildClaudeDisallowedTools,
  buildClaudeOrcaCallerProvenanceHooks,
  buildClaudeRemoteOrcaCallerGuards,
  buildClaudeRemoteRootOnlyToolGuards,
  buildClaudeLocalToolGuardHooks,
  buildClaudeRemoteToolGuards,
  buildClaudeSkillOverrides,
  mergeClaudeHookSets,
  CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
  CINDY_ASK_OWNER_TOOL_NAME,
  CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
  ORCA_SEND_TO_LEAD_TOOL_NAME,
} from '../capability-routing.js';

describe('Claude Orca caller provenance', () => {
  it('allows the root locally but denies a native subagent before MCP dispatch', async () => {
    const hook = buildClaudeOrcaCallerProvenanceHooks().PreToolUse?.[0]?.hooks[0];
    if (!hook) throw new Error('expected Orca caller provenance hook');
    const input = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'session-orca-worker',
      transcript_path: '/tmp/transcript',
      cwd: '/repo',
      tool_name: ORCA_SEND_TO_LEAD_TOOL_NAME,
      tool_input: { worker_id: 'forged-worker-id' },
      tool_use_id: 'tool-orca-report',
    };

    await expect(hook(input, 'tool-orca-report', {
      signal: new AbortController().signal,
    })).resolves.toEqual({ continue: true });
    await expect(hook({ ...input, agent_id: 'native-child-1' }, 'tool-orca-report', {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('serializes one exact root-only guard for a remote Orca worker', () => {
    expect(buildClaudeRemoteOrcaCallerGuards(true)).toEqual([{
      toolNamePrefix: ORCA_SEND_TO_LEAD_TOOL_NAME,
      sourceServerId: 'orca_worker_bridge',
      invocation: 'root-only',
      denialMessage: 'NESTED_AGENT_NOT_ALLOWED: nested agent cannot report directly to the lead',
    }]);
    expect(buildClaudeRemoteOrcaCallerGuards(false)).toEqual([]);
  });

  it.each([CLAUDE_ASK_USER_QUESTION_TOOL_NAME, CINDY_ASK_OWNER_TOOL_NAME])('allows only the root to ask using %s', async (toolName) => {
    const hook = buildClaudeAskUserQuestionCallerProvenanceHooks().PreToolUse?.find((entry) => entry.matcher === toolName)?.hooks[0];
    if (!hook) throw new Error('expected AskUserQuestion caller provenance hook');
    const input = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'session-ask-user-question',
      transcript_path: '/tmp/transcript',
      cwd: '/repo',
      tool_name: toolName,
      tool_input: { questions: [] },
      tool_use_id: 'tool-ask-user-question',
    };

    await expect(hook(input, 'tool-ask-user-question', {
      signal: new AbortController().signal,
    })).resolves.toEqual({ continue: true });
    await expect(hook({ ...input, agent_id: 'native-child-1' }, 'tool-ask-user-question', {
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
      },
    });
  });

  it('serializes the native AskUserQuestion root-only guard for remote Claude', () => {
    expect(buildClaudeRemoteRootOnlyToolGuards()).toEqual([{
      toolNamePrefix: CLAUDE_ASK_USER_QUESTION_TOOL_NAME,
      sourceServerId: 'claude-code',
      invocation: 'root-only',
      denialMessage: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
    }, {
      toolNamePrefix: CINDY_ASK_OWNER_TOOL_NAME,
      sourceServerId: 'cindy_helper',
      invocation: 'root-only',
      denialMessage: CLAUDE_SUBAGENT_ASK_USER_QUESTION_DENIAL_REASON,
    }]);
  });
});

describe('buildClaudeSkillOverrides', () => {
  it('maps host policy to Claude Code native skill visibility', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'skill',
            id: 'feishu-delegate:message-feishu-coworkers',
            artifactId: 'message-feishu-coworkers',
            containerId: 'feishu-delegate',
          },
          invocation: 'explicit-only',
        },
        {
          capabilityId: 'legacy',
          source: {
            kind: 'user-skill',
            surface: 'skill',
            id: 'legacy-skill',
          },
          invocation: 'disabled',
        },
        {
          capabilityId: 'normal',
          source: {
            kind: 'project-skill',
            surface: 'skill',
            id: 'normal-skill',
          },
          invocation: 'auto',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildClaudeSkillOverrides(policy)).toEqual({
      'feishu-delegate:message-feishu-coworkers': 'user-invocable-only',
    });
  });

  it('ignores user/project skills, other harnesses, and non-skill surfaces', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'skill',
            id: 'feishu-delegate:message-feishu-coworkers',
          },
          invocation: 'explicit-only',
        },
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'feishu',
          },
          invocation: 'disabled',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildClaudeSkillOverrides(policy)).toEqual({});
  });
});

describe('Claude disabled built-in surfaces', () => {
  const policy = {
    overrides: [
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'claude-code', surface: 'tool', id: 'Artifact' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'claude-code', surface: 'mcp', id: 'claude.ai Claude Docs' },
        invocation: 'disabled',
      },
      {
        capabilityId: 'feishu',
        source: { kind: 'harness-plugin', harness: 'claude-code', surface: 'mcp', id: 'plugin:feishu-delegate:feishu-delegate' },
        invocation: 'explicit-only',
      },
      {
        capabilityId: 'output-delivery',
        source: { kind: 'harness-builtin', harness: 'codex', surface: 'tool', id: 'view_image' },
        invocation: 'disabled',
      },
    ],
  } as const satisfies CapabilityRoutingPolicy;

  it('maps disabled tools to SDK disallowedTools', () => {
    expect(buildClaudeDisallowedTools(policy)).toEqual(['Artifact']);
    expect(buildClaudeDisallowedTools(undefined)).toEqual([]);
  });

  it('withoutUserMcpRoutes drops only user-mcp routes and keeps the same object when there are none', () => {
    const user = {
      capabilityId: 'computer-use',
      source: { kind: 'user-mcp' as const, harness: 'claude-code', surface: 'mcp' as const, id: 'cua-driver' },
      invocation: 'disabled' as const,
    };
    const mixed = { overrides: [...policy.overrides, user] };
    expect(withoutUserMcpRoutes(mixed)?.overrides).toEqual(policy.overrides);
    expect(withoutUserMcpRoutes(policy)).toBe(policy);
    expect(withoutUserMcpRoutes(undefined)).toBeUndefined();
  });

  it('denies a disabled MCP server by name so its instructions leave the prompt too', () => {
    expect(buildClaudeDeniedMcpServers(policy)).toEqual([
      { serverName: 'claude.ai Claude Docs' },
    ]);
    expect(buildClaudeDeniedMcpServers(undefined)).toEqual([]);
  });

  // A user-mcp route names the user's own registration on purpose (cua-driver →
  // cindy_computer); it is applied only as a denied server, never narrowed.
  it('applies a user-mcp route only as a disabled server', () => {
    const userRoute = (invocation: 'disabled' | 'explicit-only' | 'auto') => ({
      overrides: [{
        capabilityId: 'computer-use',
        source: { kind: 'user-mcp' as const, harness: 'claude-code', surface: 'mcp' as const, id: 'cua-driver' },
        invocation,
        replacement: { kind: 'cindy-host' as const, id: 'cindy_computer' },
      }],
    });
    expect(buildClaudeDeniedMcpServers(userRoute('disabled'))).toEqual([{ serverName: 'cua-driver' }]);
    expect(buildClaudeDeniedMcpServers(userRoute('explicit-only'))).toEqual([]);
    expect(buildClaudeRemoteToolGuards(userRoute('explicit-only'))).toEqual([]);
    expect(buildClaudeRemoteToolGuards(userRoute('disabled'))).toEqual([
      expect.objectContaining({ toolNamePrefix: 'mcp__cua-driver__', invocation: 'disabled' }),
    ]);
  });
});

describe('buildClaudeRemoteToolGuards', () => {
  it('serializes only non-auto Claude MCP routes with the real plugin prefix', () => {
    const policy = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: [
            '$feishu-delegate:message-feishu-coworkers',
            '/feishu-delegate:message-feishu-coworkers',
          ],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
        {
          capabilityId: 'normal',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'normal',
          },
          invocation: 'auto',
        },
        {
          capabilityId: 'codex-only',
          source: {
            kind: 'harness-plugin',
            harness: 'codex',
            surface: 'mcp',
            id: 'other',
          },
          invocation: 'disabled',
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;

    expect(buildClaudeRemoteToolGuards(policy)).toEqual([
      {
        toolNamePrefix:
          'mcp__plugin_feishu-delegate_feishu-delegate__',
        sourceServerId: 'plugin:feishu-delegate:feishu-delegate',
        invocation: 'explicit-only',
        explicitSelectors: [
          '$feishu-delegate:message-feishu-coworkers',
          '/feishu-delegate:message-feishu-coworkers',
        ],
        denialMessage:
          'This downstream source was not explicitly selected. Use Cindy capability xd-feishu.',
      },
    ]);
  });
});

describe('buildClaudeLocalToolGuardHooks', () => {
  const policy = {
    overrides: [
      {
        capabilityId: 'feishu',
        source: {
          kind: 'harness-plugin',
          harness: 'claude-code',
          surface: 'mcp',
          id: 'plugin:feishu-delegate:feishu-delegate',
        },
        invocation: 'explicit-only',
        explicitSelectors: [
          '/feishu-delegate:message-feishu-coworkers',
        ],
        replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
      },
    ],
  } as const satisfies CapabilityRoutingPolicy;

  it('reads accepted turn state and runs before unrelated host hooks', async () => {
    let selectionText = '查一下我和康康的飞书消息';
    const routing = buildClaudeLocalToolGuardHooks(
      policy,
      () => selectionText,
    );
    const hostHook = async () => ({ continue: true });
    const merged = mergeClaudeHookSets(routing, {
      PreToolUse: [{ matcher: 'Read', hooks: [hostHook] }],
    });
    const preToolUse = merged.PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected local routing hook');
    const input = {
      hook_event_name: 'PreToolUse' as const,
      session_id: 'session-local-route',
      transcript_path: '/tmp/transcript',
      cwd: '/repo',
      tool_name:
        'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
      tool_input: {},
      tool_use_id: 'tool-route',
    };

    await expect(
      preToolUse(
        input,
        'tool-route',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
    expect(merged.PreToolUse?.[1]?.matcher).toBe('Read');

    selectionText =
      '/feishu-delegate:message-feishu-coworkers 查一下康康';
    await expect(
      preToolUse(
        input,
        'tool-route',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });
  });

  it('does not intercept a user MCP with the plugin server base name', async () => {
    const preToolUse = buildClaudeLocalToolGuardHooks(
      policy,
      () => '',
    ).PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected local routing hook');
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session-user-mcp',
          transcript_path: '/tmp/transcript',
          cwd: '/repo',
          tool_name: 'mcp__feishu-delegate__read_messages',
          tool_input: {},
          tool_use_id: 'tool-user-mcp',
        },
        'tool-user-mcp',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });
  });

  it('still intercepts a user-mcp route although the server is a user registration', async () => {
    const preToolUse = buildClaudeLocalToolGuardHooks(
      {
        overrides: [{
          capabilityId: 'computer-use',
          source: { kind: 'user-mcp', harness: 'claude-code', surface: 'mcp', id: 'cua-driver' },
          invocation: 'disabled',
          replacement: { kind: 'cindy-host', id: 'cindy_computer' },
        }],
      },
      () => '',
      undefined,
      () => new Set(['cua-driver']),
    ).PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected local routing hook');
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session-user-driver',
          transcript_path: '/tmp/transcript',
          cwd: '/repo',
          tool_name: 'mcp__cua-driver__run_steps',
          tool_input: {},
          tool_use_id: 'tool-user-driver',
        },
        'tool-user-driver',
        { signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('cindy_computer'),
      },
    });
  });

  it('does not intercept a user MCP whose id aliases the normalized plugin prefix', async () => {
    const preToolUse = buildClaudeLocalToolGuardHooks(
      policy,
      () => '',
      undefined,
      () => new Set(['plugin_feishu-delegate_feishu-delegate']),
    ).PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected local routing hook');
    await expect(
      preToolUse(
        {
          hook_event_name: 'PreToolUse',
          session_id: 'session-user-mcp-normalized-collision',
          transcript_path: '/tmp/transcript',
          cwd: '/repo',
          tool_name:
            'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
          tool_input: {},
          tool_use_id: 'tool-user-mcp-normalized-collision',
        },
        'tool-user-mcp-normalized-collision',
        { signal: new AbortController().signal },
      ),
    ).resolves.toEqual({ continue: true });
  });
});
