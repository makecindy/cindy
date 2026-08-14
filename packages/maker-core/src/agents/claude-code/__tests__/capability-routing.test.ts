import { describe, expect, it } from 'vitest';

import type { CapabilityRoutingPolicy } from '../../../types/capability-routing.js';
import {
  buildClaudeOrcaCallerProvenanceHooks,
  buildClaudeRemoteOrcaCallerGuards,
  buildClaudeLocalToolGuardHooks,
  buildClaudeRemoteToolGuards,
  buildClaudeSkillOverrides,
  mergeClaudeHookSets,
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
