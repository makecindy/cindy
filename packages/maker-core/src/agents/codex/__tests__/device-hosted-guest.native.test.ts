/**
 * 真 Codex app-server：受邀者(另一个账号)的托管会话使用受邀者目录作为 CODEX_HOME。
 * 本机用户 CODEX_HOME 里的全局 AGENTS.md 不进入请求，会话历史只写在受邀者目录里，本机用户的
 * 历史与凭证文件不被触碰；命令经 exec-server 环境在「任务所在电脑」执行(这里用一个独立的
 * `codex exec-server` 进程模拟)。同账号托管会话仍使用本机用户的 CODEX_HOME。
 *
 * 显式开启：CINDY_CODEX_TEST_BINARY=<codex 可执行文件> vitest run <本文件>。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import net from 'node:net';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Logger } from '../../../interfaces/logger.js';
import type { DeviceHostedSession } from '../../base-agent.js';
import { CodexAgent } from '../index.js';

const binaryPath = process.env.CINDY_CODEX_TEST_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { recursive: true })).map(String);
  } catch {
    return [];
  }
}

describe.skipIf(!binaryPath)('Codex device-hosted guest with a real app-server', () => {
  it.each([true, false])('keeps this computer\'s Codex home out of the session (guest: %s)', async (guest) => {
    const root = realpathSync.native(await mkdtemp(path.join(tmpdir(), 'cindy-codex-guest-native-')));
    const hostHome = path.join(root, 'host-codex-home');
    const guestHome = path.join(root, 'remote-agent', 'guest-homes', 'c1');
    const sessionRoot = path.join(root, 'remote-agent', 'workspaces', 'c1', 's1');
    const workingDir = path.join(sessionRoot, 'fs', 'workspace');
    // 任务所在电脑上的项目：仓库根有 .git 与说明文件，任务在子目录里。
    const taskRepo = path.join(root, 'task-computer', 'repo');
    const taskDir = path.join(taskRepo, 'sub');
    await mkdir(hostHome, { recursive: true });
    await mkdir(workingDir, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await mkdir(path.join(taskRepo, '.git'), { recursive: true });
    await writeFile(path.join(taskRepo, 'AGENTS.md'), 'TASK_REPO_ROOT_CANARY');
    await writeFile(path.join(taskDir, 'AGENTS.md'), 'TASK_PROJECT_CANARY');
    await writeFile(path.join(hostHome, 'AGENTS.md'), 'HOST_GLOBAL_CANARY');
    // 本机用户的目录：影子目录的上级带 .git 与说明文件。托管时项目说明经执行环境读取，不沿本机影子目录向上找。
    await mkdir(path.join(root, 'remote-agent', '.git'), { recursive: true });
    await writeFile(path.join(root, 'remote-agent', 'AGENTS.md'), 'HOST_ANCESTOR_CANARY');
    await writeFile(path.join(workingDir, 'AGENTS.md'), 'SHADOW_CANARY');

    const bodies: string[] = [];
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (!req.url?.includes('/responses')) { res.writeHead(404).end('{}'); return; }
        bodies.push(body);
        const item = { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id: 'r1', status: 'in_progress', output: [] } },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'r1', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
    // 「任务所在电脑」：独立的 exec-server(只服务这个测试)。
    const port = await freePort();
    const execServer: ChildProcess = spawn(binaryPath!, ['exec-server', '--listen', `ws://127.0.0.1:${port}`], {
      env: { ...process.env, CODEX_HOME: path.join(root, 'task-codex-home') },
      stdio: 'ignore',
    });
    await mkdir(path.join(root, 'task-codex-home'), { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const spawnContexts: Array<{ accountHostKey?: string; runtimeCodexHome?: string; deviceHostedGuestProviderId?: string }> = [];
    const registeredRoutes: Array<{ smartSubagentRoutes?: unknown; subagentRoute?: unknown }> = [];
    const agent = new CodexAgent({
      binaryPath: binaryPath!,
      logger,
      runtimeConfig: {},
      // 供应商配置随 spawn 参数下发(与 Desktop 一样)，不依赖 CODEX_HOME 里的 config.toml。
      prepareCodexExtraSpawnConfig: async (_providers, ctx) => {
        spawnContexts.push(ctx);
        return {
        extraArgs: [
          '-c', 'model_provider="fixture"',
          '-c', `model_providers.fixture={ name = "Fixture", base_url = "${endpoint}", wire_api = "responses", requires_openai_auth = false, request_max_retries = 0, supports_websockets = false }`,
          '-c', 'check_for_update_on_startup=false',
          '-c', 'analytics.enabled=false',
          // 本机用户开了智能子代理调配时 host 会带上的配置；受邀者的 app-server 不接受。
          '-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
        ],
        extraEnv: {},
        codexProxyActive: true,
        smartSubagentRoutes: [{ providerId: 'other-provider', catalogModel: 'other-model' }],
        };
      },
      registerCodexSystemPromptForThread: ({ smartSubagentRoutes, subagentRoute }) => {
        registeredRoutes.push({ smartSubagentRoutes, subagentRoute });
      },
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({
          HOME: root, USERPROFILE: root, CODEX_HOME: hostHome,
          OPENAI_API_KEY: '', CODEX_API_KEY: '', NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    const deviceHosted: DeviceHostedSession = {
      workingDir: taskDir,
      extraDirs: [],
      writableDirs: [],
      platform: process.platform,
      shell: process.platform === 'win32' ? 'powershell' : 'zsh',
      isGitRepo: false,
      tunnelUrl: `http://127.0.0.1:${port}`,
      tunnelToken: 'unused',
      mcpServers: [],
      mirrorRoot: path.join(sessionRoot, 'fs'),
      ...(guest ? {
        guest: true,
        guestHome,
        guestProvider: { providerId: 'xd', modelIds: ['gpt-5.5'], routeToken: 'unused' },
      } : {}),
    };
    try {
      const handle = await agent.startSession({
        sessionId: guest ? 'guest-native' : 'owner-native',
        model: 'gpt-5.5',
        ...(guest ? { providerId: 'xd' } : {}),
        workingDir,
        permissionMode: 'bypassPermissions',
        makerMemoryEnabled: false,
        deviceHosted,
      });
      const done = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'hello' }, { throwOnStartFailure: true });
      await done;
      await handle.close();

      expect(bodies.length).toBeGreaterThan(0);
      const sent = bodies.join('\n');
      // 本机用户的全局说明只在同账号会话里；本机影子目录及其上级的说明文件两者都不读(项目说明经执行环境
      // 从任务所在电脑读取，那条路径在非 Windows 的 codexHosted.e2e 里覆盖)。
      expect({
        hostGlobal: sent.includes('HOST_GLOBAL_CANARY'),
        hostAncestor: sent.includes('HOST_ANCESTOR_CANARY'),
        shadow: sent.includes('SHADOW_CANARY'),
      }).toEqual({ hostGlobal: !guest, hostAncestor: false, shadow: false });
      const hostRollouts = (await listFiles(path.join(hostHome, 'sessions'))).filter((name) => name.endsWith('.jsonl'));
      const guestRollouts = (await listFiles(path.join(guestHome, 'codex', 'sessions'))).filter((name) => name.endsWith('.jsonl'));
      if (guest) {
        // 受邀者任务的 app-server 用受邀者目录，并走按 host 分开的 proxy(不改写本机任务共用的 proxy 状态)。
        expect(spawnContexts.some((ctx) => ctx.runtimeCodexHome === path.join(guestHome, 'codex')
          && ctx.accountHostKey?.startsWith('local-guest:')
          && ctx.deviceHostedGuestProviderId === 'xd')).toBe(true);
        // host 给出的子代理改道不进入受邀者的线程(子代理沿用会话模型)。
        expect(registeredRoutes.length).toBeGreaterThan(0);
        expect(registeredRoutes.every((entry) => !entry.smartSubagentRoutes && !entry.subagentRoute)).toBe(true);
        expect(sent).not.toContain('HOST_GLOBAL_CANARY');
        expect(guestRollouts.length).toBeGreaterThan(0);
        expect(hostRollouts).toEqual([]);
        // 受邀者目录不落凭证文件(ephemeral)，本机用户也没有被写入凭证。
        await expect(stat(path.join(guestHome, 'codex', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(path.join(hostHome, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        expect(spawnContexts.every((ctx) => !ctx.runtimeCodexHome && !ctx.accountHostKey
          && !ctx.deviceHostedGuestProviderId)).toBe(true);
        expect(registeredRoutes.some((entry) => Array.isArray(entry.smartSubagentRoutes))).toBe(true);
        expect(sent).toContain('HOST_GLOBAL_CANARY');
        expect(hostRollouts.length).toBeGreaterThan(0);
        expect(guestRollouts).toEqual([]);
      }
    } finally {
      await agent.dispose();
      execServer.kill();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }, 60_000);
});
