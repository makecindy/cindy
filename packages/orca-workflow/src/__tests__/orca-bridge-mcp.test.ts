import type {
  AgentEvent,
  AgentKind,
  Logger,
  Maker,
  McpProvider,
  Session,
  SessionSendOptions,
  SessionSendResult,
} from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  createOrcaWorkerBridgeMcpProvider,
  type OrcaBridgeMcpDeps,
  type OrcaWorkerLink,
} from '../orca-bridge-mcp';

interface FakeSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  capabilities: Record<string, unknown>;
  closeCalls: number;
  sendAfterAccepted?: (session: FakeSession, message: unknown) => void | Promise<void>;
  sendBeforeAcceptedGate?: AsyncGate;
  sendError?: unknown;
  sendResolveGate?: AsyncGate;
  sendResult: SessionSendResult;
  sent: unknown[];
  turnRunning: boolean;
  onEvent(cb: (ev: AgentEvent) => void): () => void;
  close(): Promise<void>;
  send(message: unknown, opts?: SessionSendOptions): Promise<SessionSendResult>;
  getStatus(): string;
  isTurnRunning(): boolean;
  emit(ev: AgentEvent): void;
}

interface CreateSessionOpts {
  id: string;
  agentKind: AgentKind;
  workingDir?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  fastMode?: boolean;
  title?: string;
  parentSessionId?: string;
  resumeSessionId?: string;
  userPrompt?: string;
  providerId?: string | null;
  vendorOptions?: Record<string, unknown>;
}

interface FakeTool {
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

interface FakeMcpServer {
  _registeredTools: Record<string, FakeTool>;
}

interface FakeLogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  msg: string;
  ctx?: Record<string, unknown>;
}

interface AsyncGate {
  started: Promise<void>;
  wait: Promise<void>;
  markStarted: () => void;
  release: () => void;
}

const ACCEPTED_SEND: SessionSendResult = { accepted: true };
const CANCELLED_SEND: SessionSendResult = {
  accepted: false,
  reason: 'cancelled-before-dispatch',
};

function makeAsyncGate(): AsyncGate {
  let markStarted: () => void = () => undefined;
  let release: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { started, wait, markStarted, release };
}

function makeSession(id: string, opts?: {
  sendAfterAccepted?: (session: FakeSession, message: unknown) => void | Promise<void>;
  sendBeforeAcceptedGate?: AsyncGate;
  sendError?: unknown;
  sendResolveGate?: AsyncGate;
  sendResult?: SessionSendResult;
}): FakeSession {
  const listeners: Array<(ev: AgentEvent) => void> = [];
  return {
    id,
    agentKind: 'claude-code',
    workDir: '/repo',
    capabilities: {},
    closeCalls: 0,
    sendAfterAccepted: opts?.sendAfterAccepted,
    sendBeforeAcceptedGate: opts?.sendBeforeAcceptedGate,
    sendError: opts?.sendError,
    sendResolveGate: opts?.sendResolveGate,
    sendResult: opts?.sendResult ?? ACCEPTED_SEND,
    sent: [],
    turnRunning: false,
    onEvent(cb: (ev: AgentEvent) => void) {
      listeners.push(cb);
      return () => {
        const idx = listeners.indexOf(cb);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    emit(ev: AgentEvent) {
      for (const cb of [...listeners]) cb(ev);
    },
    async close() {
      this.closeCalls += 1;
    },
    async send(message: unknown, opts?: SessionSendOptions) {
      this.sent.push(message);
      if (this.sendBeforeAcceptedGate) {
        this.sendBeforeAcceptedGate.markStarted();
        await this.sendBeforeAcceptedGate.wait;
      }
      await opts?.onAccepted?.();
      await this.sendAfterAccepted?.(this, message);
      if (this.sendResolveGate) {
        this.sendResolveGate.markStarted();
        await this.sendResolveGate.wait;
      }
      if (this.sendError) throw this.sendError;
      return this.sendResult;
    },
    getStatus() {
      return 'idle';
    },
    isTurnRunning() {
      return this.turnRunning;
    },
  };
}

function makeLogger(entries: FakeLogEntry[] = []): Logger & { entries: FakeLogEntry[] } {
  const logger = {
    entries,
    trace: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'trace', msg, ctx }),
    debug: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'debug', msg, ctx }),
    info: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'info', msg, ctx }),
    warn: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'warn', msg, ctx }),
    error: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'error', msg, ctx }),
    fatal: (msg: string, ctx?: Record<string, unknown>) => entries.push({ level: 'fatal', msg, ctx }),
    child: () => makeLogger(entries),
  };
  return logger;
}

function makeSensitiveError(code?: string): Error {
  const err = new Error('prompt=SECRET_PROMPT token=SECRET_TOKEN user=SECRET_USER_MESSAGE file=SECRET_FILE_BODY');
  if (code) {
    (err as Error & { code: string }).code = code;
  }
  return err;
}

function expectToolError(result: unknown): Record<string, unknown> {
  expect((result as { isError?: unknown }).isError).toBe(true);
  return parseToolJson(result);
}

function expectNoSensitiveLogContent(entries: FakeLogEntry[]): void {
  const serialized = JSON.stringify(entries);
  expect(serialized).not.toContain('SECRET_PROMPT');
  expect(serialized).not.toContain('SECRET_TOKEN');
  expect(serialized).not.toContain('SECRET_USER_MESSAGE');
  expect(serialized).not.toContain('SECRET_FILE_BODY');
}

function expectStructuredSendWarning(
  entries: FakeLogEntry[],
  partial: Record<string, unknown>,
): FakeLogEntry {
  const entry = entries.find((item) => {
    if (item.level !== 'warn') return false;
    return Object.entries(partial).every(([key, value]) => item.ctx?.[key] === value);
  });
  expect(entry?.ctx).toMatchObject({
    kind: 'session-dispatch',
    owner: 'orca-workflow',
    ...partial,
  });
  expect(entry?.ctx).toHaveProperty('entrypoint');
  expect(entry?.ctx).toHaveProperty('sessionId');
  expect(entry?.ctx).toHaveProperty('action');
  expect(entry?.ctx).toHaveProperty('reason');
  expect(entry?.ctx).toHaveProperty('context');
  expect(entry?.ctx).toHaveProperty('workerStatus');
  expect(entry?.ctx).toHaveProperty('autoBridgePending');
  return entry as FakeLogEntry;
}

function makeProvider(opts?: {
  activeSessions?: Record<string, FakeSession>;
  firstPersistGate?: AsyncGate;
  logger?: Logger & { entries: FakeLogEntry[] };
  dispatchInterAgentMessage?: OrcaBridgeMcpDeps['dispatchInterAgentMessage'];
  workerLink?: OrcaWorkerLink | null;
}) {
  const createSessionCalls: CreateSessionOpts[] = [];
  const wired: string[] = [];
  const persisted: Array<{ sessionId: string; content: string }> = [];
  const sessionRows: Array<{ id: string; status: 'active' | 'archived'; title?: string }> = [];
  const statusUpdates: Array<{ workerId: string; status: string }> = [];
  const activeSessions = opts?.activeSessions ?? {};
  const logger = opts?.logger ?? makeLogger();
  const maker = {
    getSession(id: string) {
      return activeSessions[id] ?? null;
    },
    async createSession(o: CreateSessionOpts): Promise<Session> {
      createSessionCalls.push(o);
      const session = activeSessions[o.id] ?? makeSession(o.id);
      session.agentKind = o.agentKind;
      session.workDir = o.workingDir ?? '/repo';
      activeSessions[o.id] = session;
      if (!sessionRows.some((row) => row.id === o.id)) {
        sessionRows.push({ id: o.id, status: 'active', title: o.title });
      }
      return session as unknown as Session;
    },
  };
  return {
    activeSessions,
    createSessionCalls,
    logger,
    maker,
    persisted,
    sessionRows,
    statusUpdates,
    wired,
  };
}

function getServer(provider: McpProvider, ctx: Record<string, unknown>) {
  const toClaudeSdkConfig = provider.toClaudeSdkConfig;
  if (!toClaudeSdkConfig) throw new Error('expected SDK MCP provider');
  const config = toClaudeSdkConfig(ctx as never) as { type?: string; instance?: unknown } | null;
  if (config?.type !== 'sdk') throw new Error('expected sdk MCP config');
  return config.instance as unknown as FakeMcpServer;
}

function parseToolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: Array<{ text?: string }> }).content;
  const text = content?.[0]?.text;
  if (!text) throw new Error('expected text tool result');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('orca_worker_bridge MCP helpers', () => {
  function makeWorkerBridgeLeadHarness(lead: FakeSession) {
    const logger = makeLogger();
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const base = makeProvider({
      activeSessions: { 'lead-1': lead },
      logger,
      workerLink,
    });
    const workerProvider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => base.maker as unknown as Maker,
      logger: logger as never,
      persistUserMessage: async (sessionId, message) => {
        base.persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          base.statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(workerProvider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });
    return {
      ...base,
      seedExistingLeadResult: async () => {
        await server._registeredTools.read_lead.handler({ worker_id: 'worker-1' });
        lead.emit({ type: 'done', data: { result: 'Existing lead result' } } as AgentEvent);
      },
      server,
      workerLink,
    };
  }

  it('send_to_lead accepted false does not expose a running lead entry before accept', async () => {
    const leadSendGate = makeAsyncGate();
    const lead = makeSession('lead-1', {
      sendBeforeAcceptedGate: leadSendGate,
      sendResult: CANCELLED_SEND,
    });
    const { persisted, seedExistingLeadResult, server, statusUpdates } = makeWorkerBridgeLeadHarness(lead);

    await seedExistingLeadResult();

    const resultPromise = server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'SECRET_USER_MESSAGE',
    });
    await leadSendGate.started;

    const duringDispatch = parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }));
    expect(duringDispatch).toMatchObject({
      status: 'done',
      result: 'Existing lead result',
    });

    leadSendGate.release();
    const result = await resultPromise;
    const json = expectToolError(result);

    expect(json).toMatchObject({
      error: 'session send not dispatched',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });
    const afterDispatch = parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }));
    expect(afterDispatch).toMatchObject({
      status: 'done',
      result: 'Existing lead result',
    });
    expect(persisted).toEqual([]);
    expect(statusUpdates).toEqual([]);
  });

  it('hydrates lead provider route before cold send_to_lead creates the lead session', async () => {
    const order: string[] = [];
    const hydrateSessionRoute = vi.fn(async (sessionId: string, providerId: string | null) => {
      order.push(`hydrate:${sessionId}:${providerId}`);
    });
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
      },
    };
    const { createSessionCalls, maker, persisted, statusUpdates, wired } = makeProvider({
      workerLink,
    });
    const originalCreateSession = maker.createSession.bind(maker);
    maker.createSession = vi.fn(async (opts) => {
      order.push(`create:${opts.id}:${opts.providerId ?? null}`);
      return originalCreateSession(opts);
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: (session) => {
        wired.push(session.id);
      },
      hydrateSessionRoute,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true, lead_session_id: 'lead-1' });
    expect(hydrateSessionRoute).toHaveBeenCalledWith('lead-1', 'anthropic');
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toMatchObject({ id: 'lead-1', providerId: 'anthropic' });
    expect(wired).toEqual(['lead-1']);
    expect(order).toEqual(['hydrate:lead-1:anthropic', 'create:lead-1:anthropic']);
  });

  it('preserves a persisted null Pi providerId when cold rehydrating the lead', async () => {
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1', workflowId: 'workflow-1', workerSessionId: 'worker-session-1', leadSessionId: 'lead-1',
      leadSession: { sessionId: 'lead-1', agentKind: 'pi', workingDir: '/repo', model: 'gpt-5', providerId: null },
    };
    const { createSessionCalls, maker } = makeProvider({ workerLink });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker, logger: makeLogger() as never,
      persistUserMessage: async () => {}, wireSession: () => {},
      orcaTeamStore: { async getWorkerLink() { return workerLink; }, async updateWorkerStatus() {} },
    });
    const server = getServer(provider, {
      agentKind: 'pi', workingDir: '/repo',
      vendorOptions: { orcaRole: 'worker', orcaWorkerId: 'worker-1', orcaWorkerSessionId: 'worker-session-1' },
    });

    await server._registeredTools.send_to_lead.handler({ worker_id: 'worker-1', message: 'hello lead' });

    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toMatchObject({ id: 'lead-1', agentKind: 'pi', providerId: null });
  });

  it('carries lead remoteHostId into rehydration createSession (remote worker → inactive remote lead)', async () => {
    // codex-connector P1 回归:远端 worker send_to_lead 且 lead 不活跃 (关闭 /
    // app 重启) 时, 持久化快照必须把 remoteHostId 带进 createSession — 缺失
    // 会以远端 workingDir 在本机重建 (workdir check 失败 / 建出错误的本地
    // session), 而不是在 SSH 主机上重连 lead。
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/remote/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
        remoteHostId: 'host-remote-1',
      },
    };
    const { createSessionCalls, maker } = makeProvider({ workerLink });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async () => {},
      wireSession: () => {},
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus() {},
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/remote/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello remote lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true, lead_session_id: 'lead-1' });
    expect(createSessionCalls).toHaveLength(1);
    expect(createSessionCalls[0]).toMatchObject({ id: 'lead-1', remoteHostId: 'host-remote-1' });
    // R6 P2:未注入 ensureRemoteSessionStart (老宿主 / no-op) 时按 false 保守
    // 处理 — 记忆开关必须经宿主 preflight 归一化后才允许开。
    expect(createSessionCalls[0]).toMatchObject({ makerMemoryEnabled: false });
  });

  it('runs the injected remote preflight before rehydrating an inactive remote lead', async () => {
    // codex-connector R17 P1 回归:bridge 直调 core createSession 不经
    // maker-ipc, 远端 preflight (SSH 重连 / agent install / MCP 注入) 必须
    // 由 deps.ensureRemoteSessionStart 补齐并先于 createSession — 缺失时
    // app 重启后 worker 回报在 SSH 未重连 / 无协同 MCP 的状态重建 lead。
    const order: string[] = [];
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/remote/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
        remoteHostId: 'host-remote-1',
      },
    };
    const base = makeProvider({ workerLink });
    const maker = {
      ...base.maker,
      async createSession(o: CreateSessionOpts) {
        order.push('create');
        return base.maker.createSession(o);
      },
    };
    const ensureSpy = vi.fn(async () => {
      order.push('ensure');
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async () => {},
      wireSession: () => {},
      ensureRemoteSessionStart: ensureSpy,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus() {},
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/remote/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello remote lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true });
    expect(ensureSpy).toHaveBeenCalledWith({
      sessionId: 'lead-1',
      agentKind: 'claude-code',
      remoteHostId: 'host-remote-1',
      workingDir: '/remote/repo',
    });
    expect(order).toEqual(['ensure', 'create']);
    // preflight 返回 void (老宿主形态) → 记忆保守关闭。
    expect(base.createSessionCalls[0]).toMatchObject({ makerMemoryEnabled: false });
  });

  it('applies the preflight-normalized Maker Memory flag to remote rehydration (R6 P2)', async () => {
    // SSH remote 与 IPC create/send 同语义:全局开着时远端 rehydrate 不再
    // 硬编码 false;开关值 = 宿主 preflight 归一化 (backfill + stale-bridge
    // 钳制) 后回传的结果。
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/remote/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
        remoteHostId: 'host-remote-1',
      },
    };
    const { createSessionCalls, maker } = makeProvider({ workerLink });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async () => {},
      wireSession: () => {},
      ensureRemoteSessionStart: async () => ({ makerMemoryEnabled: true }),
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus() {},
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/remote/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello remote lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true });
    expect(createSessionCalls[0]).toMatchObject({
      id: 'lead-1',
      remoteHostId: 'host-remote-1',
      makerMemoryEnabled: true,
    });
  });

  it('does not run the remote preflight when rehydrating a local lead', async () => {
    // 本地 lead (无 remoteHostId) 不触发 preflight — 回调只对远端有意义。
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
      },
    };
    const { maker } = makeProvider({ workerLink });
    const ensureSpy = vi.fn(async () => {});
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async () => {},
      wireSession: () => {},
      ensureRemoteSessionStart: ensureSpy,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus() {},
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello local lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true });
    expect(ensureSpy).not.toHaveBeenCalled();
  });

  it('hydrates lead provider route even when send_to_lead reuses an active lead', async () => {
    const order: string[] = [];
    const lead = makeSession('lead-1', {
      sendAfterAccepted: () => {
        order.push('send:lead-1');
      },
    });
    const hydrateSessionRoute = vi.fn(async (sessionId: string, providerId: string | null) => {
      order.push(`hydrate:${sessionId}:${providerId}`);
    });
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
        providerId: 'anthropic',
      },
    };
    const { createSessionCalls, maker, persisted, statusUpdates } = makeProvider({
      activeSessions: { 'lead-1': lead },
      workerLink,
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      hydrateSessionRoute,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'hello active lead',
    });

    expect(parseToolJson(result)).toMatchObject({ ok: true, lead_session_id: 'lead-1' });
    expect(hydrateSessionRoute).toHaveBeenCalledWith('lead-1', 'anthropic');
    expect(createSessionCalls).toEqual([]);
    expect(lead.sent).toHaveLength(1);
    expect(order).toEqual(['hydrate:lead-1:anthropic', 'send:lead-1']);
  });

  it('send_to_lead accepted false does not expose a running lead entry before send resolves', async () => {
    const leadSendGate = makeAsyncGate();
    const lead = makeSession('lead-1', {
      sendResolveGate: leadSendGate,
      sendResult: CANCELLED_SEND,
    });
    const { persisted, seedExistingLeadResult, server, statusUpdates } = makeWorkerBridgeLeadHarness(lead);

    await seedExistingLeadResult();

    const resultPromise = server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'SECRET_USER_MESSAGE',
    });
    await leadSendGate.started;

    const duringDispatch = parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }));
    expect(duringDispatch).toMatchObject({
      status: 'running',
      result: '',
    });

    leadSendGate.release();
    const result = await resultPromise;
    const json = expectToolError(result);

    expect(json).toMatchObject({
      error: 'session send not dispatched',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });
    const afterDispatch = parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }));
    expect(afterDispatch).toMatchObject({
      status: 'done',
      result: 'Existing lead result',
    });
    expect(persisted).toEqual([]);
    expect(statusUpdates).toEqual([]);
  });

  it('send_to_lead preserves partial lead output captured before send resolves', async () => {
    const lead = makeSession('lead-1');
    lead.sendAfterAccepted = () => {
      lead.emit({
        type: 'text',
        data: { text: 'Partial new answer', isFinal: false },
      } as AgentEvent);
    };
    const { persisted, seedExistingLeadResult, server, statusUpdates } = makeWorkerBridgeLeadHarness(lead);

    await seedExistingLeadResult();

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'SECRET_USER_MESSAGE',
    });
    const json = parseToolJson(result);
    expect(json).toMatchObject({
      ok: true,
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });

    const leadState = parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }));
    expect(leadState).toMatchObject({
      status: 'running',
      result: 'Partial new answer',
    });
    expect(persisted).toHaveLength(1);
    expect(statusUpdates).toEqual([{ workerId: 'worker-1', status: 'done' }]);
  });

  it('read_lead and lead_status stay running across claim-bearing continuation boundaries', async () => {
    const lead = makeSession('lead-1');
    const { server } = makeWorkerBridgeLeadHarness(lead);

    await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'continue the lead turn',
    });
    lead.emit({
      type: 'text',
      data: { text: 'First segment', isFinal: false },
    } as AgentEvent);
    lead.emit({
      type: 'status',
      data: { status: 'Done', isRunning: false },
      turnContinuationId: 1,
    } as AgentEvent);
    lead.emit({
      type: 'done',
      data: { result: 'First segment result' },
      turnContinuationId: 1,
    } as AgentEvent);

    expect(parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }))).toMatchObject({
      status: 'running',
      result: 'First segment result',
    });
    expect(parseToolJson(await server._registeredTools.lead_status.handler({
      worker_id: 'worker-1',
    }))).toMatchObject({ status: 'running' });

    lead.emit({
      type: 'done',
      data: { result: 'Final lead result' },
    } as AgentEvent);

    expect(parseToolJson(await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    }))).toMatchObject({
      status: 'done',
      result: 'Final lead result',
    });
    expect(parseToolJson(await server._registeredTools.lead_status.handler({
      worker_id: 'worker-1',
    }))).toMatchObject({ status: 'done' });
  });

  it('send_to_lead accepted false does not persist success or mark done', async () => {
    const lead = makeSession('lead-1', { sendResult: CANCELLED_SEND });
    const logger = makeLogger();
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const { maker, persisted, statusUpdates } = makeProvider({
      activeSessions: { 'lead-1': lead },
      logger,
      workerLink,
    });
    const workerProvider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: logger as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const workerServer = getServer(workerProvider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await workerServer._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'SECRET_USER_MESSAGE',
    });
    const json = expectToolError(result);

    expect(json).toMatchObject({
      error: 'session send not dispatched',
      dispatched: false,
      reason: 'cancelled-before-dispatch',
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });
    expect(persisted).toEqual([]);
    expect(statusUpdates).toEqual([]);
    expectStructuredSendWarning(logger.entries, {
      source: 'mcp-tool',
      entrypoint: 'orca_worker_bridge.send_to_lead',
      sessionId: 'lead-1',
      action: 'dispatch-to-lead',
      reason: 'cancelled-before-dispatch',
    });
    expectNoSensitiveLogContent(logger.entries);
  });

  it('send_to_lead thrown send error does not persist success or mark done', async () => {
    const lead = makeSession('lead-1', { sendError: makeSensitiveError() });
    const logger = makeLogger();
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const { maker, persisted, statusUpdates } = makeProvider({
      activeSessions: { 'lead-1': lead },
      logger,
      workerLink,
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: logger as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'SECRET_USER_MESSAGE',
    });
    const json = expectToolError(result);

    expect(json).toMatchObject({
      error: 'session send failed',
      dispatched: false,
      worker_id: 'worker-1',
      lead_session_id: 'lead-1',
    });
    expect(persisted).toEqual([]);
    expect(statusUpdates).toEqual([]);
    expectStructuredSendWarning(logger.entries, {
      source: 'mcp-tool',
      entrypoint: 'orca_worker_bridge.send_to_lead',
      sessionId: 'lead-1',
      action: 'dispatch-to-lead',
      reason: 'send-rejected',
    });
    expectNoSensitiveLogContent(logger.entries);
  });

  it('send_to_lead resolves Claude worker identity from vendorOptions', async () => {
    const lead = makeSession('lead-1');
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const { maker, persisted, statusUpdates, wired } = makeProvider({
      activeSessions: { 'lead-1': lead },
      workerLink,
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: (session) => {
        wired.push(session.id);
      },
      orcaTeamStore: {
        async getWorkerLink() {
          return workerLink;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'claude-code',
      workingDir: '/repo',
      vendorOptions: {
        orcaRole: 'worker',
        orcaWorkerId: 'worker-1',
        orcaWorkerSessionId: 'worker-session-1',
      },
    });

    const result = await server._registeredTools.send_to_lead.handler({
      message: 'Done',
    });

    expect(persisted).toEqual([{
      sessionId: 'lead-1',
      content: '{"orcaSource":"worker","content":"Done"}',
    }]);
    expect(lead.sent).toEqual([{ type: 'user', content: '[From Orca Worker]\nDone' }]);
    expect(statusUpdates).toEqual([{ workerId: 'worker-1', status: 'done' }]);
    expect(wired).toEqual([]);
    expect(JSON.stringify(result)).toContain('\\"ok\\":true');
  });

  it('Codex worker path rejects worker_id fallback without session ownership', async () => {
    const lead = makeSession('lead-1');
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const { maker, persisted, statusUpdates } = makeProvider({
      activeSessions: { 'lead-1': lead },
      workerLink,
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink(input) {
          return input.workerId === 'worker-1' ? workerLink : null;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'codex',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const result = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'Codex done',
    });

    const json = expectToolError(result);
    expect(json).toMatchObject({
      error: 'not an orca worker session',
      worker_id: 'worker-1',
    });
    expect(persisted).toEqual([]);
    expect(lead.sent).toEqual([]);
    expect(statusUpdates).toEqual([]);
  });

  it('Codex worker path rejects a different runtime session even with a valid worker_id', async () => {
    const lead = makeSession('lead-1');
    const workerLink: OrcaWorkerLink = {
      workerId: 'worker-1',
      workflowId: 'workflow-1',
      workerSessionId: 'worker-session-1',
      leadSessionId: 'lead-1',
      leadSession: {
        sessionId: 'lead-1',
        agentKind: 'claude-code',
        workingDir: '/repo',
        model: 'claude-opus-4-7',
      },
    };
    const { maker, persisted, statusUpdates } = makeProvider({
      activeSessions: { 'lead-1': lead },
      workerLink,
    });
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async (sessionId, message) => {
        persisted.push({ sessionId, content: message.content });
      },
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink(input) {
          return input.workerId === 'worker-1' ? workerLink : null;
        },
        async updateWorkerStatus(workerId, status) {
          statusUpdates.push({ workerId, status });
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'codex',
      workingDir: '/repo',
      vendorOptions: {},
      getSessionContext: () => ({
        agentKind: 'codex',
        workingDir: '/repo',
        sessionId: 'other-session',
        vendorOptions: {
          orcaRole: 'worker',
          orcaWorkerId: 'worker-1',
          orcaWorkerSessionId: 'other-session',
        },
      }),
    });

    const sendResult = await server._registeredTools.send_to_lead.handler({
      worker_id: 'worker-1',
      message: 'Codex done',
    });
    const readResult = await server._registeredTools.read_lead.handler({
      worker_id: 'worker-1',
    });
    const statusResult = await server._registeredTools.lead_status.handler({
      worker_id: 'worker-1',
    });

    for (const result of [sendResult, readResult, statusResult]) {
      expect(expectToolError(result)).toMatchObject({
        error: 'worker session mismatch',
        worker_id: 'worker-1',
        worker_session_id: 'other-session',
        resolved_worker_session_id: 'worker-session-1',
      });
    }
    expect(persisted).toEqual([]);
    expect(lead.sent).toEqual([]);
    expect(statusUpdates).toEqual([]);
  });

  it('worker tools reject non-worker calls without identity', async () => {
    const { maker } = makeProvider();
    const provider = createOrcaWorkerBridgeMcpProvider({
      getMaker: () => maker as unknown as Maker,
      logger: makeLogger() as never,
      persistUserMessage: async () => undefined,
      wireSession: () => undefined,
      orcaTeamStore: {
        async getWorkerLink() {
          return null;
        },
        async updateWorkerStatus() {
          return undefined;
        },
      },
    });
    const server = getServer(provider, {
      agentKind: 'codex',
      workingDir: '/repo',
      vendorOptions: {},
    });

    const result = await server._registeredTools.lead_status.handler({});

    expect(JSON.stringify(result)).toContain('not an orca worker session');
  });
});
