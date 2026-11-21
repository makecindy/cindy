import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '@cindy/maker-core';
import type { LiziMcpSessionContext } from '@cindy/mcps';

import {
  startCodexHttpBridge,
  withMcpRouteIdentity,
  type CodexHttpBridge,
} from '../codexHttpBridge.desktop.js';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CLAUDE = path.join(
  REPO,
  'apps',
  'claude-code-bin',
  ARCH,
  process.platform === 'win32' ? 'claude.exe' : 'claude',
);

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

function fixtureServer(): McpServer {
  const server = new McpServer({ name: 'mcp-lifecycle-cli', version: '1.0.0' });
  server.tool('fixture_ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

interface CliProbeResult {
  engine: string;
  lifecycle: string;
  rounds: Array<{
    round: number;
    instance: string;
    created: number;
    closed: number;
    remaining: number;
  }>;
  finalAfterOwnerClose: number;
}

export async function runClaudeCliProbe(): Promise<CliProbeResult> {
  if (!fs.existsSync(CLAUDE)) throw new Error(`Claude Code binary missing: ${CLAUDE}`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-mcp-cli-')));
  const home = path.join(root, 'home');
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  let bridge: CodexHttpBridge | null = await startCodexHttpBridge({
    serverFactories: { fixture: fixtureServer },
    logger: noopLogger,
  });
  try {
    const config = path.join(root, 'mcp.json');
    const rounds = [];
    for (let i = 1; i <= 5; i++) {
      rounds.push(
        await runOne({
          bridge,
          config,
          home,
          configDir,
          signal: i % 2 === 0 ? 'SIGTERM' : undefined,
          instance: `claude-cli-${i}`,
          round: i,
        }),
      );
    }
    return {
      engine: 'claude-code',
      lifecycle: 'real CLI five restarts, normal exit and SIGTERM',
      rounds,
      finalAfterOwnerClose: bridge.mcpSessionCount(),
    };
  } finally {
    await bridge.shutdown();
    bridge = null;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function runOne(input: {
  bridge: CodexHttpBridge;
  config: string;
  home: string;
  configDir: string;
  signal?: NodeJS.Signals;
  instance: string;
  round: number;
}): Promise<{
  round: number;
  instance: string;
  created: number;
  closed: number;
  remaining: number;
}> {
  const before = input.bridge.mcpSessionCount();
  const context: LiziMcpSessionContext = {
    agentKind: 'claude-code',
    sessionId: 'real-cli-task',
    sessionInstanceId: input.instance,
    workingDir: input.home,
    vendorOptions: {},
  };
  const threadId = `real-cli-thread-${input.round}`;
  input.bridge.registerThreadContext(threadId, context);
  fs.writeFileSync(
    input.config,
    JSON.stringify({
      mcpServers: {
        fixture: {
          type: 'http',
          url: withMcpRouteIdentity(input.bridge.url('fixture'), {
            sessionInstanceId: input.instance,
          }),
          headers: { Authorization: `Bearer ${input.bridge.token}` },
        },
      },
    }),
  );
  const child = spawn(
    CLAUDE,
    [
      '--print',
      '--strict-mcp-config',
      '--mcp-config',
      input.config,
      '--dangerously-skip-permissions',
      'Reply with one word.',
    ],
    {
      cwd: input.home,
      env: {
        ...process.env,
        HOME: input.home,
        USERPROFILE: input.home,
        CLAUDE_CONFIG_DIR: input.configDir,
        ANTHROPIC_API_KEY: 'cindy-mcp-lifecycle-probe',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  );
  let maxSeen = before;
  for (let i = 0; i < 150; i++) {
    maxSeen = Math.max(maxSeen, input.bridge.mcpSessionCount());
    if (maxSeen > before) break;
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (input.signal) child.kill(input.signal);
  await new Promise<void>((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    // real-wait: bound the opt-in real CLI probe when a provider process ignores the first signal.
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000).unref();
  });
  const maxBeforeClose = Math.max(maxSeen, input.bridge.mcpSessionCount());
  input.bridge.closeSessionInstance(input.instance);
  const remaining = input.bridge.mcpSessionCount();
  input.bridge.unregisterThreadContext(threadId, input.instance);
  maxSeen = Math.max(maxSeen, remaining);
  return {
    round: input.round,
    instance: input.signal ? 'sigterm' : 'normal',
    created: maxSeen - before,
    closed: maxBeforeClose - remaining,
    remaining,
  };
}
