/**
 * 真 Pi 二进制 + 假网关：受邀者(另一个账号)的托管会话里，系统提示只含会话目录内的说明文件
 * (受邀者的项目与个人说明)，不含会话目录之上的本机用户说明与本机全局说明；托管时 bridge 会
 * 按当前选项渲染整段系统提示，这里同时验证 cindy-guest-context 排在 bridge 之前。同账号托管
 * 会话仍按 Pi 原生规则向上读取。本机用户家目录里的 Agent Skills 也只对同账号会话可见。
 * 二进制缺失时整组 skip。
 */
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PiAgent } from '../index.js';
import type { AgentDeps, AgentSessionHandle, DeviceHostedSession } from '../../base-agent.js';
import type { AgentEvent } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const PI_BINARY = process.env.CINDY_TEST_PI_BINARY || path.join(
  REPO_ROOT, 'apps', 'pi-bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'pi.exe' : 'pi',
);

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function anthropicStreamBody(text: string): string {
  const events: Array<{ event: string; data: unknown }> = [
    { event: 'message_start', data: { type: 'message_start', message: {
      id: 'msg_guest_1', type: 'message', role: 'assistant', model: 'pi-test-model', content: [],
      stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 },
    } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ];
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

describe.skipIf(!existsSync(PI_BINARY))('Pi device-hosted guest context files (real pi binary)', () => {
  let server: Server;
  let endpoint = '';
  const bodies: Array<{ url: string; body: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        bodies.push({ url: req.url ?? '', body });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(anthropicStreamBody('pong'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (typeof address === 'object' && address) endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.each([true, false])('builds the system prompt from the session directory only for guests (guest: %s)', { timeout: 60_000 }, async (guest) => {
    const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'pi-guest-int-')));
    const agentHome = path.join(root, 'agent-home');
    const hostUser = path.join(root, 'host-user');
    const sessionRoot = path.join(hostUser, 'remote-agent', 'workspaces', 'c1', 's1');
    const workingDir = path.join(sessionRoot, 'fs', 'workspace');
    const globalHome = path.join(root, 'pi-global');
    for (const dir of [agentHome, workingDir, globalHome]) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(hostUser, 'AGENTS.md'), 'HOST_ANCESTOR_CANARY');
    // 本机用户的家目录就是会话目录的上级(与真实布局一致)，里面有自己的 Agent Skills。
    mkdirSync(path.join(hostUser, '.agents', 'skills', 'host-skill'), { recursive: true });
    writeFileSync(
      path.join(hostUser, '.agents', 'skills', 'host-skill', 'SKILL.md'),
      ['---', 'name: host-skill', 'description: HOST_SKILL_CANARY', '---', 'body', ''].join('\n'),
    );
    const previousHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = hostUser;
    process.env.USERPROFILE = hostUser;
    writeFileSync(path.join(globalHome, 'AGENTS.md'), 'HOST_GLOBAL_CANARY');
    writeFileSync(path.join(sessionRoot, 'CLAUDE.md'), 'GUEST_PERSONAL_CANARY');
    writeFileSync(path.join(workingDir, 'AGENTS.md'), 'GUEST_PROJECT_CANARY');
    const deps: AgentDeps = {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'test-key-123' }),
      },
      runtimeConfig: { endpoint },
      binaryPath: PI_BINARY,
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'pi-test-model', displayName: 'Pi Test Model', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGlobalContextHome: () => globalHome,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
    };
    const deviceHosted: DeviceHostedSession = {
      workingDir,
      extraDirs: [],
      writableDirs: [],
      platform: process.platform,
      shell: process.platform === 'win32' ? 'powershell' : 'zsh',
      isGitRepo: false,
      // 本用例不调用工具，隧道不会被访问。
      tunnelUrl: 'http://127.0.0.1:9/t/unused/',
      tunnelToken: 'unused',
      mcpServers: [],
      mirrorRoot: path.join(sessionRoot, 'fs'),
      ...(guest ? {
        guest: true,
        guestHome: path.join(root, 'guest-homes', 'c1'),
        guestProvider: { providerId: 'xd', modelIds: ['pi-test-model'], routeToken: 'unused' },
      } : {}),
    };
    let handle: AgentSessionHandle | undefined;
    try {
      handle = await new PiAgent(deps).startSession({
        sessionId: guest ? 'guest-context' : 'owner-context',
        workingDir,
        model: 'pi-test-model',
        ...(guest ? { providerId: 'xd' } : {}),
        deviceHosted,
      });
      const systems: string[] = [];
      const toolLists: string[][] = [];
      for (let turn = 0; turn < 2; turn++) {
        const start = bodies.length;
        const events: AgentEvent[] = [];
        const done = (async () => {
          for await (const event of handle!.events()) {
            events.push(event);
            if (event.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: `ping ${turn}` });
        await done;
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        const request = bodies.slice(start).find((entry) => entry.url.includes('/messages'));
        expect(request, JSON.stringify(events)).toBeDefined();
        systems.push(JSON.stringify(JSON.parse(request!.body).system));
        toolLists.push((JSON.parse(request!.body).tools ?? []).map((tool: { name: string }) => tool.name));
      }
      // 受邀者：模型只看到 Cindy 扩展注册的工具，Pi 自带而没被替换的(Windows 上默认开着的 powershell)不出现；
      // 工具清单在轮次之间不变。
      if (guest) {
        expect(toolLists[0]).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']));
        expect(toolLists[0]).not.toContain('powershell');
      }
      expect(toolLists[1]).toEqual(toolLists[0]);
      const text = systems[0]!;
      expect(text).toContain('GUEST_PROJECT_CANARY');
      expect(text).toContain('GUEST_PERSONAL_CANARY');
      if (guest) {
        expect(text).not.toContain('HOST_ANCESTOR_CANARY');
        expect(text).not.toContain('HOST_GLOBAL_CANARY');
        expect(text).not.toContain('HOST_SKILL_CANARY');
      } else {
        expect(text).toContain('HOST_ANCESTOR_CANARY');
        expect(text).toContain('HOST_GLOBAL_CANARY');
        expect(text).toContain('HOST_SKILL_CANARY');
      }
      // 受邀者的 Pi 会话文件只写在受邀者目录里，本机的会话目录里没有。
      const sessionFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).filter((name) => name.endsWith('.jsonl')) : []);
      if (guest) {
        expect(sessionFiles(path.join(root, 'guest-homes', 'c1', 'pi-sessions')).length).toBeGreaterThan(0);
        expect(sessionFiles(path.join(agentHome, 'sessions'))).toEqual([]);
      }
      // 系统提示在轮次之间保持稳定(缓存前缀)。
      expect(systems[1]).toEqual(systems[0]);
    } finally {
      await handle?.close();
      for (const [key, value] of Object.entries(previousHome)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
