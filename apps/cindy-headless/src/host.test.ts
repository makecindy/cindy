import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyFailure, isHeadlessTerminalEvent, codexMcpArgs, deriveTurnStallMs, extractProviderUsage, modelCapabilityAdditions, normalizeTraceEvents, piProjectSkillsEvidence } from './host.js';
import { HeadlessRemoteMcpProvider } from './headless-integrations.js';
import type { HeadlessProfile } from './profile.js';

describe('Headless result classification', () => {
  it('derives a watchdog below the outer deadline', () => {
    expect(deriveTurnStallMs(5_000_000)).toBe(4_000_000);
    expect(deriveTurnStallMs(1_800_000)).toBe(1_440_000);
    expect(deriveTurnStallMs(5_000)).toBe(1_000);
  });

  it('normalizes final snapshots without double-counting deltas', () => {
    const events = normalizeTraceEvents([
      { type: 'text', data: { text: 'hel', isFinal: false }, turnAttemptToken: 1 },
      { type: 'text', data: { text: 'hello', isFinal: true }, turnAttemptToken: 1 },
      { type: 'done', data: {}, turnAttemptToken: 1 },
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].data).toMatchObject({ text: 'hello', isFinal: true });
  });

  it('classifies a terminal-free successful turn as completed', () => {
    expect(classifyFailure(undefined, undefined, false)).toBe('valid-completed');
  });

  it('keeps deadline and authentication failures distinct', () => {
    expect(classifyFailure('HEADLESS_DEADLINE_EXCEEDED', undefined, true)).toBe('valid-deadline-killed');
    expect(classifyFailure('401 unauthorized', undefined, false)).toBe('infra-invalid-auth');
    expect(classifyFailure('stream disconnected before completion', undefined, false)).toBe('infra-invalid-provider');
    expect(classifyFailure('Claude Code native binary not found at /opt/cindy-headless/bin/claude', undefined, false)).toBe('infra-agent-setup');
    expect(classifyFailure("Input tag 'document' does not match expected tags", undefined, false)).toBe('infra-invalid-request');
    expect(classifyFailure('Connection closed mid-response', undefined, false)).toBe('infra-invalid-provider');
    expect(classifyFailure('sdk_stream_crashed: upstream ended', undefined, false)).toBe('infra-invalid-provider');
    expect(classifyFailure('HTTP 502 from gateway', undefined, false)).toBe('infra-invalid-provider');
    expect(classifyFailure('killed by signal SIGKILL', undefined, false)).toBe('infra-invalid-provider');
    expect(classifyFailure('HEADLESS_TERMINATED_SIGTERM', undefined, false)).toBe('infra-terminated-signal');
  });

  it('normalizes provider usage without double-counting cache tokens', () => {
    const usage = extractProviderUsage([{ type: 'done', data: { usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25, modelUsageCumulativeStartsAtZero: true } }]);
    expect(usage.normalizedUsage).toEqual({ inputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 5, outputTokens: 7, costUsd: 0.25 });
  });

  it('derives and aggregates Claude multi-turn usage from cumulative snapshots', () => {
    const usage = extractProviderUsage([
      { type: 'done', turnAttemptToken: 1, data: { usage: { input_tokens: 3, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.25, modelUsageCumulativeStartsAtZero: true } },
      { type: 'done', turnAttemptToken: 2, data: { usage: { input_tokens: 8, cache_read_input_tokens: 21, cache_creation_input_tokens: 7, output_tokens: 16 }, total_cost_usd: 0.6, modelUsageCumulativeStartsAtZero: true } },
    ]);
    expect(usage.normalizedUsage).toEqual({ inputTokens: 8, cacheReadTokens: 21, cacheCreationTokens: 7, outputTokens: 16, costUsd: 0.6 });
    expect(usage.rawProviderUsage).toMatchObject({ aggregation: 'cumulative-delta', turns: [{ turnAttemptToken: 1 }, { turnAttemptToken: 2 }] });
    expect(usage.usageComplete).toBe(true);
  });

  it('prefers complete Claude request segments when a resumed cumulative baseline is unknown', () => {
    const usage = extractProviderUsage([{ type: 'done', data: {
      usage: { input_tokens: 1003, cache_read_input_tokens: 2010, cache_creation_input_tokens: 305, output_tokens: 407 },
      usageSegments: [{ inputTokens: 3, cacheReadTokens: 10, cacheCreateTokens: 5, outputTokens: 7 }],
      usageSegmentsComplete: true,
      modelUsageCumulativeStartsAtZero: false,
      total_cost_usd: 1.25,
    } }]);
    expect(usage.normalizedUsage).toEqual({ inputTokens: 3, cacheReadTokens: 10, cacheCreationTokens: 5, outputTokens: 7, costUsd: 0 });
    expect(usage.usageComplete).toBe(false);
  });

  it('reconstructs current Claude usage from request metadata and terminal status', () => {
    const usage = extractProviderUsage([
      { type: 'thinking', data: {}, agentMeta: { requestId: 'request-1', usage: { inputTokens: 2, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 33054 } } },
      { type: 'text', data: {}, agentMeta: { requestId: 'request-1', usage: { inputTokens: 2, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 33054 } } },
      { type: 'text', data: {}, agentMeta: { requestId: 'request-2', usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 33054, cacheCreationInputTokens: 163 } } },
      { type: 'status', data: { status: 'Done', tokenUsage: 151, contextTokens: 33218, contextWindow: 1_000_000, costUsd: 0.138, isRunning: false } },
    ]);
    expect(usage.normalizedUsage).toEqual({ inputTokens: 3, cacheReadTokens: 33054, cacheCreationTokens: 33217, outputTokens: 148, costUsd: 0.138 });
    expect(usage.rawProviderUsage).toMatchObject({ reconstructed_from: 'agentMeta+terminalStatus' });
  });

  it('normalizes Codex per-turn usage', () => {
    const usage = extractProviderUsage([{ type: 'done', data: { usage: { promptTokens: 11, cachedTokens: 13, completionTokens: 17, reasoningTokens: 5 } } }], 'codex');
    expect(usage.normalizedUsage).toEqual({ inputTokens: 11, cacheReadTokens: 13, cacheCreationTokens: 0, outputTokens: 17, costUsd: 0 });
  });

  it('aggregates Codex multi-turn usage including cache tokens', () => {
    const usage = extractProviderUsage([
      { type: 'done', turnAttemptToken: 1, data: { usage: { promptTokens: 11, cachedTokens: 13, completionTokens: 17, reasoningTokens: 5 } } },
      { type: 'done', turnAttemptToken: 2, data: { usage: { promptTokens: 19, cachedTokens: 23, completionTokens: 29, reasoningTokens: 7 } } },
    ], 'codex');
    expect(usage.normalizedUsage).toEqual({ inputTokens: 30, cacheReadTokens: 36, cacheCreationTokens: 0, outputTokens: 46, costUsd: 0 });
    expect(usage.rawProviderUsage).toMatchObject({ aggregation: 'per-turn', turns: [{ turnAttemptToken: 1 }, { turnAttemptToken: 2 }] });
  });

  it('normalizes Pi per-turn usage and cost', () => {
    const usage = extractProviderUsage([{ type: 'done', data: { usage: { inputTokens: 11, cacheReadTokens: 13, cacheCreationTokens: 2, outputTokens: 17 }, totalCostUsd: 0.42 } }], 'pi');
    expect(usage.normalizedUsage).toEqual({ inputTokens: 11, cacheReadTokens: 13, cacheCreationTokens: 2, outputTokens: 17, costUsd: 0.42 });
  });

  it('aggregates Pi multi-turn usage, cache, and cost', () => {
    const usage = extractProviderUsage([
      { type: 'done', turnAttemptToken: 1, data: { usage: { inputTokens: 11, cacheReadTokens: 13, cacheCreationTokens: 2, outputTokens: 17, segments: [{ costUsd: 0.42 }] } } },
      { type: 'done', turnAttemptToken: 2, data: { usage: { inputTokens: 19, cacheReadTokens: 23, cacheCreationTokens: 3, outputTokens: 29, segments: [{ costUsd: 0.58 }] } } },
    ], 'pi');
    expect(usage.normalizedUsage).toEqual({ inputTokens: 30, cacheReadTokens: 36, cacheCreationTokens: 5, outputTokens: 46, costUsd: 1 });
    expect(usage.rawProviderUsage).toMatchObject({ aggregation: 'per-turn', turns: [{ turnAttemptToken: 1 }, { turnAttemptToken: 2 }] });
  });

  it('injects an explicit context limit and preserves the agent default when omitted', () => {
    const profile = {
      model: { provider: 'moonshot', requestedId: 'moonshot/kimi-k3', contextLimit: 1_048_576, effort: 'high' },
    } as HeadlessProfile;
    expect(modelCapabilityAdditions(profile)?.availableModels[0]).toMatchObject({
      id: 'moonshot/kimi-k3',
      contextWindow: 1_048_576,
      efforts: ['high'],
      defaultEffort: 'high',
    });
    expect(modelCapabilityAdditions({ ...profile, model: { ...profile.model, contextLimit: undefined } })).toBeUndefined();
  });

  it('projects deterministic Pi project Skills evidence into artifacts', () => {
    expect(piProjectSkillsEvidence(null)).toEqual({ revision: null, count: 0, discoveredSkills: [] });
    const repo = path.resolve('fixture-repo');
    expect(piProjectSkillsEvidence({
      identity: { canonicalRepoRoot: repo },
      approval: { revision: 'headless-profile:abc123' },
      discovered: { skills: [path.join(repo, '.pi', 'skills', 'review'), path.join(repo, '.agents', 'skills', 'test.md')] },
    } as never)).toEqual({
      revision: 'headless-profile:abc123',
      count: 2,
      discoveredSkills: ['.pi/skills/review', '.agents/skills/test.md'],
    });
  });

  it('serializes custom Codex MCP headers as secret environment references', () => {
    process.env.TEST_MCP_TOKEN = 'secret';
    process.env.TEST_MCP_HEADER = 'header-secret';
    try {
      const provider = new HeadlessRemoteMcpProvider({ id: 'docs', transport: 'http', url: 'https://mcp.example.test', bearerTokenEnvVar: 'TEST_MCP_TOKEN', headerEnvVars: { 'X-Api.Key': 'TEST_MCP_HEADER' } });
      const config = codexMcpArgs([provider], '/workspace');
      expect(config.extraArgs).toContain('mcp_servers.docs.env_http_headers."X-Api.Key"="TEST_MCP_HEADER"');
      expect(config.extraArgs.join(' ')).not.toContain('secret');
      expect(config.extraEnv).toMatchObject({ TEST_MCP_TOKEN: 'secret', TEST_MCP_HEADER: 'header-secret' });
    } finally {
      delete process.env.TEST_MCP_TOKEN;
      delete process.env.TEST_MCP_HEADER;
    }
  });
});


describe('Headless product-turn completion', () => {
  it('waits across SDK done, idle and cancelled claims until the product terminal', () => {
    let kind: 'none' | 'done' | 'error' = 'none';
    const session = { getObservedCurrentTurnTerminal: () => ({ kind }) };
    const event = { type: 'done' as const, data: {}, turnAttemptToken: 1, turnContinuationId: 7 };
    expect(isHeadlessTerminalEvent(event, session, 1)).toBe(false);
    expect(isHeadlessTerminalEvent({ type: 'status', data: { isRunning: false }, turnAttemptToken: 1 }, session, 1)).toBe(false);
    // Even a cancelled claim keeps its SDK boundary nonterminal until Core's ordered terminal.
    expect(isHeadlessTerminalEvent(event, session, 1)).toBe(false);
    kind = 'done';
    expect(isHeadlessTerminalEvent({ type: 'done', data: {}, turnAttemptToken: 1 }, session, 1)).toBe(true);
  });
  it('ignores background and old-turn terminals, and distinguishes retrying errors', () => {
    const done = { getObservedCurrentTurnTerminal: () => ({ kind: 'done' as const }) };
    expect(isHeadlessTerminalEvent({ type: 'done', data: {}, turnScope: 'background' }, done, 2)).toBe(false);
    expect(isHeadlessTerminalEvent({ type: 'done', data: {}, turnAttemptToken: 1 }, done, 2)).toBe(false);
    expect(isHeadlessTerminalEvent({ type: 'status', data: { isRunning: false } }, done, 2)).toBe(false);
    expect(isHeadlessTerminalEvent({ type: 'done', data: {} }, done, undefined)).toBe(false);
    const error = { getObservedCurrentTurnTerminal: () => ({ kind: 'error' as const }) };
    expect(isHeadlessTerminalEvent({ type: 'error', data: { willRetry: true }, turnAttemptToken: 2 }, error, 2)).toBe(false);
    expect(isHeadlessTerminalEvent({ type: 'error', data: { isTerminal: true }, turnAttemptToken: 2 }, error, 2)).toBe(true);
  });
});
