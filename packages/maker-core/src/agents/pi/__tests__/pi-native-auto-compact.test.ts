/**
 * Pi owns automatic threshold and overflow compaction. Cindy observes the native
 * events and only latches deterministic failures for the next-send rollover.
 */

import fsSync, { promises as fs, existsSync, mkdtempSync, mkdirSync, realpathSync, renameSync, symlinkSync, unlinkSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPiSpawnArgvFitsPlatform } from '../project-resource-cli.js';
import { preparePinnedPiSkillInvocation } from '../runtime-capabilities.js';

const knobs = vi.hoisted(() => ({
  spawnArgs: [] as string[],
  compactCalls: [] as Array<Record<string, unknown>>,
  compactHold: null as null | Promise<void>,
  rpcCalls: [] as Array<Record<string, unknown>>,
  switchSessionSuccess: true,
  bridgeAckSuccess: true,
  runtimeVersion: '1.0.0',
  nativeSettings: null as null | { compaction?: Record<string, unknown> },
  configHome: '',
  autoCompactionSuccess: true,
  runtimeProvider: "cindy",
  runtimeModel: "m",
  runtimeContextWindow: 200_000,
  contextTokens: null as number | null,
  targetRuntimeContextWindow: 100_000,
  setModelReportsContextWindow: true,
  verifiedContextWindows: [] as number[],
  closeCalls: 0,
  stateModelOverride: null as null | string,
  onEvent: null as
    null | ((event: { type: string; [key: string]: unknown }) => void),
}));

vi.mock("../transport.js", () => ({
  createPiStdioTransport: (opts: {
    args?: string[];
    env?: Record<string, string>;
    onProcessSpawned?: (pid: number) => void | (() => void);
  }) => {
    knobs.spawnArgs = opts.args ?? [];
    knobs.configHome = opts.env?.PI_CODING_AGENT_DIR ?? '';
    knobs.nativeSettings = JSON.parse(readFileSync(path.join(knobs.configHome, 'settings.json'), 'utf8'));
    opts.onProcessSpawned?.(1234);
    return {
      writeLine: async () => {},
      onLine: () => () => {},
      onStderr: () => () => {},
      onClose: () => () => {},
      close: async () => {},
      pid: 1234,
      isClosed: () => false,
    };
  },
  attachJsonlReader: () => {},
}));

vi.mock("../rpc-client.js", () => ({
  PiRpcProcess: class {
    isClosed = false;
    constructor(opts: {
      onEvent?: (event: { type: string; [key: string]: unknown }) => void;
    }) {
      knobs.onEvent = opts.onEvent ?? null;
    }
    async request(cmd: Record<string, unknown>): Promise<{
      success: boolean;
      data?: unknown;
      error?: string;
    }> {
      knobs.rpcCalls.push(cmd);
      if (cmd.type === 'get_commands') return { success: true, data: { commands: [
        { name: 'cindy-native-provider-refresh', source: 'extension' },
      ] } };
      if (cmd.type === 'prompt' && typeof cmd.message === 'string' && cmd.message.startsWith('/cindy-native-provider-refresh ')) {
        const nonce = cmd.message.split(' ')[1];
        knobs.onEvent?.({ type: 'extension_ui_request', method: 'input',
          title: 'cindy:provider-refresh-ack', id: 'refresh-ack', placeholder: JSON.stringify({
            nonce, ok: knobs.bridgeAckSuccess, code: knobs.bridgeAckSuccess ? undefined : 'APPLY_FAILED',
            runtimeSettings: { version: knobs.runtimeVersion, compaction: knobs.nativeSettings?.compaction ?? {} },
          }) });
        return { success: true, data: {} };
      }
      if (cmd.type === 'get_available_models') {
        const config = JSON.parse(readFileSync(path.join(knobs.configHome, 'models.json'), 'utf8')) as {
          providers: Record<string, { models?: Array<{ id: string }> }>;
        };
        return { success: true, data: { models: Object.entries(config.providers).flatMap(
          ([provider, spec]) => (spec.models ?? []).map(model => ({ provider, id: model.id }))) } };
      }
      if (cmd.type === "get_session_stats" && knobs.contextTokens !== null) {
        return { success: true, data: { contextUsage: {
          tokens: knobs.contextTokens, contextWindow: knobs.runtimeContextWindow,
        } } };
      }
      if (cmd.type === "get_state") {
        return {
          success: true,
          data: {
            sessionFile: "/mock/s.jsonl",
            model: {
              provider: knobs.runtimeProvider,
              id: knobs.stateModelOverride ?? knobs.runtimeModel,
              contextWindow: knobs.verifiedContextWindows.shift() ?? knobs.runtimeContextWindow,
            },
          },
        };
      }
      if (cmd.type === "compact") {
        knobs.compactCalls.push(cmd);
        if (knobs.compactHold) await knobs.compactHold;
        return { success: true, data: {} };
      }
      if (cmd.type === "set_auto_compaction") {
        return knobs.autoCompactionSuccess
          ? { success: true, data: {} }
          : { success: false, error: "runtime rejected" };
      }
      if (cmd.type === "set_compaction_reserve_tokens") {
        return { success: false, error: "Unknown command: set_compaction_reserve_tokens" };
      }
      if (cmd.type === "set_model") {
        knobs.runtimeProvider = String(cmd.provider);
        knobs.runtimeModel = String(cmd.modelId);
        knobs.runtimeContextWindow = knobs.runtimeModel === "n"
          ? knobs.targetRuntimeContextWindow
          : 200_000;
        return {
          success: true,
          data: knobs.setModelReportsContextWindow
            ? { contextWindow: knobs.runtimeContextWindow }
            : {},
        };
      }
      if (cmd.type === "switch_session") {
        if (!knobs.switchSessionSuccess) {
          return { success: false, error: "reload denied" };
        }
        // Real Pi reconstructs from the process' original CLI route.
        knobs.runtimeProvider = "cindy";
        knobs.runtimeModel = "m";
        knobs.runtimeContextWindow = 200_000;
        return { success: true, data: {} };
      }
      return { success: true, data: { entries: [] } };
    }
    send(): void {}
    async close(): Promise<void> {
      knobs.closeCalls += 1;
      this.isClosed = true;
    }
  },
}));

import { buildPiSettingsJsonContent, PiAgent } from "../index.js";
import type { AgentDeps, AgentSessionHandle } from "../../base-agent.js";
import { AgentStartupStoppedError } from "../../base-agent.js";
import type { Logger } from "../../../interfaces/logger.js";

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

describe("Pi native settings", () => {
  it.each([1_000, 32_000, 200_000])('uses budget %s for compaction without shrinking request capacity', (budget) => {
    const settings = JSON.parse(buildPiSettingsJsonContent(200_000, 90, [], budget));
    expect(200_000 - settings.compaction.reserveTokens).toBe(budget * 0.9);
  });
  it("maps the configured percentage to Pi reserve tokens", () => {
    const retry = {
      enabled: true,
      maxRetries: 6,
      baseDelayMs: 2000,
      provider: { maxRetries: 0 },
    };
    expect(JSON.parse(buildPiSettingsJsonContent(128_000, 75))).toEqual({
      transport: "sse",
      retry,
      compaction: { reserveTokens: 32_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(200_000, 75))).toEqual({
      transport: "sse",
      retry,
      compaction: { reserveTokens: 50_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(100_000, 75))).toEqual({
      transport: "sse",
      retry,
      compaction: { reserveTokens: 25_000 },
    });
    expect(JSON.parse(buildPiSettingsJsonContent(128_000))).toEqual({ transport: "sse", retry });
  });
});

describe("PiAgent native auto-compaction ownership", () => {
  let agentHome = "";
  let cwd = "";

  beforeEach(() => {
    knobs.spawnArgs = [];
    knobs.compactCalls = [];
    knobs.compactHold = null;
    knobs.rpcCalls = [];
    knobs.switchSessionSuccess = true;
    knobs.bridgeAckSuccess = true;
    knobs.runtimeVersion = '1.0.0';
    knobs.nativeSettings = null;
    knobs.autoCompactionSuccess = true;
    knobs.runtimeProvider = "cindy";
    knobs.runtimeModel = "m";
    knobs.runtimeContextWindow = 200_000;
    knobs.contextTokens = null;
    knobs.targetRuntimeContextWindow = 100_000;
    knobs.setModelReportsContextWindow = true;
    knobs.verifiedContextWindows = [];
    knobs.closeCalls = 0;
    knobs.stateModelOverride = null;
    knobs.onEvent = null;
    agentHome = mkdtempSync(path.join(tmpdir(), "pi-native-ac-home-"));
    cwd = mkdtempSync(path.join(tmpdir(), "pi-native-ac-cwd-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(agentHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  it('keeps the applied small budget until native settings are reloaded', async () => {
    let budget: number | null = 1_000;
    const deps = buildDeps();
    deps.resolveModelContextLimit = () => budget;
    const handle = await new PiAgent(deps).startSession({ sessionId: 'small-budget', workingDir: cwd, model: 'm', providerId: 'xd' });
    try {
      expect(handle.getUsageSnapshot().contextWindow).toBe(1_000);
      expect((await handle.getContextUsage!()).maxTokens).toBe(1_000);
      knobs.contextTokens = 6_000;
      expect(await handle.getContextUsage!()).toMatchObject({
        totalTokens: 6_000, maxTokens: 1_000, rawMaxTokens: 1_000, percentage: 100,
      });
      expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: 'xd' })).toBe(false);
      budget = 32_000;
      expect(handle.getUsageSnapshot().contextWindow).toBe(1_000);
      expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: 'xd' })).toBe(true);
      budget = null;
      expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: 'xd' })).toBe(true);
    } finally { await handle.close(); }
  });

  it('requests a fresh native runtime to clear a startup narrow budget', async () => {
    let budget: number | null = 1_000;
    const deps = buildDeps();
    deps.runtimeConfig = { ...deps.runtimeConfig, piAutoCompactThresholdPct: undefined };
    deps.resolveModelContextLimit = () => budget;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'clear-budget', workingDir: cwd, model: 'm', providerId: 'xd',
    });
    budget = null;
    knobs.rpcCalls = [];
    expect(await handle.previewModelSwitch?.('m', { providerId: 'xd' })).toMatchObject({ action: 'rebuild' });
    await expect(handle.setModel!('m', { providerId: 'xd' })).rejects.toThrow(/load the changed native compaction/);
    expect(knobs.rpcCalls.some(call => call.type === 'set_model')).toBe(false);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(199_100);
    await handle.close();
  });

  it('requires native settings reload for a new narrow budget without partially changing the route', async () => {
    let budget: number | null = null;
    const deps = buildDeps();
    deps.runtimeConfig = { ...deps.runtimeConfig, piAutoCompactThresholdPct: undefined };
    deps.resolveModelContextLimit = () => budget;
    const handle = await new PiAgent(deps).startSession({
      sessionId: 'add-budget', workingDir: cwd, model: 'm', providerId: 'xd',
    });
    expect(readLatestPiSettings().compaction?.reserveTokens).toBeUndefined();
    budget = 1_000;
    knobs.rpcCalls = [];
    expect(await handle.previewModelSwitch?.('m', { providerId: 'xd' })).toMatchObject({ action: 'rebuild' });
    await expect(handle.setModel!('m', { providerId: 'xd' })).rejects.toThrow(/load the changed native compaction/);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBeUndefined();
    expect(handle.getUsageSnapshot().contextWindow).toBe(200_000);
    await handle.close();
  });

  it.each([null, 'xd', 'cindy'] as const)('refreshes gateway aliases from a %s source without changing routes', async (providerId) => {
    let window = 200_000;
    const deps = buildDeps();
    deps.resolveModelContextLimit = () => window;
    const handle = await new PiAgent(deps).startSession({ sessionId: 'context-alias', workingDir: cwd, model: 'm', providerId });
    try {
      for (const target of [null, 'xd', 'cindy']) {
        expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: target })).toBe(false);
      }
      window = 100_000;
      for (const target of [null, 'xd', 'cindy']) {
        expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: target })).toBe(true);
      }
      expect(await handle.requiresModelSwitchRebuild?.('m', { providerId: 'other-source' })).toBe(false);
      expect(await handle.requiresModelSwitchRebuild?.('n', { providerId: 'xd' })).toBe(false);
    } finally {
      await handle.close();
    }
  });

  function buildDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({
          authenticated: true,
          identity: "t",
          authSource: "api-key" as const,
        }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      // Keep a host threshold here to prove PiAgent no longer consumes it.
      runtimeConfig: {
        endpoint: "http://127.0.0.1:9",
        autoCompactThresholdPct: 75,
        piAutoCompactThresholdPct: 75,
      },
      binaryPath: path.join(agentHome, "pi"),
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [
          {
            id: "m",
            displayName: "M",
            contextWindow: 200_000,
            efforts: [],
            defaultEffort: null,
          },
          {
            id: "n",
            displayName: "N",
            contextWindow: 100_000,
            efforts: [],
            defaultEffort: null,
          },
        ],
      },
      resolvePiGatewayModelApi: () => "openai-responses",
      resolvePiAgentHome: () => agentHome,
    };
  }

  async function start(): Promise<AgentSessionHandle> {
    return new PiAgent(buildDeps()).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
  }

  function settleWithUsage(input: number): void {
    knobs.onEvent?.({
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input, cacheRead: 0, cacheWrite: 0, output: 8 },
      },
    });
    knobs.onEvent?.({ type: "agent_settled" });
  }

  it.each(['ordinary', 'disabled', 'bot-allow', 'bot-deny', 'bot-failed', 'bot-disabled', 'bot-missing', 'bot-user-collision', 'bot-global-disabled'] as const)('loads managed skills through explicit paths: %s', async (mode) => {
    const skill = path.join(agentHome, 'managed', 'learn', 'SKILL.md');
    mkdirSync(path.dirname(skill), {recursive:true}); writeFileSync(skill, '---\nname: learn\ndescription: fixture\n---\nLearn');
    const deps = buildDeps();
    deps.getManagedSkills = async () => [{kind:'agent-skill', name:'learn', source:'skill', path:skill,
      claudeCommandName:'cindy:learn'}];
    if(mode === 'disabled' || mode === 'bot-global-disabled') deps.getDisabledSkillPaths = () => [path.dirname(skill)];
    const bot = mode.startsWith('bot');
    const handle = await new PiAgent(deps).startSession({ sessionId:'managed-skills', workingDir:cwd, model:'m',
      ...(bot ? {botRuntimeProfile:{botId:'fixture',profileVersion:1,
        skillPolicy:{mode:'allowlist' as const, configured:mode === 'bot-deny' ? [] : ['skill:learn'],
          catalog: mode === 'bot-missing' ? [] : [
            { name: 'learn', runtimeCommandName: 'skill:learn', path: skill,
              enabled: mode !== 'bot-disabled', runtimeStatus: mode === 'bot-failed' ? 'failed' as const : 'loaded' as const },
            ...(mode === 'bot-user-collision' ? [{ name: 'learn', runtimeCommandName: 'skill:learn',
              path: path.join(agentHome, 'user-learn', 'SKILL.md'), enabled: true }] : []),
          ]},
        mcpPolicy:{mode:'inherit' as const,configured:[],catalog:[]},
        toolsetPolicy:{mode:'inherit' as const,configured:[],catalog:[]}}} : {})});
    try {
      const projection = knobs.spawnArgs.find((arg) => path.basename(arg) === 'cindy-managed-skills');
      expect(!!projection).toBe(mode === 'ordinary' || mode === 'bot-allow');
      expect(knobs.spawnArgs).not.toContain(realpathSync(skill));
      if (projection) {
        const entries = readdirSync(projection);
        expect(entries).toHaveLength(1);
        const projectedFile = path.join(projection, entries[0]!, 'SKILL.md');
        expect(realpathSync(projectedFile)).toBe(realpathSync(skill));
        expect(preparePinnedPiSkillInvocation('/learn', { name: 'learn', path: skill }, {
          capturedAt: '2026-10-01T00:00:00.000Z', generation: 1, status: 'loaded', source: 'pi:get_commands',
          commands: [{ name: 'skill:learn', source: 'skill', sourceInfo: { path: projectedFile, baseDir: path.dirname(projectedFile) } }],
        })).toBe('/skill:learn');
      }
      if(bot) expect(knobs.spawnArgs).toContain('--no-skills');
      if(mode === 'bot-allow') expect(knobs.spawnArgs.filter((arg) => arg === '--skill')).toHaveLength(1);
    } finally {await handle.close();}
  });

  // 350 real skill files + 350 session junctions make this case load-sensitive on the
  // shared Windows PR runners (repeated "Test timed out in 5000ms", #5350). Only the
  // Windows budget is widened; the fixture size and every assertion stay as in #5318.
  it('keeps hundreds of long managed skill paths out of Windows argv and cleans only session links', {
    timeout: process.platform === 'win32' ? 30_000 : 5_000,
  }, async () => {
    const skills = Array.from({ length: 350 }, (_, index) => {
      const file = path.join(agentHome, 'approved', 'revision-'.repeat(12), String(index), 'SKILL.md');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `---\nname: fixture-${index}\ndescription: fixture\n---\nBody`);
      return { kind: 'agent-skill' as const, name: `fixture-${index}`, source: 'skill' as const,
        path: file, claudeCommandName: `cindy-plugin-example:fixture-${index}` };
    });
    expect(() => assertPiSpawnArgvFitsPlatform(skills.flatMap((skill) => ['--skill', skill.path]), 'win32')).toThrow();
    const deps = buildDeps();
    deps.getManagedSkills = async () => skills;
    const handle = await new PiAgent(deps).startSession({ sessionId: 'many-skills', workingDir: cwd, model: 'm' });
    const projection = knobs.spawnArgs.find((arg) => path.basename(arg) === 'cindy-managed-skills')!;
    try {
      expect(() => assertPiSpawnArgvFitsPlatform(knobs.spawnArgs, 'win32')).not.toThrow();
      expect(knobs.spawnArgs.filter((arg) => arg === '--skill')).toHaveLength(1);
      expect(knobs.spawnArgs.some((arg) => skills.some((skill) => arg === skill.path))).toBe(false);
      const entries = readdirSync(projection).sort();
      expect(entries).toHaveLength(skills.length);
      expect(entries.map((entry) => realpathSync(path.join(projection, entry, 'SKILL.md'))))
        .toEqual(skills.map((skill) => realpathSync(skill.path)));
    } finally { await handle.close(); }
    await vi.waitFor(() => expect(existsSync(projection)).toBe(false));
    expect(skills.every((skill) => existsSync(skill.path))).toBe(true);
  });

  it.each(['discovery', 'realpath', 'mkdir', 'symlink'] as const)('cleans startup resources when managed Skill %s fails', async (operation) => {
    const skill = path.join(agentHome, 'managed', 'learn', 'SKILL.md');
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, '---\nname: learn\ndescription: fixture\n---\nLearn');
    const deps = buildDeps();
    const disposeSessionCtx = vi.fn();
    deps.preparePiExtraSpawnConfig = async () => ({ disposeSessionCtx });
    deps.getManagedSkills = async () => [{ kind: 'agent-skill', name: 'learn', source: 'skill',
      path: skill, claudeCommandName: 'cindy:learn' }];
    const failure = Object.assign(new Error('managed projection I/O failed'), { code: 'EACCES' });
    const originalMkdir = fs.mkdir;
    const originalSymlink = fs.symlink;
    let failedPath = '';
    if (operation === 'discovery') {
      deps.getManagedSkills = async () => { failedPath = skill; throw failure; };
    } else if (operation === 'realpath') {
      const originalRealpath = fsSync.realpathSync;
      vi.spyOn(fsSync, 'realpathSync').mockImplementation(((target: string, options: unknown) => {
        if (String(target) === skill) { failedPath = skill; throw failure; }
        return originalRealpath(target, options as never);
      }) as typeof fsSync.realpathSync);
    } else if (operation === 'mkdir') {
      vi.spyOn(fs, 'mkdir').mockImplementation((async (target: string, options: unknown) => {
        if (String(target).endsWith('cindy-managed-skills')) { failedPath = String(target); throw failure; }
        return originalMkdir(target, options as never);
      }) as typeof fs.mkdir);
    } else {
      vi.spyOn(fs, 'symlink').mockImplementation(async (target, link, type) => {
        if (String(link).includes('cindy-managed-skills')) { failedPath = String(link); throw failure; }
        return originalSymlink(target, link, type);
      });
    }
    const startupFailure = await new PiAgent(deps).startSession({ sessionId: 'failed-skill', workingDir: cwd, model: 'm' })
      .catch((error: unknown) => error);
    expect(startupFailure).toBeInstanceOf(AgentStartupStoppedError);
    expect((startupFailure as AgentStartupStoppedError).cause).toBe(failure);
    expect(failedPath).not.toBe('');
    expect(disposeSessionCtx).toHaveBeenCalledTimes(1);
    expect(knobs.spawnArgs).toEqual([]);
    await vi.waitFor(() => {
      expect(readdirSync(path.join(agentHome, 'run-tmp'))).toEqual([]);
      expect(readdirSync(path.join(agentHome, 'runtime')).filter(name => /^(perm|subagent)-/.test(name))).toEqual([]);
    });
    expect(existsSync(skill)).toBe(true);
  });

  it("enables Pi native auto-compaction during startup", async () => {
    const handle = await start();
    expect(knobs.rpcCalls).toContainEqual({
      type: "set_auto_compaction",
      enabled: true,
    });
    await handle.close();
  });

  it("refuses to start when native auto-compaction cannot be enabled", async () => {
    knobs.autoCompactionSuccess = false;
    await expect(start()).rejects.toThrow(/refusing to start without native auto-compaction/);
  });

  it("does not issue host compact RPCs at the shared threshold or a full window", async () => {
    const handle = await start();
    settleWithUsage(160_000);
    settleWithUsage(200_000);
    await Promise.resolve();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it("accepts a successful native threshold boundary and updates context usage", async () => {
    const handle = await start();
    settleWithUsage(200_000);
    knobs.onEvent?.({ type: "compaction_start", reason: "threshold" });
    knobs.onEvent?.({
      type: "compaction_end",
      reason: "threshold",
      result: { tokensBefore: 200_000, estimatedTokensAfter: 20_000 },
      aborted: false,
    });
    expect(handle.getUsageSnapshot()).toMatchObject({
      contextTokens: 20_000,
      contextWindow: 200_000,
    });
    expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();
    expect(knobs.compactCalls).toEqual([]);
    await handle.close();
  });

  it.each(["threshold", "overflow"])(
    "latches a deterministic native %s compaction failure for local rollover",
    async (reason) => {
      const handle = await start();
      settleWithUsage(190_000);
      knobs.onEvent?.({
        type: "compaction_end",
        reason,
        result: null,
        aborted: false,
        errorMessage: "summarization produced empty response",
      });
      expect(handle.getUsageSnapshot().needsRollover).toBe(true);
      expect(knobs.compactCalls).toEqual([]);
      await handle.close();
    },
  );

  it("does not latch manual, aborted, or transient native compaction failures", async () => {
    const cases = [
      {
        reason: "manual",
        aborted: false,
        errorMessage: "summarization produced empty response",
      },
      {
        reason: "threshold",
        aborted: true,
        errorMessage: "summarization produced empty response",
      },
      { reason: "threshold", aborted: false, errorMessage: "gateway 500" },
    ];
    for (const testCase of cases) {
      const handle = await start();
      settleWithUsage(190_000);
      knobs.onEvent?.({ type: "compaction_end", result: null, ...testCase });
      expect(handle.getUsageSnapshot().needsRollover).toBeUndefined();
      await handle.close();
    }
  });

  async function startHeldManualCompact(handle: AgentSessionHandle): Promise<{
    release: () => void;
    compactDone: Promise<unknown>;
  }> {
    let release!: () => void;
    knobs.compactHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compactDone = handle.compactSession!();
    await vi.waitFor(() => expect(knobs.compactCalls).toHaveLength(1));
    return { release, compactDone };
  }

  it("keeps manual compact serialized before model controls", async () => {
    const handle = await start();
    const { release, compactDone } = await startHeldManualCompact(handle);
    const setModelDone = handle.setModel!("n");
    await Promise.resolve();
    expect(knobs.rpcCalls.some((call) => call.type === "set_model")).toBe(
      false,
    );
    release();
    await Promise.all([compactDone, setModelDone]);
    const types = knobs.rpcCalls.map((call) => call.type);
    expect(types.lastIndexOf("set_model")).toBeGreaterThan(
      types.lastIndexOf("compact"),
    );
    await handle.close();
  });

  it.each([
    [
      "prompt",
      (handle: AgentSessionHandle) =>
        handle.send({
          type: "user",
          content: "hi",
        }),
    ],
    [
      "steer",
      (handle: AgentSessionHandle) =>
        handle.steer!({
          type: "user",
          content: "steer now",
        }),
    ],
  ] as const)(
    "keeps manual compact serialized before %s",
    async (rpcType, run) => {
      const handle = await start();
      const { release, compactDone } = await startHeldManualCompact(handle);
      const controlDone = run(handle);
      await Promise.resolve();
      await Promise.resolve();
      expect(knobs.rpcCalls.some((call) => call.type === rpcType)).toBe(false);
      release();
      await Promise.all([compactDone, controlDone]);
      const types = knobs.rpcCalls.map((call) => call.type);
      expect(types.lastIndexOf(rpcType)).toBeGreaterThan(
        types.lastIndexOf("compact"),
      );
      await handle.close();
    },
  );

  function readLatestPiSettings(): { compaction?: { reserveTokens?: number }; skills?: string[]; packages?: Array<{ source: string; skills?: string[] }> } {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "settings.json") files.push(next);
      }
    };
    walk(agentHome);
    expect(files.length).toBeGreaterThan(0);
    return JSON.parse(readFileSync(files[files.length - 1]!, "utf8")) as {
      compaction?: { reserveTokens?: number };
    };
  }

  it("writes the local override into the native model file and compression reserve", async () => {
    const deps = buildDeps();
    deps.resolveModelContextLimit = (_provider, model) => model === "m" ? 500_000 : null;
    const handle = await new PiAgent(deps).startSession({ sessionId: "budget", workingDir: cwd, model: "m" });
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "models.json") files.push(next);
      }
    };
    walk(agentHome);
    const models = files.flatMap((file) => {
      const data = JSON.parse(readFileSync(file, "utf8")) as { providers: Record<string, { models?: Array<{ id: string; contextWindow: number }> }> };
      return Object.values(data.providers).flatMap((provider) => provider.models ?? []);
    });
    expect(models.find((model) => model.id === "m")?.contextWindow).toBe(500_000);
    expect(models.find((model) => model.id === "n")?.contextWindow).toBe(100_000);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(125_000);
    await handle.close();
  });

  it("rewrites native reserve tokens when the model window changes", async () => {
    const handle = await start();
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(50_000);
    await handle.setModel!("n");
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(25_000);
    const switchIndex = knobs.rpcCalls.findIndex((call) => call.type === "switch_session");
    const setModelIndexes = knobs.rpcCalls
      .map((call, index) => (call.type === "set_model" ? index : -1))
      .filter((index) => index >= 0);
    const verifyIndex = knobs.rpcCalls.findLastIndex((call) => call.type === "get_state");
    expect(setModelIndexes).toHaveLength(1);
    expect(switchIndex).toBe(-1);
    expect(verifyIndex).toBeGreaterThan(setModelIndexes[0]!);
    expect(knobs.rpcCalls.some((call) => call.type === "set_compaction_reserve_tokens")).toBe(false);
    expect(knobs.nativeSettings?.compaction?.modelOverrides).toMatchObject({
      'cindy/m': { reserveTokens: 50_000 }, 'cindy/n': { reserveTokens: 25_000 },
    });
    expect(knobs.runtimeProvider).toBe("cindy");
    expect(knobs.runtimeModel).toBe("n");
    expect(handle.getUsageSnapshot().contextWindow).toBe(100_000);
    await handle.close();
  });

  it("rejects an unexpected runtime window rather than claiming an unapplied reserve", async () => {
    const deps = buildDeps();
    deps.runtimeConfig = {
      ...deps.runtimeConfig,
      autoCompactThresholdPct: 90,
      piAutoCompactThresholdPct: 90,
    };
    const handle = await new PiAgent(deps).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(20_000);

    knobs.targetRuntimeContextWindow = 1_000_000;
    knobs.setModelReportsContextWindow = false;
    knobs.rpcCalls = [];
    await expect(handle.setModel!("n")).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(20_000);
    expect(knobs.rpcCalls.filter((call) => call.type === "switch_session")).toHaveLength(0);
    expect(knobs.rpcCalls.filter((call) => call.type === "set_model")).toHaveLength(1);
    expect(knobs.rpcCalls.filter((call) => call.type === "get_state")).toHaveLength(1);
    expect(knobs.closeCalls).toBe(1);
    await handle.close();
  });

  it("verifies a missing set_model window even when the catalog estimate is unchanged", async () => {
    const deps = buildDeps();
    deps.runtimeConfig = {
      ...deps.runtimeConfig,
      autoCompactThresholdPct: 90,
      piAutoCompactThresholdPct: 90,
    };
    deps.capabilityAdditions = {
      availableModels: deps.capabilityAdditions!.availableModels!.map((model) =>
        model.id === "n" ? { ...model, contextWindow: 200_000 } : model,
      ),
    };
    const handle = await new PiAgent(deps).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(20_000);

    knobs.setModelReportsContextWindow = false;
    knobs.rpcCalls = [];
    await expect(handle.setModel!("n")).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(20_000);
    expect(knobs.rpcCalls.filter((call) => call.type === "switch_session")).toHaveLength(0);
    expect(knobs.rpcCalls.filter((call) => call.type === "set_model")).toHaveLength(1);
    expect(knobs.rpcCalls.filter((call) => call.type === "get_state")).toHaveLength(1);
    expect(knobs.closeCalls).toBe(1);
    await handle.close();
  });

  it("does not fake a live native reserve change after a window mismatch", async () => {
    const handle = await start();
    knobs.targetRuntimeContextWindow = 1_000_000;
    knobs.setModelReportsContextWindow = false;
    knobs.verifiedContextWindows = [1_000_000];

    await expect(handle.setModel!("n")).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(50_000);
    expect(knobs.closeCalls).toBe(1);
    await handle.close();
  });

  it("terminates the session when native Pi does not confirm the target model", async () => {
    const handle = await start();
    knobs.stateModelOverride = "m";
    await expect(handle.setModel!("n")).rejects.toThrow(/PI_CATALOG_RELOAD_UNCONFIRMED/);
    await handle.close();
  });

  it("applies stable-root user shellPath to a brand-new session (#3643 cross-start)", async () => {
    // 用户在稳定根(pi-agent-home/settings.json)配置逃生门;本地 configHome 是
    // 每会话随机目录,新会话必须能从稳定根拿到配置。
    writeFileSync(
      path.join(agentHome, "settings.json"),
      JSON.stringify({ shellPath: "C:/cygwin64/bin/bash.exe" }, null, 2),
    );
    const handle = await start();
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "settings.json") files.push(next);
      }
    };
    walk(path.join(agentHome, "run-tmp"));
    expect(files.length).toBeGreaterThan(0);
    const written = JSON.parse(readFileSync(files[files.length - 1]!, "utf8")) as {
      shellPath?: string;
      transport?: string;
    };
    expect(written.shellPath).toBe("C:/cygwin64/bin/bash.exe");
    expect(written.transport).toBe("sse");
    await handle.close();
  });

  it("preserves user shellPath across settings.json rewrites (#3643)", async () => {
    const handle = await start();
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(next);
        else if (entry.name === "settings.json") files.push(next);
      }
    };
    walk(agentHome);
    expect(files.length).toBeGreaterThan(0);
    const settingsPath = files[files.length - 1]!;
    // 用户在会话间隙按 pi docs/windows.md 配置 shell 逃生门。
    const current = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    writeFileSync(
      settingsPath,
      JSON.stringify({ ...current, shellPath: "C:/cygwin64/bin/bash.exe" }, null, 2),
    );
    await handle.setModel!("n");
    const rewritten = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      shellPath?: string;
      compaction?: { reserveTokens?: number };
    };
    expect(rewritten.shellPath).toBe("C:/cygwin64/bin/bash.exe");
    expect(rewritten.compaction?.reserveTokens).toBe(25_000);
    await handle.close();
  });

  it.each(["unchanged", "alias", "physical", "startup"])("keeps frozen Skill exclusions across both settings rewrites (%s)", async (change) => {
    const a = path.join(cwd, "a");
    const b = path.join(cwd, "b");
    const alias = path.join(cwd, "alias");
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(path.join(a, "SKILL.md"), "fixture a");
    writeFileSync(path.join(b, "SKILL.md"), "fixture b");
    symlinkSync(a, alias, process.platform === "win32" ? "junction" : "dir");
    const deps = buildDeps();
    deps.getDisabledSkillPaths = () => [a];
    deps.resolvePiNativePackagePaths = async () => [{ source: cwd, skills: ["**/*"] }];
    deps.resolvePiManagedPackageResources = async () => {
      if (change === "startup") {
        renameSync(a, `${a}-moved`);
        symlinkSync(b, a, process.platform === "win32" ? "junction" : "dir");
      }
      return { extensions: [], skills: [{ name: "alias", path: alias }], promptTemplates: [], packageRoots: [cwd] };
    };
    const handle = await new PiAgent(deps).startSession({ sessionId: "frozen-skills", workingDir: cwd, model: "m" });
    try {
      if (change === "startup") expect(readLatestPiSettings().skills ?? []).not.toContain(`-${a}`);
      else expect(readLatestPiSettings().skills).toContain(`-${alias}`);
      if (change === "alias") {
        unlinkSync(alias);
        symlinkSync(b, alias, process.platform === "win32" ? "junction" : "dir");
      } else if (change === "physical") {
        renameSync(a, `${a}-moved`);
        symlinkSync(b, a, process.platform === "win32" ? "junction" : "dir");
      }
      knobs.targetRuntimeContextWindow = 100_000;
      knobs.setModelReportsContextWindow = false;
      knobs.rpcCalls = [];
      await handle.setModel!("n");
      const rewritten = readLatestPiSettings();
      expect(knobs.rpcCalls.filter((call) => call.type === "switch_session")).toHaveLength(0);
      expect(rewritten.packages?.[0]?.source).toBe(cwd);
      expect(rewritten.skills ?? []).not.toContain(`-${b}`);
      expect(rewritten.packages?.[0]?.skills ?? []).not.toContain("-b");
      if (change === "unchanged") expect(rewritten.skills).toContain(`-${alias}`);
      else expect(rewritten.skills ?? []).not.toContain(`-${alias}`);
      if (change === "physical" || change === "startup") expect(rewritten.skills ?? []).not.toContain(`-${a}`);
    } finally { await handle.close(); }
  });

  it("rejects before switching when the native settings inspection fails", async () => {
    const handle = await start();
    knobs.bridgeAckSuccess = false;
    await expect(handle.setModel!("n")).rejects.toThrow(/could not read the live Pi compaction settings/);
    expect(knobs.rpcCalls.filter((call) => call.type === "set_model")).toHaveLength(0);
    expect(knobs.closeCalls).toBe(0);
    await handle.close();
  });

  it("keeps an older official Pi route untouched when a new reserve requires reloading settings", async () => {
    let addNative = false;
    const deps = buildDeps();
    deps.resolvePiNativeProviders = async () => ({
      providers: addNative ? [{ id: "native-added", name: "Added", baseUrl: "http://a.test",
        api: "openai-completions", models: [{ id: "native-model" }] }] : [],
      env: {},
    });
    const handle = await new PiAgent(deps).startSession({
      sessionId: "old-pi-no-partial-refresh", workingDir: cwd, model: "m", providerId: "xd",
    });
    addNative = true;
    knobs.runtimeVersion = '0.85.1';
    knobs.rpcCalls = [];
    expect(await handle.previewModelSwitch?.('n', { providerId: 'xd' })).toMatchObject({ action: 'rebuild' });
    await expect(handle.setModel!("n", { providerId: "xd" })).rejects.toThrow(/load the changed native compaction/);
    expect(knobs.rpcCalls.some(call => call.type === 'set_model' || call.type === 'refresh_models' || call.type === 'set_compaction_reserve_tokens')).toBe(false);
    expect(knobs.closeCalls).toBe(0);
    expect(handle.model).toBe("m");
    await handle.close();
  });

  it("keeps the startup Pi percentage after the live setting changes", async () => {
    const runtimeConfig = {
      endpoint: "http://127.0.0.1:9",
      autoCompactThresholdPct: 75,
      piAutoCompactThresholdPct: 75,
    };
    const handle = await new PiAgent({
      ...buildDeps(),
      runtimeConfig,
    }).startSession({
      sessionId: "s1",
      workingDir: cwd,
      model: "m",
    });
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(50_000);
    runtimeConfig.piAutoCompactThresholdPct = 50;
    await handle.setModel!("n");
    expect(readLatestPiSettings().compaction?.reserveTokens).toBe(25_000);
    await handle.close();
  });
});
