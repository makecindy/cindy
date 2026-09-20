import { access, appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryMcpProvider } from './memory-provider.js';
import { ClaudeCodeAgent, CodexAgent, PiAgent, Maker, MakerMemoryManager, isTerminalTurnEvent, type AgentEvent, type AgentKind, type AgentRuntimeConfig, type AuthAdapter, type BaseAgent, type Logger, type McpProvider, type UserMessage } from '@cindy/maker-core';
import { startCodexMemoryBridge, type CodexMemoryBridge } from './codex-memory-bridge.js';
import { sha256, type HeadlessProfile, type ResolvedProfile } from './profile.js';
import { readProjectContext } from './project-context.js';
import { openHeadlessSqlite } from './sqlite.js';
import { createUsageArtifact, type NormalizedUsage } from './usage.js';
import { SqliteSessionStorage } from './session-storage.js';
import { assertSafeExecutionProfile, CINDY_HEADLESS_VERSION, CINDY_UPSTREAM_COMMIT } from './compatibility.js';
import { buildCodexGatewayArgs } from './gateway-config.js';
import { HeadlessRemoteMcpProvider, inspectPiProjectWorkspaceResources, piProjectResourcesEvidence, piProjectSkillDenials, resolveNativeProviders, resolvePiProjectTrust, resolveTurns, type HeadlessTurnInput, type PiProjectWorkspaceResources } from './headless-integrations.js';

/** Use Session's product-turn boundary, not an intermediate SDK done/idle. */
export function isHeadlessTerminalEvent(
  event: AgentEvent,
  session: { getObservedCurrentTurnTerminal(): { kind: 'none' | 'done' | 'error' } },
  turnAttemptToken: number | undefined,
): boolean {
  if (turnAttemptToken === undefined || event.turnScope === 'background') return false;
  // Session tags the current foreground attempt; untagged tails may belong to the previous turn.
  if (event.turnAttemptToken !== turnAttemptToken) return false;
  return isTerminalTurnEvent(event) && session.getObservedCurrentTurnTerminal().kind !== 'none';
}

let environmentQueue = Promise.resolve();

const MIN_TURN_STALL_MS = 1_000;
const HEADLESS_CLEANUP_RESERVE_MS = 10_000;

export function deriveTurnStallMs(timeoutMs: number): number {
  const beforeDeadline = Math.max(MIN_TURN_STALL_MS, timeoutMs - HEADLESS_CLEANUP_RESERVE_MS);
  return Math.min(beforeDeadline, Math.max(MIN_TURN_STALL_MS, Math.floor(timeoutMs * 0.8)));
}

function eventData(event: AgentEvent): Record<string, unknown> | undefined {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, unknown>
    : undefined;
}

export function normalizeTraceEvents(events: AgentEvent[]): AgentEvent[] {
  const output: Array<AgentEvent | undefined> = [];
  const deltas = new Map<string, number[]>();
  let fallbackTurn = 0;

  for (const event of events) {
    if (event.type === 'done' || (event.type === 'error' && isTerminalTurnEvent(event))) {
      fallbackTurn += 1;
    }
    if (event.type !== 'text' && event.type !== 'thinking') {
      output.push(event);
      continue;
    }
    const data = eventData(event);
    const turn = event.turnAttemptToken ?? fallbackTurn;
    const key = `${turn}:${event.type}`;
    if (data?.isFinal === true) {
      for (const index of deltas.get(key) ?? []) output[index] = undefined;
      deltas.delete(key);
      output.push(event);
      continue;
    }
    const index = output.push(event) - 1;
    const indexes = deltas.get(key) ?? [];
    indexes.push(index);
    deltas.set(key, indexes);
  }
  return output.filter((event): event is AgentEvent => event !== undefined);
}

async function acquireEnvironmentLease(): Promise<() => void> {
  let release!: () => void;
  const previous = environmentQueue;
  environmentQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  return release;
}

function claudeAuth(): AuthAdapter {
  return { async getState() { const key = process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY; return { authenticated: Boolean(key), authSource: key ? 'api-key' : undefined }; }, async triggerLogin() { return this.getState(); }, async logout() {}, async getAuthEnv(): Promise<Record<string, string>> { const key = process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY; return key ? { ANTHROPIC_API_KEY: key } : {}; } };
}

function codexAuth(stateDir: string): AuthAdapter {
  const configuredHome = process.env.CINDY_HEADLESS_CODEX_HOME ?? process.env.CODEX_HOME;
  const apiKey = process.env.CINDY_CODEX_API_KEY;
  const codexHome = configuredHome ? path.resolve(configuredHome) : path.resolve(stateDir);
  return {
    async getState() { return { authenticated: Boolean(apiKey || configuredHome), authSource: apiKey ? 'api-key' : configuredHome ? 'oauth' : undefined, errorReason: apiKey || configuredHome ? undefined : 'missing_codex_home_or_api_key' }; },
    async triggerLogin() { return this.getState(); },
    async logout() {},
    async getAuthEnv(): Promise<Record<string, string>> { return { CODEX_HOME: codexHome, ...(apiKey ? { CINDY_CODEX_API_KEY: apiKey } : {}) }; },
  };
}

function piAuth(profile: HeadlessProfile): AuthAdapter {
  return {
    async getState() { const key = process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? profile.nativeProviders?.map((provider) => provider.apiKeyEnvVar && process.env[provider.apiKeyEnvVar]).find(Boolean) ?? (profile.nativeProviders?.some((provider) => !provider.apiKeyEnvVar) ? 'keyless-native-provider' : undefined); return { authenticated: Boolean(key), authSource: key ? 'api-key' : undefined }; },
    async triggerLogin() { return this.getState(); },
    async logout() {},
    async getAuthEnv(): Promise<Record<string, string>> { const key = process.env.CINDY_HEADLESS_API_KEY ?? process.env.ANTHROPIC_API_KEY; return key ? { CINDY_PI_API_KEY: key } : { CINDY_PI_API_KEY: 'headless-native-provider' }; },
  };
}

function jsonLogger(): Logger {
  const write = (level: string, message: string, context?: Record<string, unknown>) => process.stderr.write(`${JSON.stringify({ level, message, ...context })}\n`);
  const result: Logger = { trace: (m, c) => write('trace', m, c), debug: (m, c) => write('debug', m, c), info: (m, c) => write('info', m, c), warn: (m, c) => write('warn', m, c), error: (m, c) => write('error', m, c), fatal: (m, c) => write('fatal', m, c), child: () => result };
  return result;
}

export function modelCapabilityAdditions(profile: HeadlessProfile) {
  return profile.model.contextLimit
    ? {
        availableModels: [{
          id: profile.model.requestedId,
          displayName: profile.model.requestedId,
          contextWindow: profile.model.contextLimit,
          efforts: profile.model.effort ? [profile.model.effort] : [],
          defaultEffort: profile.model.effort ?? null,
          maxOutputTokens: profile.model.maxOutputTokens,
        }],
      }
    : undefined;
}

export function codexMcpArgs(providers: McpProvider[], workingDir: string): { extraArgs: string[]; extraEnv: Record<string, string> } {
  const context = { agentKind: 'codex' as const, workingDir, vendorOptions: {} };
  const extraArgs: string[] = providers.length ? ['-c', 'mcp_servers={}'] : [];
  const extraEnv: Record<string, string> = {};
  for (const provider of providers) {
    const config = provider.toCodexMcpConfig?.(context);
    if (!config) continue;
    Object.assign(extraEnv, provider.getExtraEnv?.(context) ?? {});
    extraArgs.push('-c', `mcp_servers.${provider.name}.url=${JSON.stringify(config.url)}`);
    if (config.bearerTokenEnvVar) extraArgs.push('-c', `mcp_servers.${provider.name}.bearer_token_env_var=${JSON.stringify(config.bearerTokenEnvVar)}`);
    for (const [header, envName] of Object.entries(config.envHttpHeaders ?? {})) {
      extraArgs.push('-c', `mcp_servers.${provider.name}.env_http_headers.${JSON.stringify(header)}=${JSON.stringify(envName)}`);
    }
    extraArgs.push('-c', `mcp_servers.${provider.name}.startup_timeout_sec=600`, '-c', `mcp_servers.${provider.name}.tool_timeout_sec=600`);
  }
  return { extraArgs, extraEnv };
}

function piRemoteMcpConfig(profile: HeadlessProfile) {
  const servers: Array<{ name: string; url: string; remote: { headerEnvVars: Record<string, string>; startupTimeoutMs: number; requestTimeoutMs: number } }> = [];
  const env: Record<string, string> = {};
  for (const server of profile.mcpServers ?? []) {
    const headerEnvVars = { ...(server.headerEnvVars ?? {}) };
    if (server.bearerTokenEnvVar && !Object.keys(headerEnvVars).some((header) => header.toLowerCase() === 'authorization')) headerEnvVars.Authorization = server.bearerTokenEnvVar;
    for (const [header, envName] of Object.entries(headerEnvVars)) {
      const raw = process.env[envName];
      if (!raw) throw new Error(`custom MCP ${server.id} requires environment variable ${envName}`);
      env[envName] = header.toLowerCase() === 'authorization' && server.bearerTokenEnvVar === envName ? `Bearer ${raw}` : raw;
    }
    servers.push({ name: server.id, url: server.url, remote: { headerEnvVars, startupTimeoutMs: server.startupTimeoutMs ?? 10_000, requestTimeoutMs: server.requestTimeoutMs ?? 600_000 } });
  }
  return { servers, env };
}

type PiProjectTrustSnapshot = Awaited<ReturnType<typeof resolvePiProjectTrust>>;

export function piProjectSkillsEvidence(snapshot: PiProjectTrustSnapshot) {
  const canonicalRepoRoot = snapshot?.identity.canonicalRepoRoot;
  return {
    revision: snapshot?.approval?.revision ?? null,
    count: snapshot?.discovered.skills.length ?? 0,
    discoveredSkills: snapshot && typeof canonicalRepoRoot === 'string'
      ? snapshot.discovered.skills.map((skill) => path.relative(canonicalRepoRoot, skill).replaceAll('\\', '/'))
      : [],
  };
}

function createHeadlessMaker(resolved: ResolvedProfile, stateDir: string, workingDir: string, piProjectTrust: PiProjectTrustSnapshot, piSkillDenials: readonly string[]): { maker: Maker; makerMemory: MakerMemoryManager; sessionStorage: SqliteSessionStorage; shutdownBridge(): Promise<void> } {
  const profile = resolved.profile;
  const logger = jsonLogger();
  const makerMemory = new MakerMemoryManager({
    basePath: stateDir,
    sqliteFactory: (filePath) => {
      const db = openHeadlessSqlite(filePath);
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      return db;
    },
    agents: {},
    logger: logger.child('maker-memory'),
    initialEnabled: profile.makerMemory,
    reviewAgent: profile.agentBackend,
  });
  const behaviorFlags = { ...(profile.containerSandbox ? { IS_SANDBOX: '1' } : {}), ...(profile.agentBackend === 'claude-code' && profile.model.maxOutputTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(profile.model.maxOutputTokens) } : {}) };
  const compactThresholdPct = profile.compaction?.enabled ? profile.compaction.thresholdPct : undefined;
  const runtimeConfig: AgentRuntimeConfig = {
    endpoint: profile.endpoint,
    systemPrompt: resolved.systemPrompt,
    userDataPath: stateDir,
    memoryEnabled: profile.nativeMemory,
    makerMemoryEnabled: profile.makerMemory,
    behaviorFlags: Object.keys(behaviorFlags).length > 0 ? behaviorFlags : undefined,
    autoCompactThresholdPct: profile.agentBackend === 'claude-code' ? compactThresholdPct : undefined,
    piAutoCompactThresholdPct: profile.agentBackend === 'pi' ? compactThresholdPct : undefined,
  };
  const memoryProvider = createMemoryMcpProvider({ getManager: () => makerMemory, logger: logger.child('cindy-memory-mcp') });
  const memoryProviders = profile.makerMemory ? [memoryProvider] : [];
  const remoteMcpProviders = (profile.mcpServers ?? []).map((server) => new HeadlessRemoteMcpProvider(server));
  const mcpProviders: McpProvider[] = [...memoryProviders, ...remoteMcpProviders];
  const capabilityAdditions = modelCapabilityAdditions(profile);
  const resolveModelContextLimit = (_providerId: string | null | undefined, modelId: string) =>
    profile.model.contextLimit && profile.supportedModelIds.includes(modelId) ? profile.model.contextLimit : null;
  let bridge: CodexMemoryBridge | undefined;
  let bridgePromise: Promise<CodexMemoryBridge> | undefined;
  let agent: BaseAgent;
  if (profile.agentBackend === 'claude-code') {
    agent = new ClaudeCodeAgent({ auth: claudeAuth(), runtimeConfig, binaryPath: profile.agentBinaryPath, logger, mcpProviders, makerMemory, capabilityAdditions, resolveModelContextLimit });
  } else if (profile.agentBackend === 'codex') {
    agent = new CodexAgent({
      auth: codexAuth(stateDir),
      runtimeConfig,
      binaryPath: profile.agentBinaryPath,
      logger,
      mcpProviders,
      makerMemory,
      capabilityAdditions,
      resolveModelContextLimit,
      resolveCodexThreadContextWindow: async (_providerId, modelId) => resolveModelContextLimit(_providerId, modelId),
      prepareCodexExtraSpawnConfig: async () => {
        let extraArgs = process.env.CINDY_CODEX_API_KEY && process.env.CINDY_HEADLESS_BASE_URL
          ? buildCodexGatewayArgs({ baseUrl: process.env.CINDY_HEADLESS_BASE_URL, apiKey: process.env.CINDY_CODEX_API_KEY })
          : [];
        let extraEnv: Record<string, string> = process.env.CINDY_CODEX_API_KEY ? { CINDY_CODEX_API_KEY: process.env.CINDY_CODEX_API_KEY } : {};
        const remote = codexMcpArgs(remoteMcpProviders, workingDir);
        extraArgs = [...extraArgs, ...remote.extraArgs];
        extraEnv = { ...extraEnv, ...remote.extraEnv };
        if (memoryProviders.length > 0) {
          bridgePromise ??= startCodexMemoryBridge({ provider: memoryProvider, workingDir, logger });
          bridge = await bridgePromise;
          extraArgs = [...extraArgs, ...(remoteMcpProviders.length > 0 ? bridge.extraArgs.slice(2) : bridge.extraArgs)];
          extraEnv = { ...extraEnv, ...bridge.extraEnv };
        }
        return { extraArgs, extraEnv };
      },
    });
  } else {
    agent = new PiAgent({
      auth: piAuth(profile),
      runtimeConfig,
      binaryPath: profile.agentBinaryPath,
      logger,
      mcpProviders,
      makerMemory,
      capabilityAdditions,
      resolveModelContextLimit,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
      resolvePiAgentHome: () => path.join(stateDir, 'pi-agent-home'),
      ...(profile.nativeProviders ? { resolvePiNativeProviders: async () => resolveNativeProviders(profile) } : {}),
      ...(profile.piProjectSkills?.enabled ? { resolvePiProjectTrustInput: async () => piProjectTrust } : {}),
      // Pi 0.85.x loads in-repo project Skills in place for local root tasks. A
      // profile that did not approve a Skill must still not see it.
      ...(piSkillDenials.length > 0 ? { getDisabledSkillPaths: () => piSkillDenials } : {}),
      preparePiExtraSpawnConfig: async () => {
        const remote = piRemoteMcpConfig(profile);
        if (memoryProviders.length === 0 && remote.servers.length === 0) return null;
        if (memoryProviders.length > 0) {
          bridgePromise ??= startCodexMemoryBridge({ provider: memoryProvider, workingDir, logger });
          bridge = await bridgePromise;
        }
        return {
          mcpBridge: { token: bridge?.token ?? '', servers: [...(bridge ? [{ name: 'cindy_memory', url: bridge.url }] : []), ...remote.servers] },
          ...(Object.keys(remote.env).length ? { mcpEnv: remote.env } : {}),
          disposeSessionCtx: () => undefined,
        };
      },
    });
  }
  const agents = { [profile.agentBackend]: agent } as Record<AgentKind, BaseAgent>;
  makerMemory.setAgents(agents);
  const sessionStorage = new SqliteSessionStorage(path.join(stateDir, 'headless-sessions.sqlite'));
  return {
    maker: new Maker({ agents, storage: sessionStorage, logger, makerMemory }),
    makerMemory,
    sessionStorage,
    async shutdownBridge() {
      if (!bridge && bridgePromise) bridge = await bridgePromise.catch(() => undefined);
      await bridge?.shutdown();
    },
  };
}

export function classifyFailure(error: string | undefined, terminalError: AgentEvent | undefined, deadlineKilled: boolean): string {
  if (deadlineKilled) return 'valid-deadline-killed';
  if (error?.startsWith('HEADLESS_TERMINATED_')) return 'infra-terminated-signal';
  if (!error && !terminalError) return 'valid-completed';
  const text = `${error ?? ''} ${terminalError ? JSON.stringify(terminalError.data) : ''}`.toLowerCase();
  if (/native binary not found|executable.*not found|enoent|no such file or directory/.test(text)) return 'infra-agent-setup';
  if (/auth|api.?key|unauthorized|401/.test(text)) return 'infra-invalid-auth';
  if (/invalid_request_error|input tag .* does not match|unsupported content|bad request|\b4\d\d\b/.test(text)) return 'infra-invalid-request';
  if (/model.*(not found|unsupported)|route|requested.*effective/.test(text)) return 'infra-invalid-route';
  if (/\b5\d\d\b|rate.?limit|overload|provider|network|econn|timeout|stream disconnected|sdk[_ -]?stream[_ -]?crashed|broken pipe|connection reset|connection aborted|socket hang up|connection closed mid-response|sigkill|killed by signal/.test(text)) return 'infra-invalid-provider';
  return 'valid-agent-error';
}

function standardResult(status: string, reward: number | null): 'PASSED' | 'FAILED_AGENT' | 'ERRORED_INFRA' | 'INVALID_TASK' | null {
  if (status === 'valid-completed') return reward === null ? null : reward === 1 ? 'PASSED' : 'FAILED_AGENT';
  if (status === 'valid-agent-error' || status === 'valid-deadline-killed') return 'FAILED_AGENT';
  if (status.includes('invalid-task')) return 'INVALID_TASK';
  return 'ERRORED_INFRA';
}

type ExtractedProviderUsage = {
  rawProviderUsage: Record<string, unknown> | null;
  normalizedUsage: NormalizedUsage;
  usageComplete: boolean;
};

const EMPTY_NORMALIZED_USAGE: NormalizedUsage = {
  inputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  costUsd: 0,
};

function usageNumber(value: Record<string, unknown> | undefined | null, key: string): number {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
}

function sumNormalizedUsage(values: NormalizedUsage[]): NormalizedUsage {
  return values.reduce<NormalizedUsage>((total, value) => ({
    inputTokens: total.inputTokens + value.inputTokens,
    cacheReadTokens: total.cacheReadTokens + value.cacheReadTokens,
    cacheCreationTokens: total.cacheCreationTokens + value.cacheCreationTokens,
    outputTokens: total.outputTokens + value.outputTokens,
    costUsd: total.costUsd + value.costUsd,
  }), { ...EMPTY_NORMALIZED_USAGE });
}

export function extractProviderUsage(events: AgentEvent[], agentBackend: AgentKind = 'claude-code'): ExtractedProviderUsage {
  const doneRecords = events.flatMap((event, eventIndex) => {
    if (event.type !== 'done' || !event.data || typeof event.data !== 'object') return [];
    const data = event.data as Record<string, unknown>;
    const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : null;
    if (!usage) return [];
    return [{ event, eventIndex, data, usage }];
  });
  if (agentBackend === 'codex') {
    if (doneRecords.length === 0) {
      const terminal = [...events].reverse().find((event) => event.type === 'status' && event.data && typeof event.data === 'object' && typeof (event.data as Record<string, unknown>).tokenUsage === 'number');
      const tokenUsage = terminal?.data && typeof terminal.data === 'object' ? Number((terminal.data as Record<string, unknown>).tokenUsage ?? 0) : 0;
      return {
        rawProviderUsage: tokenUsage > 0 ? { tokenUsage, reconstructed_from: 'terminalStatus' } : null,
        normalizedUsage: { ...EMPTY_NORMALIZED_USAGE },
        usageComplete: false,
      };
    }
    const turns = doneRecords.map(({ event, eventIndex, usage }) => ({
      eventIndex,
      turnAttemptToken: event.turnAttemptToken ?? null,
      usage,
    }));
    const normalizedUsage = sumNormalizedUsage(doneRecords.map(({ usage }) => ({
      inputTokens: usageNumber(usage, 'promptTokens'),
      cacheReadTokens: usageNumber(usage, 'cachedTokens'),
      cacheCreationTokens: 0,
      outputTokens: usageNumber(usage, 'completionTokens'),
      costUsd: 0,
    })));
    return {
      rawProviderUsage: { aggregation: 'per-turn', backend: agentBackend, turns, totals: normalizedUsage },
      normalizedUsage,
      usageComplete: true,
    };
  }
  if (agentBackend === 'pi') {
    if (doneRecords.length === 0) return { rawProviderUsage: null, normalizedUsage: { ...EMPTY_NORMALIZED_USAGE }, usageComplete: false };
    const turns = doneRecords.map(({ event, eventIndex, data, usage }) => ({
      eventIndex,
      turnAttemptToken: event.turnAttemptToken ?? null,
      usage,
      totalCostUsd: typeof data.totalCostUsd === 'number' ? data.totalCostUsd : null,
    }));
    const normalizedUsage = sumNormalizedUsage(doneRecords.map(({ data, usage }) => {
      const segments = Array.isArray(usage.segments)
        ? usage.segments.filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object')
        : [];
      return {
        inputTokens: usageNumber(usage, 'inputTokens'),
        cacheReadTokens: usageNumber(usage, 'cacheReadTokens'),
        cacheCreationTokens: usageNumber(usage, 'cacheCreationTokens'),
        outputTokens: usageNumber(usage, 'outputTokens'),
        costUsd: typeof data.totalCostUsd === 'number'
          ? data.totalCostUsd
          : segments.reduce((total, segment) => total + usageNumber(segment, 'costUsd'), 0),
      };
    }));
    return {
      rawProviderUsage: { aggregation: 'per-turn', backend: agentBackend, turns, totals: normalizedUsage },
      normalizedUsage,
      usageComplete: true,
    };
  }
  if (doneRecords.length === 0) {
    const byRequest = new Map<string, Record<string, unknown>>();
    for (const event of events) {
      const requestId = typeof event.agentMeta?.requestId === 'string' ? event.agentMeta.requestId : undefined;
      const eventUsage = event.agentMeta?.usage;
      if (requestId && eventUsage && typeof eventUsage === 'object') byRequest.set(requestId, eventUsage as Record<string, unknown>);
    }
    const sum = (key: string): number => [...byRequest.values()].reduce((total, usage) => total + (typeof usage[key] === 'number' ? usage[key] as number : 0), 0);
    const terminal = [...events].reverse().find((event) => event.type === 'status' && event.data && typeof event.data === 'object' && (event.data as Record<string, unknown>).isRunning === false);
    const terminalData = terminal?.data as Record<string, unknown> | undefined;
    const inputTokens = sum('inputTokens');
    const tokenUsage = typeof terminalData?.tokenUsage === 'number' ? terminalData.tokenUsage : inputTokens;
    const reconstructed = {
      input_tokens: inputTokens,
      cache_read_input_tokens: sum('cacheReadInputTokens'),
      cache_creation_input_tokens: sum('cacheCreationInputTokens'),
      output_tokens: Math.max(0, tokenUsage - inputTokens),
      reconstructed_from: 'agentMeta+terminalStatus',
    };
    return {
      rawProviderUsage: reconstructed,
      normalizedUsage: {
        inputTokens: reconstructed.input_tokens,
        cacheReadTokens: reconstructed.cache_read_input_tokens,
        cacheCreationTokens: reconstructed.cache_creation_input_tokens,
        outputTokens: reconstructed.output_tokens,
        costUsd: typeof terminalData?.costUsd === 'number' ? terminalData.costUsd : 0,
      },
      usageComplete: false,
    };
  }

  let previousUsage: Record<string, unknown> | null = null;
  let previousCost = 0;
  let usageComplete = true;
  const turns = doneRecords.map(({ event, eventIndex, data, usage }) => {
    const segments = Array.isArray(data.usageSegments) ? data.usageSegments.filter((segment): segment is Record<string, unknown> => Boolean(segment) && typeof segment === 'object') : [];
    const segmentsComplete = data.usageSegmentsComplete === true;
    const fromSegments = segmentsComplete && segments.length > 0 ? {
      inputTokens: segments.reduce((total, segment) => total + usageNumber(segment, 'inputTokens'), 0),
      cacheReadTokens: segments.reduce((total, segment) => total + usageNumber(segment, 'cacheReadTokens'), 0),
      cacheCreationTokens: segments.reduce((total, segment) => total + usageNumber(segment, 'cacheCreateTokens'), 0),
      outputTokens: segments.reduce((total, segment) => total + usageNumber(segment, 'outputTokens'), 0),
    } : null;
    const delta = (key: string): number => {
      const current = usageNumber(usage, key);
      const prior = usageNumber(previousUsage, key);
      return previousUsage && current >= prior ? current - prior : current;
    };
    const cumulativeCost = typeof data.total_cost_usd === 'number' ? data.total_cost_usd : 0;
    const baselineKnown = previousUsage !== null || data.modelUsageCumulativeStartsAtZero === true;
    const costUsd = baselineKnown
      ? previousUsage && cumulativeCost >= previousCost ? cumulativeCost - previousCost : cumulativeCost
      : 0;
    const normalized: NormalizedUsage = {
      inputTokens: fromSegments?.inputTokens ?? delta('input_tokens'),
      cacheReadTokens: fromSegments?.cacheReadTokens ?? delta('cache_read_input_tokens'),
      cacheCreationTokens: fromSegments?.cacheCreationTokens ?? delta('cache_creation_input_tokens'),
      outputTokens: fromSegments?.outputTokens ?? delta('output_tokens'),
      costUsd,
    };
    if (data.modelUsageCumulativeStartsAtZero === false && previousUsage === null) usageComplete = false;
    previousUsage = usage;
    previousCost = cumulativeCost;
    return {
      eventIndex,
      turnAttemptToken: event.turnAttemptToken ?? null,
      cumulativeUsage: usage,
      usageSegments: segments,
      usageSegmentsComplete: segmentsComplete,
      normalized,
    };
  });
  const normalizedUsage = sumNormalizedUsage(turns.map((turn) => turn.normalized));
  return {
    rawProviderUsage: { aggregation: 'cumulative-delta', backend: agentBackend, turns, totals: normalizedUsage },
    normalizedUsage,
    usageComplete,
  };
}

export async function runTask(resolved: ResolvedProfile, task: string, workingDir: string, outputDir: string, timeoutMs: number | null, turns: Array<string | HeadlessTurnInput> = [task]): Promise<Record<string, unknown>> {
  assertSafeExecutionProfile(resolved.profile);
  const releaseEnvironment = await acquireEnvironmentLease();
  try {
    return await runTaskWithIsolatedEnvironment(resolved, task, workingDir, outputDir, timeoutMs, turns);
  } finally {
    releaseEnvironment();
  }
}

async function runTaskWithIsolatedEnvironment(resolved: ResolvedProfile, task: string, workingDir: string, outputDir: string, timeoutMs: number | null, turns: Array<string | HeadlessTurnInput> = [task]): Promise<Record<string, unknown>> {
  const profile = resolved.profile;
  const absoluteOutputDir = path.resolve(outputDir);
  const absoluteWorkingDir = path.resolve(workingDir);
  await mkdir(absoluteOutputDir, { recursive: true });
  const cleanHome = await mkdtemp(path.join(os.tmpdir(), 'cindy-headless-'));
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    XDT_SESSION_TURN_STALL_MS: process.env.XDT_SESSION_TURN_STALL_MS,
    XDT_CC_SSE_IDLE_TIMEOUT_MS: process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS,
    XDT_CODEX_IDLE_TIMEOUT_MS: process.env.XDT_CODEX_IDLE_TIMEOUT_MS,
  };
  const timeoutOwner = timeoutMs === null ? 'external' : 'headless';
  const turnStallMs = timeoutMs === null ? null : deriveTurnStallMs(timeoutMs);
  process.env.HOME = cleanHome;
  process.env.USERPROFILE = cleanHome;
  process.env.CLAUDE_CONFIG_DIR = path.join(cleanHome, '.claude');
  if (turnStallMs === null) {
    process.env.XDT_SESSION_TURN_STALL_MS = '0';
    process.env.XDT_CC_SSE_IDLE_TIMEOUT_MS = '0';
    process.env.XDT_CODEX_IDLE_TIMEOUT_MS = '0';
  } else {
    process.env.XDT_SESSION_TURN_STALL_MS = String(turnStallMs);
  }
  let onSigterm: (() => void) | undefined;
  let onSigint: (() => void) | undefined;
  try {
  const events: AgentEvent[] = [];
  let session: Awaited<ReturnType<Maker['createSession']>> | undefined;
  let runtime: ReturnType<typeof createHeadlessMaker> | undefined;
  const startedAt = Date.now();
  let error: string | undefined;
  let deadlineKilled = false;
  let timeoutReachedAtMs: number | null = null;
  let terminationSignal: NodeJS.Signals | undefined;
  let terminalError: AgentEvent | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectTermination!: (cause: Error) => void;
  const termination = new Promise<void>((_, reject) => { rejectTermination = reject; });
  const terminate = (signal: NodeJS.Signals) => {
    if (terminationSignal) return;
    terminationSignal = signal;
    rejectTermination(new Error(`HEADLESS_TERMINATED_${signal}`));
    void session?.abort().catch(() => undefined);
  };
  onSigterm = () => terminate('SIGTERM');
  onSigint = () => terminate('SIGINT');
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  const projectContext = await readProjectContext(absoluteWorkingDir, profile.projectContext);
  const resolvedTurns = await resolveTurns(turns.length > 0 ? turns : [task], absoluteWorkingDir, profile.inputPolicy);
  const piProjectTrust = profile.agentBackend === 'pi' && profile.piProjectSkills?.enabled
    ? await resolvePiProjectTrust(absoluteWorkingDir, profile.piProjectSkills)
    : null;
  // Pi 0.85.x loads local root task project resources in place, so Headless
  // inspects the workspace itself to keep the frozen profile decisive.
  const piProjectResources: PiProjectWorkspaceResources | null = profile.agentBackend === 'pi'
    ? await inspectPiProjectWorkspaceResources(absoluteWorkingDir)
    : null;
  const piSkillDenials = piProjectResources
    ? piProjectSkillDenials(piProjectResources, piProjectTrust?.discovered.skills ?? [])
    : [];
  const stateDir = path.resolve(process.env.CINDY_HEADLESS_STATE_DIR ?? path.join(absoluteOutputDir, 'state'));
  try {
    await mkdir(stateDir, { recursive: true });
    await access(profile.agentBinaryPath);
    runtime = createHeadlessMaker(resolved, stateDir, absoluteWorkingDir, piProjectTrust, piSkillDenials);
    session = await runtime.maker.createSession({ agentKind: profile.agentBackend, workingDir: absoluteWorkingDir, model: profile.model.requestedId, providerId: profile.model.provider, effort: profile.model.effort, permissionMode: profile.permissionMode, makerMemoryEnabled: profile.makerMemory, userPrompt: projectContext.content, vendorOptions: { onStderrLine: (line: string) => { void appendFile(path.join(absoluteOutputDir, 'stderr.log'), `${line}\n`, 'utf8'); } }, id: `headless-${Date.now()}` });
    let resolveTerminal: (() => void) | undefined;
    let terminal = Promise.resolve();
    let activeTurnAttemptToken: number | undefined;
    session.onEvent((event) => {
      events.push(event);
      if (!session || !isHeadlessTerminalEvent(event, session, activeTurnAttemptToken)) return;
      if (event.type === 'error') terminalError = event;
      resolveTerminal?.();
    });
    for (const [turnIndex, turn] of resolvedTurns.entries()) {
      activeTurnAttemptToken = turnIndex + 1;
      terminal = new Promise<void>((resolve) => { resolveTerminal = resolve; });
      const sent = await session.send(turn, { turnAttemptToken: turnIndex + 1 });
      if (!sent.accepted) throw new Error(terminationSignal ? `HEADLESS_TERMINATED_${terminationSignal}` : `HEADLESS_SEND_NOT_ACCEPTED: ${sent.reason}`);
      const completion: Promise<void>[] = [terminal, termination];
      if (timeoutMs !== null) completion.push(new Promise<void>((_, reject) => {
        timer = setTimeout(() => reject(new Error('HEADLESS_DEADLINE_EXCEEDED')), timeoutMs);
      }));
      await Promise.race(completion);
      if (timer) { clearTimeout(timer); timer = undefined; }
      if (terminalError) break;
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    deadlineKilled = error === 'HEADLESS_DEADLINE_EXCEEDED';
    if (deadlineKilled) timeoutReachedAtMs = Date.now() - startedAt;
    if ((deadlineKilled || terminationSignal) && session) {
      await session.abort().catch(() => undefined);
      // If the deadline fired, the agent binary may be stuck in a streaming
      // HTTP request that never checks abort signals. Force-kill the maker
      // process immediately so resources are freed without waiting.
      try { await runtime?.maker.shutdown(); } catch { /* best-effort force kill */ }
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  // Claude may emit the final `done` event while closing the SDK session. Flush
  // it before extracting provider usage so Harbor receives real token counts.
  // Cleanup is outside the scoring budget, but it must remain bounded so
  // artifact persistence can finish during the outer harness grace period.
  const CLOSE_DEADLINE_MS = 5_000;
  try { await Promise.race([session?.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('CLOSE_TIMEOUT')), CLOSE_DEADLINE_MS))]); } catch { /* artifact writing must still run */ }
  const usage = session?.getUsageSnapshot() ?? { tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 };
  const providerUsage = extractProviderUsage(events, profile.agentBackend);
  if (providerUsage.normalizedUsage.costUsd === 0 && usage.costUsd > 0) providerUsage.normalizedUsage.costUsd = usage.costUsd;
  const hasObservedUsage = providerUsage.rawProviderUsage !== null || usage.tokenUsage > 0;
  const interrupted = deadlineKilled || terminationSignal !== undefined;
  const usageStatus = interrupted ? (hasObservedUsage ? 'PARTIAL' : 'MISSING') : (providerUsage.rawProviderUsage && providerUsage.usageComplete ? 'COMPLETE' : hasObservedUsage ? 'PARTIAL' : 'MISSING');
  const usageCompleteness = usageStatus === 'COMPLETE' ? 'exact' : usageStatus === 'PARTIAL' ? 'lower-bound' : 'incomplete';
  const usageSource = [providerUsage.rawProviderUsage ? 'provider-events' : '', usage.tokenUsage > 0 ? 'session-snapshot' : ''].filter(Boolean);
  const missingFields = usageStatus === 'COMPLETE' ? [] : ['inputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'outputTokens', 'costUsd'].filter((field) => providerUsage.normalizedUsage[field as keyof typeof providerUsage.normalizedUsage] === 0);
  const terminalMessage = terminalError?.data && typeof terminalError.data === 'object' && typeof (terminalError.data as Record<string, unknown>).message === 'string'
    ? String((terminalError.data as Record<string, unknown>).message) : undefined;
  const effectiveError = error ?? terminalMessage;
  const status = classifyFailure(effectiveError, terminalError, deadlineKilled);
  const reward = typeof process.env.CINDY_HEADLESS_REWARD === 'string' ? Number(process.env.CINDY_HEADLESS_REWARD) : null;
  const benchmark = process.env.CINDY_BENCHMARK ?? null;
  const taskId = process.env.CINDY_TASK_ID ?? null;
  const repetition = Number(process.env.CINDY_REPETITION ?? '0') || null;
  const runId = process.env.CINDY_RUN_ID ?? `local-${startedAt}`;
  const cellId = process.env.CINDY_CELL_ID ?? sha256(JSON.stringify({ benchmark, revision: process.env.CINDY_BENCHMARK_REVISION ?? null, taskId, agent: profile.id, model: profile.model.requestedId, repetition }));
  const attemptId = process.env.CINDY_ATTEMPT_ID ?? `${cellId}-${startedAt}`;
  const manifestDigest = process.env.CINDY_MANIFEST_DIGEST ?? null;
  const standard = standardResult(status, reward);
  const actualEndpoint = profile.agentBackend === 'codex'
    ? process.env.CINDY_CODEX_BASE_URL ?? process.env.CINDY_HEADLESS_BASE_URL ?? null
    : profile.nativeProviders?.find((provider) => provider.id === profile.model.provider)?.baseUrl ?? process.env.CINDY_HEADLESS_BASE_URL ?? profile.endpoint ?? null;
  const observedModels = [...new Set(events.map((event) => event.agentMeta?.model).filter((model): model is string => typeof model === 'string' && model !== '<synthetic>'))];
  const actualModelId = process.env.CINDY_ACTUAL_MODEL ?? (observedModels.length === 1 ? observedModels[0] : null);
  const upstreamProvider = process.env.CINDY_UPSTREAM_PROVIDER ?? null;
  const requestIds = [...new Set(events.map((event) => event.agentMeta?.requestId).filter((id): id is string => typeof id === 'string'))];
  const piSkillsEvidence = piProjectSkillsEvidence(piProjectTrust);
  const piResourcesEvidence = piProjectResourcesEvidence(piProjectResources, piSkillDenials);
  const identityEvidence = {
    actualModelId: process.env.CINDY_ACTUAL_MODEL ? 'operator-asserted' : observedModels.length === 1 ? 'provider-event' : 'unknown',
    actualEndpoint: actualEndpoint ? 'configured' : 'unknown',
    upstreamProvider: process.env.CINDY_UPSTREAM_PROVIDER ? 'operator-asserted' : 'unknown',
    requestIds: requestIds.length > 0 ? 'provider-event' : 'unknown',
    gatewayAttested: false,
  };
  const identity = { schemaVersion: 2, runId, cellId, attemptId, manifestDigest, benchmark, benchmarkRevision: process.env.CINDY_BENCHMARK_REVISION ?? null, taskId, repetition, profileId: profile.id, profileDigest: resolved.profileDigest, systemPromptDigest: resolved.systemPromptDigest, agentBackend: profile.agentBackend, agentBinaryVersion: profile.agentBinaryVersion, cindyCliVersion: CINDY_HEADLESS_VERSION, cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT, harborVersion: process.env.HARBOR_VERSION ?? null, litellmVersion: process.env.LITELLM_VERSION ?? null, requestedModelId: profile.model.requestedId, actualModelId, provider: profile.model.provider, actualEndpoint, upstreamProvider, routeId: profile.model.routeId ?? null, observedModels, requestIds, identityEvidence, containerSandbox: profile.containerSandbox ?? false, projectContext: profile.projectContext, projectContextInjected: projectContext.injected, projectContextDigest: projectContext.digest, makerMemory: profile.makerMemory, nativeMemory: profile.nativeMemory, attachments: profile.inputPolicy?.attachments ?? false, customMcpServers: profile.mcpServers?.map((server) => server.id) ?? [], nativeProviders: profile.nativeProviders?.map((provider) => provider.id) ?? [], piProjectSkills: profile.piProjectSkills?.enabled ?? false, piProjectSkillsRevision: piSkillsEvidence.revision, piProjectSkillsCount: piSkillsEvidence.count, piProjectResources: piResourcesEvidence };
  const result = { schemaVersion: 2, status, resultClass: standard, reward, runId, cellId, attemptId, manifestDigest, cindyUpstreamCommit: CINDY_UPSTREAM_COMMIT, benchmark, benchmarkRevision: process.env.CINDY_BENCHMARK_REVISION ?? null, taskId, repetition, sessionId: session?.id ?? null, turnsCount: turns.length > 0 ? turns.length : 1, durationMs: Date.now() - startedAt, timedOut: deadlineKilled, timeoutOwner, timeoutMs, timeoutReachedAtMs, error: effectiveError ?? null, terminalError: terminalError?.data ?? null, eventsCount: events.length, retries: Number(process.env.CINDY_RETRY_COUNT ?? '0') || 0, replacesAttemptId: process.env.CINDY_REPLACES_ATTEMPT_ID ?? null };
  try { await runtime?.maker.shutdown(); } catch { /* best effort cleanup */ }
  try { await runtime?.shutdownBridge(); } catch { /* best effort cleanup */ }
  try { runtime?.sessionStorage.close(); } catch { /* best effort cleanup */ }
  const normalizedEvents = normalizeTraceEvents(events);
  await Promise.all([
    writeFile(path.join(absoluteOutputDir, 'stderr.log'), '', { encoding: 'utf8', flag: 'a' }),
    writeFile(path.join(absoluteOutputDir, 'identity.json'), JSON.stringify(identity, null, 2) + '\n', 'utf8'),
    writeFile(path.join(absoluteOutputDir, 'config.json'), JSON.stringify({ profilePath: resolved.profilePath, workingDir: absoluteWorkingDir, stateDir, timeoutOwner, timeoutMs, turnStallMs, projectContext: { injected: projectContext.injected, reason: projectContext.reason ?? null, tocPath: projectContext.tocPath, digest: projectContext.digest }, capabilities: { attachments: profile.inputPolicy?.attachments ?? false, customMcpServers: profile.mcpServers?.map((server) => ({ id: server.id, transport: server.transport, url: server.url, bearerTokenEnvVar: server.bearerTokenEnvVar ?? null, headerEnvVars: server.headerEnvVars ?? {} })) ?? [], nativeProviders: profile.nativeProviders?.map((provider) => ({ id: provider.id, api: provider.api, baseUrl: provider.baseUrl, apiKeyEnvVar: provider.apiKeyEnvVar ?? null, models: provider.models.map((model) => model.id) })) ?? [], piProjectSkills: { ...(profile.piProjectSkills ?? { enabled: false, roots: [] }), revision: piSkillsEvidence.revision, discoveredSkills: piSkillsEvidence.discoveredSkills }, piProjectResources: piResourcesEvidence } }, null, 2) + '\n', 'utf8'),
    writeFile(path.join(absoluteOutputDir, 'trace.raw.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + (events.length ? '\n' : ''), 'utf8'),
    writeFile(path.join(absoluteOutputDir, 'trace.jsonl'), normalizedEvents.map((event) => JSON.stringify(event)).join('\n') + (normalizedEvents.length ? '\n' : ''), 'utf8'),
    writeFile(path.join(absoluteOutputDir, 'usage.json'), JSON.stringify(createUsageArtifact({ ...providerUsage, sessionSnapshot: usage, usageStatus, usageCompleteness, usageSource, missingFields, termination: deadlineKilled ? 'HEADLESS_DEADLINE' : terminationSignal ?? null, observedTokenTotal: usage.tokenUsage > 0 ? usage.tokenUsage : null }), null, 2) + '\n', 'utf8'),
    writeFile(path.join(absoluteOutputDir, 'result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8'),
  ]);
  return { ...result, usage };
  } finally {
    if (onSigterm) process.off('SIGTERM', onSigterm);
    if (onSigint) process.off('SIGINT', onSigint);
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(cleanHome, { recursive: true, force: true });
  }
}
