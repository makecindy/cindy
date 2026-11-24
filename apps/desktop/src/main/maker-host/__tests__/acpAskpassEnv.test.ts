import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@cindy/maker-core';
import { buildAcpAgent } from '../acp-host.js';
import type { NodeWorkerProcess } from '../../cindy-brain/nodeRuntimeBroker.js';

const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

function createStubAcpProcess(): NodeWorkerProcess {
  const proc = new EventEmitter() as unknown as EventEmitter & NodeWorkerProcess & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: { write: (chunk: string) => boolean };
  };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.stdin = {
    write: (chunk: string) => {
      const text = Buffer.from(chunk, 'base64').toString('utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; method?: string };
        if (msg.method === 'initialize') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: 1,
              agentCapabilities: { mcpCapabilities: { http: true } },
            },
          })}\n`);
        } else if (msg.method === 'session/new') {
          stdout.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: { sessionId: 'native-1', configOptions: [] },
          })}\n`);
        }
      }
      return true;
    },
  };
  proc.kill = () => {
    proc.emit('exit', 0);
    return true;
  };
  return proc;
}

describe('ACP host native askpass env passthrough', () => {
  it('passes taskShellEnv askpass variables for local ACP sessions', async () => {
    const spawnCalls: Array<{ key: string; options?: Record<string, unknown> }> = [];
    const taskShellEnv = vi.fn(({ sessionId }: { sessionId: string }) => ({
      SUDO_ASKPASS: '/tmp/cindy-askpass',
      SSH_ASKPASS: '/tmp/cindy-askpass',
      GIT_ASKPASS: '/tmp/cindy-askpass',
      CINDY_INPUT_HANDOFF_SESSION: sessionId,
    }));
    const agent = buildAcpAgent({
      logger: silentLogger,
      appVersion: '0.1.145',
      taskShellEnv,
      spawnHarness: async (key, options) => {
        spawnCalls.push({ key, options: options as Record<string, unknown> | undefined });
        return createStubAcpProcess();
      },
    });
    const handle = await agent.startSession({
      sessionId: 'local-sess-1',
      workingDir: '/tmp/repo',
      model: 'default',
      providerId: 'acp-plugin:agy-acp:agy',
    });
    expect(taskShellEnv).toHaveBeenCalledWith({ sessionId: 'local-sess-1' });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options).toMatchObject({
      extraEnv: {
        SUDO_ASKPASS: '/tmp/cindy-askpass',
        SSH_ASKPASS: '/tmp/cindy-askpass',
        GIT_ASKPASS: '/tmp/cindy-askpass',
        CINDY_INPUT_HANDOFF_SESSION: 'local-sess-1',
      },
    });
    await handle.close();
  });

  it('never passes local askpass env for remote-hosted or guest ACP sessions', async () => {
    const spawnCalls: Array<{ key: string; options?: Record<string, unknown> }> = [];
    const taskShellEnv = vi.fn(() => ({
      SUDO_ASKPASS: '/tmp/cindy-askpass',
      CINDY_INPUT_HANDOFF_SESSION: 'should-not-leak',
    }));
    const agent = buildAcpAgent({
      logger: silentLogger,
      appVersion: '0.1.145',
      taskShellEnv,
      spawnHarness: async (key, options) => {
        spawnCalls.push({ key, options: options as Record<string, unknown> | undefined });
        return createStubAcpProcess();
      },
    });
    const hosted = {
      workingDir: '/shadow/p',
      extraDirs: [],
      writableDirs: [],
      platform: 'linux' as const,
      shell: 'bash',
      isGitRepo: true,
      tunnelUrl: 'http://127.0.0.1:4711/',
      tunnelToken: 'tok',
      mcpServers: ['cindy_exec'],
    };
    const handle = await agent.startSession({
      sessionId: 'remote-sess-1',
      workingDir: '/shadow/p',
      model: 'default',
      providerId: 'acp-plugin:agy-acp:agy',
      deviceHosted: hosted,
    });
    expect(taskShellEnv).not.toHaveBeenCalled();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.options).not.toHaveProperty('extraEnv');
    await handle.close();
  });
});
