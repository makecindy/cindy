/**
 * 真 Codex app-server：受邀者(另一个账号)的托管会话使用受邀者目录作为 CODEX_HOME，线程里只开
 * 白名单内的 Codex 功能(按线程向 app-server 查询核对)。
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
import { LOCAL_AGENT_CLIENT } from '../../base-agent.js';
import { CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES, listCodexFeatures } from '../device-hosted-guest.js';
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
  // 本机应用复用真实 app-server 夹具；历史 hhh namespace 验证 v1 兼容，不读取用户凭据。
  it.each([true, false, 'local-host-only', 'local-native', 'hosted-client-only'] as const)('keeps this computer\'s Codex home out of the session (guest: %s)', async (variant) => {
    const guest = variant === true;
    const localHostOnly = variant === 'local-host-only' || variant === 'hosted-client-only';
    const localClient = localHostOnly || variant === 'local-native';
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
    const projectSkill = path.join(workingDir, '.agents', 'skills', 'project-native');
    await mkdir(projectSkill, { recursive: true });
    await writeFile(path.join(projectSkill, 'SKILL.md'), '---\nname: project-native\ndescription: PROJECT_NATIVE_SKILL_CANARY\n---\nA project skill for the explicitly selected workspace.');

    const bodies: string[] = [];
    let hostToolCalls = 0;
    const server: Server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url?.includes('/mcp')) {
          if (req.method !== 'POST') { res.writeHead(405).end(); return; }
          const rpc=JSON.parse(body);
          if(rpc.id===undefined){res.writeHead(202).end();return;}
          if (rpc.method === 'tools/call') hostToolCalls++;
          const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'hhh',version:'1'}}:rpc.method==='tools/list'?{tools:[{name:'echo',description:'HHH host echo',inputSchema:{type:'object',properties:{}}}]}:rpc.method==='tools/call'?{content:[{type:'text',text:'HHH_HOST_TOOL_RESULT'}]}:{};
          res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result}));return;
        }
        if (!req.url?.includes('/responses')) { res.writeHead(404).end('{}'); return; }
        bodies.push(body);
        const item = localHostOnly && bodies.length === 1
          ? { type: 'function_call', id: 'fc-1', call_id: 'call-1', namespace: 'mcp__hhh', name: 'echo', arguments: '{}', status: 'completed' }
          : { type: 'message', id: 'msg-1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] };
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
    const registeredRoutes: Array<{ threadId: string; text: string; smartSubagentRoutes?: unknown; subagentRoute?: unknown }> = [];
    const agent = new CodexAgent({
      binaryPath: binaryPath!,
      logger,
      runtimeConfig: {
        systemPrompt: 'CINDY_HOST_IDENTITY_CANARY',
        answerDeliveryPrompt: 'CINDY_ANSWER_DELIVERY_CANARY',
      },
      getGhostRosterPrompt: () => 'WORKDIR_GHOST_ROSTER_CANARY',
      prepareCodexHostToolCatalog: async modelId => {
        const target=path.join(root,'host-tool-models.json');
        await writeFile(target,JSON.stringify({models:[{slug:modelId,display_name:modelId,description:null,supported_reasoning_levels:[],shell_type:'unified_exec',visibility:'none',supported_in_api:true,priority:99,base_instructions:'Use the available host tools.',include_skills_usage_instructions:false,include_plugin_usage_instructions:false,include_apps_usage_instructions:false,supports_reasoning_summary_parameter:true,default_reasoning_summary:'auto',support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},context_window:272000,max_context_window:272000,effective_context_window_percent:95,experimental_supported_tools:[],apply_patch_tool_type:null,supports_search_tool:false}]}));
        return target;
      },
      // 供应商配置随 spawn 参数下发(与 Desktop 一样)，不依赖 CODEX_HOME 里的 config.toml。
      prepareCodexExtraSpawnConfig: async (_providers, ctx) => {
        spawnContexts.push(ctx);
        return {
        extraArgs: [
          '-c', 'model_provider="fixture"',
          '-c', `model_providers.fixture={ name = "Fixture", base_url = "${endpoint}", wire_api = "responses", requires_openai_auth = false, request_max_retries = 0, supports_websockets = false }`,
          '-c', 'check_for_update_on_startup=false',
          '-c', 'analytics.enabled=false',
          // Provider defaults must stay excluded after native rewind/fork too.
          ...(localClient || guest ? ['-c', `mcp_servers.private_canary={url="${endpoint}/mcp",enabled=true}`] : []),
          ...(guest ? ['-c', 'features.apps=true'] : []),
          // 本机用户开了智能子代理调配时 host 会带上的配置；受邀者的 app-server 不接受。
          '-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
        ],
        extraEnv: {},
        // Cover both existing delivery paths: client-only registers its prompt
        // for the host HTTP proxy; native sends developerInstructions inline.
        codexProxyActive: !localClient || localHostOnly,
        smartSubagentRoutes: [{ providerId: 'other-provider', catalogModel: 'other-model' }],
        };
      },
      registerCodexSystemPromptForThread: ({ threadId, text, smartSubagentRoutes, subagentRoute }) => {
        registeredRoutes.push({ threadId, text, smartSubagentRoutes, subagentRoute });
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
        ...(variant === 'hosted-client-only' ? { deviceHosted } : {}),
        sessionId: guest ? 'guest-native' : 'owner-native',
        model: 'gpt-5.5',
        ...(guest ? { providerId: 'xd' } : {}),
        workingDir,
        permissionMode: 'bypassPermissions',
        makerMemoryEnabled: false,
        ...(localClient ? {
          userPrompt: 'CLIENT_INSTRUCTIONS_CANARY',
          makerMemoryIndexSnapshot: 'PRIVATE_MEMORY_INDEX_CANARY',
        } : {}),
        ...(localClient ? {[LOCAL_AGENT_CLIENT]:{url:`${endpoint}/mcp`,token:'fixture',hostToolsOnly:localHostOnly,mcpName:'hhh',storageDirectory:path.join(sessionRoot,'client-a')}} : {deviceHosted}),
      });
      const done = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'hello' }, { throwOnStartFailure: true });
      await done;
      // 按这个线程向 Codex 查功能状态：受邀者线程里白名单之外的功能都是关着的；同账号线程里有开着的。
      const hosts = (agent as unknown as { hosts: Map<string, { request: (method: string, params: unknown) => Promise<unknown> }> }).hosts;
      const threadHost = [...hosts].find(([key]) => key.startsWith('local-guest:') === guest)?.[1];
      if (!threadHost) throw new Error('expected the session app-server');
      const threadFeatures = await listCodexFeatures((cursor) => threadHost.request(
        'experimentalFeature/list', { threadId: handle.id, limit: 200, ...(cursor ? { cursor } : {}) },
      ));
      const enabledOutsideAllowlist = threadFeatures
        .filter((feature) => feature.enabled && feature.stage !== 'removed' && !CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES.has(feature.name))
        .map((feature) => feature.name);
      if (guest || localHostOnly) expect(enabledOutsideAllowlist).toEqual([]);
      else expect(enabledOutsideAllowlist.length).toBeGreaterThan(0);
      // 两种会话里干活要用的功能都开着(命令、shell 快照、看图、子代理)。
      const enabled = new Set(threadFeatures.filter((feature) => feature.enabled).map((feature) => feature.name));
      if (localClient) {
        // 2026-10-22 maintainer decision: the app calls Cindy with its existing
        // prompt assembly. Metadata/instructions do not grant private MCP access.
        // This fixture does not run the Desktop proxy, so inspect the actual
        // production registration for that channel, not its uninjected fake upstream.
        const prompt = localHostOnly
          ? registeredRoutes.find(entry => entry.threadId === handle.id)?.text ?? ''
          : bodies[0];
        for (const segment of [
          'CINDY_HOST_IDENTITY_CANARY', 'CINDY_ANSWER_DELIVERY_CANARY',
          'CLIENT_INSTRUCTIONS_CANARY', 'WORKDIR_GHOST_ROSTER_CANARY',
        ]) expect(prompt).toContain(segment);
        expect(prompt).not.toContain('PRIVATE_MEMORY_INDEX_CANARY');
        expect(bodies.join('')).not.toContain('PRIVATE_MEMORY_INDEX_CANARY');
        expect(bodies.join('')).not.toContain('private_canary');
      }
      if (variant === 'local-native') {
        expect(enabled.has('shell_tool') || enabled.has('unified_exec')).toBe(true);
        expect(JSON.stringify(JSON.parse(bodies[0]).tools)).toMatch(/\bhhh\b/);
        expect(bodies.join('')).not.toContain('HOST_GLOBAL_CANARY');
        expect(bodies.join('')).toContain('PROJECT_NATIVE_SKILL_CANARY');
        await handle.close();
        return;
      }
      if(localHostOnly){
        expect(hostToolCalls).toBe(1);
        expect(bodies.at(-1)).toContain('HHH_HOST_TOOL_RESULT');
        const request=JSON.parse(bodies.at(-1)!);
        const names=(request.tools ?? []).flatMap((tool:{name?:string;type?:string;tools?:Array<{name:string}>})=>tool.type==='namespace'?(tool.tools ?? []).map(child=>`${tool.name}__${child.name}`):[tool.name ?? tool.type]);
        // Native MCP discovery helpers can only inspect this session's HHH
        // server. Native interactive input is explicitly dismissed by the Host.
        expect(names).toContain('mcp__hhh__echo');
        expect(names.filter((name:string)=>!['mcp__hhh__echo','list_mcp_resources','list_mcp_resource_templates','read_mcp_resource','request_user_input'].includes(name))).toEqual([]);
        expect(['shell_tool','shell_snapshot','view_image','multi_agent'].filter(name=>enabled.has(name))).toEqual([]);
        expect(bodies.join('')).not.toMatch(/HOST_GLOBAL_CANARY|HOST_ANCESTOR_CANARY|SHADOW_CANARY/);
        // A second custom model must get a fresh native catalog snapshot. Sharing
        // the earlier process would silently restore the native fallback tools.
        const other = await agent.startSession({sessionId:'owner-native',model:'custom-host-fixture',workingDir,
          permissionMode:'bypassPermissions',makerMemoryEnabled:false,
          [LOCAL_AGENT_CLIENT]:{url:`${endpoint}/mcp`,token:'fixture',hostToolsOnly:true,mcpName:'hhh',storageDirectory:path.join(sessionRoot,'client-a')}});
        const finished=(async()=>{for await(const event of other.events()){
          if(event.type==='error')throw Error(JSON.stringify(event));if(event.type==='done')return;
        }})();
        await other.send({type:'user',content:'hello'},{throwOnStartFailure:true});await finished;
        const second=JSON.parse(bodies.at(-1)!);
        expect(JSON.stringify(second.tools)).not.toMatch(/apply_patch|exec_command|write_stdin/);
        expect([...hosts.keys()].filter(key=>key.includes(':host-tools-only:')).length).toBe(2);
        // An unrelated grant using the same model must not share the app-server or native history.
        // Retain the historical namespace here to cover v1 grants as well as custom names in Claude/Pi.
        const unrelated = await agent.startSession({sessionId:'other-client',model:'gpt-5.5',workingDir,
          permissionMode:'bypassPermissions',makerMemoryEnabled:false,
          [LOCAL_AGENT_CLIENT]:{url:`${endpoint}/mcp`,token:'fixture',hostToolsOnly:true,mcpName:'hhh',storageDirectory:path.join(sessionRoot,'client-b')}});
        const unrelatedDone=(async()=>{for await(const event of unrelated.events()){
          if(event.type==='error')throw Error(JSON.stringify(event));if(event.type==='done')return;
        }})();
        await unrelated.send({type:'user',content:'hello'},{throwOnStartFailure:true});await unrelatedDone;
        expect([...hosts.keys()].filter(key=>key.includes(':host-tools-only:')).length).toBe(3);
        expect([...hosts.keys()].some(key=>key.includes(path.join(sessionRoot,'client-b','native-history')))).toBe(true);
        await unrelated.close();
        await other.close();await handle.close();return;
      }
      expect(['shell_tool', 'unified_exec', 'shell_snapshot', 'view_image', 'multi_agent'].filter((name) => !enabled.has(name))).toEqual([]);

      // Regression: native fork reloads process defaults. Exercise the production
      // rewind entry and a subsequent turn, then inspect the new native runtime.
      // Existing startup-only assertions missed restored apps and provider MCP.
      const previousThreadId = handle.id;
      const turns = await threadHost.request('thread/turns/list', { threadId: previousThreadId, limit: 10 }) as { data: Array<{ id: string }> };
      expect(turns.data).toHaveLength(1);
      const rewound = await handle.commitRewindFiles!('', '', { tailTurnsToDrop: 1, lastTurnId: turns.data[0]!.id });
      expect(rewound?.sdkSessionId).not.toBe(previousThreadId);
      const rewindDone = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'continue after rewind' }, { throwOnStartFailure: true });
      await rewindDone;
      if (guest) {
        const afterRewindFeatures = await listCodexFeatures(cursor => threadHost.request(
          'experimentalFeature/list', { threadId: rewound!.sdkSessionId, limit: 200, ...(cursor ? { cursor } : {}) },
        ));
        expect(afterRewindFeatures.filter(feature => feature.enabled && feature.stage !== 'removed'
          && !CODEX_DEVICE_HOSTED_GUEST_KEPT_FEATURES.has(feature.name)).map(feature => feature.name)).toEqual([]);
        expect(bodies.join('')).not.toContain('private_canary');
      }
      await handle.close();

      if (guest) {
        const requestCount = bodies.length;
        const forked = await agent.forkSdkSession({
          sourceSdkSessionId: rewound!.sdkSessionId!, upToMessageId: undefined,
          lastTurnId: turns.data[0]!.id, workingDir, hostedGuestHome: guestHome, providerId: 'xd', model: 'gpt-5.5',
        });
        expect(forked.newSdkSessionId).not.toBe(rewound!.sdkSessionId);
        expect(bodies).toHaveLength(requestCount);
      }

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
