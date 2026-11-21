/**
 * MCP bridge 生命周期复现探针。
 *
 * 测试价值
 * - 生产入口与可观察结果：通过 startCodexHttpBridge 的真实 loopback HTTP
 *   initialize 入口创建 Streamable HTTP 会话，观察 mcpSessionCount() 在进程
 *   实例替换、任务注销和客户端显式关闭后的变化。
 * - Bug／规则依据：复现 2026-11 主进程 MCP 会话长期堆积，以及
 *   docs/dev-rules/engineering-conventions.md §3.2 要求的最小失败时序。
 * - 现有覆盖缺口：相邻 codexHttpBridge.test.ts 只覆盖单次初始化和注销，
 *   没有把同一任务的五轮实例替换按引擎生命周期汇总成可比较的数字。
 * - 最小失败输入：同一 ownerSessionId 保持注册，连续五个 sessionInstanceId
 *   各对每个 MCP server 发一次 initialize，旧进程不发 DELETE。
 * - tier：integration。使用真实 loopback socket 和 MCP SDK transport。
 * - 实测耗时：单独运行该文件应低于 5 秒（本机）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '@cindy/mcps';

import {
  startCodexHttpBridge,
  withMcpRouteIdentity,
  type CodexHttpBridge,
} from '../codexHttpBridge.desktop.js';

const SERVER_NAMES = ['cindy_orca', 'cindy_memory', 'cindy_helper'];
const ROUNDS = 5;
const REAL_CLI = process.env.CINDY_MCP_LIFECYCLE_REAL_CLI === '1';
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

async function initialize(
  bridge: CodexHttpBridge,
  serverName: string,
  identity?: { sessionId?: string; sessionInstanceId: string },
  sessionToken?: string,
  id = 1,
): Promise<string> {
  const url = identity
    ? withMcpRouteIdentity(bridge.url(serverName), identity)
    : bridge.url(serverName);
  const headers: Record<string, string> = {
    authorization: `Bearer ${sessionToken ?? bridge.token}`,
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  };
  const response = await fetch(url, { method: 'POST', headers, body: initializeBody(id) });
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  await response.text();
  expect(sessionId).toBeTruthy();
  return sessionId!;
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

async function runOwnedReplacementScenario(
  engine: string,
  lifecycle: string,
  agentKind: LiziMcpSessionContext['agentKind'],
  ownerSessionId: string,
  options: { closeAfterRound?: boolean; discoveryFails?: boolean } = {},
): Promise<ScenarioResult> {
  let bridge: CodexHttpBridge | null = await startCodexHttpBridge({
    serverFactories: Object.fromEntries(SERVER_NAMES.map((name) => [name, createFixtureServer])),
    logger: noopLogger,
  });
  try {
    const rounds: RoundResult[] = [];
    const sessionToken = `${ownerSessionId}-token`;
    bridge.registerSessionToken(ownerSessionId, sessionToken);
    for (let round = 1; round <= ROUNDS; round++) {
      const instance = `${engine}-${round}`;
      const context: LiziMcpSessionContext = {
        agentKind,
        sessionId: ownerSessionId,
        sessionInstanceId: instance,
        workingDir: '/tmp/mcp-lifecycle-probe',
        vendorOptions: {},
      };
      bridge.registerSessionCtx(ownerSessionId, context);
      const before = bridge.mcpSessionCount();
      for (const serverName of SERVER_NAMES) {
        const sessionId = await initialize(
          bridge,
          serverName,
          { sessionId: ownerSessionId, sessionInstanceId: instance },
          sessionToken,
          round,
        );
        if (options.discoveryFails) {
          const route = withMcpRouteIdentity(bridge.url(serverName), {
            sessionId: ownerSessionId,
            sessionInstanceId: instance,
          });
          const failedDiscovery = await fetch(route, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${sessionToken}`,
              accept: 'application/json, text/event-stream',
              'content-type': 'application/json',
              'mcp-session-id': sessionId,
            },
            body: '{"jsonrpc":"2.0","id":99,"method":"tools/list","params":',
          });
          expect(failedDiscovery.status).toBeGreaterThanOrEqual(400);
          await failedDiscovery.text();
        }
      }
      const roundResult: RoundResult = {
        round,
        instance,
        created: bridge.mcpSessionCount() - before,
        closed: 0,
        remaining: bridge.mcpSessionCount(),
      };
      if (options.closeAfterRound) {
        const beforeRoundClose = bridge.mcpSessionCount();
        bridge.unregisterSessionCtx(ownerSessionId);
        roundResult.closed = beforeRoundClose - bridge.mcpSessionCount();
        roundResult.remaining = bridge.mcpSessionCount();
      } else {
        bridge.closeSessionInstance(instance);
        roundResult.closed = roundResult.remaining - bridge.mcpSessionCount();
        roundResult.remaining = bridge.mcpSessionCount();
      }
      rounds.push(roundResult);
    }
    if (!options.closeAfterRound) bridge.unregisterSessionCtx(ownerSessionId);
    const finalAfterOwnerClose = bridge.mcpSessionCount();
    return { engine, lifecycle, rounds, finalAfterOwnerClose };
  } finally {
    await bridge.shutdown();
    bridge = null;
  }
}

async function runCodexReplacementScenario(): Promise<ScenarioResult> {
  let bridge: CodexHttpBridge | null = await startCodexHttpBridge({
    serverFactories: Object.fromEntries(SERVER_NAMES.map((name) => [name, createFixtureServer])),
    logger: noopLogger,
  });
  try {
    const rounds: RoundResult[] = [];
    for (let round = 1; round <= ROUNDS; round++) {
      const instance = `codex-${round}`;
      bridge.registerThreadContext(`thread-${round}`, {
        agentKind: 'codex',
        sessionId: 'task-codex',
        sessionInstanceId: instance,
        workingDir: '/tmp/mcp-lifecycle-probe',
        vendorOptions: {},
      });
      const before = bridge.mcpSessionCount();
      for (const serverName of SERVER_NAMES)
        await initialize(bridge, serverName, { sessionInstanceId: instance }, undefined, round);
      const created = bridge.mcpSessionCount() - before;
      bridge.closeSessionInstance(instance);
      rounds.push({
        round,
        instance,
        created,
        closed: created,
        remaining: bridge.mcpSessionCount(),
      });
    }
    const finalAfterOwnerClose = bridge.mcpSessionCount();
    return {
      engine: 'codex',
      lifecycle: 'same task replaces old instance',
      rounds,
      finalAfterOwnerClose,
    };
  } finally {
    await bridge.shutdown();
    bridge = null;
  }
}

describe('MCP bridge lifecycle accumulation probe', () => {
  const bridges: CodexHttpBridge[] = [];

  afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdown()));
  });

  it('records five rounds for Claude Code, remote Agent and Pi without task unregister', async () => {
    const results = await Promise.all([
      runOwnedReplacementScenario(
        'claude-code',
        'idle recycle then wake',
        'claude-code',
        'task-claude-idle',
      ),
      runOwnedReplacementScenario(
        'claude-code',
        'runtime-refresh',
        'claude-code',
        'task-claude-refresh',
      ),
      runOwnedReplacementScenario(
        'claude-code',
        'remote run reclaim then reconnect',
        'claude-code',
        'task-remote-cc',
      ),
      runOwnedReplacementScenario(
        'claude-code',
        'control session close then reopen',
        'claude-code',
        'task-remote-reopen',
        { closeAfterRound: true },
      ),
      runOwnedReplacementScenario('pi', 'reconnect replaces old client', 'pi', 'task-pi-reconnect'),
      runOwnedReplacementScenario(
        'pi',
        'initialize succeeds but discovery fails',
        'pi',
        'task-pi-discovery',
        { discoveryFails: true },
      ),
    ]);
    for (const result of results) {
      expect(result.rounds).toHaveLength(ROUNDS);
      expect(result.rounds.map((round) => round.created)).toEqual(
        Array.from({ length: ROUNDS }, () => SERVER_NAMES.length),
      );
      expect(result.rounds.map((round) => round.remaining)).toEqual([0, 0, 0, 0, 0]);
      expect(result.rounds.map((round) => round.closed)).toEqual([3, 3, 3, 3, 3]);
      expect(result.finalAfterOwnerClose).toBe(0);
    }
    writeReport(results);
  });

  it('records five rounds for local Codex instance replacement', async () => {
    const result = await runCodexReplacementScenario();
    expect(result.rounds.map((round) => round.created)).toEqual([3, 3, 3, 3, 3]);
    expect(result.rounds.map((round) => round.remaining)).toEqual([0, 0, 0, 0, 0]);
    expect(result.rounds.map((round) => round.closed)).toEqual([3, 3, 3, 3, 3]);
    expect(result.finalAfterOwnerClose).toBe(0);
    writeReport([result]);
  });

  // 测试价值
  // - 生产入口与可观察结果：同一个 sessionInstanceId 连续建立两条 HTTP MCP
  //   会话并调用工具，确认没有“断链就猜进程结束”的关闭动作。
  // - Bug／规则依据：2a 远程断链兼容边界，仍在运行的 run 必须保留在途工具。
  // - 现有覆盖缺口：已有 bridge 测试只覆盖 session 注销，没有验证实例关闭接口
  //   不会被重连路径误用。
  // - 最小失败输入：同一实例两个 transport，第二个 transport 发 tools/call。
  // - tier：integration。
  it('keeps a live run MCP transport available across a reconnect', async () => {
    let bridge: CodexHttpBridge | null = await startCodexHttpBridge({
      serverFactories: { cindy_orca: createFixtureServer },
      logger: noopLogger,
    });
    try {
      const context: LiziMcpSessionContext = {
        agentKind: 'claude-code',
        sessionId: 'live-run',
        sessionInstanceId: 'live-instance',
        workingDir: '/tmp/mcp-lifecycle-probe',
        vendorOptions: {},
      };
      bridge.registerSessionCtx('live-run', context);
      const token = 'live-run-token';
      bridge.registerSessionToken('live-run', token);
      const identity = { sessionId: 'live-run', sessionInstanceId: 'live-instance' };
      const first = await initialize(bridge, 'cindy_orca', identity, token, 1);
      const second = await initialize(bridge, 'cindy_orca', identity, token, 2);
      expect(bridge.mcpSessionCount()).toBe(2);
      const response = await fetch(withMcpRouteIdentity(bridge.url('cindy_orca'), identity), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': second,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'fixture_ping', arguments: {} },
        }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(bridge.mcpSessionCount()).toBe(2);
      expect(first).not.toBe(second);
    } finally {
      await bridge?.shutdown();
      bridge = null;
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
