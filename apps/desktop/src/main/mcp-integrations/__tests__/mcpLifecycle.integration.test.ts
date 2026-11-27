/**
 * MCP 生命周期计数探针。远程 run 的接线由 roundtrip.test.ts 覆盖。
 * Pi 进程退出走真实 PiAgent 和本机 HTTP 桥。Pi 进程内的恢复和发现失败
 * 由 maker-core 的 Pi MCP 测试驱动。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PiAgent, type Logger } from '@cindy/maker-core';
import { fileURLToPath } from 'node:url';

import {
  startCodexHttpBridge,
  withMcpRouteIdentity,
  type CodexHttpBridge,
} from '../codexHttpBridge.desktop.js';

const SERVER_NAMES = ['cindy_orca', 'cindy_memory', 'cindy_helper'];
const ROUNDS = 5;
const REAL_CLI = process.env.CINDY_MCP_LIFECYCLE_REAL_CLI === '1';
const PI_BINARY = path.join(
  fileURLToPath(new URL('../../../../../../', import.meta.url)), 'apps', 'pi-bin',
  `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi',
);
const REPORT_PATH =
  process.env.CINDY_MCP_LIFECYCLE_REPORT_PATH ??
  path.join(os.tmpdir(), `cindy-mcp-lifecycle-${process.pid}.json`);

const noopLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return noopLogger;
  },
};

function createFixtureServer(): McpServer {
  const server = new McpServer({ name: 'cindy-lifecycle-fixture', version: '1.0.0' });
  server.tool('fixture_ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

function initializeBody(id: number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-lifecycle-probe', version: '1' },
    },
  });
}

async function initializeSharedConnection(bridge: CodexHttpBridge): Promise<void> {
  const url = bridge.url('cindy_orca');
  const headers: Record<string, string> = {
    authorization: `Bearer ${bridge.token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const response = await fetch(url, { method: 'POST', headers, body: initializeBody(1) });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  await response.text();
  expect(sessionId).toBeTruthy();
}

interface RoundResult {
  round: number;
  instance: string;
  created: number;
  closed: number;
  remaining: number;
}

interface ScenarioResult {
  engine: string;
  lifecycle: string;
  rounds: RoundResult[];
  finalAfterOwnerClose: number;
}

describe('MCP bridge lifecycle accumulation probe', () => {
  // 2026-11 堆积回归，真实 PiAgent.startSession/close 和正式扩展初始化真实 HTTP 桥。
  // 最小输入是带 instance 的 Pi 连接和同任务的一条共享连接。保留桥注册以独立验证
  // 确认退出的回调，避免 task dispose 掩盖漏接。Integration tier，原生二进制和 loopback。
  it.skipIf(!fs.existsSync(PI_BINARY))('returns to baseline after five Pi process exits for the same task', { timeout: 30_000 }, async () => {
    const bridge = await startCodexHttpBridge({
      serverFactories: Object.fromEntries(SERVER_NAMES.map(name => [name, createFixtureServer])),
      logger: noopLogger,
    });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-mcp-exit-'));
    const sessionId = 'task-pi';
    const token = 'pi-fixture-token';
    const agent = new PiAgent({
      binaryPath: PI_BINARY,
      logger: noopLogger,
      runtimeConfig: { endpoint: 'http://127.0.0.1:9' },
      auth: {
        getState: async () => ({ authenticated: true, authSource: 'api-key' }),
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'fixture-only' }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
      },
      capabilityAdditions: {
        availableModels: [{ id: 'pi-test', displayName: 'Pi Test', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiGatewayModelApi: () => 'anthropic-messages',
      resolvePiAgentHome: () => path.join(root, 'home'),
      preparePiExtraSpawnConfig: async (_providers, ctx) => {
        const sessionInstanceId = ctx?.sessionInstanceId;
        if (!sessionInstanceId) throw new Error('Pi did not supply its session instance');
        bridge.registerSessionCtx(sessionId, { agentKind: 'pi', sessionId, sessionInstanceId, workingDir: root });
        return {
          mcpBridge: { token, servers: SERVER_NAMES.map(name => ({
            name, url: withMcpRouteIdentity(bridge.url(name), { sessionId, sessionInstanceId }),
          })) },
          closeSessionInstance: () => bridge.closeSessionInstance(sessionInstanceId),
          // Keep task registration alive across all five processes.
        };
      },
    });
    try {
      await initializeSharedConnection(bridge);
      const baseline = bridge.mcpSessionCount();
      expect(baseline).toBe(1);
      const rounds: RoundResult[] = [];
      bridge.registerSessionToken(sessionId, token);
      for (let round = 1; round <= ROUNDS; round++) {
        const instance = `pi-${round}`;
        const handle = await agent.startSession({ sessionId, sessionInstanceId: instance, workingDir: root, model: 'pi-test' });
        const activeCount = bridge.mcpSessionCount();
        await handle.close({ reason: 'navigation' });
        expect(activeCount).toBe(baseline + SERVER_NAMES.length);
        expect(bridge.mcpSessionCount()).toBe(baseline);
        rounds.push({ round, instance, created: activeCount - baseline,
          closed: activeCount - bridge.mcpSessionCount(), remaining: bridge.mcpSessionCount() });
      }
      bridge.unregisterSessionCtx(sessionId);
      writeReport([{ engine: 'pi', lifecycle: 'PiAgent process exit, same task',
        rounds, finalAfterOwnerClose: bridge.mcpSessionCount() }]);
    } finally {
      await bridge.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!REAL_CLI)(
    'real Claude Code sends DELETE on normal exit and SIGTERM',
    async () => {
      // The opt-in CLI probe is intentionally kept out of the normal unit tier.
      // The harness is run with an isolated CLAUDE_CONFIG_DIR and a loopback MCP
      // config. The report path records whether the bridge count returned to zero.
      const { runClaudeCliProbe } = await import('./mcpLifecycle.realCliProbe.js');
      const result = await runClaudeCliProbe();
      writeReport([result]);
    },
    120_000,
  );
});

function writeReport(results: ScenarioResult[]): void {
  const existing: ScenarioResult[] = fs.existsSync(REPORT_PATH)
    ? (JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')) as ScenarioResult[])
    : [];
  fs.writeFileSync(REPORT_PATH, JSON.stringify([...existing, ...results], null, 2));
}
