import { MAKER_PUSH } from '@cindy/maker-shared/maker-channels';
import { CONTINUE_AFTER_ERROR_PROMPT } from '@cindy/maker-shared/synthetic-trigger';
import { buildBotMemoryScopeKey } from '@cindy/maker-core';
import { SharedTaskHost } from '@cindy/remote-agent/host/sharedTaskHost';
import { botRuntimeSnapshots, botDirectMessages } from '@cindy/runtime-db/schema';
import { desc, eq } from 'drizzle-orm';
import { createSharedTaskJournal } from '@cindy/runtime-db/sharedTasks';
import { createSharedTaskApi, sharedTaskGuestPeer, type SharedTaskDetail } from '@cindy/device-link';
import { buildRemoteWorkerQueuedMessage, createOrcaRemoteWorkerRuntime, type RemoteWorkerTurnEnd, type RemoteWorkerRef } from '@cindy/orca-workflow/host/orcaRemoteWorkerRuntime';
import { SESSION_ACTIVITY_CHANNEL, type SessionActivityPayload } from '@cindy/device-link';
import { piSubagentRunRoot, piSubagentDeletedTombstonePath } from '@cindy/maker-core/pi-subagent-runs';
import { readTerminalWorkerCompletion } from './orca-completion.js';
import { buildUiLanguageErrorNote } from '@cindy/app-runtime/uiLanguageErrorNote';
import { taskStorageFixture, closeTaskStorageFixtures } from '../testing/task-storage.js';
import { createTerminalWorktrees } from '../worktrees/host.js';
import { registerWorktreeResources } from '../worktrees/resources.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TerminalPluginSessions } from '../plugins/sessions.js';
import { registerPluginResources } from '../plugins/resources.js';
import { runResourceCommand } from '../resource-commands.js';
import { encodeCatalogModelPin } from '@cindy/model-providers/catalogModelPin';
import { enqueueMessage, waitForTurn } from '../client-operations.js';
import type { TerminalClient } from '../contracts.js';
import { TerminalSchedulerHost } from './scheduler.js';
import { createTerminalTaskNotifications } from './notifications.js';
import { createServer } from 'node:http';
import { createProviderProxy } from '../models/proxy.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as platform from '../platform.js';
import { TerminalImBindings } from '../im/bindings.js';
import { TerminalImConnections } from '../im/connections.js';
import { registerImResources } from '../im/resources.js';
import { TerminalGroupWindows } from '../im/group-window.js';
import Database from 'better-sqlite3';
import { GROUP_WINDOW_SCHEMA_SQL } from '../im/group-window-schema.js';
import { TerminalConfiguration } from '../configuration.js';
import { TerminalProtectedInput } from '../protected-input.js';
import { TerminalSecretStore } from '../secrets.js';
import { access, appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {admitTaskAction} from '@cindy/app-runtime/taskActionAuthorization';
import { ClaudeCodeAgent, CodexAgent, PiAgent, type AgentEvent, type Session, type AgentSessionHandle, type InteractionDecision, type InteractionResolver, type Logger, type StartSessionOptions } from '@cindy/maker-core';
import type { TerminalSecrets } from '../contracts.js';
import { TerminalTaskHost } from './host.js';
import { rebuildQueuedOrcaLeadMessage } from '@cindy/orca-workflow/host/orcaInterAgentDispatcher';
import type { RuntimeInput } from '../models/runtime.js';
import { TerminalTaskStorage } from './storage.js';
import { downloadRemoteFile } from '../file-transfers.js';
import { TerminalMediaTransfer } from '../media-transfer.js';
import { RemoteResourceRegistry, REMOTE_AGENT_CHANNEL, DL_SESSION_REFERENCE_CAPABILITY_CHANNEL } from '@cindy/device-link';
import { TerminalRemoteAgentService } from '../remote/agent.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { TerminalPlugins } from '../plugins/host.js';
import { TerminalPluginTasks } from '../plugins/tasks.js';
import { TerminalCompanionHost } from '../remote/companions/host.js';
import { registerCompanionResources } from '../remote/companions/resources.js';
import { TerminalKnowledge } from '../knowledge.js';
import { TerminalPluginMarket } from '../plugins/market.js';
import { TerminalPluginAccount } from '../plugins/account.js';
import { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { SharedPermission } from '@cindy/im-runtime/sharedPermission';
import { createTurnRunner } from '@cindy/im-runtime/turnRunner';
import { withAutoReviewContext, AUTO_REVIEW_USER_INTENT, type AutoReviewRequest, type SendOptions } from '@cindy/maker-core';
import { createSlashHandlers } from '@cindy/im-runtime/slashCommands';
import { createCardBuilders } from '@cindy/im-runtime/cardBuilders';
import type { ImChannelAdapter } from '@cindy/im-runtime/types';
import type { TextChannelIM, ImFinalOutput, RichChannelIM, IMMessageEvent, IMCardActionEvent, InteractiveCardSpec } from '@cindy/im';
import { ui as wechatUi } from '@cindy/im-runtime/channels/wechat/uiText';

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };
const roots: string[] = [];
const schedulers: TerminalSchedulerHost[] = [];
const hosts: TerminalTaskHost[] = [];
const companionKnowledge:TerminalKnowledge[]=[];
async function connectCompanionFixture(host:TerminalTaskHost,root:string,existing?:TerminalKnowledge){
  if(host.bots)return;
  const knowledge=existing??new TerminalKnowledge({root,logger,assertCurrent(){},changed(){},workingDirs:async()=>[root]});
  if(!existing)companionKnowledge.push(knowledge);
  await knowledge.ready;host.configureKnowledge(knowledge);
  vi.spyOn(host,'listAgentSkills').mockResolvedValue({skills:[]});
  await host.connectOriginalBotServices({memory:knowledge.memory,resourceRoot:()=>path.resolve(process.cwd(),'../desktop/resources'),
    listBotImChannels:({botId})=>host.botImConnections.listBotImConnectionsForBot(botId).map(row=>row.channel),isCompanionShadowed:()=>false});
}
afterEach(async () => {
  await closeTaskStorageFixtures(); for(const scheduler of schedulers.splice(0))await scheduler.close(); for (const host of hosts.splice(0)) await host.close(); for(const knowledge of companionKnowledge.splice(0))await knowledge.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

/** Native transport substitute: all task lifecycle/approval behavior remains in real Maker. */
function engine(beforeStart?: (input: RuntimeInput, options: StartSessionOptions) => Promise<void>, beforeSend?: (input: RuntimeInput, options: StartSessionOptions) => Promise<void>) {
  const starts: StartSessionOptions[] = [];
  const teardowns: Array<{id: string; reason?: string}> = [];
  const crashTransport = new Map<string, () => void>();
  const inputs: RuntimeInput[] = [];
  const decisions: InteractionDecision[] = [];
  const modelChanges: Array<{sessionId: string; model: string; providerId?: string | null}> = [];
  const permissionModes: import('@cindy/maker-core').PermissionMode[] = [];
  const title = { reply: async () => '"Server task"' };
  const titleRequests: Array<{ prompt: string; options?: import('@cindy/maker-core').OneShotOptions }> = [];
  const sent: import('@cindy/maker-core').UserMessage[] = [];
  const sentTaskIds: string[] = [];
  const steered: import('@cindy/maker-core').UserMessage[] = [];
  const steer = { reply: async () => {} };
  const held = new Map<string, () => void>();
  const heldListeners = new Map<string, () => void>();
  const sends: Array<SendOptions|undefined> = [];
  const resumeFailures = new Set<string>();
  const overflowed = new Set<string>();
  const responses = new Map<string,AgentEvent[]>();
  const usageByModel = new Map<string, { contextTokens: number; contextWindow: number }>();
  const create = async (input: RuntimeInput) => {
    inputs.push(input);
    const Agent = { 'claude-code': ClaudeCodeAgent, codex: CodexAgent, pi: PiAgent }[input.selection.agentKind];
    const agent = new Agent({ binaryPath: process.execPath, auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} }, runtimeConfig: {}, logger });
    agent.oneShot = async (prompt, options) => { titleRequests.push({ prompt, options }); return title.reply(); };
    agent.startSession = async options => {
      await beforeStart?.(input, options);
      // The synthetic factory replaces createTerminalAgent, including its
      // initial proxy preferences. Later changes still use the original host.
      input.runtimeAxes?.setSessionEffort(options.sessionId!,options.effort);
      input.runtimeAxes?.setSessionFastMode(options.sessionId!,options.fastMode??false);
      starts.push(options);
      if (options.resumeSessionId && resumeFailures.delete(options.resumeSessionId)) throw new Error('fixture native transcript expired');
      let running = false;
      let silentForever = false;
      let ended = false;
      let streamFailure: Error | undefined;
      let resolver: InteractionResolver | undefined;
      let awaken: (() => void) | undefined;
      const events: AgentEvent[] = [];
      crashTransport.set(options.sessionId!, () => { streamFailure=new Error('synthetic native transport exit'); ended=true; awaken?.(); });
      const emit = (event: AgentEvent) => { events.push(event); awaken?.(); };
      const handle: AgentSessionHandle = {
        id: options.resumeSessionId ?? `${input.selection.agentKind === 'claude-code' ? 'native' : `${input.selection.agentKind}-native`}-${options.sessionId}`,
        agentKind: input.selection.agentKind, get model() { return options.model; },
        async send(message,sendOptions) {
          sent.push(message);
          sentTaskIds.push(input.taskId);
          sends.push(sendOptions);
          running = true;
          emit({ type: 'status', data: { isRunning: true } });
          await beforeSend?.(input, options);
          const rawText = typeof message.content === 'string' ? message.content : '';
          // The provider fixture interprets the user's instruction after Cindy's
          // original environment note; `sent` above retains the exact wire input.
          const localeNote = buildUiLanguageErrorNote('en') + '\n\n';
          const text = rawText.startsWith(localeNote) ? rawText.slice(localeNote.length) : rawText;
          if (text === 'wait-for-steer') {
            held.set(input.taskId, () => { running = false; emit({ type: 'done', data: {} }); held.delete(input.taskId); });
            heldListeners.get(input.taskId)?.(); heldListeners.delete(input.taskId);
            return;
          }
          if (text === 'silent-once' || text === 'silent-loop' || silentForever) {
            silentForever ||= text === 'silent-loop';
            running = false;
            emit({ type: 'done', data: { silentStop: true } });
            return;
          }
          if (text.includes('context-overflow-fixture') || text.includes('overflow-once') && !overflowed.has(input.taskId) || text.includes('overflow-after-write')) {
            overflowed.add(input.taskId);
            if (text.includes('overflow-after-write')) {
              await writeFile(path.join(options.workingDir, 'effect.txt'), 'completed once');
              emit({ type: 'tool_use', data: { toolName: 'Write', input: { file_path: 'effect.txt' } } });
            }
            running = false;
            emit({ type: 'error', data: { reason: 'context-overflow', message: 'maximum context length exceeded', isTerminal: true } });
            return;
          }
          if (text === 'interrupted-after-write') {
            const file = path.join(options.workingDir, 'effect.txt');
            const prior = await readFile(file, 'utf8').catch(() => '');
            await writeFile(file, prior + 'completed\n');
            emit({ type: 'tool_use', data: { toolName: 'Write', input: { file_path: file } } });
            running = false;
            emit({ type: 'error', data: { reason: 'upstream_response_idle_timeout', message: 'Upstream stopped responding', isTerminal: true } });
            return;
          }
          const scripted=responses.get(text);
          if(scripted){for(const event of scripted)emit(event);running=false;return;}
          if (text === 'permission') {
            const decision = await resolver!({ requestId: 'native-request', kind: 'permission', toolName: 'Bash', input: { command: 'true' } });
            decisions.push(decision);
          }
          if (text === 'edit-fixture') {
            await input.turnChangeCapture!.beforeKnownFileWrite({ sessionId: options.sessionId!, provider: 'claude-code', cwd: options.workingDir, targetPath: 'revision.txt' });
            await writeFile(path.join(options.workingDir, 'revision.txt'), 'after\n');
          }
          emit({ type: 'text', data: { text: `Echo: ${text}`, isFinal: true } });
          running = false;
          emit({ type: 'done', data: {result:`Echo: ${text}`} });
        },
        async steer(message) { steered.push(message); await steer.reply(); },
        async abort() { running = false; emit({ type: 'done', data: {} }); },
        async close(opts) { teardowns.push({id: options.sessionId!, reason: opts?.reason}); ended = true; running = false; awaken?.(); },
        async *events() {
          while (!ended || events.length) {
            const next = events.shift();
            if (next) yield next;
            else await new Promise<void>(resolve => { awaken = resolve; });
          }
          if (streamFailure) throw streamFailure;
        },
        getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: input.route.model.contextWindow, costUsd: 0, ...usageByModel.get(options.model!) }),
        setInteractionResolver: value => { resolver = value; },
        async setModel(model, opts) { modelChanges.push({sessionId: options.sessionId!, model, providerId: opts?.providerId}); options.model = model; },
        async setEffort(effort) { options.effort = effort; },
        getEffort: () => options.effort ?? null,
        async setFastMode(fastMode) { options.fastMode = fastMode; },
        getFastMode: () => options.fastMode ?? false,
        async setPermissionMode(mode) { permissionModes.push(mode); },
        async setPlanMode(enabled) { options.planMode=enabled; },
        async setVendorOptions(patch) { options.vendorOptions = { ...options.vendorOptions, ...patch }; },
        getPlanMode: () => options.planMode ?? false,
        isTurnRunning: () => running,
      };
      return handle;
    };
    return agent;
  };
  return { teardowns, crashTransport, responses, create, starts, decisions, inputs, sent, sends, modelChanges, permissionModes, title, titleRequests, resumeFailures, usageByModel,
    steered, steer, sentFor: (id: string) => sent.filter((_message, index) => sentTaskIds[index] === id), finishHeld: (id: string) => held.get(id)?.(),
    waitForHeld: (id: string) => held.has(id) ? Promise.resolve() : new Promise<void>(resolve => heldListeners.set(id, resolve)),
  };
}

async function setup(native = engine(), overrides: Partial<ConstructorParameters<typeof TerminalTaskHost>[0]> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-task-test-'));
  roots.push(root);
  const vault = new Map<string, string>();
  const secrets: TerminalSecrets = { get: async key => vault.get(key) ?? null, set: async (key, value) => { vault.set(key, value); }, delete: async key => { vault.delete(key); } };
  const pushes: Array<{ channel: string; payload: unknown }> = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  const nextPush = (channel: string, match: (payload: unknown) => boolean = () => true) => new Promise<unknown>(resolve => {
    listeners.set(channel, payload => { if (match(payload)) { listeners.delete(channel); resolve(payload); } });
  });
  const create = () => {
    const host = new TerminalTaskHost({ profileDir: root, secretStore: secrets, logger, binaryPaths: { 'claude-code': process.execPath, codex: process.execPath, pi: process.execPath }, createAgent: native.create, nativeStatus: async () => ({ authenticated: false }), ...overrides, emit: (channel, args) => { pushes.push({ channel, payload: args[0] }); listeners.get(channel)?.(args[0]); } });
    hosts.push(host);
    return host;
  };
  const host = create();
  await host.invoke('maker:provider:custom:create', [{ id: 'fixture', name: 'Fixture', auth: { method: 'apiKey' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'test-model', name: 'Test model', contextWindow: 200000 }] } } }, { 'claude-code': 'invalid-test-key-only' }]);
  await host.invoke('terminal:models:set-default', [{ agentKind: 'claude-code', providerId: 'fixture', model: 'test-model' }]);
  return { host, root, create, pushes, native, vault, nextPush };
}

// Real auxiliary HTTP route, shared by the channel/title regressions.
async function auxiliaryFixture(host: TerminalTaskHost, reply: () => Promise<string>) {
  const requests: Array<{model: string; messages: Array<{content: string}>}> = [];
  const api = createServer(async (req, res) => {
    let body=''; for await (const chunk of req) body+=chunk;
    requests.push(JSON.parse(body));
    const text=await reply();
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{content:text}}]}));
  });
  await new Promise<void>(resolve=>api.listen(0,'127.0.0.1',resolve));
  const close=async()=>{api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));};
  try {
    await host.models.saveProvider({id:'auxiliary-fixture',name:'Auxiliary fixture',auth:{method:'apiKey'},runtimes:{codex:{baseUrl:`http://127.0.0.1:${(api.address() as {port:number}).port}`,wireProtocol:'openai-chat',models:[{id:'test-utility',name:'Utility'}]}}},{codex:'fake-auxiliary-key'},true);
    await host.utility.update({models:[encodeCatalogModelPin({providerId:'auxiliary-fixture',agentKind:'codex',model:'test-utility'})]});
    return {requests,close};
  } catch(error) { await close();throw error; }
}

async function persistHandoffFixture(host: TerminalTaskHost, id: string, clientId: string, handoff: string) {
  await (await host.conversations).messages.createMessage(id, { clientId, role: 'agent_switch',
    content: { fromAgentKind: 'cc', toAgentKind: 'cc', fromModel: 'test-model', toModel: 'test-model', handoff, consumed: false } });
}

describe('terminal task host', () => {
  // Integration: original device settings and providers were absent from the
  // Node assembly. Exercise public IPC plus a real SDK MCP connection; never
  // launch a driver, install ADB, or touch a user's attached devices.
  it('mounts original device tools and saves their original settings through public commands',async()=>{
    const {host,root,native}=await setup();
    await writeFile(path.join(root,'tsconfig.json'),'{}');
    expect(await host.invoke('maker:lsp-mode:get')).toEqual({enabled:false});
    const first=await host.invoke('maker:create-session',[{workingDir:root}]) as {id:string};
    const tools=native.inputs.find(input=>input.taskId===first.id)!.tools!;
    expect(tools.providers.map(provider=>provider.name)).toEqual(expect.arrayContaining(['cindy_android','cindy_computer','cindy_lsp','cindy_browser','cindy_docs']));
    expect(tools.buildSessionMcpConfig('device-fixture')['mcp_servers.cindy_lsp.enabled']).toBe(false);
    await expect(host.invoke('maker:lsp-mode:set',['true'])).rejects.toThrow('lsp mode enabled required');
    expect(await host.invoke('maker:lsp-mode:set',[true])).toEqual({effective:'next-session'});
    const second=await host.invoke('maker:create-session',[{workingDir:root}]) as {id:string};
    expect(native.inputs.find(input=>input.taskId===second.id)!.tools!.buildSessionMcpConfig('next-device-fixture')['mcp_servers.cindy_lsp.enabled']).toBe(true);
    await expect(host.invoke('maker:android:set-default-device',[{defaultDeviceSerial:42}])).rejects.toThrow('defaultDeviceSerial must be a string or null');
    expect(await host.invoke('maker:android:set-default-device',[{defaultDeviceSerial:' fixture-phone '}])).toMatchObject({value:{defaultDeviceSerial:'fixture-phone',adbPathOverride:null}});
    expect(JSON.parse(await readFile(path.join(root,'android-automation-settings.json'),'utf8'))).toMatchObject({defaultDeviceSerial:'fixture-phone'});
    const provider=tools.providers.find(provider=>provider.name==='cindy_android')!;
    const sdk=provider.toClaudeSdkConfig!({sessionId:first.id,workingDir:root,agentKind:'claude-code'}) as {instance:McpServer};
    const [left,right]=InMemoryTransport.createLinkedPair(),client=new McpClient({name:'native-device-fixture',version:'1'});
    try{
      await sdk.instance.connect(left);await client.connect(right);
      expect((await client.listTools()).tools.map(tool=>tool.name)).toEqual(expect.arrayContaining(['list_tools','call_tool']));
      const catalog=await client.callTool({name:'list_tools',arguments:{category:'android'}});
      expect(catalog.isError).not.toBe(true);expect(JSON.stringify(catalog)).toContain('get_device_state');
    }finally{await client.close();}
    await host.invoke('maker:android:set-default-device',[{defaultDeviceSerial:null}]);
    expect(await host.invoke('maker:android:get-config')).toMatchObject({value:{defaultDeviceSerial:null,adbPathOverride:null},isCustomized:false});
  });
  // Integration: native document tools previously had no original path-grant
  // host. A real MCP read outside the task must follow live permissions and
  // remote confirmation, including Plan and stale-instance revocation.
  it('routes original document path grants through remote confirmation and live task permissions',async()=>{
    const {host,root}=await setup();const workdir=path.join(root,'task');await mkdir(workdir);
    const outside=path.join(root,'outside.csv');await writeFile(outside,'receipt\nnative-path-grant\n');
    const task=await host.invoke('maker:create-session',[{workingDir:workdir,permissionMode:'ask'}]) as {id:string};
    const session=host.channelRuntime().getSession(task.id)!;
    const provider=host.deviceTools.providers.find(p=>p.name==='cindy_docs')!;
    const context={sessionId:task.id,sessionInstanceId:session.instanceId,workingDir:workdir,agentKind:'claude-code' as const};
    const sdk=provider.toClaudeSdkConfig!({...context,getSessionContext:()=>context}) as {instance:McpServer};
    const [left,right]=InMemoryTransport.createLinkedPair(),client=new McpClient({name:'native-path-fixture',version:'1'});
    const read=async()=>{const result=await client.callTool({name:'read_sheet',arguments:{path:outside}});return JSON.parse((result.content as Array<{text:string}>)[0]!.text);};
    try{
      await sdk.instance.connect(left);await client.connect(right);
      for(const behavior of ['deny','allow'] as const){
        const result=read();let pending:Array<{request:{requestId:string;input:{lane:string;items:Array<{absPath:string}>}}}>=[];
        await vi.waitFor(async()=>{pending=await host.invoke('maker:get-pending-interactions',[task.id],{source:'remote',deviceId:'path-owner'}) as typeof pending;expect(pending).toHaveLength(1);});
        expect(pending[0].request.input).toMatchObject({lane:'outside_workdir',items:[{absPath:await realpath(outside)}]});
        await host.invoke('maker:resolve-interaction',[pending[0].request.requestId,{kind:'permission',behavior}],{source:'remote',deviceId:'path-owner'});
        const output=await result;
        if(behavior==='allow'){expect(output.ok).toBe(true);expect(JSON.stringify(output)).toContain('native-path-grant');}
        else expect(output.errorCode).toBe('PATH_NOT_ALLOWED');
      }
      await host.invoke('maker:set-permission-mode',[task.id,'bypassPermissions']);
      expect((await read()).ok).toBe(true);expect(await host.invoke('maker:get-pending-interactions',[task.id])).toEqual([]);
      await host.invoke('maker:set-plan-mode',[task.id,true]);expect((await read()).errorCode).toBe('PATH_NOT_ALLOWED');
      await host.invoke('maker:set-plan-mode',[task.id,false]);
      await host.invoke('maker:close-session',[task.id]);expect((await read()).errorCode).toBe('PATH_NOT_ALLOWED');
    }finally{await client.close();}
  });
  // Integration: the native helper could only receive remote task handoffs.
  // Two original Maker hosts now exchange messages and revalidate a queued
  // delivery after its source authorization is revoked. Transport is in-process.
  it('sends original task handoffs both ways and revokes queued remote delivery',async()=>{
    let first!:TerminalTaskHost,second!:TerminalTaskHost,lastReceipt='';
    const invoke=(source:'first'|'second')=>async(device:string,channel:string,args:unknown[])=>{
      expect(device).toBe(source==='first'?'second':'first');
      const target=source==='first'?second:first;
      if(source==='first'&&channel==='maker:session:handoff'&&(args[0] as {taskActionReceipt?:string}).taskActionReceipt)lastReceipt=(args[0] as {taskActionReceipt:string}).taskActionReceipt;
      try{return {ok:true,result:await target.invoke(channel,args,{source:'remote',deviceId:source,assertCurrent(){}})};}
      catch(error){return {ok:false,error:{code:'IPC_ERROR',message:error instanceof Error?error.message:String(error)}};}
    };
    const a=await setup(engine(),{remoteInvoke:invoke('first')});first=a.host;
    const b=await setup(engine(),{remoteInvoke:invoke('second')});second=b.host;
    const source=await first.invoke('maker:create-session',[{workingDir:a.root,title:'Source'}]) as {id:string};
    const target=await second.invoke('maker:create-session',[{workingDir:b.root,title:'Target'}]) as {id:string};
    const send=first.helperDeps({sessionId:source.id,workingDir:a.root,agentKind:'claude-code'}).sendToRemoteSession!;
    expect(await send({deviceId:'second',sessionId:target.id,message:'outward receipt',dispatcherSessionId:source.id})).toMatchObject({ok:true});
    await vi.waitFor(async()=>expect(JSON.stringify(b.native.sentFor(target.id)),JSON.stringify({
      receipt:await second.storage.latestSubmission(target.id),queue:await second.invoke('maker:input:get-projection',[target.id]),
    })).toContain('outward receipt'));
    await second.invoke('terminal:tasks:wait',[target.id,'remote-task-action:'+lastReceipt]);
    const messages=await second.invoke('local-db:messages:list',[target.id]) as Array<{role:string;agentMeta?:unknown}>;
    expect(messages.find(row=>row.role==='user')?.agentMeta).toMatchObject({
      origin:{kind:'session',senderSessionId:'first::'+source.id,displayText:'outward receipt'},
      autoReviewUserText:{kind:'agent-request',request:{userText:null}},
    });
    const back=second.helperDeps({sessionId:target.id,workingDir:b.root,agentKind:'claude-code'}).sendToRemoteSession!;
    expect(await back({deviceId:'first',sessionId:source.id,message:'return receipt',dispatcherSessionId:target.id})).toMatchObject({ok:true});
    await vi.waitFor(()=>expect(JSON.stringify(a.native.sentFor(source.id))).toContain('return receipt'));
    await second.invoke('maker:send',[target.id,{text:'wait-for-steer',clientId:'remote-hold'}]);await b.native.waitForHeld(target.id);
    let current=true;
    const admission=await admitTaskAction({sessionId:source.id,server:'cindy_helper',tool:'send_to_session',args:{targetSessionId:'second::'+target.id,message:'revoked remote message'}},
      {key:'native-handoff-fixture',ownerInput:true,delegated:false,async assertCurrent(){if(!current)throw new Error('AUTHORIZATION_REVOKED');}});
    if(!admission.ok||!admission.run)throw new Error('fixture admission failed');
    expect(await admission.run(()=>send({deviceId:'second',sessionId:target.id,message:'revoked remote message',dispatcherSessionId:source.id}))).toMatchObject({ok:true,wakeKind:'queued'});
    current=false;b.native.finishHeld(target.id);
    const requestId='remote-task-action:'+lastReceipt;
    expect(await second.invoke('terminal:tasks:wait',[target.id,requestId])).toMatchObject({status:'failed'});
    expect(JSON.stringify(b.native.sentFor(target.id))).not.toContain('revoked remote message');
  });
  // Integration: Node previously omitted live native quota events. Use the
  // original event recorder and actual SQLite snapshot; only official CLI
  // status output is synthetic, and no subscription credential is accessed.
  // Integration: the GUI invokes the original session service over Node. The
  // missing surface was previously hand-coded list/get/title-only mutations.
  // Minimal case: create -> pin -> archive -> restore -> delete, with a side
  // chat, through public endpoints and the actual owner SQLite transactions.
  it('serves the original GUI session lifecycle and preserves remote field authority', async () => {
    const { host, root, pushes } = await setup();
    const remote = { source: 'remote' as const, ownerId: 'owner', deviceId: 'controller', assertCurrent() {} };
    const task = await host.invoke('local-db:sessions:create', [{ id: 'original-session', title: 'Original', workingDir: root, agentKind: 'cc', providerId: 'fixture', model: 'test-model' }]) as { id: string };
    expect(task.id).toBe('original-session');
    await host.invoke('local-db:sessions:patch-meta', [task.id, { title: 'Renamed', pinnedAt: '2026-01-01T00:00:00.000Z' }], remote);
    expect(await host.invoke('local-db:sessions:get-many', [[task.id, 'missing']])).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, title: 'Renamed' })]));
    await expect(host.invoke('local-db:sessions:patch-meta', [task.id, { workingDir: path.dirname(root) }], remote)).rejects.toThrow('field not allowed');
    await expect(host.invoke('local-db:sessions:create', [{ title: 'Forged', source: 'bot' }])).rejects.toThrow('Bot task creation');
    await expect(host.invoke('local-db:sessions:create', [{ title: 'Remote create' }], remote)).rejects.toThrow('LOCAL_ONLY_COMMAND');
    await expect(host.invoke('local-db:sessions:update', [task.id, { extraDirs: [root] }])).rejects.toThrow();
    await host.invoke('local-db:sessions:patch-meta', [task.id, { status: 'archived' }], remote);
    expect(await host.invoke('local-db:sessions:list', [100, 'archived'], remote)).toEqual(expect.arrayContaining([expect.objectContaining({ id: task.id, status: 'archived' })]));
    await host.invoke('local-db:sessions:restore-if-archived', [task.id, { workingDir: root, workspaceKind: 'project', remoteHostId: null }], remote);
    expect(await host.invoke('local-db:sessions:get', [task.id], remote)).toMatchObject({ id: task.id, status: 'active', title: 'Renamed' });
    const db = await host.storage.database();
    await db.db.exec("INSERT INTO sessions (id,title,agent_kind,working_dir,source,parent_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", ['side-original', 'Side', 'cc', root, 'side-chat', task.id, Date.now(), Date.now()]);
    await host.invoke('terminal:tasks:delete', [task.id]);
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({ id: task.id, status: 'deleted' });
    expect(await host.invoke('local-db:sessions:get', ['side-original'])).toMatchObject({ status: 'deleted' });
    expect(pushes.some(push => push.channel === 'local-db:sessions:patched' && (push.payload as {sessionId:string}).sessionId === task.id)).toBe(true);
    await host.close();
  });

  // Integration: GUI history actions were absent from the Node dispatch table.
  // A rebuilt native thread is the smallest offline fixture that proves the
  // real fork transaction, copied messages, lineage and remote owner boundary.
  it('serves the original GUI read routes from the terminal host', async () => {
    const { host } = await setup();
    const auth = await host.invoke('maker:auth:get-state', ['codex']);
    expect(auth).toHaveProperty('authenticated');
    expect(await host.invoke('maker:api-key:present')).toEqual({ present: false });
    const plugins = await host.invoke('maker:plugins:list', []) as Array<{ id: string; effectiveEnabled: boolean }>;
    expect(plugins.some(plugin => plugin.id === 'collab')).toBe(true);
    expect(await host.invoke('maker:plugins:get-state', ['collab'])).toHaveProperty('effectiveEnabled');
    await host.invoke('maker:plugins:set-enabled', ['collab', false]);
    expect(await host.invoke('maker:plugins:get-state', ['collab'])).toMatchObject({ effectiveEnabled: false });
    await host.invoke('maker:plugins:clear-enabled', ['collab']);
    expect(await host.invoke('maker:plugins:get-state', ['collab'])).toMatchObject({ effectiveEnabled: true });
    expect(await host.invoke('maker:session-background-activity', ['missing'])).toEqual({ active: false });
    expect(await host.invoke('maker:session-background-activity:list')).toEqual({ sessionIds: [] });
    expect(await host.invoke('maker:session-background-tasks:list', ['missing'])).toEqual({ tasks: [], pendingContinuations: 0 });
    expect(await host.invoke('maker:agent:binary-version', ['codex'])).toMatchObject({ kind: 'codex', latestVersion: null, updateAvailable: false });
    expect(await host.invoke('maker:list-agent-commands', ['codex'])).toMatchObject({ success: true });
    expect(await host.invoke(DL_SESSION_REFERENCE_CAPABILITY_CHANNEL)).toEqual({ supported: true, version: 1 });
  });

  it('forks rebuilt history and creates side chats through original remote routes',async()=>{
    const {host,root,create}=await setup();
    const db=(await host.database).db, now=Date.now()-1000, id='history-source';
    await db.exec('INSERT INTO sessions (id,title,agent_kind,model,provider_id,working_dir,sdk_session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id,'Source','codex','historical-model','retired-provider',root,'new-native-thread',now,now]);
    for(const [key,role,content,at,withdrawn] of [
      ['q','user',JSON.stringify({text:'Original question'}),now+1,null],
      ['a','assistant',JSON.stringify({text:'Original answer'}),now+2,null],
      ['rebuild','context_rebuild',JSON.stringify({reason:'context-overflow',sourceAgentKind:'codex',sourceModel:'historical-model',sourceProviderId:'retired-provider'}),now+3,now+3],
    ])await db.exec('INSERT INTO messages (id,client_id,session_id,role,content,created_at,rewind_at) VALUES (?,?,?,?,?,?,?)',[key,key,id,role,content,at,withdrawn]);
    const remote={source:'remote' as const,deviceId:'fixture-controller',ownerId:'fixture-owner',assertCurrent(){}};
    const fork=await host.invoke('maker:fork',[id,'a'],remote) as {id:string};
    expect(await host.invoke('local-db:sessions:get',[fork.id],remote)).toMatchObject({parentSessionId:id,agentKind:'codex',model:'historical-model'});
    const rows=await host.invoke('local-db:messages:list',[fork.id],remote) as Array<{role:string;content:unknown}>;
    expect(rows.filter(row=>['user','assistant'].includes(row.role)&&row.content!=='').reverse().map(row=>row.content)).toEqual([{text:'Original question'},{text:'Original answer'}]);
    const side=await host.invoke('maker:side-chat:v1',[id],remote) as {id:string};
    expect(await host.invoke('maker:side-chat:list:v1',[id],remote)).toEqual([{id:side.id}]);
    await expect(host.invoke('maker:side-chat:v1',[id],{...remote,sharedTask:{sharedTaskId:'share',sessionId:id,memberId:'member',accountId:'guest'}})).rejects.toThrow('SHARED_TASK_PERMISSION_DENIED');
    await host.invoke('maker:message:delete',[id,'a'],remote);
    const visible=await host.invoke('local-db:messages:list',[id],remote) as typeof rows;
    expect(visible.some(row=>JSON.stringify(row.content).includes('Original answer'))).toBe(false);
    expect(visible.some(row=>JSON.stringify(row.content).includes('Original question'))).toBe(true);
    await host.close();const restarted=create();await restarted.ready;
    expect(await restarted.invoke('maker:side-chat:list:v1',[id],remote)).toEqual([{id:side.id}]);
    expect(await restarted.invoke('local-db:sessions:get',[fork.id],remote)).toMatchObject({parentSessionId:id});
  });

  // Integration: a remote rewind must stop the real host input coordinator,
  // commit its original history transaction and retain queued work paused.
  // Only the provider's native rewind response is substituted, as in engine().
  it('rewinds a running task through the original remote route without replaying its queue',async()=>{
    const {host,root,native}=await setup();
    await host.models.saveProvider({id:'rewind-fixture',name:'Fixture',auth:{method:'none'},runtimes:{codex:{
      baseUrl:'http://127.0.0.1:1',wireProtocol:'openai-responses',models:[{id:'rewind-model',name:'Fixture'}],
    }}},{},true);
    const task=await host.invoke('maker:create-session',[{agentKind:'codex',providerId:'rewind-fixture',model:'rewind-model',workingDir:root}]) as {id:string};
    await host.invoke('maker:send',[task.id,{text:'wait-for-steer',clientId:'rewind-user'}]);
    await native.waitForHeld(task.id);
    const session=host.channelRuntime().getSession(task.id) as Session;
    const rewind=vi.spyOn(session,'commitRewindFiles').mockResolvedValue(undefined);
    const client={invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient;
    await enqueueMessage(client,task.id,'Queued after rewind','rewind-queued');
    const remote={source:'remote' as const,deviceId:'fixture-controller',ownerId:'fixture-owner',assertCurrent(){}};
    try {
      await host.invoke('maker:rewind:commit',[task.id,'rewind-user',{stopIfRunning:true,allowFileRestore:false}],remote);
      expect(rewind).toHaveBeenCalledOnce();
      expect(session.isTurnRunning()).toBe(false);
      expect(await host.invoke('local-db:messages:list',[task.id],remote)).toEqual([]);
      expect(await host.invoke('maker:input:get-projection',[task.id],remote)).toMatchObject({queuePaused:true,pendingQueue:[expect.objectContaining({clientId:'rewind-queued'})]});
      expect(native.sentFor(task.id)).toHaveLength(1);
    }finally{rewind.mockRestore();}
  });

  // Integration: original deletion used the desktop-wide Pi home, missing
  // Node's per-task native homes. Public deletion + restart + original IM
  // revival must share the same durable marker and cancel cleanup on revival.
  it('cleans the actual Pi task home and retires its deletion marker on IM revival', async () => {
    const { host, root, create } = await setup();
    await host.models.saveProvider({ id: 'pi-fixture', name: 'Pi fixture', auth: { method: 'none' }, runtimes: { pi: {
      baseUrl: 'http://127.0.0.1:1', wireProtocol: 'openai-chat', models: [{ id: 'pi-fixture', name: 'Pi fixture' }],
    } } }, {}, true);
    await host.channelDefaults.update({ agents: { pi: { providerId: 'pi-fixture', model: 'pi-fixture', effort: 'high' } } }, 'telegram');
    const config = { agentKind: 'pi' as const, defaultModel: 'pi-fixture', defaultPermissionMode: 'auto' as const };
    const namespace = { source: 'telegram' as const, sessionIdFor: () => 'telegram_pi_fixture', defaultTitle: () => 'Pi task', ensureWorkingDir: () => root, extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }) };
    const task = await host.channelRepository(config, namespace).createSession('bot', 'owner');
    const home = path.join(root, 'engines', 'pi', task.id);
    const runs = piSubagentRunRoot(home, task.id), marker = piSubagentDeletedTombstonePath(home, task.id);
    await mkdir(runs, { recursive: true });
    await host.invoke('terminal:tasks:delete', [task.id]);
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(marker, 'utf8'))).toMatchObject({ sessionId: task.id });
      await expect(access(runs)).rejects.toMatchObject({ code: 'ENOENT' });
    }, { interval: 1 });
    await host.close();
    // Emulate a crash after the database commit, before the marker was saved.
    await rm(marker); await mkdir(runs, { recursive: true });
    const restored = create(); await restored.ready;
    await vi.waitFor(async () => {
      await access(marker);
      await expect(access(runs)).rejects.toMatchObject({ code: 'ENOENT' });
    }, { interval: 1 });
    const revived = await restored.channelRepository(config, namespace).findActiveSession('bot', 'owner');
    expect(revived?.id).toBe(task.id);
    expect(await restored.invoke('local-db:sessions:get', [task.id])).toMatchObject({ status: 'active' });
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'pi-agent-home'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // Integration: native import handlers were never registered in Node. Read a
  // synthetic external rollout through the original scanner and importer;
  // scanning is read-only and repeated explicit imports retain one task.
  it('imports a selected native transcript through the original local API', async () => {
    const fakeHome = await mkdtemp(path.join(os.tmpdir(), 'cindy-import-home-')); roots.push(fakeHome);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    const environment = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'XDG_CONFIG_HOME'] as const;
    const before = environment.map(key => process.env[key]);
    const codexHome = path.join(fakeHome, '.codex');
    for (const key of environment) process.env[key] = key === 'CODEX_HOME' ? codexHome : path.join(fakeHome, key.toLowerCase());
    let host: TerminalTaskHost | undefined;
    try {
      ({ host } = await setup());
      const sdk = '019dcd5a-6e54-7960-95e0-aa68117a28d1';
      const directory = path.join(codexHome, 'sessions'); await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, `rollout-${sdk}.jsonl`), [
        { type: 'session_meta', timestamp: '2026-05-13T00:00:00.000Z', payload: { id: sdk, timestamp: '2026-05-13T00:00:00.000Z', cwd: fakeHome, source: 'cli', model_provider: 'openai' } },
        { type: 'response_item', timestamp: '2026-05-13T00:00:01.000Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Synthetic imported request' }] } },
        { type: 'response_item', timestamp: '2026-05-13T00:00:02.000Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Synthetic imported reply' }] } },
      ].map(row => JSON.stringify(row)).join('\n') + '\n');
      const scan = await host.invoke('local-db:session-import:scan', []) as { candidates: Array<{ id: string; source: string }> };
      expect(scan.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ id: sdk, source: 'codex' })]));
      expect(await host.invoke('local-db:sessions:list', [])).toEqual([]);
      await expect(host.invoke('local-db:session-import:scan', [], { source: 'remote' })).rejects.toThrow('LOCAL_ONLY_COMMAND');
      expect(await host.invoke('local-db:session-import:import', [{ items: [{ source: 'codex', id: sdk }] }])).toMatchObject({ inserted: 1 });
      const imported = await host.invoke('local-db:sessions:list', []) as Array<{ id: string; sdkSessionId: string }>;
      expect(imported).toHaveLength(1); expect(imported[0]?.sdkSessionId).toBe(sdk);
      const messages = await host.invoke('local-db:messages:list', [imported[0]!.id]);
      expect(JSON.stringify(messages)).toContain('Synthetic imported reply');
      expect(await host.invoke('local-db:session-import:import', [{ items: [{ source: 'codex', id: sdk }] }])).toMatchObject({ inserted: 0 });
      expect(await host.invoke('local-db:sessions:list', [])).toHaveLength(1);
    } finally {
      await host?.close(); homedir.mockRestore();
      for (const [i, key] of environment.entries()) { if (before[i] === undefined) delete process.env[key]; else process.env[key] = before[i]; }
    }
  });

  it('persists live Claude quota events and drops them after native disconnect', async () => {
    const { host } = await setup();
    const { TerminalClaudeLogin } = await import('../models/claude-login.js');
    let binding: string | null = null;
    const native = new TerminalClaudeLogin({ owner: 'usage-fixture', readBinding: () => binding, writeBinding: value => { binding = value; },
      binary: async () => '/fixture/claude', assertCurrent() {}, changed() {},
      run: async () => ({ code: 0, stdout: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'usage@example.invalid', subscriptionType: 'max' }), stderr: '' }),
    });
    host.models.nativeClaude = native;
    const ticket = await native.begin(); await native.finish(ticket.id);
    const event = { status: 'allowed', rateLimitType: 'five_hour', utilization: 0.4 };
    await host.usage.accounts.onClaudeRateLimitInfo(event);
    expect(await host.usage.readClaudeSubscriptionUsageSnapshot()).toMatchObject({ fiveHour: { utilization: 40 }, subscriptionType: 'max', accountFingerprint: native.usageAccountFingerprint() });
    native.disconnect();
    await host.usage.accounts.syncCredentialChanges('anthropic');
    await host.usage.accounts.onClaudeRateLimitInfo(event);
    expect(await host.usage.readClaudeSubscriptionUsageSnapshot()).toBeNull();
  });

  // Integration: GUI usage channels were absent on the Node host. Two actual
  // SQLite ledgers must serialize and combine via the original public APIs,
  // including persisted task metadata and owner-only access.
  it('serves original usage history and combines the selected remote computer', async () => {
    const first = await setup(engine(), { deviceId: 'usage-a' });
    const second = await setup(engine(), { deviceId: 'usage-b' });
    const ids: string[] = [];
    for (const [index, fixture] of [first, second].entries()) {
      const task = await fixture.host.invoke('maker:create-session', [{ title: `Usage ${index}` }]) as { id: string };
      ids.push(task.id);
      const money = { amount: index + 1, currency: 'USD' as const, approximate: false, kind: 'actual-cost' as const };
      await fixture.host.usage.dailySpend.incrementDailySpend(money);
      await fixture.host.usage.dailyModel.incrementDailyModelUsage({ agentKind: 'claude-code', model: 'test-model', money, inputTokensDelta: 10, outputTokensDelta: index + 1, cacheReadTokensDelta: 0, cacheCreateTokensDelta: 0 });
      await fixture.host.usage.dailySession.incrementDailySessionUsage(task.id, 11 + index);
    }
    const { decodeUsageDeviceRowsResponse } = await import('@cindy/app-runtime/usageDeviceRows');
    const remoteContext = { source: 'remote' as const, deviceId: 'usage-a' };
    const wire = await second.host.invoke('maker:usage:device-rows', [{}], remoteContext);
    expect(await decodeUsageDeviceRowsResponse(wire)).toMatchObject({ rows: { sessionRows: [expect.objectContaining({ sessionId: ids[1], tokens: 12 })] } });
    const local = await first.host.invoke('maker:usage:history', [{ includeTasks: true }]) as { totals: { todayTokens: number }; tasks: Array<{ sessionId: string }> };
    expect(local.totals.todayTokens).toBe(11);
    expect(local.tasks.some(task => task.sessionId === ids[0])).toBe(true);
    first.host.usageApi.bindPeers({
      listDevices: async () => ({ devices: [{ deviceId: 'usage-b', name: 'Server', platform: 'linux', appVersion: (await import('../version.js')).VERSION, online: true, busy: false, isSelf: false, remoteControlEnabled: true, controlEnabled: true, lastSeenAt: null }] }),
      invoke: async (device, channel, args) => { expect(device).toBe('usage-b'); expect(channel).toBe('maker:usage:device-rows'); return { ok: true, result: await second.host.invoke(channel, args, remoteContext) }; },
    });
    await vi.waitFor(async () => {
      const combined = await first.host.invoke('maker:usage:history', [{ device: 'all', includeTasks: true, forceRefresh: true }]) as { totals: { todayTokens: number; today: { amount: number } }; tasks: Array<{ sessionId: string; deviceId: string }> };
      expect(combined.totals).toMatchObject({ todayTokens: 23, today: { amount: 3 } });
      expect(combined.tasks.some(task => task.sessionId === ids[1] && task.deviceId === 'usage-b')).toBe(true);
    }, { interval: 1 });
    await expect(first.host.invoke('maker:usage:device-rows', [{ sinceDay: 'invalid' }], remoteContext)).rejects.toThrow();
  });
  // Integration: the previous Node host bypassed installed message hooks. Drive
  // the public queue through the real plugin reply pipe, DB and original gateway;
  // only the native plugin process and model transport are substituted.
  // Standard integration: the event journal dropped original tool pairing,
  // reply IDs and completion seals. Real Maker + public queue + SQLite;
  // only the provider transport is synthetic. Restart preserves exact IDs.
  it('persists native replies and tools through the original transcript without an event journal', async () => {
    const {host,root,create,native,nextPush,pushes}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    native.responses.set('transcript fixture',[
      {type:'text',source:'claude-code',data:{text:'Before tool',isFinal:false}},
      {type:'tool_use',source:'claude-code',data:{toolUseId:'read-fixture',toolName:'Read',input:{file_path:'fixture.txt'}}},
      {type:'tool_result_full',source:'claude-code',data:{toolUseId:'read-fixture',fullText:'Tool output',isError:false}},
      {type:'text',source:'claude-code',data:{text:'Final reply',isFinal:true}},
      {type:'done',source:'claude-code',data:{result:'Final reply'}},
    ]);
    const finished=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'transcript fixture','transcript-user');
    await finished;
    const rows=await host.invoke('local-db:messages:list',[task.id]) as Array<{id:string;clientId:string;role:string;content:unknown;agentMeta?:{turnCompleted?:boolean}}>;
    expect(rows.slice().reverse().map(row=>row.role)).toEqual(['user','assistant','tool_use','tool_result','assistant']);
    expect(rows[0]).toMatchObject({content:'Final reply',agentMeta:{turnCompleted:true}});
    expect(JSON.stringify(rows.find(row=>row.role==='tool_result')?.content)).toContain('Tool output');
    const events=pushes.filter(push=>push.channel==='maker:event').map(push=>push.payload as {event:AgentEvent;persistId?:string});
    expect(events.find(push=>push.event.type==='tool_use')?.persistId).toBe(rows.find(row=>row.role==='tool_use')?.clientId);
    expect(events.every(push=>push.event.sessionInstanceId===undefined&&push.event.sessionTurnGeneration===undefined)).toBe(true);
    const completed = await readTerminalWorkerCompletion(host, task.id, 'idle');
    expect(completed).toMatchObject({status:'done', completedAt:expect.any(Number)});
    await expect(access(path.join(root,'tasks',task.id,'events.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
    await host.close();
    const restored=create();await restored.ready;
    expect((await restored.invoke('local-db:messages:list',[task.id]) as typeof rows).map(row=>row.id)).toEqual(rows.map(row=>row.id));
    expect(await readTerminalWorkerCompletion(restored, task.id, 'idle')).toMatchObject({status:'done', completedAt:completed.completedAt});
  });

  // Integration: the Node host used a hardcoded disabled Git policy and bypassed
  // original session opening. Real Git + public creation/input prove the baseline
  // precedes the native edit and settings/history survive restart (provider fake).
  it('uses original opening settings and captures Git state before native file edits',async()=>{
    const f=await setup(engine(undefined,async(_input,options)=>{await writeFile(path.join(options.workingDir!,'seed.txt'),'after native edit\n');}));
    expect(await f.host.invoke('maker:git-safety:get')).toMatchObject({mode:'existing-git',autoSnapshotEnabled:true,isCustomized:false});
    const dialogue=await f.host.invoke('maker:create-session',[{}]) as {id:string};
    const dialogueRow=await f.host.storage.get(dialogue.id);
    expect(dialogueRow).toMatchObject({workspaceKind:'dialogue'});
    expect(dialogueRow!.workDir.startsWith(path.join(f.root,'dialogues')+path.sep)).toBe(true);
    await expect(access(path.join(dialogueRow!.workDir,'.git'))).rejects.toMatchObject({code:'ENOENT'});
    const repo=path.join(f.root,'project');await mkdir(repo);
    const git=(...args:string[])=>promisify(execFile)('git',args,{cwd:repo,env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:os.devNull}});
    await git('init');await git('config','user.name','Fixture');await git('config','user.email','fixture@example.invalid');
    await writeFile(path.join(repo,'seed.txt'),'before native edit\n');await git('add','seed.txt');await git('commit','--no-gpg-sign','-m','seed');
    const head=(await git('rev-parse','HEAD')).stdout.trim();
    const task=await f.host.invoke('maker:create-session',[{workingDir:repo}]) as {id:string};
    const done=f.nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>f.host.invoke(channel,args)} as TerminalClient,task.id,'edit seed','git-user');
    await done;
    await f.host.invoke('maker:git-safety:set',['off']);
    await f.host.close();
    const commits=(await git('log','--format=%H',`refs/cindy/savepoints/${task.id}`)).stdout.trim().split('\n');
    expect(commits.length).toBeGreaterThanOrEqual(1);
    const baseline=commits[commits.length-1];
    expect((await git('show',baseline+':seed.txt')).stdout).toBe('before native edit\n');
    expect((await git('show','-s','--format=%B',baseline)).stdout).toContain('git-user');
    expect((await git('rev-parse','HEAD')).stdout.trim()).toBe(head);
    expect(await readFile(path.join(repo,'seed.txt'),'utf8')).toBe('after native edit\n');
    const restored=f.create();await restored.ready;
    expect(await restored.invoke('maker:git-safety:get')).toMatchObject({mode:'off',isCustomized:true});
    expect(await restored.invoke('maker:git-safety:reset')).toMatchObject({mode:'existing-git',isCustomized:false});
  });

  // Integration: remote Goal controls previously had no Node handler. Exercise
  // the original controller, live Maker, event persistence and completion record.
  it('runs a remotely configured goal through the original controller and transcript',async()=>{
    let native:ReturnType<typeof engine>;
    native=engine(undefined,async()=>{
      const message=native.sent[native.sent.length-1];
      let text=typeof message.content==='string'?message.content:'';
      const prefix=buildUiLanguageErrorNote('en')+'\n\n';if(text.startsWith(prefix))text=text.slice(prefix.length);
      native.responses.set(text,[{type:'text',source:'claude-code',data:{text:'Completed the fixture.\n```json\n{"goal_status":"complete","reason":"Finished"}\n```',isFinal:true}},
        {type:'done',source:'claude-code',data:{}}]);
    });
    const f=await setup(native);
    const task=await f.host.invoke('maker:create-session',[{}]) as {id:string};
    const completed=f.nextPush('maker:goal:status-changed',value=>(value as {sessionId:string;goal:unknown}).sessionId===task.id&&(value as {goal:unknown}).goal===null);
    expect(await f.host.invoke('maker:goal:set',[{sessionId:task.id,objective:'Complete the fixture'}],{source:'remote'})).toEqual({ok:true});
    await completed;
    expect(await f.host.invoke('maker:goal:get-status',[task.id],{source:'remote'})).toBeNull();
    await (await f.host.conversations).persistence.drainPersistQueue();
    const rows=await f.host.invoke('local-db:messages:list',[task.id]) as Array<{role:string;content:unknown;agentMeta?:{goalObjective?:unknown;goalCompletion?:{turnsUsed:number}}}>;
    expect(rows.find(row=>row.role==='user')).toMatchObject({content:'Complete the fixture',agentMeta:{goalObjective:{updated:false}}});
    expect(rows.find(row=>row.agentMeta?.goalCompletion)).toBeTruthy();
    expect(native.sent).toHaveLength(1);
  });

  // Standard integration: remote clear previously had no Node endpoint. Use
  // the public queue, real native host and SQLite; an old device clock must not
  // poison the host watermark or revive the persisted queue/handoff on restart.
  it('clears the original queue, transcript and handoff through the remote endpoint across restart',async()=>{
    const {host,create,native,nextPush}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const done=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'before clear','before-clear-user');
    await done;
    await persistHandoffFixture(host,task.id,'old-handoff','Old context must stay cleared');
    await host.invoke('maker:input:set-interaction-lock',[task.id,'composer-edit',true]);
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'queued before clear','before-clear-queued');
    const started=Date.now();
    await host.invoke('maker:input:clear-session',[task.id,'2099-01-01T00:00:00.000Z'],{source:'remote'});
    const boundary=(await host.storage.get(task.id))!.clearedAt!;
    expect(boundary).toBeGreaterThanOrEqual(started);
    expect(boundary).toBeLessThanOrEqual(Date.now());
    expect(await host.invoke('local-db:messages:list',[task.id])).toEqual([]);
    expect(await host.invoke('maker:input:get-projection',[task.id])).toMatchObject({pendingQueue:[]});
    await host.close();
    const restarted=create();
    expect(await restarted.invoke('local-db:messages:list',[task.id],{source:'remote'})).toEqual([]);
    expect(await restarted.invoke('maker:input:get-projection',[task.id])).toMatchObject({pendingQueue:[]});
    const nextDone=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>restarted.invoke(channel,args)} as TerminalClient,task.id,'after clear','after-clear-user');
    await nextDone;
    const rows=await restarted.invoke('local-db:messages:list',[task.id]) as Array<{clientId:string;content:unknown}>;
    expect(rows.some(row=>row.clientId==='after-clear-user')).toBe(true);
    expect(JSON.stringify(native.sent.at(-1))).not.toContain('Old context must stay cleared');
    expect(native.sent).toHaveLength(2);
  });

  // Standard integration: a deleted bound directory formerly made the Node
  // send preflight reject forever. The original recovery recreates it and
  // preserves the task binding; this drives that path through public enqueue.
  it('recovers a removed bound directory through the original send preflight',async()=>{
    const {host,root,native,nextPush}=await setup();
    const workingDir=path.join(root,'recoverable-project');await mkdir(workingDir);
    const task=await host.invoke('maker:create-session',[{workingDir}]) as {id:string};
    const done=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'before removing directory','dir-before');
    await done;
    await rm(workingDir,{recursive:true});
    const resumed=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='done');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'after removing directory','dir-after');
    await resumed;
    await expect(access(workingDir)).resolves.toBeUndefined();
    expect((await host.storage.get(task.id))?.workDir).toBe(workingDir);
    expect(native.sent).toHaveLength(2);
    expect(JSON.stringify(native.sent.at(-1))).toContain('after removing directory');
    const rows=await host.invoke('local-db:messages:list',[task.id]) as Array<{clientId:string}>;
    expect(rows.some(row=>row.clientId==='dir-after')).toBe(true);
  });

  // Standard integration: the Node host did not attach ordinary account-limit
  // recovery. A synthetic native error supplies the provider reset time; all
  // queue ownership, saved waits, owner startup and cancellation use production.
  it('restores a native account-limit wait before releasing the owner startup queue',async()=>{
    let scheduled!:()=>void;
    const saved=new Promise<void>(resolve=>{scheduled=resolve;});
    const native=engine();
    const f=await setup(native,{deferPendingTasks:true,nativeStatus:async()=>({authenticated:true}),
      logger:{...logger,info:(message)=>{if(message==='usage-limit auto-resume scheduled')scheduled();}},
    });
    await f.host.resumePending();
    f.host.models.catalogRuntime.setAnthropicDiscoveredModels([{id:'quota-native-fixture',name:'Quota fixture',contextWindow:200000,efforts:[],defaultEffort:null}]);
    const provider=(await f.host.models.views()).find(row=>row.id==='anthropic')!;
    const model=provider.models['claude-code']!.find(row=>!row.disabled&&row.defaultEnabled!==false)!;
    const task=await f.host.invoke('maker:create-session',[{agentKind:'claude-code',providerId:provider.id,model:model.id}]) as {id:string};
    native.responses.set('quota fixture',[{type:'error',source:'claude-code',data:{message:'Account usage limit reached',usageLimit:true,usageResetAt:Date.now()+3_600_000,isTerminal:true}}]);
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>f.host.invoke(channel,args)} as TerminalClient,task.id,'quota fixture','quota-user');
    await saved;
    const before=await f.host.invoke('maker:input:get-projection',[task.id]) as {usageLimitWait:{resumeAt:number}};
    expect(before.usageLimitWait.resumeAt).toBeGreaterThan(Date.now());
    await f.host.close();
    const restarted=f.create();await restarted.ready;
    expect(native.sent).toHaveLength(1);
    await restarted.resumePending();
    expect(await restarted.invoke('maker:input:get-projection',[task.id])).toMatchObject({usageLimitWait:{resumeAt:before.usageLimitWait.resumeAt}});
    expect(native.sent).toHaveLength(1);
    await restarted.invoke('maker:input:cancel-usage-limit-wait',[task.id]);
    await restarted.close();
    const cancelled=f.create();await cancelled.ready;await cancelled.resumePending();
    expect((await cancelled.invoke('maker:input:get-projection',[task.id]) as {usageLimitWait?:unknown}).usageLimitWait).toBeFalsy();
    expect(native.sent).toHaveLength(1);
  });

  // Integration: the original scheduler must keep ownership during account
  // quota waits, and pause must cancel that same waiter without replay. Synthetic
  // native quota errors; real runner, coordinator, SQLite and public controls.
  it('keeps a scheduled run pending during quota wait and cancels only that run on pause', async () => {
    let scheduled!: () => void;
    const saved = new Promise<void>(resolve => { scheduled = resolve; });
    let injectQuota = true;
    const native = engine(undefined, async () => {
      if (!injectQuota) return;
      injectQuota = false;
      const text = String(native.sent.at(-1)!.content).replace(buildUiLanguageErrorNote('en') + '\n\n', '');
      native.responses.set(text, [{type:'error',source:'claude-code',data:{message:'Account usage limit reached',usageLimit:true,usageResetAt:Date.now()+3_600_000,isTerminal:true}}]);
    });
    const f = await setup(native, { nativeStatus: async () => ({authenticated:true}),
      logger: {...logger, info: message => { if (message === 'usage-limit auto-resume scheduled') scheduled(); }},
    });
    f.host.models.catalogRuntime.setAnthropicDiscoveredModels([{id:'quota-native-fixture',name:'Quota fixture',contextWindow:200000,efforts:[],defaultEffort:null}]);
    const provider = (await f.host.models.views()).find(row => row.id === 'anthropic')!;
    const model = provider.models['claude-code']!.find(row => !row.disabled && row.defaultEnabled !== false)!;
    const task = await f.host.invoke('maker:create-session', [{agentKind:'claude-code',providerId:provider.id,model:model.id}]) as {id:string};
    const scheduler = new TerminalSchedulerHost({profileDir:f.root,tasks:f.host,logger,emit(){}}); schedulers.push(scheduler);
    const schedule = await scheduler.invoke('maker:schedule:create', [{name:'Quota run',prompt:'quota scheduled message',kind:'cron',cronExpr:'0 * * * *',timezone:'UTC',manual:true,recurring:true,
      targetSessionId:task.id,persistentSession:true,agentKind:'claude-code',notify:{desktop:false,feishu:false}}]) as {id:string};
    const run = scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    await saved;
    expect((await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{status:string}>)[0].status).toBe('running');
    expect(await f.host.invoke('maker:input:get-projection', [task.id])).toMatchObject({usageLimitWait:{resumeAt:expect.any(Number)}});
    await scheduler.invoke('maker:schedule:pause', [schedule.id]); await run;
    expect(native.sentFor(task.id)).toHaveLength(1);
    expect((await f.host.invoke('maker:input:get-projection', [task.id]) as {usageLimitWait?:unknown}).usageLimitWait).toBeFalsy();
    await f.host.invoke('maker:send', [task.id, 'owner after paused schedule']);
    await vi.waitFor(() => expect(native.sentFor(task.id).at(-1)?.content).toContain('owner after paused schedule'));
    await vi.waitFor(() => expect(f.host.isTurnRunning(task.id)).toBe(false));
    expect(native.sentFor(task.id)).toHaveLength(2);
    expect((await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{status:string}>)[0].status).not.toBe('success');
  });

  // Standard integration: native image bytes must survive provider shutdown
  // and be visible through the same history/media service used remotely.
  it('stores native generated images through the original ledger and restores their messages', async () => {
    const {host,create,native,nextPush}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9kAAAAASUVORK5CYII=','base64');
    native.responses.set('generated image fixture',[
      {type:'image',source:'codex',data:{kind:'generation',blockId:'original-native-image',data:bytes.toString('base64')}},
      {type:'done',source:'claude-code',data:{}},
    ]);
    const saved=nextPush('maker:event',value=>(value as {event?:AgentEvent}).event?.type==='tool_result_full');
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.id,'generated image fixture','image-user');
    const delivered=await saved as {persistId:string;resolvedContent:string};
    const url=delivered.resolvedContent.match(/cindy-media:\/\/blobs\/[a-f0-9]+\.[a-z0-9]+/)?.[0];
    expect(url).toBeTruthy();
    const media=await host.media.persisted();
    expect(await readFile(media.blobStore.resolveSafe(url!).absPath)).toEqual(bytes);
    const before=await host.invoke('local-db:messages:list',[task.id]) as Array<{clientId:string;role:string;content:unknown}>;
    expect(before.find(row=>row.clientId===delivered.persistId)?.role).toBe('tool_result');
    expect(JSON.stringify(before)).toContain(url);
    await host.close();const restored=create();await restored.ready;
    const after=await restored.invoke('local-db:messages:list',[task.id]) as typeof before;
    expect(after.find(row=>row.clientId===delivered.persistId)).toEqual(before.find(row=>row.clientId===delivered.persistId));
  });

  it('applies original plugin message hooks before native dispatch and publishes turn subscriptions', async () => {
    const {host, root, native, nextPush, pushes} = await setup();
    const conversations = await host.conversations, database = await host.database;
    const vault = new Map<string,string>();
    let rewritten!:()=>void;const replyRewritten=new Promise<void>(resolve=>{rewritten=resolve;});
    const plugins = new TerminalPlugins({root:path.join(root,'plugin-host'),deferStart:true,runtimeDirectory:root,
      executablePath:async()=>{throw new Error('Fixture must not start Chromium');},assertCurrent(){},locale:()=> 'en',changed(){},
      secrets:{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);},getSync:key=>vault.get(key)??null,setSync:(key,value)=>{vault.set(key,value);},deleteSync:key=>{vault.delete(key);},setManySync:entries=>{for(const [key,value] of Object.entries(entries)){if(value===null)vault.delete(key);else vault.set(key,value);}}},
      receive:async()=>({ok:false}),cards:{persist:async()=>{},broadcast(){}},
      fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false,reason:'cancelled'}),writeSaveDeposit:async()=>{throw new Error('unused');}},
      events:{getDbClient:database.getDbClient,assertCurrent(){},logger,
        updateMessageContent:conversations.messages.updateMessageContent,
        saveCard:row=>host.media.savePluginCard(row,()=>{}),publish:(channel,payload)=>{pushes.push({channel,payload});if(channel==='ghosts:assistant-message-rewritten')rewritten();}},
    });
    const pluginId='_root__message-fixture';
    const installed={dir:path.join(root,pluginId),enabled:true,approval:{state:'approved',revision:'00000000-0000-4000-8000-000000000001'},
      instanceKey:pluginId,namespace:null,manifest:{id:'message-fixture',name:'Message fixture',version:'1.0.0',mainView:{html:'main.html'},
        subscribe:{topics:['turn'],hooks:['will-user-message','will-assistant-message']}}} as unknown as import('@cindy/plugin-runtime/shared/ghost').InstalledGhost;
    const deliveries:Array<{name:string;data?:Record<string,unknown>}>=[];
    try {
      await plugins.ready;
      const list=vi.spyOn(plugins.native,'list').mockReturnValue([installed]);
      const running=vi.spyOn(plugins.native.runtime!,'stateOf').mockReturnValue('running');
      const send=vi.spyOn(plugins.native.web!,'send').mockImplementation((id,payload)=>{
        const frame=payload as unknown as {name:string;hookId?:string;data?:Record<string,unknown>};deliveries.push(frame);
        if(frame.hookId)void plugins.receive(id,{type:'event-verdict',hookId:frame.hookId,
          ...(frame.name==='will-assistant-message'?{action:'rewrite',text:'Reply rewritten by installed hook'}:frame.data?.text==='blocked original' ? {action:'block',reason:'Fixture restriction'} : {action:'rewrite',text:'rewritten by installed hook'})});
        return true;
      });
      plugins.events!.reconcile();host.configurePluginEvents(plugins.events!);
      const task=await host.invoke('maker:create-session',[{}]) as {id:string};
      const client={invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient;
      const blocked=nextPush('ghosts:message-blocked');
      await enqueueMessage(client,task.id,'blocked original','hook-blocked');
      expect(await blocked).toMatchObject({sessionId:task.id,clientId:'hook-blocked',reason:'Fixture restriction'});
      expect(native.sentFor(task.id)).toEqual([]);
      expect(await host.invoke('local-db:messages:list',[task.id])).toEqual([]);
      await enqueueMessage(client,task.id,'rewrite original','hook-rewritten');
      expect(await waitForTurn(client,task.id,'hook-rewritten')).toMatchObject({status:'completed',finalText:'Reply rewritten by installed hook'});
      await replyRewritten;
      expect((await host.invoke('local-db:messages:list',[task.id]) as Array<{role:string;content:unknown}>).find(row=>row.role==='assistant')?.content).toBe('Reply rewritten by installed hook');
      expect(JSON.stringify(native.sentFor(task.id))).toContain('rewritten by installed hook');
      expect(JSON.stringify(native.sentFor(task.id))).not.toContain('rewrite original');
      const users=await conversations.invoke('local-db:messages:list',[task.id],{source:'local'}) as Array<{role:string;content:string}>;
      expect(users.filter(row=>row.role==='user')).toMatchObject([{content:'rewritten by installed hook'}]);
      expect(deliveries.some(frame=>frame.name==='did-turn-start')).toBe(true);
      expect(deliveries.some(frame=>frame.name==='did-turn-end')).toBe(true);
      expect(await host.generateTaskTitle({sessionId:task.id,message:'not sent to an auxiliary model'})).toBeNull();
      send.mockRestore();running.mockRestore();list.mockRestore();
    } finally { await host.close();await plugins.close(); }
  });

  // Integration: headless group input previously bypassed the original group
  // service entirely. Exercise GUI create, remote send, real Maker lane/SQLite
  // settlement and idempotent replay through the production registrations.
  it('runs original group lanes from GUI and remote resources in the same task host', async () => {
    const { host, root, vault, native, pushes } = await setup();
    await host.models.setVisibility('claude-code', 'fixture', ['test-model'], true);
    await connectCompanionFixture(host, root);
    const worktrees = await createTerminalWorktrees({ profile: root, root, tasks: host.storage, logger,
      guard() {}, appDataRoot: path.join(root, 'app-data'),
      secrets: { getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); } },
    });
    await host.connectWorktrees(worktrees);
    await host.invoke('local-db:bots:model-chain-settings-set', [{ modelChain: [
      { harness: 'claude', providerId: 'fixture', model: 'test-model', effort: '', fastMode: false },
    ] }]);
    for (const id of ['group-first', 'group-second']) {
      await host.invoke('local-db:bots:create', [{ id, name: id, identitySource: 'Group fixture', avatar: '✦' }]);
    }
    const registry = new RemoteResourceRegistry();
    await host.connectOriginalGroupServices({ resources: registry, trashItem: async () => { throw new Error('unexpected fixture trash'); } });
    const created = await host.invoke('maker:bot-group:create', [{ name: 'Original group', botIds: ['group-first', 'group-second'] }]) as { ok: boolean; groupId: string };
    expect(created).toMatchObject({ ok: true });
    const client = { protocolVersion: 1 as const, primitives: ['form'], locale: 'en' }, context = { controllerDeviceId: 'owner' };
    const ref = { collectionId: 'bot-groups', kind: 'bot-group', id: created.groupId };
    expect(registry.manifest(context, { client }).collections.map(row => row.id)).toContain('bot-groups');
    expect((await registry.list(context, { client, collectionId: 'bot-groups' })).items.map(row => row.ref)).toContainEqual(ref);
    const input = { text: 'Remote group fixture', clientId: 'group-remote-once', mentions: { all: false, botIds: ['group-first'] } };
    await registry.invoke(context, { client, collectionId: 'bot-groups', resourceRef: ref, actionId: 'send', input });
    await expect.poll(async () => {
      const detail = await host.botGroupChat!.getGroup(created.groupId);
      return detail.ok ? { replies: detail.group.messages.filter(row => row.authorKind === 'bot').length, status: detail.group.round.status } : null;
    }, { interval: 5 }).toEqual({ replies: 1, status: 'idle' });
    const detail = await host.botGroupChat!.getGroup(created.groupId);
    expect(detail.ok).toBe(true); if (!detail.ok) throw new Error(detail.errorCode);
    expect(detail.group.round.status).toBe('idle');
    expect(detail.group.messages.filter(row => row.kind === 'message').map(row => row.content)).toEqual([
      'Remote group fixture', expect.stringContaining('Echo:'),
    ]);
    expect(native.starts).toHaveLength(1);
    const laneId = native.starts[0]!.sessionId!;
    expect(await host.invoke('local-db:messages:list', [laneId])).toContainEqual(expect.objectContaining({ role: 'assistant' }));
    expect(JSON.stringify(await registry.get(context, { client, ref }))).toContain('Remote group fixture');
    await registry.invoke(context, { client, collectionId: 'bot-groups', resourceRef: ref, actionId: 'send', input });
    expect(native.sentFor(laneId)).toHaveLength(1);
    expect(pushes.some(row => row.channel === MAKER_PUSH.BOT_GROUP_CHANGED)).toBe(true);
  });

  // Integration: GUI precreation must be claimed by the same persisted task,
  // cancellation must fence late creation, and native runtime closure must
  // precede the actual encrypted worktree recycler.
  it('claims GUI worktree precreation and restores it after native task archival', async () => {
    const profile = await realpath(await mkdtemp(path.join(os.tmpdir(), 'terminal-worktree-task-'))); roots.push(profile);
    const owner = path.join(profile, 'owners', 'b'.repeat(32));
    const f = await setup(engine(), { profileDir: owner });
    const worktrees = await createTerminalWorktrees({ profile, root: owner, tasks: f.host.storage, logger, guard() {},
      appDataRoot: path.join(profile, 'app-data'),
      secrets: { getSync: key => f.vault.get(key) ?? null, setSync: (key, value) => { f.vault.set(key, value); } },
    });
    await f.host.connectWorktrees(worktrees);
    const repo = path.join(profile, 'repo'); await mkdir(repo);
    const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repo, windowsHide: true,
      env: { ...process.env, GIT_CONFIG_GLOBAL: path.join(profile, 'git-global'), GIT_CONFIG_NOSYSTEM: '1' } });
    await git('init', '-b', 'main'); await git('config', 'user.name', 'Worktree Test'); await git('config', 'user.email', 'worktree-test@localhost');
    await writeFile(path.join(repo, 'file.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'fixture');
    const id = 'gui-precreated';
    const remote = { source: 'remote' as const, ownerId: 'owner', deviceId: 'controller', assertCurrent() {} };
    const created = await f.host.invoke('worktree:create', [{ sessionId: id, baseRepo: repo, name: 'gui', sourceBranch: 'main', recoveryKey: 'gui-recovery-key-0001' }], remote) as { ok: boolean; meta: { path: string } };
    expect(created, JSON.stringify(created)).toMatchObject({ ok: true });
    const task = await f.host.invoke('maker:create-session', [{ id, workingDir: created.meta.path }], remote) as { sessionId: string };
    expect(task.sessionId).toBe(id);
    expect(f.native.starts.at(-1)?.workingDir).toBe(created.meta.path);
    expect(await f.host.invoke('local-db:sessions:get', [id])).toMatchObject({ id, worktreePath: created.meta.path });
    await expect(f.host.invoke('worktree:cancel-precreated', [{ sessionId: id, recoveryKey: 'gui-recovery-key-0001' }], remote)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await writeFile(path.join(created.meta.path, 'file.txt'), 'retained user changes');
    const recycled = f.nextPush('worktree:changed', value => (value as {sessionId:string}).sessionId === id);
    await f.host.invoke('local-db:sessions:patch-meta', [id, { status: 'archived' }]);
    await recycled;
    await expect(access(created.meta.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.host.invoke('worktree:restore-for-session', [id], remote)).toMatchObject({ ok: true, snapshotApplied: true });
    expect(await readFile(path.join(created.meta.path, 'file.txt'), 'utf8')).toBe('retained user changes');
    await f.host.invoke('local-db:sessions:update', [id, { status: 'active' }]);
    // No engine was started by restoring metadata. The retained lease must
    // already protect the directory when an older GUI scans runtime paths.
    const retained = JSON.parse(await readFile(path.join(owner, 'worktree-task-references.json'), 'utf8'));
    expect(retained.entries.find((entry: { id: string }) => entry.id === id)?.leases).toEqual(expect.arrayContaining([
      expect.objectContaining({ physicalPath: await worktrees.locks.physicalWorktreeKey(created.meta.path) }),
    ]));
    await f.host.invoke('worktree:cancel-precreated', [{ sessionId: 'cancelled-task', path: path.join(repo, '.cindy-worktrees', 'cancelled') }], remote);
    await expect(f.host.invoke('maker:create-session', [{ id: 'cancelled-task', workingDir: repo }])).rejects.toThrow('creation was cancelled');
    expect(await f.host.storage.get('cancelled-task')).toBeNull();
    const lead = await f.host.invoke('maker:create-session', [{ workingDir: repo }], remote) as { id: string };
    const worker = await f.host.invoke('maker:session:enable-orca', [lead.id, { workerAgent: 'claude-code', label: 'Isolated', worktree: { sourceBranch: 'main' } }], remote) as { workerId: string; workerSessionId: string };
    const workerRow = await f.host.storage.get(worker.workerSessionId);
    expect(workerRow?.worktreePath).toBeTruthy();
    expect(workerRow?.workDir).toBe(workerRow?.worktreePath);
    expect(workerRow?.workDir).not.toBe(repo);
    expect(f.native.starts.at(-1)?.workingDir).toBe(workerRow?.workDir);
    await worktrees.manager.awaitBackgroundCheckout(worker.workerSessionId);
    expect(await readFile(path.join(workerRow!.workDir, 'file.txt'), 'utf8')).toBe('original');
    await writeFile(path.join(workerRow!.workDir, 'worker.txt'), 'worker changes');
    const workerRecycled = f.nextPush('worktree:changed', value => (value as {sessionId:string}).sessionId === worker.workerSessionId);
    await f.host.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: worker.workerId }], remote);
    await workerRecycled;
    await expect(access(workerRow!.workDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await f.host.invoke('worktree:restore-for-session', [worker.workerSessionId], remote)).toMatchObject({ ok: true, snapshotApplied: true });
    expect(await readFile(path.join(workerRow!.workDir, 'worker.txt'), 'utf8')).toBe('worker changes');
    const registry = new RemoteResourceRegistry(); registerWorktreeResources(registry, worktrees, f.host);
    const context = { controllerDeviceId: 'terminal-controller', assertCurrent() {} }, client = { protocolVersion: 1, primitives: ['text', 'actions'], locale: 'zh-CN' };
    const formTask = await registry.invoke(context, { client, collectionId: 'worktrees', actionId: 'create', input: { baseRepo: repo, name: 'terminal' } });
    const formId = (formTask.result as { sessionId: string }).sessionId;
    expect((await f.host.storage.get(formId))?.worktreePath).toContain('terminal');
    expect(await registry.list(context, { client, collectionId: 'worktrees' })).toMatchObject({ items: expect.arrayContaining([expect.objectContaining({ ref: { collectionId: 'worktrees', kind: 'worktree', id: formId } })]) });
    await expect(registry.invoke({ ...context, assertCurrent() { throw new Error('CONTROLLER_REVOKED'); } }, { client, collectionId: 'worktrees', actionId: 'create', input: { baseRepo: repo } })).rejects.toThrow('CONTROLLER_REVOKED');
    const scheduler = new TerminalSchedulerHost({ profileDir: owner, tasks: f.host, worktrees, logger, emit() {} }); schedulers.push(scheduler);
    const schedule = await scheduler.invoke('maker:schedule:create', [{ name: 'Worktree schedule', prompt: 'scheduled hello', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: true, agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', workspaceKind: 'project', workingDir: repo, useWorktree: true, persistentSession: true, notify: { desktop: false, feishu: false } }]) as { id: string };
    await scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    const runs = await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{ status: string; sessionId: string }>;
    expect(runs[0]).toMatchObject({ status: 'success' });
    const scheduledTask = await f.host.storage.get(runs[0]!.sessionId);
    expect(scheduledTask?.worktreePath).toBe(scheduledTask?.workDir);
    expect(scheduledTask?.workDir).not.toBe(repo);
    expect(await readFile(path.join(scheduledTask!.workDir, 'file.txt'), 'utf8')).toBe('original');
    await scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    expect(await scheduler.invoke('maker:schedule:list-runs', [schedule.id])).toMatchObject([{ status: 'success', sessionId: scheduledTask!.id }, { status: 'success', sessionId: scheduledTask!.id }]);
  }, 30_000);

  it('discovers remote worker computers through the shared controller without exposing the account directory to guests', async () => {
    const device = (id: string, patch: Record<string, unknown> = {}) => ({ deviceId: id, name: id, platform: 'linux',
      appVersion: null, lastSeenAt: null, online: true, busy: false, remoteControlEnabled: true, controlEnabled: true, isSelf: false, ...patch });
    const probed: string[] = [];
    const { host } = await setup(engine(), {
      listOrcaDevices: async () => ({ devices: [device('server'), device('older-client'), device('offline', { online: false }), device('phone', { platform: 'ios' }), device('self', { isSelf: true }), device('disabled', { controlEnabled: false })] }),
      remoteInvoke: async (id, channel) => {
        expect(channel).toBe('maker:orca:remote-worker:caps'); probed.push(id);
        return id === 'server' ? { ok: true, result: { version: 1, workerBridge: true, agentDevice: true } }
          : { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'unsupported by older client' } };
      },
    });
    expect(await host.invoke('maker:orca:execution-devices')).toEqual({ devices: [
      { deviceId: 'server', name: 'server', platform: 'linux', supported: true, supportsAgentDevice: true },
      { deviceId: 'older-client', name: 'older-client', platform: 'linux', supported: false },
    ] });
    expect(probed).toEqual(['server', 'older-client']);
    await expect(host.invoke('maker:orca:execution-devices', [], { source: 'remote', sharedTask: { sessionId: 'shared' } as never })).rejects.toThrow();
    expect(probed).toHaveLength(2);
  });
  // Existing GUI/Mobile consumers must observe the durable collaboration
  // projection after a terminal process restart, without internal receipts.
  it('restores team membership through the existing remote GUI read channels', async () => {
    const { host, create } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'worker-link', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.close();
    const restored = create();
    const context = { source: 'remote' as const, deviceId: 'controller', ownerId: 'owner', assertCurrent() {} };
    expect(await restored.invoke('local-db:orca-workflows:get-by-lead', [lead.sessionId], context)).toMatchObject({ id: team.id, status: 'active' });
    expect(await restored.invoke('local-db:orca-workflows:get-by-worker-session', [worker.sessionId], context)).toMatchObject({ id: team.id });
    const batch = await restored.invoke('local-db:orca-workflows:list-workers-by-leads', [[lead.sessionId, 'another-lead', lead.sessionId]], context) as Record<string, Array<Record<string, unknown>>>;
    expect(batch['another-lead']).toEqual([]);
    expect(batch[lead.sessionId]).toMatchObject([{ id: 'worker-link', label: 'build', session: { title: 'Worker' } }]);
    expect(batch[lead.sessionId]![0]).not.toHaveProperty('pendingReport');
    expect(await restored.invoke('local-db:sessions:get', [worker.sessionId], context)).toMatchObject({ orcaRole: 'worker' });
    await expect(restored.invoke('local-db:orca-workflows:list-workers-by-leads', [Array(201).fill(lead.sessionId)], context)).rejects.toThrow('INVALID_ARGUMENT');
    await expect(restored.invoke('local-db:orca-workflows:get-by-lead', [lead.sessionId], { ...context, sharedTask: { sessionId: lead.sessionId } as never })).rejects.toThrow();
  });
  // Integration: the shared dispatcher must commit actual terminal receipts.
  // A paused assignment, a process restart and a released team are the minimum
  // inputs that distinguish persistence from an in-memory queue mock.
  it('persists local collaboration input, restores its sender, and rejects revoked assignments', async () => {
    const { host, create, native, nextPush } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'durable-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', true]);
    const dispatch = (target: TerminalTaskHost, content: string) => target.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({
      targetSessionId: worker.sessionId, source: 'lead', senderLabel: 'untrusted label', workerId: 'durable-worker', rawContent: content,
      meta: { source: 'orca', context: 'durable-assignment-test' },
    });
    const queued = await dispatch(host, 'Inspect the project');
    if (!queued.ok) throw new Error('Expected a queued assignment');
    expect(queued.mode).toBe('queued');
    expect(await host.storage.submission(worker.sessionId, queued.clientId)).toMatchObject({ status: 'queued', collaboration: {
      teamId: team.id, source: 'lead', origin: { kind: 'orca', senderSessionId: lead.sessionId, senderLabel: 'Lead' },
    } });
    expect(native.sent).toHaveLength(0);
    await host.close();
    const restored = create();
    expect(await restored.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ pendingQueue: [{
      clientId: queued.clientId, origin: { senderSessionId: lead.sessionId, senderLabel: 'Lead' },
    }] });
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, queued.clientId])).toMatchObject({ status: 'completed' });
    const history = (await restored.invoke('local-db:messages:list', [worker.sessionId]) as Array<{role:string;clientId:string;content:unknown;agentMeta?:Record<string,unknown>}>).filter(row => row.role === 'user');
    expect(history).toHaveLength(1);
    expect(history[0].agentMeta).toMatchObject({ origin: { kind: 'orca', senderSessionId: lead.sessionId }, autoReviewUserText: { kind: 'delegated-continuation' } });
    expect(history[0].content).not.toEqual(native.sent[0].content);
    expect(JSON.stringify(history[0].content)).toContain('Inspect the project');
    expect(JSON.stringify(native.sent[0])).toContain('Inspect the project');
    await restored.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', true]);
    const revoked = await dispatch(restored, 'Do not execute after release');
    const edited = await dispatch(restored, 'Replace this delegated input');
    if (!revoked.ok || !edited.ok) throw new Error('Expected queued assignments');
    await restored.invoke('maker:input:update-text', [worker.sessionId, edited.clientId, 'A new human request']);
    // The original editor preserves semantic origin; editing is not a new human turn.
    expect((await restored.orcaQueue.snapshot(worker.sessionId)).find(item => item.clientId === edited.clientId)?.origin?.kind).toBe('orca');
    await restored.orcaStore.markTeamEnded(team.id, 'completed');
    const rejected = nextPush('maker:input:projection', payload => {
      const projection = payload as { sessionId?: string; error?: string; turnInProgress?: boolean; recovery?: { kind: string; clientId?: string } };
      return projection.sessionId === worker.sessionId && Boolean(projection.error) && projection.turnInProgress === false
        && projection.recovery?.kind === 'queue-head' && projection.recovery.clientId === revoked.clientId;
    });
    await restored.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', false]);
    await rejected;
    expect(native.sentFor(worker.sessionId)).toHaveLength(1);
    expect(await restored.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ recovery: { kind: 'queue-head', clientId: revoked.clientId } });
    await restored.invoke('maker:input:remove', [worker.sessionId, edited.clientId]);
    await restored.invoke('maker:input:remove', [worker.sessionId, revoked.clientId]);
    await restored.invoke('terminal:tasks:submit', [worker.sessionId, 'A new human request', { requestId: 'human_after_release' }]);
    await restored.invoke('maker:input:clear-error', [worker.sessionId]);
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    expect(await restored.invoke('terminal:tasks:wait', [worker.sessionId, 'human_after_release'])).toMatchObject({ status: 'completed' });
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
    expect(JSON.stringify(native.sentFor(worker.sessionId)[1])).toContain('A new human request');
    const users = (await restored.invoke('local-db:messages:list', [worker.sessionId]) as typeof history).filter(row => row.role === 'user');
    expect(users.map(row => row.clientId)).toEqual(['human_after_release', queued.clientId]);
    expect(users[0].agentMeta?.origin).toBeUndefined();
  });

  // Integration: accepted callbacks claim a native turn, not an enqueue. A
  // release during the real change-set preparation must still prevent send.
  it('settles collaboration callbacks at native acceptance and rechecks assignment before sending', async () => {
    const { host, native, nextPush } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'accepted-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    const events: string[] = [];
    const request = { targetSessionId: worker.sessionId, rawContent: 'Build', source: 'lead' as const,
      senderLabel: 'Lead', workerId: 'accepted-worker', meta: { source: 'orca', context: 'acceptance-test' },
      onAccepted: () => { events.push('accepted'); }, onAcceptedCommit: () => { events.push('commit'); },
      onAcceptedRollback: () => { events.push('rollback'); } };
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', true]);
    const waiting = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
    if (!waiting.ok) throw new Error('Expected queued assignment');
    expect(events).toEqual([]);
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', false]);
    expect(await host.invoke('terminal:tasks:wait', [worker.sessionId, waiting.clientId])).toMatchObject({ status: 'completed' });
    expect(events).toEqual(['accepted', 'commit']);
    const begin = host.changes.begin.bind(host.changes);
    const releaseDuringPreparation = vi.spyOn(host.changes, 'begin').mockImplementationOnce(async (...args) => {
      await begin(...args); await host.orcaStore.markTeamEnded(team.id, 'completed');
    });
    try {
      const failed = nextPush('maker:input:projection', payload => {
        const projection = payload as { sessionId?: string; error?: string; recovery?: { kind: string } };
        return projection.sessionId === worker.sessionId && Boolean(projection.error) && projection.recovery?.kind === 'active-turn';
      });
      const rejected = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
      if (!rejected.ok) throw new Error('Expected queued assignment');
      await failed;
      expect(await host.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ recovery: { kind: 'active-turn', item: { clientId: rejected.clientId } } });
      expect(native.sent).toHaveLength(1);
      expect(events).toEqual(['accepted', 'commit']);
    } finally { releaseDuringPreparation.mockRestore(); }
  });

  // Integration: original coordinator CAS and SQLite recovery preserve controller
  // edits. Failed snapshot writes must not report durable success; the next
  // mutation retries that snapshot without duplicating the merged input.
  it('commits collaboration queue edits atomically and preserves newer controller input', async () => {
    const { host, create } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'queue-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'composer-edit', true]);
    const ids: string[] = [];
    for (const content of ['first', 'second', 'third']) {
      const result = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ targetSessionId: worker.sessionId,
        source: 'lead', senderLabel: 'Lead', workerId: 'queue-worker', rawContent: content, meta: { source: 'orca', context: 'queue-edit-test' } });
      if (!result.ok) throw new Error('Expected queued assignment');
      ids.push(result.clientId);
    }
    const original = await host.orcaQueue.snapshot(worker.sessionId);
    await host.invoke('maker:input:update-text', [worker.sessionId, ids[0], 'A newer controller edit']);
    expect(await host.orcaQueue.replace(worker.sessionId, ids[0]!, rebuildQueuedOrcaLeadMessage(original[0]!, 'stale overwrite'), original[0])).toBe(false);
    expect(await host.orcaQueue.remove(worker.sessionId, ids[0]!, original[0])).toBe(false);
    expect((await host.orcaQueue.snapshot(worker.sessionId)).find(item=>item.clientId===ids[0])?.text).toBe('A newer controller edit');
    await host.invoke('maker:input:set-edit-lock', [worker.sessionId, ids[2], true]);
    expect(await host.orcaQueue.move(worker.sessionId, ids[2]!, 0)).toBe('locked');
    await host.invoke('maker:input:set-edit-lock', [worker.sessionId, ids[2], false]);
    expect(await host.orcaQueue.move(worker.sessionId, ids[2]!, 0)).toBe(0);
    expect(await host.orcaQueue.move(worker.sessionId, ids[1]!, 1)).toBe(1);
    const database = await host['database'];
    const sql = new Database(database.dbPath);
    sql.exec("CREATE TRIGGER reject_queue_write BEFORE UPDATE ON agent_input_queue_snapshots BEGIN SELECT RAISE(ABORT, 'fixture queue write failed'); END");
    try {
      await expect(host.orcaQueue.merge(worker.sessionId, [ids[2]!, ids[1]!], items => rebuildQueuedOrcaLeadMessage(items[0]!, 'Merged task'))).rejects.toThrow('fixture queue write failed');
      const durable = JSON.parse((sql.prepare('SELECT payload FROM agent_input_queue_snapshots WHERE session_id = ?').get(worker.sessionId) as { payload: string }).payload) as Array<{ clientId: string }>;
      expect(durable.map(row=>row.clientId)).toEqual([ids[2], ids[1], ids[0]]);
    } finally { sql.exec('DROP TRIGGER reject_queue_write'); sql.close(); }
    await host.invoke('maker:input:set-expanded', [worker.sessionId, true]);
    await database.inputQueue.awaitAgentInputQueueSnapshotPersistence(worker.sessionId);
    expect((await database.inputQueue.loadAgentInputQueueSnapshot(worker.sessionId)).map(item=>item.clientId)).toEqual([ids[2], ids[0]]);
    await host.close();
    const restored = create();
    await restored.ready;
    const restoredItems = await restored.orcaQueue.snapshot(worker.sessionId);
    expect(restoredItems.map(row => row.clientId)).toEqual([ids[2], ids[0]]);
    expect(restoredItems[0].origin).toMatchObject({ kind: 'orca', displayText: 'Merged task' });
    expect(restoredItems[1].text).toBe('A newer controller edit');
  });

  // Integration: the released direct-steer channel must use the original
  // source/clear boundary transaction; wire-only fields cannot impersonate mobile.
  it('routes direct remote steering through the original source and clear boundaries', async () => {
    const { host, native, nextPush } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { sessionId: string };
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,task.sessionId,'wait-for-steer','steer-owner-turn');
    await native.waitForHeld(task.sessionId);
    const remote = { source: 'remote' as const, ownerId: 'test-owner', deviceId: 'desktop-controller',
      sourceDevice: { deviceId: 'desktop-controller', name: 'Test desktop', platform: 'desktop' as const }, assertCurrent() {} };
    await host.invoke('maker:steer', [task.sessionId, 'A direct correction', {
      expectedClearBoundaryMs: null, expectedInputGeneration: 999, fromMobileClient: true,
      sourceDevice: { deviceId: 'forged-mobile', name: 'Forged phone', platform: 'mobile' },
    }], remote);
    expect(native.steered).toHaveLength(1);
    expect(JSON.stringify(native.steered[0])).toContain('A direct correction');
    expect(JSON.stringify(native.steered[0])).not.toContain('Forged phone');
    await expect(host.invoke('maker:steer', [task.sessionId, 'Stale correction', { expectedClearBoundaryMs: 1 }], remote))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(native.steered).toHaveLength(1);
    const done = nextPush('maker:event', payload => {
      const value = payload as { sessionId: string; event: { type: string } };
      return value.sessionId === task.sessionId && value.event.type === 'done';
    });
    native.finishHeld(task.sessionId); await done;
  });

  // Integration: native steering ACK belongs to the existing turn. An uncertain
  // ACK must survive restart as paused input and never silently run twice.
  it('steers collaboration into the current native turn and durably pauses uncertain delivery', async () => {
    const { host, create, native, nextPush } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.addOrUpdateWorker({ id: 'steer-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build' });
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,worker.sessionId,'wait-for-steer','original-turn');
    await native.waitForHeld(worker.sessionId);
    const accepted = vi.fn();
    const request = { targetSessionId: worker.sessionId, rawContent: 'A correction', source: 'lead' as const,
      senderLabel: 'Lead', workerId: 'steer-worker', delivery: 'steer' as const,
      meta: { source: 'orca', context: 'native-steer-test' }, onAccepted: accepted };
    const sent = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage(request);
    expect(sent).toMatchObject({ ok: true, mode: 'steered' });
    expect(native.steered).toHaveLength(1);
    expect(accepted).not.toHaveBeenCalled();
    expect((await host.invoke('local-db:messages:list', [worker.sessionId]) as Array<{role:string;agentMeta?:unknown}>).find(row => row.role === 'user')?.agentMeta).toMatchObject({
      delivery: 'steer', origin: { kind: 'orca', senderSessionId: lead.sessionId },
    });
    native.steer.reply = async () => { throw new Error('The provider did not acknowledge within its deadline'); };
    const uncertain = await host.orcaDispatcher.dispatchOrEnqueueOrcaInterAgentMessage({ ...request, rawContent: 'An uncertain correction' });
    if (!uncertain.ok) throw new Error('Expected retained input');
    expect(uncertain).toMatchObject({ mode: 'queued', steerFallbackReason: 'STEER_UNCERTAIN' });
    expect(await (await host['database']).inputQueue.loadAgentInputQueueSnapshot(worker.sessionId)).toMatchObject([{ clientId: uncertain.clientId, origin: { kind: 'orca' } }]);
    expect(await host.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ queuePaused: true, pendingQueue: [{ clientId: uncertain.clientId }] });
    const originalDone = nextPush('maker:event', payload => { const value = payload as { sessionId: string; event?: { type: string } }; return value.sessionId === worker.sessionId && value.event?.type === 'done'; });
    native.finishHeld(worker.sessionId);
    await originalDone;
    await host.storage.flush();
    expect(native.sent).toHaveLength(1);
    await host.close();
    const restored = create();
    expect(await restored.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({ queuePaused: true, pendingQueue: [{ clientId: uncertain.clientId }] });
    expect(native.sent).toHaveLength(1);
    const completed = nextPush('maker:event', payload => { const value = payload as { sessionId: string; event?: { type: string } }; return value.sessionId === worker.sessionId && value.event?.type === 'done'; });
    await restored.invoke('maker:input:resume', [worker.sessionId]);
    await completed;
    await restored.storage.flush();
    expect(await (await restored['database']).inputQueue.readInputDeliveryReceipts(worker.sessionId, [uncertain.clientId])).toEqual([{ clientId: uncertain.clientId, state: 'accepted' }]);
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
  });

  // Integration: the actual shared team controller must use terminal queues,
  // resume a dormant worker, report each accepted turn once and release it.
  it('runs shared team controls through durable worker tasks and automatic Lead reports', async () => {
    const { host, native } = await setup();
    const lead = await host.invoke('maker:create-session', [{ title: 'Lead' }]) as { sessionId: string };
    const worker = await host.invoke('maker:create-session', [{ title: 'Worker' }]) as { sessionId: string };
    const foreign = await host.invoke('maker:create-session', [{ title: 'Other Lead' }]) as { sessionId: string };
    const team = await host.orcaStore.createActiveTeam({ leadSessionId: lead.sessionId });
    await host.orcaStore.createActiveTeam({ leadSessionId: foreign.sessionId });
    await host.orcaStore.setSessionOrcaRole(lead.sessionId, 'lead');
    await host.orcaStore.addOrUpdateWorker({ id: 'controlled-worker', teamId: team.id, sessionId: worker.sessionId, label: 'Build', role: 'developer' });
    await host.invoke('maker:close-session', [worker.sessionId]);
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'queue-controls', true]);
    await host.invoke('maker:input:set-interaction-lock', [lead.sessionId, 'queue-controls', true]);
    const controls = host.orcaTeamService;
    expect(await controls.sendToWorker({ callerLeadSessionId: foreign.sessionId, targetSessionId: worker.sessionId, message: 'Wrong team' })).toMatchObject({ ok: false });
    const ids: string[] = [];
    for (const message of ['First task', 'Remove this task', 'Last task']) {
      const result = await controls.sendToWorker({ callerLeadSessionId: lead.sessionId, targetSessionId: worker.sessionId, message });
      if (!result.ok || !result.queuedMessageId) throw new Error('Expected queued worker task');
      ids.push(result.queuedMessageId);
    }
    await host.orcaStore.setSessionOrcaRole(worker.sessionId, 'worker');
    const moved = await controls.moveWorkerQueuedMessage({ callerLeadSessionId: worker.sessionId, queuedMessageId: ids[0]!, position: 0 });
    expect(moved, JSON.stringify(moved)).toMatchObject({ ok: true });
    const updated = await controls.updateWorkerQueuedMessage({ callerLeadSessionId: lead.sessionId, workerRef: 'controlled-worker', queuedMessageId: ids[0]!, message: 'Updated first task' });
    expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true });
    expect(await controls.cancelWorkerQueuedMessage({ callerLeadSessionId: lead.sessionId, workerRef: 'controlled-worker', queuedMessageId: ids[1]! })).toMatchObject({ ok: true });
    await host.invoke('maker:input:set-interaction-lock', [worker.sessionId, 'queue-controls', false]);
    await vi.waitFor(async () => {
      expect(await host.orcaQueue.snapshot(lead.sessionId)).toHaveLength(2);
      expect(await host.invoke('maker:input:get-projection', [worker.sessionId])).toMatchObject({turnInProgress:false});
    }, {interval:5});
    const history = await host.invoke('local-db:messages:list', [worker.sessionId, 50]) as Array<{role:string;clientId?:string}>;
    expect(history.filter(row => row.role === 'user').map(row => row.clientId)).toEqual([ids[2], ids[0]]);
    expect(history.filter(row => row.role === 'assistant')).toHaveLength(2);
    expect(native.sentFor(worker.sessionId)).toHaveLength(2);
    const reports = await host.orcaQueue.snapshot(lead.sessionId);
    expect(reports.map(row => row.origin)).toEqual([
      expect.objectContaining({ kind: 'orca', senderSessionId: worker.sessionId, senderLabel: 'developer' }),
      expect.objectContaining({ kind: 'orca', senderSessionId: worker.sessionId, senderLabel: 'developer' }),
    ]);
    expect(reports[0]!.text).toContain('Updated first task');
    await host.invoke('maker:input:set-interaction-lock', [lead.sessionId, 'queue-controls', false]);
    await vi.waitFor(async () => {
      expect(native.sentFor(lead.sessionId)).toHaveLength(2);
      expect(await host.invoke('maker:input:get-projection', [lead.sessionId])).toMatchObject({turnInProgress:false});
    }, {interval:5});
    expect(native.sentFor(lead.sessionId)).toHaveLength(2);
    expect((await host.orcaStore.listWorkersByLead(lead.sessionId))[0]).toMatchObject({ status: 'done' });
    expect(await controls.idleWorker({ callerLeadSessionId: lead.sessionId, workerId: 'controlled-worker', expectedStatus: 'done' })).toMatchObject({ ok: true });
    expect((await host.orcaStore.listWorkersByLead(lead.sessionId))[0]).toMatchObject({ status: 'idle' });
    expect(await controls.archiveWorker({ callerLeadSessionId: lead.sessionId, workerId: 'controlled-worker', onlyIfIdle: true })).toMatchObject({ ok: true });
    expect((await host.storage.get(worker.sessionId))?.archived).toBe(true);
    expect(await host.orcaStore.listWorkersByLead(lead.sessionId)).toEqual([]);
  });

  // Integration: native bootstrap can fail after task persistence; that orphan
  // must not occupy a slot. The replacement's idle release must close its real
  // runtime while preserving native identity for the next assignment.
  it('archives failed Worker bootstrap and releases a completed Worker without losing its native identity', async () => {
    let failWorker = true;
    const native = engine(async (_input, options) => {
      if (failWorker && options.vendorOptions?.orcaRole === 'worker') { failWorker = false; throw new Error('NATIVE_WORKER_START_FAILED'); }
    });
    const { host } = await setup(native);
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:stop', [lead.id]);
    await host.orcaLifecycle.startTeam({ leadSessionId: lead.id });
    const args = { leadSessionId: lead.id, agent: 'claude-code' as const, role: 'developer', label: 'Retry', initialTask: 'Run the assignment' };
    expect(await host.orcaLifecycle.createWorker(args)).toMatchObject({ ok: false });
    const discarded = (await host.storage.list()).filter(task => task.id !== lead.id);
    expect(discarded).toHaveLength(1); expect(discarded[0]?.archived).toBe(true);
    const worker = await host.orcaLifecycle.createWorker(args);
    if (!worker.ok) throw new Error(worker.message);
    await vi.waitFor(async () => expect((await host.orcaStore.workerForLead(lead.id, worker.workerId))?.status).toBe('done'));
    // The Lead receipt commits before the Worker finishes its own turn journal.
    // An idle scan must protect that live tail, so age it only after settlement.
    await vi.waitFor(() => expect(host.isTurnRunning(worker.workerSessionId)).toBe(false));
    const sdkId = (await host.storage.get(worker.workerSessionId))!.sdkSessionId;
    await host.invoke('maker:collaboration-settings:set', [{ key: 'workerIdleReleaseMinutes', value: 1 }]);
    await host.orcaStore.touchWorker(worker.workerId, Date.now() - 120_000);
    await host.orcaIdle.scanNow();
    expect(await host.orcaTools.api.getWorkerStatus({ leadSessionId: lead.id, workerId: worker.workerId })).toMatchObject({ status: 'idle', session_status: 'not_running' });
    const next = await host.orcaTeamService.sendToWorker({ callerLeadSessionId: lead.id, targetSessionId: worker.workerSessionId, message: 'Another assignment' });
    if (!next.ok || !next.queuedMessageId) throw new Error('Expected worker assignment');
    expect(await host.invoke('terminal:tasks:wait', [worker.workerSessionId, next.queuedMessageId])).toMatchObject({ status: 'completed' });
    expect((await host.storage.get(worker.workerSessionId))!.sdkSessionId).toBe(sdkId);
    expect(native.sentFor(worker.workerSessionId)).toHaveLength(2);
  });

  // Integration: GUI control uses the original team completion and SQLite queue.
  // Restart must preserve an accepted report without a second terminal outbox.
  it('restores an original GUI-created Worker report from the shared SQLite queue', async () => {
    const { host, create, native } = await setup(engine(), { deferPendingTasks: true });
    let authorized = true;
    const remote = { source: 'remote' as const, deviceId: 'gui-controller', ownerId: 'test-owner',
      assertCurrent: () => { if (!authorized) throw new Error('CONTROLLER_REVOKED'); } };
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:set-interaction-lock', [lead.id, 'composer-edit', true]);
    // The real remote test exposed INVALID_PARAMS being obscured as INTERNAL.
    // A rejected locator must carry its safe wire code and create no team.
    await expect(host.invoke('maker:session:enable-orca', [lead.id, { label: '原生回报验收' }], remote))
      .rejects.toMatchObject({ code: 'INVALID_PARAMS', message: 'Orca operation failed' });
    expect(await host.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
    expect(await host.invoke('maker:collaboration-settings:set', [{ key: 'workerIdleReleaseMinutes', value: 1 }], remote)).toMatchObject({ workerIdleReleaseMinutes: 1 });
    const created = await host.invoke('maker:session:enable-orca', [lead.id, { workerAgent: 'claude-code', label: 'Recovery', delegateTask: 'Durable GUI assignment' }], remote) as { workerId: string; workerSessionId: string };
    const pending = await host.orcaQueue.snapshot(created.workerSessionId);
    expect(pending).toHaveLength(1);
    expect(await host.invoke('maker:worker:list', [lead.id], remote)).toEqual([expect.objectContaining({ id: created.workerId })]);
    await host.resumePending();
    expect(await host.invoke('terminal:tasks:wait', [created.workerSessionId, pending[0]!.clientId])).toMatchObject({ status: 'completed' });
    await vi.waitFor(async () => expect(await host.orcaQueue.snapshot(lead.id)).toHaveLength(1), { interval: 5 });
    expect(native.sentFor(created.workerSessionId)).toHaveLength(1);
    await host.close();
    const restarted = create(); await restarted.ready;
    const reports = await restarted.orcaQueue.snapshot(lead.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.origin).toMatchObject({ kind: 'orca', displayText: expect.stringContaining('Durable GUI assignment') });
    expect(await restarted.orcaQueue.snapshot(lead.id)).toHaveLength(1);
    expect(native.sentFor(created.workerSessionId)).toHaveLength(1);
    expect(await restarted.invoke('maker:collaboration-settings:get', [], remote)).toMatchObject({ workerIdleReleaseMinutes: 1 });
    authorized = false;
    await expect(restarted.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: created.workerId }], remote)).rejects.toThrow('CONTROLLER_REVOKED');
    expect((await restarted.storage.get(created.workerSessionId))?.archived).not.toBe(true);
    authorized = true;
    await restarted.invoke('maker:worker:archive', [{ leadSessionId: lead.id, workerId: created.workerId }], remote);
    expect((await restarted.storage.get(created.workerSessionId))?.archived).toBe(true);
    await restarted.invoke('maker:session:disable-orca', [lead.id], remote);
    expect(await restarted.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
  });

  // Integration: public MCP creation must boot real Maker Sessions with their
  // role, persist local assignments, and settle explicit reports exactly once.
  it('creates teams through native MCP and restores identity with the original report settlement', async () => {
    const connect = async (input: RuntimeInput, options: StartSessionOptions, name: string) => {
      const tools = input.tools!, ctx = { sessionId: options.sessionId!, sessionInstanceId: options.sessionInstanceId!,
        workingDir: options.workingDir, agentKind: input.selection.agentKind, vendorOptions: options.vendorOptions,
        mcpCallerKind: 'root' as const, mcpCallerAttested: true };
      const bridge = tools.pi(ctx), client = new McpClient({ name: 'terminal-orca-integration', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpBridge!.servers.find(server => server.name === name)!.url),
        { requestInit: { headers: { Authorization: `Bearer ${bridge.mcpBridge!.token}` } } }));
      return { call: async (tool: string, args: Record<string, unknown>) => {
        const result = await client.callTool({ name: tool, arguments: args });
        if (result.isError) return { ok: false };
        return JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
      }, close: async () => { await client.close(); bridge.disposeSessionCtx?.(); } };
    };
    const reports: unknown[] = [];
    const native = engine(undefined, async (input, options) => {
      if (options.vendorOptions?.orcaRole !== 'worker') return;
      const bridge = await connect(input, options, 'orca_worker_bridge');
      try {
        reports.push(await bridge.call('send_to_lead', { worker_id: options.vendorOptions.orcaWorkerId, message: 'MCP_WORKER_RESULT' }));
      } finally { await bridge.close(); }
    });
    const { host, create } = await setup(native, { deferPendingTasks: true });
    const lead = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:input:set-interaction-lock', [lead.id, 'composer-edit', true]);
    const control = await connect(native.inputs[0]!, native.starts[0]!, 'cindy_orca');
    let workerId = '', workerSessionId = '';
    try {
      expect(await control.call('start_team', {})).toMatchObject({ ok: true });
      const invalid = await control.call('create_worker', { role: 'developer', label: 'invalid', agent: 'claude-code', model: 'unavailable-model' });
      expect(invalid.ok).toBe(false);
      const created = await control.call('create_worker', { role: 'developer', label: 'builder', agent: 'claude-code', initial_task: 'Complete the assigned work' });
      expect(created).toMatchObject({ ok: true });
      workerId = created.worker_id; workerSessionId = created.worker_session_id;
      expect(workerId).toBeTruthy(); expect(workerSessionId).toBeTruthy();
      const worker = native.starts.find(start => start.sessionId === workerSessionId)!;
      expect(worker.vendorOptions).toMatchObject({ orcaRole: 'worker', orcaWorkerId: workerId, orcaLeadSessionId: lead.id });
      expect(await host.storage.get(workerSessionId)).toMatchObject({ orcaRole: 'worker', providerId: 'fixture', permissionMode: 'bypassPermissions' });
      expect((await host.storage.get(workerSessionId))?.source).not.toBe('plugin');
      const queued = await host.orcaQueue.snapshot(workerSessionId);
      expect(queued).toHaveLength(1);
      host.resumePending();
      expect(await host.invoke('terminal:tasks:wait', [workerSessionId, queued[0]!.clientId])).toMatchObject({ status: 'completed' });
      expect(reports).toEqual([expect.objectContaining({ ok: true, queued: true })]);
      expect((await host.orcaStore.listWorkersByLead(lead.id))[0]?.status).toBe('done');
      const leadQueue = await host.orcaQueue.snapshot(lead.id);
      expect(leadQueue).toHaveLength(1);
      expect(leadQueue[0]!.origin).toMatchObject({ kind: 'orca', displayText: 'MCP_WORKER_RESULT', senderSessionId: workerSessionId });
    } finally { await control.close(); }
    expect(await host.storage.get(lead.id)).toMatchObject({ orcaRole: 'lead' });
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.orcaQueue.snapshot(lead.id)).toHaveLength(1);
    expect(await restarted.orcaStore.listWorkersByLead(lead.id)).toEqual([expect.objectContaining({ id: workerId, status: 'done' })]);
    expect(await restarted.storage.get(lead.id)).toMatchObject({ orcaRole: 'lead' });
    await restarted.invoke('maker:set-permission-mode', [lead.id, 'ask']);
    const currentInput = native.inputs.findLast(input => input.taskId === lead.id)!, currentStart = native.starts.findLast(start => start.sessionId === lead.id)!;
    expect(currentStart.vendorOptions).toMatchObject({ orcaRole: 'lead', orcaLeadSessionId: lead.id });
    const resumedControl = await connect(currentInput, currentStart, 'cindy_orca');
    try {
      expect(await resumedControl.call('get_workspace_info', {})).toMatchObject({ ok: true, worker_count: 1 });
      expect(await resumedControl.call('end_team', {})).toMatchObject({ ok: true });
      expect((await restarted.storage.get(workerSessionId))?.archived).toBe(true);
      expect((await restarted.storage.get(lead.id))?.orcaRole).toBeNull();
      expect(await restarted.orcaStore.getActiveTeamByLead(lead.id)).toBeNull();
    } finally { await resumedControl.close(); }
  });

  // Integration: the original input boundary strips untrusted semantic labels.
  // Keep its behavior across SDK, HTTP and native MCP contexts; a caller cannot
  // upgrade wire origin=orca to a host-owned Lead assignment. Automatic reporting
  // through the actual controller is covered immediately below.
  it('keeps remote wire labels from granting Lead tool authority across native MCP transports', async () => {
    const results: Array<{ transport: string; caller: string; result: unknown }> = [];
    const forwarded: Array<{ device: string; request: Record<string, unknown> }> = [];
    const native = engine(undefined, async (input, options) => {
      const tools = input.tools!, provider = tools.providers.find(provider => provider.name === 'orca_worker_bridge')!;
      for (const transport of ['sdk', 'codex', 'pi'] as const) for (const caller of ['root', 'descendant', 'unknown'] as const) {
        const ctx = { sessionId: options.sessionId!, sessionInstanceId: options.sessionInstanceId!, workingDir: options.workingDir,
          agentKind: transport === 'sdk' ? 'claude-code' as const : transport, mcpCallerKind: caller, mcpCallerAttested: caller !== 'unknown', vendorOptions: {} };
        const client = new McpClient({ name: 'worker-report-test', version: '1' });
        let dispose = () => {};
        try {
          if (transport === 'sdk') {
            const server = (provider.toClaudeSdkConfig!(ctx) as { instance: McpServer }).instance;
            const pair = InMemoryTransport.createLinkedPair(); await server.connect(pair[1]); await client.connect(pair[0]);
          } else if (transport === 'pi') {
            const bridge = tools.pi(ctx); dispose = bridge.disposeSessionCtx!;
            await client.connect(new StreamableHTTPClientTransport(new URL(bridge.mcpBridge!.servers.find(server => server.name === provider.name)!.url), { requestInit: { headers: { Authorization: `Bearer ${bridge.mcpBridge!.token}` } } }));
          } else {
            tools.registerCodexMcpThreadContext({ ...ctx, threadId: `thread-${caller}` });
            dispose = () => tools.unregisterCodexMcpThreadContext(`thread-${caller}`, ctx.sessionInstanceId);
            const config = provider.toCodexMcpConfig!(ctx)!;
            await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: { Authorization: `Bearer ${tools.env[config.bearerTokenEnvVar!]}` } } }));
          }
          results.push({ transport, caller, result: await client.callTool({ name: 'send_to_lead', arguments: { worker_id: 'worker-1', message: 'Finished' }, ...(transport === 'codex' ? { _meta: { threadId: `thread-${caller}` } } : {}) }) });
        } finally { await client.close(); dispose(); }
      }
    });
    const { host, root, nextPush } = await setup(native, { remoteInvoke: async (device, _channel, args) => {
      forwarded.push({ device, request: args[0] as Record<string, unknown> });
      return { ok: true, result: { content: [{ type: 'text', text: '{"ok":true}' }], isError: false } };
    } });
    const context = { source: 'remote' as const, deviceId: 'lead-pc', ownerId: 'owner', assertCurrent() {} };
    await expect(host.invoke('maker:orca:remote-worker:caps', [], context)).resolves.toMatchObject({ workerBridge: true });
    await host.invoke('maker:orca:remote-worker:open', [{ sessionId: 'report-worker', agentKind: 'claude-code', permissionMode: 'auto', title: 'Worker', workingDir: root,
      lead: { leadSessionId: 'lead-task', leadTitle: 'Lead', workerLabel: 'Research' } }], context);
    const finished = nextPush('maker:event', payload => (payload as {sessionId:string;event:AgentEvent}).sessionId === 'report-worker' && (payload as {event:AgentEvent}).event.type === 'done');
    await host.invoke('maker:input:enqueue', ['report-worker', buildRemoteWorkerQueuedMessage({ clientId: 'lead-assignment', rawContent: 'Research', createdAt: new Date().toISOString(),
      createOpts: { agentKind: 'claude-code', model: 'test-model', providerId: 'fixture', workingDir: root } })], context);
    await finished;
    expect(results).toHaveLength(9);
    expect(results.filter(row => row.caller === 'root').every(row => JSON.stringify(row.result).includes('NOT_LEAD_ASSIGNED_TURN'))).toBe(true);
    expect(results.filter(row => row.caller === 'descendant').every(row => JSON.stringify(row.result).includes('NESTED_AGENT_NOT_ALLOWED'))).toBe(true);
    expect(results.filter(row => row.caller === 'unknown').every(row => JSON.stringify(row.result).includes('CALLER_PROVENANCE_REQUIRED'))).toBe(true);
    expect(forwarded).toHaveLength(0);
    await host.invoke('maker:send', ['report-worker', { clientId: 'human-turn', text: 'Now answer my question.' }]);
    expect(await host.invoke('terminal:tasks:wait', ['report-worker', 'human-turn'])).toMatchObject({ status: 'completed' });
    expect(results).toHaveLength(18);
    expect(results.slice(9).filter(row => row.caller === 'root').every(row => JSON.stringify(row.result).includes('NOT_LEAD_ASSIGNED_TURN'))).toBe(true);
    expect(forwarded).toHaveLength(0);
  });

  // Integration: use the actual Desktop controller, full wire payload, durable
  // delivery receipts and history reader against the Node execution host.
  it('executes and reports original cross-device Worker dispatch after a controller reconnect', async () => {
    let entered!: () => void, complete!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const completion = new Promise<void>(resolve => { complete = resolve; });
    const native = engine(undefined, async () => { entered(); await completion; });
    const { host, root } = await setup(native);
    const caller = { source: 'remote' as const, deviceId: 'lead-pc', ownerId: 'owner', assertCurrent() {} };
    await host.invoke('maker:orca:remote-worker:open', [{ sessionId: 'original-remote-worker', agentKind: 'claude-code', permissionMode: 'auto', title: 'Worker', workingDir: root,
      lead: { leadSessionId: 'original-lead', leadTitle: 'Lead', workerLabel: 'Research' } }], caller);
    const ref: RemoteWorkerRef = { workerId: 'worker-1', teamId: 'team-1', leadSessionId: 'original-lead', proxySessionId: 'proxy-1',
      deviceId: 'execution-pc', remoteSessionId: 'original-remote-worker', lastBridgedMessageId: null };
    const reports: RemoteWorkerTurnEnd[] = [];
    const starts: string[] = [];
    let offline = false;
    let durable: RemoteWorkerRef['pendingReport'];
    const controller = () => createOrcaRemoteWorkerRuntime({
      invoke: async (device, channel, args) => {
        expect(device).toBe('execution-pc');
        if (offline) throw new Error('[DEVICE_OFFLINE] execution device offline');
        return host.invoke(channel, args, caller);
      },
      saveReport: async (_id, pending) => { durable = pending; },
      deviceName: () => 'Execution computer', now: Date.now, log: logger,
      setTimeout: () => 0, clearTimeout: () => {},
      onTurnStarted: async id => { starts.push(id); },
      captureTurnEnded: () => async turn => { reports.push(turn); return true; },
      onWorkerStateChanged: () => {},
    });
    const first = controller(); first.track(ref);
    try {
      const result = await first.dispatch({ proxySessionId: ref.proxySessionId, rawContent: 'Inspect remote project', clientId: 'original-lead-input' });
      expect(result).toMatchObject({ ok: true, agentKind: 'claude-code' });
      first.confirmDispatchAccepted(ref.proxySessionId, 'original-lead-input');
      expect(durable?.clientIds).toEqual(['original-lead-input']);
      await started;
      await first.pollNow();
      expect(starts).toEqual(['proxy-1']);
      offline = true;
      await first.pollNow();
      expect(first.isReachable(ref.proxySessionId)).toBe(false);
      complete();
      await vi.waitFor(async () => {
        const rows = await host.invoke('local-db:messages:around-client-id', [ref.remoteSessionId, 'original-lead-input', { radius: 10 }]) as Array<{ role: string; content: string }>;
        expect(rows.some(row => row.role === 'assistant' && row.content.includes('Inspect remote project'))).toBe(true);
      }, { interval: 5 });
      expect(reports).toEqual([]);
    } finally { complete(); first.stop(); }
    const resumed = controller(); resumed.track({ ...ref, pendingReport: durable });
    try {
      offline = false;
      await resumed.pollNow();
      expect(reports).toEqual([expect.objectContaining({ status: 'done', finalText: expect.stringContaining('Inspect remote project') })]);
      expect(durable).toBeNull();
      await resumed.pollNow();
      expect(reports).toHaveLength(1);
      expect(native.sentFor(ref.remoteSessionId)).toHaveLength(1);
      expect(starts).toEqual(['proxy-1']);
    } finally { resumed.stop(); }
  });

  // Integration: authenticate the persisted remote Lead before bootstrap and
  // retain the original task/history when the owner releases collaboration.
  it('receives remote workers with original durable ownership and release semantics', async () => {
    let readRow!: (id: string) => Promise<unknown>;
    let persistedBeforeStart: unknown;
    const native = engine(async (_input, options) => { persistedBeforeStart = await readRow(options.sessionId!); });
    const { host, root, create, nextPush } = await setup(native, { deviceId: 'execution-pc' });
    readRow = id => host.storage.get(id);
    const context = { source: 'remote' as const, deviceId: 'lead-pc', ownerId: 'owner', assertCurrent() {}, sourceDevice: { deviceId: 'lead-pc', name: 'Lead computer', platform: 'desktop' as const } };
    const request = { sessionId: 'remote-worker', agentKind: 'claude-code', permissionMode: 'auto', title: 'Remote worker', workingDir: root,
      lead: { leadSessionId: 'lead-task', leadTitle: 'Lead task', workerLabel: 'Research', leadDeviceId: 'spoofed' } };
    const open = (target: TerminalTaskHost) => target.invoke('maker:orca:remote-worker:open', [request], context);
    await expect(host.invoke('maker:orca:remote-worker:caps')).rejects.toThrow(/PRECONDITION_FAILED/);
    await expect(host.invoke('maker:orca:remote-worker:open', [request], { ...context, sharedTask: { sharedTaskId: 'share', sessionId: 'remote-worker', memberId: 'guest', accountId: 'guest' } })).rejects.toThrow(/SHARED_TASK_PERMISSION_DENIED/);
    const [first, duplicate] = await Promise.all([open(host), open(host)]);
    expect(duplicate).toEqual(first);
    expect(native.starts).toHaveLength(1);
    expect(persistedBeforeStart).toMatchObject({ providerId: 'fixture', model: 'test-model', orcaRemoteLead: { leadDeviceId: 'lead-pc', leadSessionId: 'lead-task' } });
    await expect(host.invoke('maker:orca:remote-worker:open', [request], { ...context, deviceId: 'another-pc' })).rejects.toThrow(/ALREADY_EXISTS/);
    await expect(host.invoke('maker:orca:remote-worker:models', [{ agent: 'claude-code', agentDeviceId: 'execution-pc' }], context)).resolves.toMatchObject({ agentDeviceId: null, claude_code: [{ id: 'test-model', providers: [{ id: 'fixture' }] }] });
    const item = (clientId: string) => buildRemoteWorkerQueuedMessage({ clientId, rawContent: 'Research this.', createdAt: new Date().toISOString(),
      createOpts: { agentKind: 'claude-code', model: 'test-model', providerId: 'fixture', workingDir: root } });
    const finished = nextPush('maker:event', payload => (payload as {sessionId:string;event:AgentEvent}).sessionId === 'remote-worker' && (payload as {event:AgentEvent}).event.type === 'done');
    await host.invoke('maker:input:enqueue', ['remote-worker', item('assigned')], context);
    await finished;
    const rows = await host.invoke('local-db:messages:around-client-id', ['remote-worker', 'assigned', {radius:0}]) as Array<{agentMeta:Record<string,unknown>}>;
    expect(rows[0]?.agentMeta).toMatchObject({ sourceDevice: context.sourceDevice });
    expect(rows[0]?.agentMeta?.origin).toBeUndefined();
    await host.close();
    const resumed = create(); await resumed.ready;
    readRow = id => resumed.storage.get(id);
    expect(await open(resumed)).toEqual(first);
    await expect(resumed.invoke('maker:orca:remote-worker:release', [{sessionId:'remote-worker'}], {...context,deviceId:'another-pc'})).rejects.toThrow(/NOT_FOUND/);
    await expect(resumed.invoke('maker:orca:remote-worker:release', [{sessionId:'remote-worker'}], context)).resolves.toEqual({released:true});
    expect(await resumed.storage.get('remote-worker')).toMatchObject({ orcaRemoteLead: {leadDeviceId:'lead-pc',releasedAt:expect.any(Number)} });
    expect(await resumed.invoke('local-db:messages:around-client-id', ['remote-worker', 'assigned', {radius:0}])).toHaveLength(1);
    await expect(open(resumed)).rejects.toThrow(/ALREADY_EXISTS/);
  });

  // Integration: without the host delegate Auto fell back to an unavailable
  // reviewer. Exercise real candidate HTTP and the core authority fence; a
  // closed task must revoke its pending result and abort the network request.
  it('runs Auto review through the connected auxiliary model and revokes a closed task',async()=>{
    const {host,root,native}=await setup();
    let reply=async()=>'{"verdict":"allow"}';
    const api=await auxiliaryFixture(host,()=>reply());
    let release=()=>{};
    try{
      const task=await host.invoke('maker:create-session',[{workingDir:root,permissionMode:'auto'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'Read project files.',clientId:'auto-input'}]);
      await host.invoke('terminal:tasks:wait',[task.id,'auto-input']);
      const delegate=native.inputs.find(input=>input.taskId===task.id)!.reviewAutoPermissionAction!;
      const request:AutoReviewRequest={sessionId:task.id,agentKind:'claude-code',providerId:'fixture',model:'test-model',userIntent:'Read project files.',action:{kind:'exec',command:'ls'},workspaceRoots:[root],platform:process.platform};
      const run=()=>withAutoReviewContext(request,delegate,async prepared=>await delegate(prepared)??{verdict:'ask'});
      expect(await run()).toEqual({verdict:'allow'});
      expect(api.requests).toHaveLength(1);
      let entered!:()=>void;
      const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
      reply=async()=>{entered();await gate;return '{"verdict":"allow"}';};
      const pending=run();await started;
      await host.invoke('maker:close-session',[task.id]);
      expect(await pending).toMatchObject({verdict:'ask',unavailable:true});
      expect(api.requests).toHaveLength(2);
    }finally{release();await api.close();}
  });

  // Integration: companion settings previously never reached the native
  // permission mode/reviewer. Exercise resource + GUI updates, durable rollback,
  // actual auxiliary HTTP, and scheduled-input authority through real Maker.
  it('persists companion permissions and reviews only owner intent through the connected auxiliary model', async () => {
    const { host, root, native } = await setup();
    let reply = async () => '{"verdict":"allow"}';
    const api = await auxiliaryFixture(host, () => reply());
    await connectCompanionFixture(host,root);
    const companion = new TerminalCompanionHost({ tasks: host, root: path.join(root, 'companions'), profileDir: root,
    logger, guard() { }, emit() { }, binary: async () => process.execPath });
    let release = () => {};
    try {
      await companion.modelSettings.saveDefaults([{ agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', fastMode: false }]);
      const profile = await companion.create({ name: 'Permission fixture' });
      const registry = new RemoteResourceRegistry(); await registerCompanionResources(registry, companion);
      const client = { protocolVersion: 1 as const, primitives: ['form'], locale: 'zh-CN' }, context = { controllerDeviceId: 'owner' };
      const ref = { collectionId: 'teammates', kind: 'bot', id: profile.id };
      const before = await registry.get(context, { client, ref });
      const permissionAction=(resource:typeof before)=>(resource.blocks!.find(block=>block.id==='permissions')!.data as {actionId:string}).actionId;
      expect(before.actions?.find(action=>action.id===permissionAction(before))?.confirmation).toBeDefined();
      await registry.invoke(context,{client,collectionId:'teammates',resourceRef:ref,actionId:permissionAction(before),input:{permissions:'auto'}});
      expect(native.starts).toHaveLength(0);
      const send = async (text: string, clientId: string, origin?: Parameters<TerminalCompanionHost['send']>[3]) => {
        const result = await companion.send(profile.id, text, clientId, origin); await result.completion;
      };
      await send('Read files only. Do not delete anything.', 'owner');
      profile.sessionId=(await companion.profiles.get(profile.id))!.sessionId;
      expect(native.starts.at(-1)?.permissionMode).toBe('auto');
      let delegate = native.inputs.find(input => input.taskId === profile.sessionId)!.reviewAutoPermissionAction!;
      const request: AutoReviewRequest = { sessionId: profile.sessionId, agentKind: 'claude-code', providerId: 'fixture', model: 'test-model',
        userIntent: 'Read files only.', action: { kind: 'exec', command: 'ls' }, workspaceRoots: [companion.profiles.home(profile.id)], platform: process.platform };
      const run = () => withAutoReviewContext(request, delegate, async prepared => await delegate(prepared) ?? { verdict: 'ask' });
      expect(await run()).toEqual({ verdict: 'allow' }); expect(api.requests).toHaveLength(1);
      await send('Delete all files.', 'scheduled', { source: 'local', scheduler: { kind: 'scheduler', scheduleId: 'fixture', scheduleName: 'Fixture', runId: 'run' } });
      const intent = JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
      expect(intent).toContain('Do not delete anything.'); expect(intent).not.toContain('Delete all files.');
      const update = vi.spyOn(companion.storage, 'update').mockRejectedValueOnce(new Error('fixture disk unavailable'));
      await expect(companion.invoke('maker:set-permission-mode', [profile.sessionId, 'ask'], { source: 'local' })).rejects.toThrow('fixture disk unavailable');
      update.mockRestore();
      expect(native.permissionModes.slice(-2)).toEqual(['ask', 'auto']);
      expect((await companion.permissionState(profile.id)).mode).toBe('auto');
      expect(await run()).toMatchObject({verdict:'ask',unavailable:true});
      await send('Continue reading files only.', 'owner-resumed');
      delegate=native.inputs.filter(input=>input.taskId===profile.sessionId).at(-1)!.reviewAutoPermissionAction!;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      reply = async () => { entered(); await gate; return '{"verdict":"allow"}'; };
      const pending = run(); await Promise.race([started,pending.then(result=>{throw new Error('REVIEW_NOT_DISPATCHED:'+JSON.stringify(result));})]); await companion.stop(profile.id);
      expect(await pending).toMatchObject({ verdict: 'ask', unavailable: true });
      const settings=await registry.get(context,{client,ref});
      await expect(registry.invoke(context,{client,collectionId:'teammates',resourceRef:ref,actionId:permissionAction(settings),input:{permissions:'bypassPermissions'}})).rejects.toThrow('Invalid permissions');
      const refreshed=await registry.get(context,{client,ref});
      await registry.invoke(context,{client,collectionId:'teammates',resourceRef:ref,actionId:permissionAction(refreshed),input:{permissions:'trusted'}});
      expect((await registry.get(context,{client,ref})).revision).not.toBe(before.revision);
      await send('Continue reading.', 'resumed');
      expect(native.starts.at(-1)?.permissionMode).toBe('bypassPermissions');
      expect(JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT])).not.toContain('Delete all files.');
    } finally { release(); await companion.close(); await api.close(); }
  });

  it('keeps guest and scheduled input separate from owner authorization across task resume',async()=>{
    const {host,root,native}=await setup();
    const task=await host.invoke('maker:create-session',[{workingDir:root,permissionMode:'auto'}]) as {id:string};
    const send=async(text:string,id:string,context?:Parameters<TerminalTaskHost['invoke']>[2])=>{
      await host.invoke('maker:send',[task.id,{text,clientId:id}],context);
      await host.invoke('terminal:tasks:wait',[task.id,id]);
    };
    await send('Inspect the repository. Do not delete files.','owner-input');
    const detail: SharedTaskDetail = { sharedTaskId: 'share', sessionId: task.id, ownerAccountId: 'test-owner', hostDeviceId: 'host',
      revision: 1, status: 'active', title: 'Fixture', memberLabels: [],
      guests: [{ memberId: 'member', accountId: 'guest', deviceIds: ['peer'], version: 1 }] };
    const shared = new SharedTaskHost({
      api: createSharedTaskApi({ captureScope: () => ({ isCurrent: () => true }), request: async (_path, request) =>
        request.method === 'POST' ? { sharedTaskId: detail.sharedTaskId, revision: detail.revision }
          : { ...detail, guests: detail.guests.map(guest => ({ ...guest, displayName: 'Guest', joinedAt: null })) } }),
      journal: createSharedTaskJournal((await host.database).db), ownerAccountId: 'test-owner', hostDeviceId: 'host',
      isCurrent: () => true, readSession: async id => { const row = await host.storage.get(id); return row ? { id, title: row.title, status: 'active' } : null; },
      revoke() {}, changed() {},
    });
    await shared.open(task.id);
    const capture = shared.capturePeer(sharedTaskGuestPeer('share', 'member', 'peer'))!;
    expect(capture.authorize('input.send')).toBe(true);
    try {
      await send('Guest requests deletion.','guest-input',{source:'remote',deviceId:'peer',assertCurrent(){},sharedTask: capture.author, sharedTaskCapture: capture});
    } finally { await shared.dispose(); }
    expect(native.sends.at(-1)?.turnPermissionPolicy?.autoReviewContext).toEqual({requesterAuthority:'guest',source:'group'});
    await host.invoke('maker:close-session',[task.id]);
    await send('Continue the inspection.','owner-resume');
    const restored=JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
    expect(restored).toContain('Do not delete files.');expect(restored).not.toContain('Guest requests deletion.');
    await send('Delete everything automatically.','scheduled-input',{source:'local',scheduler:{kind:'scheduler',scheduleId:'fixture',scheduleName:'Fixture',runId:'run'}});
    const scheduled=JSON.stringify(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]);
    expect(scheduled).toContain('Do not delete files.');expect(scheduled).not.toContain('Delete everything automatically.');
  });
  // Integration: real Feishu device flow, resource lease and encrypted v3
  // controller. Only external HTTP is replaced. A raw authorization code in
  // resource traffic, a wrong controller, or a late cancelled poll is a bug.
  it('keeps Feishu registration on the initiating encrypted controller through expiry and cancellation', async () => {
    const { host: tasks, root, vault } = await setup();
    let active = true, wrongPeer = false;
    const guard = () => { if (!active) throw new Error('OWNER_CHANGED'); };
    const events: unknown[] = [], wire: unknown[] = [];
    const connections = new TerminalImConnections({ tasks, root, logger, assertCurrent: guard, emit: (channel, payload) => events.push({ channel, payload }), secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } });
    const configuration = new TerminalConfiguration(tasks.capabilities, undefined, { revision: () => connections.version(), registration: connections.registration, save: (id, value) => connections.saveConfiguration(id, value) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, tasks, configuration);
    const secrets = { get: async (key: string) => vault.get(key) ?? null, set: async (key: string, value: string) => { vault.set(key, value); }, delete: async (key: string) => { vault.delete(key); } };
    const make = (deviceId: string): TerminalProtectedInput => new TerminalProtectedInput({ root: path.join(root, deviceId), secrets,
      scope: () => ({ realm: 'global', membershipId: 'owner', deviceId }), assertCurrent: guard, remoteEnabled: () => true, taskExists: async () => true, emit: (channel, payload) => events.push({ channel, payload }),
      invoke: async (_device, channel, args) => {
        wire.push({ channel, args });
        const result = channel === 'maker:remote-resources:invoke'
          ? await registry.invoke({ controllerDeviceId: deviceId, assertCurrent: guard }, args[0] as Parameters<typeof registry.invoke>[1])
          : await host.request(wrongPeer ? 'another-controller' : deviceId, args[0]);
        wire.push({ result }); return { ok: true, result };
      },
    });
    const host = make('host'), controller = make('controller'); host.configureSettings(configuration);
    const http = vi.spyOn(connections.transport.host, 'httpPostForm').mockImplementation(async (_url, form) => ({ status: 200, body: form.get('action') === 'begin'
      ? { device_code: 'private-device-token', user_code: 'ABCD-EFGH', expires_in: 300, interval: 1 }
      : { error: 'expired_token', error_description: 'private-device-token' } }));
    try {
      await Promise.all([connections.groups.ready, connections.telegramSettings.ready]);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      wrongPeer = true;
      await expect(controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' })).rejects.toThrow();
      expect(http).not.toHaveBeenCalled(); wrongPeer = false;
      const begun = await controller.channelRegistration({ command: 'begin', service: 'lark', deviceId: 'host' });
      expect(begun.state).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: expect.stringContaining('https://open.larksuite.com/') });
      expect(JSON.stringify(begun)).not.toContain('private-device-token');
      await connections.invoke('feishuBot:set-lifecycle-announcement', { enabled: false });
      expect(await controller.channelRegistration({ command: 'read', id: begun.id })).toMatchObject({ state: { status: 'pending' } });
      await expect(host.channelRegistration({ command: 'read', id: begun.id })).rejects.toThrow('REGISTRATION_STALE');
      await vi.advanceTimersByTimeAsync(1100);
      expect(await controller.channelRegistration({ command: 'read', id: begun.id })).toEqual({ id: begun.id, state: { status: 'expired' } });
      const next = await controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' });
      await controller.channelRegistration({ command: 'cancel', id: next.id });
      const calls = http.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1100);
      expect(http).toHaveBeenCalledTimes(calls);
      await expect(controller.channelRegistration({ command: 'read', id: next.id })).rejects.toThrow('REGISTRATION_STALE');
      const pending = await controller.channelRegistration({ command: 'begin', service: 'feishu', deviceId: 'host' });
      active = false;
      await expect(controller.channelRegistration({ command: 'read', id: pending.id })).rejects.toThrow('OWNER_CHANGED');
      for (const secret of ['private-device-token', 'ABCD-EFGH']) expect(JSON.stringify({ wire, events })).not.toContain(secret);
    } finally {
      active = true; await controller.close(); await host.close(); await connections.close(); configuration.close(); http.mockRestore(); vi.useRealTimers();
    }
  });
  // The terminal SQLite schema must preserve the shared cursor receipt and
  // bot namespace rules, including a daemon restart between inbound turns.
  it('persists group history and compensated cursors without mixing bot identities', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-terminal-group-test-')); roots.push(root);
    await mkdir(path.join(root, 'im'));
    const original = new Database(path.join(root, 'im', 'history.sqlite'));
    original.exec(GROUP_WINDOW_SCHEMA_SQL); original.pragma('user_version = 1'); original.close();
    let store = new TerminalGroupWindows(root, () => {}, logger);
    try {
      let window = store.channel('wecom-personal');
      const entry = { botId: 'bot-a', chatId: 'group', threadId: '', messageId: 'earlier', author: { name: 'Alice' }, text: 'retained group context', sentAt: Date.now() };
      await window.record(entry);
      await window.record({ ...entry, botId: 'bot-b', text: 'isolated bot context' });
      await window.record({ ...entry, messageId: 'trigger', text: 'current trigger' });
      const query = { botId: 'bot-a', chatId: 'group', threadId: '', triggerMessageId: 'trigger' };
      const first = await window.buildContextPrefix(query);
      expect(first.prefix).toContain('retained group context');
      expect(first.prefix).not.toContain('isolated bot context');
      expect(first.prefix).not.toContain('current trigger');
      const receipt = await first.commit();
      expect((await window.buildContextPrefix(query)).prefix).toBe('');
      expect(receipt).toBeDefined(); await receipt!.rollback();
      const replay = await window.buildContextPrefix(query);
      expect(replay.prefix).toContain('retained group context');
      await replay.commit();
      await store.close();
      store = new TerminalGroupWindows(root, () => {}, logger);
      window = store.channel('wecom-personal');
      expect((await window.buildContextPrefix(query)).prefix).toBe('');
      expect((await window.buildContextPrefix({ ...query, botId: 'bot-b' })).prefix).toContain('isolated bot context');
      expect(await window.listKnownGroups('bot-a')).toEqual([{ chatId: 'group', chatName: null }]);
      expect(await store.search({ lane: { provider: 'wecom-personal:bot-b', chatId: 'group', threadId: '' }, query: 'isolated' })).toMatchObject([{ messageId: 'earlier' }]);
      expect(await store.search({ lane: { provider: 'wecom-personal:bot-a', chatId: 'group', threadId: '' }, query: 'isolated' })).toEqual([]);
      await window.record({ ...entry, messageId: 'not-admitted', text: 'must remain unread after shutdown' });
      const unaccepted = await window.buildContextPrefix({ ...query, triggerMessageId: '' });
      let continueGuard!: (valid: boolean) => void, reached!: () => void;
      const checkpoint = new Promise<void>(resolve => { reached = resolve; });
      let guardCalls = 0;
      const committing = unaccepted.commit(async () => {
        if (++guardCalls === 1) return true;
        reached(); return new Promise<boolean>(resolve => { continueGuard = resolve; });
      });
      await checkpoint;
      const closing = store.close();
      continueGuard(false);
      await committing; await closing;
      store = new TerminalGroupWindows(root, () => {}, logger);
      expect((await store.channel('wecom-personal').buildContextPrefix({ ...query, triggerMessageId: '' })).prefix).toContain('must remain unread after shutdown');
    } finally { await store.close(); }
  });
  // Real Discord transport, encrypted vault, media ledger and task composition;
  // only Discord's remote gateway and vendor process are replaced at their I/O.
  it('connects the official Discord transport to encrypted settings and terminal tasks', async () => {
    const { host, native, root } = await setup();
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'discord');
    const secrets = new TerminalSecretStore(path.join(root, 'vault'));
    await secrets.open(); await secrets.initialize('machine');
    type GatewayFactory = NonNullable<import('@cindy/im').DiscordIMOptions['gatewayFactory']>;
    let inbound!: Parameters<GatewayFactory>[0];
    const output: unknown[] = [];
    const connected: string[] = [];
    const channel = { id: 'dm-owner', send: async (payload: unknown) => { output.push(payload); return { id: String(output.length) }; },
      messages: { fetch: async () => ({ edit: async (payload: unknown) => { output.push(payload); }, delete: async () => {} }) } };
    const client = { users: { fetch: async () => ({ createDM: async () => channel }) }, channels: { fetch: async () => channel } };
    let current = true;
    const guard = () => { if (!current) throw new Error('OWNER_CHANGED'); };
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent: guard, emit() {}, secrets: {
      getSync: key => secrets.getSync(key), setSync: (key, value) => secrets.setSync(key, value), deleteSync: key => secrets.deleteSync(key), available: () => !secrets.status().locked,
    } }, { discord: { gatewayFactory: handlers => {
      inbound = handlers;
      return { appId: 'test-app', botTag: 'test#0001', client: client as unknown as ReturnType<GatewayFactory>['client'],
        connect: async token => { connected.push(token); handlers.onStatus({ kind: 'connected', appId: 'test#0001' }); }, destroy: async () => {
          if (host.channelControl.account.captureImAccountGeneration() === null) expect(connections.transport.host.secrets.write('discord-bot-token', 'late-token')).toBe(false);
        } };
    } } });
    const configuration = new TerminalConfiguration(host.capabilities, undefined, {
      revision: () => connections.version(), save: async (id, value, context) => { expect(id).toBe('discord'); context.assertCurrent?.(); await connections.invoke('discordBot:set-config', value); },
    });
    try {
      await connections.start();
      const token = 'synthetic-discord-token-not-a-real-credential';
      await configuration.save({ collectionId: 'channels', actionId: 'edit', resourceId: 'discord' }, { token, ownerUserId: 'owner' }, { source: 'local', assertCurrent: guard });
      expect(connected).toEqual([token]);
      expect(JSON.stringify(await connections.invoke('discordBot:get-status', undefined))).not.toContain(token);
      const persisted = new TerminalSecretStore(path.join(root, 'vault')); await persisted.open();
      expect(persisted.getSync('discord-bot-token')).toBe(token); persisted.lock();
      const media = connections.transport.host.media!;
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7xkAAAAASUVORK5CYII=', 'base64');
      const cached = await media.cacheImage({ integration: 'discord', token: 'attachment-1', buffer: png, mimeType: 'image/png', staging: true });
      expect(await readFile(cached.absPath)).toEqual(png);
      expect(await media.getCachedImage('discord', 'attachment-1', { shouldReuse: () => false })).toBeNull();
      expect(await media.getCachedImage('discord', 'attachment-1')).toMatchObject({ url: cached.url });
      await cached.discard?.();
      expect(await media.getCachedImage('discord', 'attachment-1')).toBeNull();
      inbound.onDmMessage({ id: 'incoming', content: 'hello through Discord', author: { id: 'owner' }, channelId: 'dm-owner', attachments: [], stickers: [] } as unknown as Parameters<typeof inbound.onDmMessage>[0]);
      await vi.waitFor(() => expect(JSON.stringify(output)).toContain('Echo:'));
      expect(native.sent).toHaveLength(1);
      expect((await host.storage.list()).find(row => row.source === 'discord')).toMatchObject({ imUserId: 'owner', imBotContextId: 'test-app', workspaceKind: 'dialogue' });
      secrets.setSync('discord-bot-runtime-active', 'synthetic-active-marker');
      await connections.close(); current = false;
      expect(secrets.getSync('discord-bot-runtime-active')).toBeNull();
      expect(secrets.getSync('discord-bot-token')).toBe(token);
      await expect(media.cacheImage({ integration: 'discord', token: 'late', buffer: png, mimeType: 'image/png' })).rejects.toThrow('IM_ACCOUNT_SCOPE_CLOSED');
      await expect(connections.invoke('discordBot:set-config', { token: 'late', ownerUserId: 'intruder' })).rejects.toThrow('IM_ACCOUNT_SCOPE_CLOSED');
    } finally { await connections.close(); configuration.close(); secrets.lock(); }
  });
  // The transport callbacks enter the production command/card/turn composition.
  // Telegram must retain topic history while /new rotates to a distinct task.
  // Only the Bot API and native engine I/O are substituted (integration tier).
  // Integration: companion connections preserve original canonical/channel
  // ownership and credential removal through the real transport and Maker.
  it('runs original companion IM connections and separates owner and guest lanes', async () => {
    const {host,root,vault,native}=await setup();
    await host.models.setVisibility('claude-code','fixture',['test-model'],true);
    await connectCompanionFixture(host,root);
    await host.invoke('local-db:bots:model-chain-settings-set',[{modelChain:[{harness:'claude',providerId:'fixture',model:'test-model',effort:'',fastMode:false}]}]);
    await host.invoke('local-db:bots:create',[{id:'channel-companion',name:'Channel companion',identitySource:'IM fixture',avatar:'✦'}]);
    const output:Array<{method:string;params:Record<string,unknown>}>=[];
    let receive:((updates:unknown[])=>void)|undefined,sequence=1000;
    const api:import('@cindy/im').TelegramApiClient={
      fileUrl:file=>`https://files.invalid/${file}`,callForm:async()=>{throw new Error('UNEXPECTED_UPLOAD');},
      call:async(method,params={},signal)=>{
        output.push({method,params});
        if(method==='getMe')return {id:999,is_bot:true,first_name:'Companion',username:'fixture_companion_bot'} as never;
        if(method==='getUpdates')return new Promise((resolve,reject)=>{
          const abort=()=>{receive=undefined;reject(new Error('aborted'));};
          receive=updates=>{signal?.removeEventListener('abort',abort);receive=undefined;resolve(updates as never);};
          if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
        });
        if(method.startsWith('send'))return {message_id:++sequence,date:Math.floor(Date.now()/1000),chat:{id:Number(params.chat_id),type:'private'}} as never;
        return {} as never;
      },
    };
    const im=new TerminalImConnections({tasks:host,root,logger,assertCurrent(){},emit(){},secrets:{
      getSync:key=>vault.get(key)??null,setSync:(key,value)=>{vault.set(key,value);},deleteSync:key=>{vault.delete(key);},available:()=>true,
    }},{telegram:{apiFactory:()=>api}});
    const push=async(updateId:number,peer:number,text:string)=>{
      await vi.waitFor(()=>expect(receive).toBeTypeOf('function'));
      receive!([{update_id:updateId,message:{message_id:updateId,date:Math.floor(Date.now()/1000),text,
        chat:{id:peer,type:'private'},from:{id:peer,is_bot:false,first_name:peer===111?'Owner':'Guest'}}}]);
      await vi.waitFor(()=>expect(output.some(row=>row.method.startsWith('send')&&JSON.stringify(row.params).includes('Echo:')&&JSON.stringify(row.params).includes(text))).toBe(true));
    };
    try{
      await im.connectCompanions();await im.start();
      const added=await im.invoke('botImConnection:add',{botId:'channel-companion',channel:'telegram',token:'123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef',ownerUserId:'111'}) as {connection:{id:string;status:{kind:string}}};
      expect(added.connection.status.kind).toBe('connected');
      expect(vault.get('telegram-bot-token')).toBeUndefined();
      expect([...vault.keys()]).toContain(`bot-im-${added.connection.id}-telegram-bot-token`);
      await push(1,111,'Owner canonical fixture');
      const profile=await host.invoke('local-db:bots:get',['channel-companion']) as {canonicalSessionId:string};
      expect(native.starts[0]?.sessionId).toBe(profile.canonicalSessionId);
      await push(2,222,'Guest lane fixture');
      const guestId=native.starts.at(-1)!.sessionId!;
      expect(guestId).not.toBe(profile.canonicalSessionId);
      expect(JSON.stringify(await im.invoke('botImConnection:list-lanes',{id:added.connection.id}))).toContain(guestId);
      const config=new TerminalConfiguration(host.capabilities,undefined,{revision:()=>im.version(),save:(id,input)=>im.saveConfiguration(id,input)});
      const registry=new RemoteResourceRegistry();registerImResources(registry,im,host,config);
      const client={protocolVersion:1,primitives:['text','form'],locale:'en'},context={controllerDeviceId:'owner'};
      expect((await registry.list(context,{client,collectionId:'channels'})).items.map(row=>row.ref.id)).toContain('wechat');
      await registry.invoke(context,{client,collectionId:'channels',resourceRef:{collectionId:'channels',kind:'im-channel',id:'wechat'},actionId:'companion',input:{botId:'channel-companion'}});
      expect(await im.invoke('wechatBot:get-channel-settings',undefined)).toMatchObject({companionBotId:'channel-companion'});
      await im.invoke('botImConnection:remove',{id:added.connection.id});
      expect([...vault.keys()].some(key=>key.startsWith(`bot-im-${added.connection.id}-`))).toBe(false);
      expect(await host.invoke('local-db:sessions:get',[guestId])).toMatchObject({status:'archived'});
      expect(await host.invoke('local-db:sessions:get',[profile.canonicalSessionId])).toMatchObject({status:'active'});
    }finally{await im.close();}
  });

  it('runs Telegram polling, topic history, settings and task rotation in the terminal host', async () => {
    const { host, native, root } = await setup();
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'telegram');
    const secrets = new TerminalSecretStore(path.join(root, 'vault')); await secrets.open(); await secrets.initialize('machine');
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let receive: ((updates: unknown[]) => void) | undefined, sequence = 1000;
    let secondReply!: () => void;
    const secondReplySent = new Promise<void>(resolve => { secondReply = resolve; });
    const api: import('@cindy/im').TelegramApiClient = {
      fileUrl: file => `https://files.invalid/${file}`,
      callForm: async () => { throw new Error('UNEXPECTED_UPLOAD'); },
      call: async (method, params = {}, signal) => {
        calls.push({ method, params });
        if (JSON.stringify(params).includes('Echo:') && JSON.stringify(params).includes('new topic task')) secondReply();
        if (method === 'getMe') return { id: 999, is_bot: true, first_name: 'Cindy', username: 'terminal_cindy_bot' } as never;
        if (method === 'getUpdates') return new Promise((resolve, reject) => {
          const abort = () => { receive = undefined; reject(new Error('aborted')); };
          receive = updates => { signal?.removeEventListener('abort', abort); receive = undefined; resolve(updates as never); };
          if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
        });
        if (method.startsWith('send')) return { message_id: ++sequence, date: Math.floor(Date.now() / 1000), chat: { id: Number(params.chat_id), type: Number(params.chat_id) < 0 ? 'supergroup' : 'private' } } as never;
        return {} as never;
      },
    };
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit() {}, secrets: {
      getSync: key => secrets.getSync(key), setSync: (key, value) => secrets.setSync(key, value), deleteSync: key => secrets.deleteSync(key), available: () => !secrets.status().locked,
    } }, { telegram: { apiFactory: () => api } });
    const configuration = new TerminalConfiguration(host.capabilities, undefined, { revision: () => connections.version(), save: (id, input) => connections.saveConfiguration(id, input) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, host, configuration);
    const context = { controllerDeviceId: 'terminal' }, client = { protocolVersion: 1, primitives: ['text', 'form', 'actions'], locale: 'zh-CN' };
    const resourceRef = { collectionId: 'channels', kind: 'im-channel', id: 'telegram' };
    const push = async (id: number, text: string, topic = 77, owner = true) => {
      await vi.waitFor(() => expect(receive).toBeTypeOf('function'));
      receive!([{ update_id: id, message: { message_id: id, message_thread_id: topic, is_topic_message: true, date: Math.floor(Date.now() / 1000), text,
        chat: { id: -100, type: 'supergroup', title: 'Terminal group' }, from: { id: owner ? 111 : 222, is_bot: false, first_name: owner ? 'Owner' : 'Alice' },
        ...(text.startsWith('@terminal_cindy_bot') ? { entities: [{ type: 'mention', offset: 0, length: '@terminal_cindy_bot'.length }] } : {}),
      } }]);
    };
    try {
      await connections.start();
      await connections.saveConfiguration('telegram', { token: '999:synthetic-token', ownerUserId: '111' });
      expect(connections.telegram.getStatus().kind).toBe('connected');
      expect(calls).toContainEqual({ method: 'setMyCommands', params: { scope: { type: 'chat', chat_id: 111 }, commands: expect.arrayContaining([{ command: 'new', description: 'Create a new session' }]) } });
      const view = await registry.get(context, { client, ref: resourceRef });
      expect(view.actions?.find(action => action.id === 'edit')?.fields).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'token', kind: 'secret' })]));
      expect(JSON.stringify(view)).not.toContain('synthetic-token');
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'persona', input: { botName: 'Terminal helper', soul: 'Shared persona fixture' } });
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'behavior', input: { emojiReactions: 'off' } });
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef, actionId: 'permissions', input: { permissionMode: 'ask', groupPermissionMode: 'ask' } });
      expect(host.channelDefaults.read('telegram').groupPermissionMode).toBe('ask');
      await push(1, 'topic history amber-47', 77, false);
      await vi.waitFor(async () => expect(await connections.groups.search({ lane: { provider: 'telegram-personal:999', chatId: '-100', threadId: '77' }, query: 'amber' })).toHaveLength(1));
      await push(2, '@terminal_cindy_bot recall topic history');
      await vi.waitFor(() => expect(native.sent).toHaveLength(1));
      expect(JSON.stringify(native.sent[0])).toContain('amber-47');
      expect(JSON.stringify(native.sent[0])).toContain('Shared persona fixture');
      await vi.waitFor(() => expect(JSON.stringify(calls)).toContain('Echo:'));
      const first = (await host.storage.list()).find(row => row.source === 'telegram')!;
      expect(first.imUserId).toBe('g/-100/77');
      expect(native.inputs.find(input => input.taskId === first.id)?.tools?.providers.map(provider => provider.name)).toEqual(expect.arrayContaining(['cindy_telegram_bot', 'cindy_group_history']));
      await push(3, '/new');
      await vi.waitFor(async () => expect((await host.storage.list()).filter(row => row.source === 'telegram')).toHaveLength(2));
      await push(4, '@terminal_cindy_bot new topic task');
      // Observe completion instead of racing a one-second poll against native
      // task teardown and filesystem work on slower CI hosts.
      await secondReplySent;
      expect(native.sent).toHaveLength(2);
      const latest = (await host.storage.list()).filter(row => row.source === 'telegram').find(row => row.id !== first.id)!;
      expect(latest.imUserId).toBe(first.imUserId);
      expect(await connections.invoke('telegramBot:list-groups', undefined)).toMatchObject({ groups: [{ chatId: '-100', activation: 'mention' }] });
      await connections.close();
      const { TerminalTelegramSettings } = await import('../im/telegram-settings.js');
      const settings = new TerminalTelegramSettings(root, () => {}); await settings.ready;
      expect(settings.persona().botName).toBe('Terminal helper'); expect(settings.behavior().emojiReactions).toBe('off'); await settings.close();
    } finally { await connections.close(); configuration.close(); secrets.lock(); }
  });
  // Integration: actual Feishu adapter/orchestrator, task runtime and SQLite
  // receipts. SDK sends/history and native engine processes are the I/O seams.
  it('routes Feishu history and durable notification replies through the terminal host', async () => {
    const { host, native, root, vault } = await setup(engine(async (input, options) => {
      const provider = input.tools?.providers.find(item => item.name === 'cindy_feishu_bot');
      if (provider) await provider.toClaudeSdkConfig!({ sessionId: options.sessionId, workingDir: root, agentKind: 'claude-code' });
    }));
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'feishu');
    const auxiliary=await auxiliaryFixture(host, async () => 'RELATED');
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit() {}, secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } });
    const im = connections.feishu, output: string[] = [];
    const spies = [
      vi.spyOn(im, 'getStatus').mockReturnValue({ kind: 'connected', appId: 'cli_fixture' }),
      vi.spyOn(im, 'getOwnerOpenId').mockReturnValue('ou_owner'),
      vi.spyOn(im, 'getChatName').mockResolvedValue('Terminal group'),
      vi.spyOn(im, 'reactToMessage').mockResolvedValue(null),
      vi.spyOn(im, 'sendText').mockImplementation(async (_id, text) => { output.push(text); return { messageId: 'sent' }; }),
      vi.spyOn(im, 'sendMarkdownText').mockImplementation(async (_id, text) => { output.push(text); return { messageId: 'sent' }; }),
      vi.spyOn(im, 'startStreamingText').mockImplementation(async () => ({ messageId: 'stream', append() {}, replace() {}, close() {}, finalize: async text => { output.push(text); } })),
      vi.spyOn(im, 'fetchChatHistoryPage').mockResolvedValue({ messages: [{ messageId: 'om_history', threadId: '', senderName: 'Alice', senderOpenId: 'ou_member', senderIsBot: false, text: 'feishu-context-violet-83', attachments: [], createTimeMs: Date.now() }], nextPageToken: null }),
      vi.spyOn(im, 'sendNotification').mockResolvedValue({ messageId: 'om_notification', chatId: 'oc_owner' }),
    ];
    const event = (text: string): IMMessageEvent => ({ channelName: 'feishu', senderId: 'g/oc_group', contextId: 'cli_fixture', chatId: 'oc_group', messageId: 'om_trigger', text, attachments: [], unsupported: [], speaker: { id: 'ou_owner', name: 'Owner', isOwner: true } });
    try {
      await connections.start();
      im.scope.events.emit('message', event('recall the previous group message'));
      await vi.waitFor(() => expect(output.some(text => text.includes('Echo:'))).toBe(true));
      expect(JSON.stringify(native.sent)).toContain('feishu-context-violet-83');
      expect(JSON.stringify(auxiliary.requests)).toContain('RELATED');
      const task = (await host.storage.list()).find(row => row.source === 'feishu')!;
      expect(task).toMatchObject({ feishuOpenId: 'g/oc_group', feishuBotAppId: 'cli_fixture' });
      expect(native.inputs.find(input => input.taskId === task.id)?.tools?.providers.map(provider => provider.name)).toContain('cindy_feishu_bot');
      await expect(connections.notifications.sendFeishuSessionNotification(im, task.id, 'finished')).resolves.toMatchObject({ sessionLinked: true });
      const reply = { ...event('continue original notification task'), senderId: 'ou_owner', chatId: 'oc_owner', speaker: undefined, messageId: 'om_reply', replyThread: { rootMessageId: 'om_notification', threadId: 'omt_notification' } };
      im.scope.events.emit('message', reply);
      await vi.waitFor(() => expect(output.some(text => text.includes('continue original notification task'))).toBe(true));
      expect(await host.storage.list()).toHaveLength(1);
      const originalSdk = task.sdkSessionId;
      expect((await host.storage.get(task.id))?.sdkSessionId).toBe(originalSdk);
      const ordinary = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
      const tools = native.inputs.find(input => input.taskId === ordinary.id)!.tools!;
      const provider = tools.providers.find(item => item.name === 'cindy_feishu_bot')!;
      const sdk = await provider.toClaudeSdkConfig!({ sessionId: ordinary.id, workingDir: root, agentKind: 'claude-code' }) as { instance: McpServer };
      const [left, right] = InMemoryTransport.createLinkedPair();
      const client = new McpClient({ name: 'feishu-terminal-test', version: '1' });
      await sdk.instance.connect(left); await client.connect(right);
      try {
        expect((await client.listTools()).tools.map(tool => tool.name)).toContain('send_text');
        vi.mocked(im.sendNotification).mockResolvedValueOnce({ messageId: 'om_mcp', chatId: 'oc_owner' });
        const result = await client.callTool({ name: 'call_tool', arguments: { name: 'send_message_to_user', args: { text: 'terminal task completed' } } });
        expect(JSON.stringify(result)).toContain('om_mcp'); expect(result.isError).not.toBe(true);
        expect(await connections.notifications.resolveFeishuNotificationReply(im, { ...reply, replyThread: { ...reply.replyThread!, rootMessageId: 'om_mcp' } })).toBe(ordinary.id);
      } finally { await client.close(); }
      // Keep receipts across a daemon restart and isolate another bot
      // even when it returns the same message and owner identifiers.
      await connections.close();
      const restored = new TerminalGroupWindows(root, () => {}, logger);
      try {
        const store = restored.notificationStore(async id => { const row = await host.storage.get(id); return row ? { workingDir: row.workDir, status: 'active' } : null; });
        expect(await store.find({ channel: 'feishu', botContextId: 'cli_fixture', userId: 'ou_owner', messageId: 'om_notification', chatId: 'oc_owner' })).toEqual({ sessionId: task.id });
        expect(await store.find({ channel: 'feishu', botContextId: 'another-bot', userId: 'ou_owner', messageId: 'om_notification', chatId: 'oc_owner' })).toBeNull();
      } finally { await restored.close(); }
      await expect(connections.notifications.resolveFeishuNotificationReply(im, reply)).rejects.toThrow('account changed');
    } finally { await connections.close(); for (const spy of spies) spy.mockRestore(); await auxiliary.close(); }
  });
  // The transport callbacks enter the production command/card/turn composition.
  // Regression: a successful picker must affect the next native turn and remain
  // durable; an invalid picker or a logged-out callback must not replace it.
  it('runs inbound messages and model cards through the terminal channel composition', async () => {
    const { host, native, root, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'card-provider', name: 'Card provider', auth: { method: 'none' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'card-model', name: 'Card model', contextWindow: 200000, defaultEnabled: true }, {id:'hidden-card-model',name:'Hidden card model',contextWindow:200000,defaultEnabled:true}] } } }]);
    // Hidden preferences must reach the original IM picker, independently of route disablement.
    await host.models.setVisibility('claude-code','card-provider',['hidden-card-model'],false);
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'feishu');
    let inbound!: (event: IMMessageEvent) => void;
    let action!: (event: IMCardActionEvent) => void;
    const cards: InteractiveCardSpec[] = [];
    const final: string[] = [];
    const unsubscribed: string[] = [];
    const im: RichChannelIM = {
      name: 'feishu', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: handler => { inbound = handler; return () => { unsubscribed.push('message'); }; },
      onCardAction: handler => { action = handler; return () => { unsubscribed.push('card'); }; },
      onStatusChange: () => () => {},
      sendText: async (_id, text) => { final.push(text); return { messageId: 'text' }; },
      sendMarkdownText: async (_id, text) => { final.push(text); return { messageId: 'markdown' }; },
      sendFile: async () => ({ ok: true, messageId: 'file' }),
      sendInteractiveCard: async (_id, card) => { cards.push(card); return { messageId: 'picker' }; },
      updateInteractiveCard: async (_id, card) => { cards.push(card); },
      patchMarkdownCard: async (_id, text) => { final.push(text); },
      startStreamingText: async () => ({ messageId: 'stream', append() {}, replace() {}, close() {}, finalize: async text => { final.push(text); } }),
    };
    const connection = host.channelOrchestrators.attach({
      channel: 'feishu', im, output: { kind: 'rich-card', im }, ui: wechatUi,
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' },
      sessions: { source: 'feishu', sessionIdFor: (bot, user) => `feishu_${bot}_${user}`, defaultTitle: () => 'Card task', ensureWorkingDir: () => root, extraInsertColumns: () => ({}) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'feishu' }),
    });
    const message = (text: string): IMMessageEvent => ({ channelName: 'feishu', senderId: 'owner', contextId: 'bot', chatId: 'dm', messageId: text, text, attachments: [], unsupported: [] });
    inbound(message('remember the card context'));
    await vi.waitFor(() => expect(final.some(text => text.includes('Echo:'))).toBe(true));
    const id = (await connection.repo.peekSession('bot', 'owner'))!.id;
    const originalSdk = (await host.storage.get(id))!.sdkSessionId;
    inbound(message('/model'));
    await vi.waitFor(() => expect(JSON.stringify(cards)).toContain('card-model'));
    expect(JSON.stringify(cards)).not.toContain('hidden-card-model');
    const pick: IMCardActionEvent = { channelName: 'feishu', senderId: 'owner', chatId: 'dm', messageId: 'picker', buttonId: 'model:pick', payload: { sessionId: id, modelId: 'card-model', providerId: 'card-provider', effort: 'high' } };
    await action(pick);
    expect(await host.invoke('maker:get-session-agent-switch-intent', [id])).toMatchObject({ model: 'card-model', providerId: 'card-provider' });
    inbound(message('continue after card selection'));
    await vi.waitFor(() => expect(final.some(text => text.includes('continue after card selection'))).toBe(true));
    expect(native.inputs.at(-1)?.selection).toMatchObject({ model: 'card-model', providerId: 'card-provider' });
    expect(originalSdk).toBeTruthy();
    expect(native.starts.at(-1)?.resumeSessionId).toBe(originalSdk);
    expect(JSON.stringify(await host.invoke('local-db:messages:list', [id, { limit: 20 }]))).toContain('remember the card context');
    expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBe(true);
    await action({ ...pick, payload: { ...pick.payload, modelId: 'not-a-real-model' } });
    expect((await host.storage.get(id))?.model).toBe('card-model');
    expect((await host.invoke('maker:get-session-agent-switch-intent', [id]))).toBeNull();
    const identity = { channel: 'feishu', botContextId: 'bot', userId: 'owner' };
    await host.channelBindings.store.attach(identity, id);
    expect(await host.invoke('binding:resolve-session', [id])).toMatchObject({ attached: true, identity });
    expect(await host.invoke('binding:revoke', [id])).toEqual({ ok: true, alreadyDetached: false });
    expect(await host.invoke('binding:list-attached')).toEqual({ sessionIds: [] });
    await host.close();
    expect(unsubscribed.sort()).toEqual(['card', 'message']);
    const sent = native.sent.length;
    await action({ ...pick, payload: { ...pick.payload, modelId: 'test-model', providerId: 'fixture' } });
    inbound(message('stale callback after logout'));
    const restored = create(); await restored.ready;
    expect((await restored.storage.get(id))?.model).toBe('card-model');
    expect(native.sent).toHaveLength(sent);
    await connection.close();
  });
  // Real runner/send lane: configuration changes follow, while an explicit
  // same-value GUI choice persists across restart and ends automatic following.
  it('follows channel model defaults with context and preserves an explicit task override after restart', async () => {
    const fixture = await setup();
    let host = fixture.host;
    await host.invoke('maker:provider:custom:create', [{ id: 'channel-codex', name: 'Channel Codex', auth: { method: 'none' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [
      { id: 'channel-one', name: 'One' }, { id: 'channel-two', name: 'Two' },
    ] } } }]);
    await host.channelDefaults.update({ agentKind: 'claude-code', agents: { 'claude-code': { model: 'test-model', providerId: 'fixture', effort: 'high' } } }, 'wechat');
    const im: TextChannelIM = {
      name: 'wechat', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: () => () => {}, onStatusChange: () => () => {},
      sendText: async () => ({ messageId: 'notice' }), sendMarkdownText: async () => ({ messageId: 'notice' }),
      sendFile: async () => ({ ok: true, messageId: 'file' }),
    };
    const adapter: ImChannelAdapter = {
      channel: 'wechat', im, output: { kind: 'chunked-text', im, commitFinal: async () => {} },
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' }, ui: wechatUi,
      sessions: { source: 'wechat', sessionIdFor: (bot, user) => `wechat_${bot}_${user}`, defaultTitle: () => 'Channel task', ensureWorkingDir: () => fixture.root, extraInsertColumns: (bot, user) => ({ imBotContextId: bot, imUserId: user }) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'wechat' }),
    };
    function openRunner() {
      const repo = host.channelRepository(adapter.config, adapter.sessions);
      const runner = createTurnRunner(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), host.channelTurnDependencies({
        source: 'wechat', config: adapter.config, isRouteUsable: route => runner.hasAuthForRoute(route),
      }), host.channelTurnHost());
      return runner;
    }
    let runner = openRunner();
    async function send(text: string) {
      const result = await runner.dispatchAgentTurn({ botContextId: 'bot', userId: 'owner', userMessageId: text, text, attachments: [], queueMode: 'external', beforeProviderStart: async () => {} });
      expect(result.kind).toBe('accepted');
      if (result.kind !== 'accepted') throw new Error(result.reason);
      expect((await result.terminal).kind).toBe('done');
      return result.sessionId;
    }
    try {
      const id = await send('channel context before switching');
      await host.channelDefaults.update({ agentKind: 'codex', agents: { codex: { model: 'channel-one', providerId: 'channel-codex', effort: 'high' } } }, 'wechat');
      expect(await send('follow the configured model')).toBe(id);
      expect((await host.storage.get(id))?.agentKind).toBe('codex');
      expect(JSON.stringify(fixture.native.sent.at(-1))).toContain('channel context before switching');
      expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBeUndefined();
      await host.invoke('maker:set-model', [id, 'channel-one', 'channel-codex']);
      await send('keep this explicit model');
      expect(JSON.parse((await host.storage.get(id))!.imDefaultRoute!).manual).toBe(true);
      await runner.disposeAllSessions();
      await host.close();
      host = fixture.create(); await host.ready;
      await host.channelDefaults.update({ agents: { codex: { model: 'channel-two', providerId: 'channel-codex', effort: 'high' } } }, 'wechat');
      runner = openRunner();
      expect(await send('continue after restart')).toBe(id);
      expect(fixture.native.inputs.at(-1)?.selection.model).toBe('channel-one');
      expect((await host.storage.get(id))?.model).toBe('channel-one');
      const repo = host.channelRepository(adapter.config, adapter.sessions);
      const slash = createSlashHandlers(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), runner, host.channelControl.commands);
      expect(await slash.handleSlashCommand('/new', { botContextId: 'bot', userId: 'owner' })).toBe(true);
      const reset = await host.storage.get(id);
      expect(reset).toMatchObject({ model: 'channel-two' });
      expect(reset?.sdkSessionId).toBeUndefined();
      expect(reset?.pendingHandoff).toBeUndefined();
      expect(JSON.parse(reset!.imDefaultRoute!).manual).toBeUndefined();
      expect(await send('start fresh with the channel default')).toBe(id);
      expect(fixture.native.starts.at(-1)?.resumeSessionId).toBeUndefined();
      expect(JSON.stringify(fixture.native.sent.at(-1))).not.toContain('channel context before switching');
    } finally { await runner.disposeAllSessions(); }
  });
  // Real remote-agent controller/host on two isolated task owners. Only the
  // authenticated transport and upstream vendor process are fixture adapters.
  it('moves an existing task to another agent computer and back without moving its workspace', async () => {
    const remote = await setup();
    await remote.host.invoke('maker:provider:custom:create', [{ id: 'remote-fixture', name: 'Remote fixture', auth: { method: 'none' }, runtimes: { pi: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'remote-model', name: 'Remote model', contextWindow: 200000 }] } } }]);
    const agents = new TerminalRemoteAgentService({ profileDir: remote.root, getOwnerScope: () => 'owner', readProviders: () => remote.host.models.views(), startHosted: input => remote.host.startHosted(input), isAgentAvailable: kind => remote.host.isAgentAvailable(kind) });
    try {
      await agents.setEnabled('remote-fixture', true, () => {});
      const local = await setup(engine(), { remoteInvoke: async (device, channel, args) => {
        expect(device).toBe('execution-computer');
        if (channel === 'maker:provider:list') return { ok: true, result: { providers: await agents.views() } };
        expect(channel).toBe(REMOTE_AGENT_CHANNEL);
        return { ok: true, result: await agents.request(args[0], { source: { kind: 'owner', deviceId: 'task-computer', peerId: 'task-computer' }, controllerDeviceId: 'task-computer', sourceDeviceId: 'task-computer', ownerScope: 'owner', requestId: 'fixture-request', signal: new AbortController().signal, assertCurrent() {} }) };
      } });
      const task = await local.host.invoke('maker:create-session', [{ workingDir: local.root }]) as { id: string };
      await local.host.invoke('maker:send', [task.id, { text: 'work stays on this computer', clientId: 'local-input' }]);
      await local.host.invoke('terminal:tasks:wait', [task.id, 'local-input']);
      await local.host.invoke('maker:switch-session-agent', [task.id, 'pi', 'remote-model', 'remote-fixture', undefined, undefined, { agentDeviceId: 'execution-computer' }]);
      await local.host.invoke('maker:send', [task.id, { text: 'run on the other computer', clientId: 'remote-input' }]);
      expect(await local.host.invoke('terminal:tasks:wait', [task.id, 'remote-input'])).toMatchObject({ status: 'completed' });
      expect(remote.native.sent).toHaveLength(1);
      expect(JSON.stringify(remote.native.sent[0])).toContain('work stays on this computer');
      expect(path.normalize((await local.host.storage.get(task.id))!.workDir)).toBe(path.normalize(local.root));
      expect(remote.native.starts[0].deviceHosted?.workingDir).toBeTruthy();
      await local.host.invoke('maker:switch-session-agent', [task.id, 'claude-code', 'test-model', 'fixture', undefined, undefined, { agentDeviceId: null }]);
      await local.host.invoke('maker:send', [task.id, { text: 'back on this computer', clientId: 'back-input' }]);
      expect(await local.host.invoke('terminal:tasks:wait', [task.id, 'back-input'])).toMatchObject({ status: 'completed' });
      expect(local.native.sent).toHaveLength(2);
      expect(JSON.stringify(local.native.sent.at(-1))).toContain('run on the other computer');
      expect((await local.host.storage.get(task.id))?.agentDeviceId).toBeUndefined();
      // Same production controller/host path for a companion, with no local
      // engine installed. Remote location and private workspace must survive.
      await connectCompanionFixture(local.host,local.root);
      const companion=new TerminalCompanionHost({ tasks: local.host, root: path.join(local.root, 'companions'), profileDir: local.root, logger, guard() { }, emit() { },
    binary: async () => null,
    providerViews: device => local.host.companionProviderViews(device),
    resolveModel: (choice, id, dir) => local.host.resolveCompanionModel(choice, id, dir) });
      try {
        await companion.modelSettings.saveDefaults([{agentKind:'pi',providerId:'model-route:'+JSON.stringify(['execution-computer','remote-fixture']),model:'remote-model',fastMode:false}]);
        const profile=await companion.create({name:'Remote companion'});
        await (await companion.send(profile.id,'companion on execution computer','companion-remote')).completion;
        expect(local.native.sent).toHaveLength(2);
        expect(remote.native.sent).toHaveLength(2);
        expect(remote.native.starts.at(-1)?.botProfilePrompt).toContain('Remote companion');
        expect(remote.native.starts.at(-1)?.deviceHosted?.mcpServers).toContain('cindy_memory');
        // The canonical session is created by the first send, after create()
        // returned its profile snapshot. Read the persisted session reference.
        const currentProfile = await companion.profiles.get(profile.id);
        expect(currentProfile?.sessionId).toBeTruthy();
        const storedCompanion = await companion.storage.get(currentProfile!.sessionId);
        expect(storedCompanion).toMatchObject({agentDeviceId:'execution-computer',providerId:'remote-fixture'});
        expect(path.normalize(storedCompanion!.workDir)).toBe(path.join(companion.profiles.home(profile.id),'workspace'));
        await companion.stop(profile.id);
        await agents.setEnabled('remote-fixture',false,()=>{});
        await expect(companion.send(profile.id,'must not run locally','revoked-remote').then(receipt=>receipt.completion)).rejects.toThrow();
        expect(local.native.sent).toHaveLength(2);
      } finally {await companion.close();}
      await local.host.close();
    } finally { await agents.stop(); }
    // Shutdown must drain removal of private hosted instructions before the
    // profile can be closed or removed, without racing a second filesystem pass.
    expect(remote.native.starts).toHaveLength(2);
    for (const start of remote.native.starts) await expect(access(start.workingDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // The released SET_MODEL channel must preserve Codex's native compaction,
  // and rebuild Claude/Pi context before a smaller model receives the next turn.
  it.each(['claude-code', 'codex', 'pi'] as const)('protects smaller model windows through the real %s send boundary', async kind => {
    const { host, native, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'window-fixture', name: 'Window fixture', auth: { method: 'none' }, runtimes: { [kind]: { baseUrl: 'http://127.0.0.1:1', models: [
      { id: 'big-model', name: 'Big', contextWindow: 200000 }, { id: 'small-model', name: 'Small', contextWindow: 100000 },
    ] } } }]);
    native.usageByModel.set('big-model', { contextTokens: 180000, contextWindow: 200000 });
    const task = await host.invoke('maker:create-session', [{ agentKind: kind, providerId: 'window-fixture', model: 'big-model' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'keep the original task', clientId: 'big-input' }]);
    await host.invoke('terminal:tasks:wait', [task.id, 'big-input']);
    const original = (await host.storage.get(task.id))!.sdkSessionId;
    await host.close();
    const restored = create(); await restored.ready;
    expect(await restored.invoke('maker:set-model', [task.id, 'small-model', 'window-fixture'])).toMatchObject({ deferred: true });
    expect((await restored.storage.get(task.id))!.model).toBe('big-model');
    await restored.invoke('maker:send', [task.id, { text: 'continue in the smaller model', clientId: 'small-input' }]);
    expect(await restored.invoke('terminal:tasks:wait', [task.id, 'small-input'])).toMatchObject({ status: 'completed' });
    expect(native.inputs.at(-1)?.selection.model).toBe('small-model');
    const rebuilt = kind !== 'codex';
    expect(native.starts.at(-1)?.resumeSessionId).toBe(rebuilt ? undefined : original);
    if (rebuilt) expect(JSON.stringify(native.sent.at(-1))).toContain('keep the original task');
    const messages = await restored.invoke('local-db:messages:list', [task.id, { limit: 100 }]) as Array<{ role: string; content: string; agentMeta?: { contextRebuild?: unknown } }>;
    expect(messages.filter(message => message.agentMeta?.contextRebuild)).toHaveLength(rebuilt ? 1 : 0);
    expect(messages.some(message => message.role === 'context_rebuild')).toBe(false);
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['continue in the smaller model', 'keep the original task']);
  });
  it('does not send on the old route when a queued engine choice is disabled', async () => {
    const { host, native } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'disabled-fixture', name: 'Disabled fixture', auth: { method: 'none' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'disabled-model', name: 'Model' }] } } }]);
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:switch-session-agent', [task.id, 'codex', 'disabled-model', 'disabled-fixture']);
    await host.invoke('maker:model-disable:set', [{ kind: 'model', providerId: 'disabled-fixture', modelIds: ['disabled-model'], disabled: true }]);
    await host.invoke('maker:send', [task.id, { text: 'only use the selected model', clientId: 'disabled-input' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'disabled-input'])).toMatchObject({ status: 'failed', error: 'TASK_MODEL_SWITCH_NOT_READY' });
    expect(native.sent).toHaveLength(0);
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toMatchObject({ targetAgentKind: 'codex' });
    expect(await host.invoke('local-db:messages:list', [task.id])).toEqual([]);
  });
  it('rebuilds a failed native context before the next user send without replaying a failed input', async () => {
    const { host, native, create } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    for (const text of ['completed earlier work', 'context-overflow-fixture']) {
      await host.invoke('maker:send', [task.id, { text, clientId: text.replaceAll(' ', '-') }]);
      await host.invoke('terminal:tasks:wait', [task.id, text.replaceAll(' ', '-')]);
    }
    await host.close(); const restored = create(); await restored.ready;
    await restored.invoke('maker:send', [task.id, { text: 'continue now', clientId: 'new-input' }]);
    expect(await restored.invoke('terminal:tasks:wait', [task.id, 'new-input'])).toMatchObject({ status: 'completed' });
    expect(native.starts.at(-1)?.resumeSessionId).toBeUndefined();
    expect(JSON.stringify(native.sent.at(-1))).toContain('completed earlier work');
    expect(JSON.stringify(native.sent.at(-1))).not.toContain('context-overflow-fixture');
    expect(native.sent).toHaveLength(4);
  });
  // Integration: the same submission survives automatic context rebuilding;
  // a completed tool effect or a user stop must prevent hidden replay.
  it('continues one overflowed input once and preserves its receipt and earlier history', async () => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'remember amber-47', clientId: 'earlier' }]);
    await host.invoke('terminal:tasks:wait', [task.id, 'earlier']);
    await host.invoke('maker:send', [task.id, { text: 'overflow-once', clientId: 'recover-me' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'recover-me'])).toMatchObject({ status: 'completed' });
    const history = await host.invoke('local-db:messages:list', [task.id, { limit: 100 }]) as Array<{ role: string; content: string; agentMeta?: { contextRebuild?: unknown } }>;
    expect(history.filter(row => row.agentMeta?.contextRebuild)).toHaveLength(1);
    expect(history.filter(row => row.role === 'user' && row.content === 'overflow-once')).toHaveLength(1);
    expect(history.some(row => row.role === 'error')).toBe(false);
    expect(native.sent).toHaveLength(3);
    expect(JSON.stringify(native.sent.at(-1))).toContain('amber-47');
    expect(native.starts.at(-1)?.resumeSessionId).toBeUndefined();
  });
  it('surfaces overflow after a tool effect without replaying the input', async () => {
    const { host, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'overflow-after-write', clientId: 'no-repeat' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'no-repeat'])).toMatchObject({ status: 'failed' });
    expect(native.sent).toHaveLength(1);
    expect(await readFile(path.join(root, 'effect.txt'), 'utf8')).toBe('completed once');
    expect((await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string }>).some(row => row.role === 'error')).toBe(true);
  });
  it.each(['scheduler', 'session'] as const)('returns overflow to its %s dispatcher without leaving the receipt running', async source => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const recovery = vi.spyOn(host.routes.recovery.runtime, 'tryRecover');
    if (source === 'scheduler') {
      await host.submitScheduled(task.id, 'overflow-once', { scheduleId: 'schedule-1', scheduleName: 'Fixture', runId: 'run-1', requestId: 'external-input' });
    } else {
      await host.invoke('maker:send', [task.id, { text: 'overflow-once', clientId: 'external-input' }], { source: 'local', sender: { sessionId: 'sender-1', title: 'Sender' } });
    }
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'external-input'])).toMatchObject({ status: 'failed' });
    await vi.waitFor(() => expect(recovery).toHaveBeenCalledTimes(1), {interval: 5});
    await recovery.mock.results[0].value;
    expect(native.sent).toHaveLength(1);
    const history = await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; agentMeta?: { origin?: { kind: string }; contextRebuild?: unknown } }>;
    expect(history.find(row => row.role === 'user')?.agentMeta?.origin?.kind).toBe(source);
    expect(history.filter(row => row.agentMeta?.contextRebuild)).toHaveLength(1);
  });
  // Stop an admitted recovery at its commit boundary through the public input
  // transport. Waiting on the cancellation callback avoids event-loop timing.
  it.each(['maker:input:stop', 'maker:close-session', 'maker:abort-session'])('cancels an in-flight rebuild before its commit through %s', async command => {
    const { host, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    let reached!: () => void, release!: () => void, cancelled!: () => void;
    const entered = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancellation = new Promise<void>(resolve => { cancelled = resolve; });
    const original = host.storage.commitContextRebuild.bind(host.storage);
    const commit = vi.spyOn(host.storage, 'commitContextRebuild').mockImplementation(async (...args) => { reached(); await gate; return original(...args); });
    const recovery = host.routes.recovery.runtime;
    const cancelRecovery = recovery.cancelRecovery.bind(recovery);
    let cancel: ReturnType<typeof vi.spyOn> | undefined;
    try {
      await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient, task.id, 'overflow-once', 'cancel-me');
      await entered;
      cancel = vi.spyOn(recovery, 'cancelRecovery').mockImplementation(id => { cancelRecovery(id); cancelled(); });
      const stop = host.invoke(command, [task.id]);
      await cancellation;
      release(); await stop;
      await host.storage.flush();
      expect(native.sent).toHaveLength(1);
      expect((await host.invoke('local-db:messages:list', [task.id]) as Array<{ agentMeta?: { contextRebuild?: unknown } }>).some(row => row.agentMeta?.contextRebuild)).toBe(false);
      expect(await host.invoke('maker:session-in-turn', [task.id])).toBe(false);
      await expect(access(path.join(root, 'tasks', task.id, 'events.jsonl'))).rejects.toMatchObject({code:'ENOENT'});
    } finally { release(); cancel?.mockRestore(); commit.mockRestore(); }
  });

  // The public GUI channel stages a choice; the real Maker send boundary applies
  // it, records context, and resumes the parked native engine when switching back.
  // Integration: Node previously closed every model change, unlike Desktop's
  // original hot/deferred credential transaction. Public selection during a
  // real running Maker turn must wait for the next send, then keep its native
  // session when the provider can reuse it. Only the provider transport is fake.
  // Integration: older GUI arrays serialize omitted middle arguments as null.
  // The Node public handler must use the original wire normalization before
  // reading selection/revision, otherwise these clients cannot change models.
  it('accepts the released GUI model selection with null positional placeholders', async () => {
    const diagnostics: unknown[] = [];
    const {host}=await setup(engine(), {logger: {...logger, warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args)}});
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const remote={source:'remote' as const,deviceId:'legacy-gui'};
    await expect(host.invoke('maker:set-model',[task.id,'test-model',null,null,null],remote)).resolves.toMatchObject({deferred:true});
    await host.invoke('maker:send',[task.id,{text:'continue after remote selection',clientId:'remote-model-input'}]);
    expect(await host.invoke('terminal:tasks:wait',[task.id,'remote-model-input']), JSON.stringify(diagnostics)).toMatchObject({status:'completed'});
    expect(await host.storage.get(task.id)).toMatchObject({model:'test-model',providerId:'fixture'});
  });
  it('applies the original model switch at the next send and preserves a reusable native session', async () => {
    const diagnostics: unknown[] = [];
    const {host, native} = await setup(engine(), {logger: {...logger, warn: (...args) => diagnostics.push(args), error: (...args) => diagnostics.push(args)}});
    await host.models.saveProvider({id: 'fixture', name: 'Fixture', auth: {method: 'apiKey'}, runtimes: {'claude-code': {
      baseUrl: 'http://127.0.0.1:1', models: [{id: 'test-model', name: 'First', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high'}, {id: 'test-second', name: 'Second', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high'}],
    }}}, {'claude-code': 'synthetic-only'}, false);
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'wait-for-steer', clientId: 'model-held'}]);
    await native.waitForHeld(task.id);
    expect(await host.invoke('maker:set-model', [task.id, 'test-second', 'fixture', undefined, {effort: 'high', fastMode: false}])).toMatchObject({deferred: true});
    expect(native.modelChanges).toEqual([]);
    expect(native.starts).toHaveLength(1);
    native.finishHeld(task.id);
    await host.invoke('terminal:tasks:wait', [task.id, 'model-held']);
    await host.invoke('maker:send', [task.id, {text: 'continue with selected model', clientId: 'model-next'}]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'model-next']), JSON.stringify(diagnostics)).toMatchObject({status: 'completed'});
    expect(native.modelChanges).toEqual([{sessionId: task.id, model: 'test-second', providerId: 'fixture'}]);
    expect(native.starts).toHaveLength(1);
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({model: 'test-second', providerId: 'fixture'});
    expect((await host.invoke('local-db:messages:list', [task.id]) as Array<{clientId: string}>).filter(row => row.clientId === 'model-next')).toHaveLength(1);
  });
  // Integration: Node's old shortcut started archived tasks merely to edit an
  // axis. Public local/remote commands must persist without native startup,
  // including an owner restart. Lower-level axis tests do not cover this host.
  it.each(['local', 'remote'] as const)('edits archived runtime axes without native startup (%s)', async source => {
    const {host, native, create} = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('local-db:sessions:patch-meta', [task.id, {status: 'archived'}]);
    const starts = native.starts.length;
    const context = {source, ...(source === 'remote' ? {deviceId: 'released-gui'} : {})};
    await host.invoke('maker:set-effort', [task.id, 'high'], context);
    await host.invoke('maker:set-fast-mode', [task.id, true], context);
    expect(native.starts).toHaveLength(starts);
    expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({status: 'archived', effort: 'high', fastMode: true});
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.invoke('local-db:sessions:get', [task.id])).toMatchObject({status: 'archived', effort: 'high', fastMode: true});
    expect(native.starts).toHaveLength(starts);
  });
  // Integration: public axis edits must follow the staged next harness,
  // leaving the actual running Maker turn untouched until its send boundary.
  it('keeps runtime axis edits on the pending harness until the next send', async () => {
    const {host, native} = await setup();
    await host.models.saveProvider({id: 'axes-codex', name: 'Codex', auth: {method: 'apiKey'}, runtimes: {codex: {
      baseUrl: 'http://127.0.0.1:1', models: [{id: 'axes-model', name: 'Axes', contextWindow: 200000,
        efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: true, supportsUltrafastMode: true}],
    }}}, {codex: 'synthetic-only'}, true);
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'wait-for-steer', clientId: 'axis-held'}]);
    await native.waitForHeld(task.id);
    const old = native.starts[0]!;
    const previous = {effort: old.effort, fastMode: old.fastMode};
    try {
      await host.invoke('maker:switch-session-agent', [task.id, 'codex', 'axes-model', 'axes-codex', 'low', false]);
      await host.invoke('maker:set-effort', [task.id, 'high']);
      await expect(host.invoke('maker:set-fast-mode', [task.id, 'ultrafast'])).rejects.toThrow(/Ultrafast is unavailable/);
      await host.invoke('maker:set-fast-mode', [task.id, true]);
      expect({effort: old.effort, fastMode: old.fastMode}).toEqual(previous);
      expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toMatchObject({targetAgentKind: 'codex', effort: 'high', fastMode: true});
      expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({agentKind: 'cc', model: 'test-model'});
    } finally { native.finishHeld(task.id); }
    await host.invoke('terminal:tasks:wait', [task.id, 'axis-held']);
    await host.invoke('maker:send', [task.id, {text: 'continue on selected harness', clientId: 'axis-next'}]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'axis-next'])).toMatchObject({status: 'completed'});
    expect(native.starts.at(-1)).toMatchObject({agentKind: 'codex', model: 'axes-model', effort: 'high', fastMode: true});
  });
  // Recovery: real SQLite rejection after native setEffort must retire the
  // changed process and retain the saved axis and native history for next send.
  it('restores persisted runtime axes after a native update cannot be committed', async () => {
    const {host, native} = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'remember axis history', clientId: 'axis-history'}]);
    await host.invoke('terminal:tasks:wait', [task.id, 'axis-history']);
    const before = (await host.storage.get(task.id))!;
    const db = (await host.database).db;
    await db.exec("CREATE TRIGGER reject_runtime_axis BEFORE UPDATE OF effort ON sessions WHEN NEW.effort = 'high' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_AXIS_WRITE_FAILURE'); END");
    try {
      await expect(host.invoke('maker:set-effort', [task.id, 'high'])).rejects.toThrow();
      expect(native.starts[0]?.effort).toBe('high');
      expect((await host.storage.get(task.id))?.effort).toBe(before.effort);
      expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
    } finally { await db.exec('DROP TRIGGER reject_runtime_axis'); }
    await host.invoke('maker:send', [task.id, {text: 'continue after rejected axis', clientId: 'axis-recovered'}]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'axis-recovered'])).toMatchObject({status: 'completed'});
    expect(native.starts.at(-1)?.resumeSessionId).toBe(before.sdkSessionId);
    expect(native.starts.at(-1)?.effort ?? null).toBe(before.effort ?? null);
  });

  // Persistence: terminal settings must use the original owner SQLite service.
  // An old preview profile cannot replace an existing DB row, and a rejected
  // DB write must restore its key before another request can see the route.
  // Integration: the GUI-owned draft previously disappeared in Node. Exercise the
  // original write-through receipt, remote projection, real restart and DB rollback.
  // integration: the original GUI profile contracts must own the terminal DB,
  // native snapshot and restart; a terminal-only profiles.json cannot satisfy them.
  it('runs the original GUI teammate profile through the ordinary task runtime and restart', async () => {
    let ownerToolCall:((input:RuntimeInput,options:StartSessionOptions)=>Promise<void>)|undefined;
    const {host,root,create,native,pushes}=await setup(engine(undefined,async(input,options)=>{
      const call=ownerToolCall;ownerToolCall=undefined;await call?.(input,options);
    }));

    const connect=async(current:TerminalTaskHost)=>{
      const knowledge=new TerminalKnowledge({root,logger,assertCurrent:()=>{},changed:()=>{},workingDirs:async()=>[root]});
      await knowledge.ready;current.configureKnowledge(knowledge);
      // Only native Skill discovery is replaced by the agent fixture. Catalog,
      // route selection and provider gates are the production composition.
      vi.spyOn(current,'listAgentSkills').mockResolvedValue({skills:[]});
      await knowledge.configure({memory:false});
      const services=await current.connectOriginalBotServices({memory:knowledge.memory,resourceRoot:()=>path.resolve(process.cwd(),'../desktop/resources'),listBotImChannels:()=>[],isCompanionShadowed:()=>false});
      return {knowledge,services};
    };
    await host.models.setVisibility('claude-code','fixture',['test-model'],true);
    const first=await connect(host);
    try{
      await host.invoke('local-db:bots:model-chain-settings-set',[{modelChain:[{harness:'claude',providerId:'fixture',model:'test-model',effort:'',fastMode:false}]}]);
      const profile=await host.invoke('local-db:bots:create',[{id:'runtime-fixture',name:'Runtime fixture',identitySource:'Original profile identity',avatar:'✦'}]) as {id:string;currentVersion:number};
      const canonical=await host.invoke('local-db:bots:create-canonical-session',[{botId:profile.id,expectedCanonicalSessionId:null,expectedProfileVersion:profile.currentVersion}]) as {canonicalSessionId:string|null};
      expect(canonical.canonicalSessionId).toBeTruthy();
      const id=canonical.canonicalSessionId!;
      const task=await host.storage.get(id);expect(task).toMatchObject({source:'bot',agentKind:'claude-code'});
      expect(task!.workDir).toBe(path.join(root,'bots',profile.id,'workspace'));
      await host.invoke('local-db:bots:update',[{id:profile.id,identitySource:'Updated original identity',capabilities:{toolsetMode:'allowlist',toolsets:[]}}]);
      const local=await host.invoke('local-db:bots:get',[profile.id]) as {identitySource:string;currentVersion:number};
      expect(local.identitySource).toBe('Updated original identity');
      const remote=await host.invoke('local-db:bots:get',[profile.id],{source:'remote',deviceId:'released-gui'});
      expect(remote).toMatchObject({id:profile.id,canonicalSessionId:id,currentVersion:local.currentVersion});
      expect(remote).not.toHaveProperty('identitySource');
      await expect(host.invoke('local-db:bots:update',[{id:profile.id,name:'remote bypass'}],{source:'remote',deviceId:'released-gui'})).rejects.toThrow('LOCAL_ONLY_COMMAND');
      // Cloud sync subscribes to the same canonical-history invalidation as
      // remote GUI previews, rather than only observing profile edits.
      const historyChanged=vi.fn();const offHistory=host.onBotProfileChanged(historyChanged);
      await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,id,'Use the original runtime','original-bot-input');
      await vi.waitFor(()=>expect(native.sentFor(id)).toHaveLength(1));
      await vi.waitFor(()=>expect(host.isBusy()).toBe(false));
      await vi.waitFor(()=>expect(historyChanged).toHaveBeenCalledWith(profile.id));offHistory();
      expect(native.starts.at(-1)).toMatchObject({botRuntimeProfile:{botId:profile.id,profileVersion:local.currentVersion}});
      const tools=native.inputs.at(-1)!.tools!;
      const toolContext={agentKind:'claude-code' as const,sessionId:id,workingDir:task!.workDir,vendorOptions:native.starts.at(-1)!.vendorOptions};
      expect(tools.providers.find(provider=>provider.name==='cindy_helper')?.isEnabled?.(toolContext)).toBe(true);
      expect(tools.providers.find(provider=>provider.name==='cindy_orca')?.isEnabled?.(toolContext)).toBe(false);
      expect(tools.buildSessionMcpConfig('fixture-instance')['mcp_servers.cindy_orca.enabled']).toBe(false);
      const piTools=tools.pi({...toolContext,agentKind:'pi'});
      expect(piTools.mcpBridge?.servers.map(server=>server.name)).not.toContain('cindy_orca');
      expect(piTools.mcpBridge?.servers.map(server=>server.name)).toContain('cindy_memory');
      expect(tools.buildSessionMcpConfig('catalog-fixture')['mcp_servers.cindy_memory.enabled']).toBe(true);
      expect(tools.providers.find(provider=>provider.name==='cindy_contacts')!.isEnabled!({agentKind:'claude-code',workingDir:root})).toBe(false);
      piTools.disposeSessionCtx?.();
      const [snapshot]=await (await host.database).getDbClient().drizzle.select().from(botRuntimeSnapshots).where(eq(botRuntimeSnapshots.sessionId,id)).orderBy(desc(botRuntimeSnapshots.preparedAt)).limit(1);
      expect(snapshot).toMatchObject({status:'applied'});
      const welcome=host.dispatchBotMessage({targetSessionId:id,message:'Welcome fixture',persistedContent:'[UI_ACTION_TRIGGER]Welcome fixture',clientId:'original-welcome',toolsDisabled:true,onQueued:async()=>{}});
      await vi.waitFor(()=>expect(native.sentFor(id),JSON.stringify(pushes.slice(-3))).toHaveLength(2));
      expect(await welcome).toMatchObject({ok:true});
      await vi.waitFor(()=>expect(host.isBusy()).toBe(false));
      expect(native.sends.at(-1)).toMatchObject({toolsDisabled:true});
      await (await host.conversations).persistence.drainPersistQueue();
      const found=await host.invoke('local-db:conversations:search',[{query:'original runtime',semanticMode:'keyword'}],{source:'remote',deviceId:'released-gui'}) as {results:Array<{session:{id:string}}>};
      expect(found.results.map(item=>item.session.id)).toContain(id);
      const store=await first.knowledge.memory.getStore(buildBotMemoryScopeKey(profile.id),{skipDisabledCheck:true});
      await store.write({type:'project',name:'fixture',title:'Fixture memory',description:'Original memory fixture',body:'Before editing'});
      const detail=await host.invoke('local-db:bots:memory:read',[profile.id,'project_fixture.md']) as {updatedAt:string};
      await host.invoke('local-db:bots:memory:update',[{botId:profile.id,filename:'project_fixture.md',title:'Fixture memory',body:'After editing',expectedUpdatedAt:detail.updatedAt}]);
      expect(await host.invoke('local-db:bots:memory:read',[profile.id,'project_fixture.md'])).toMatchObject({body:'After editing'});
      const peer=await host.invoke('local-db:bots:create',[{id:'runtime-peer',name:'Runtime peer',identitySource:'Peer fixture',avatar:'✦'}]) as {id:string};
      const messaging=host.helperDeps({sessionId:id,workingDir:task!.workDir,agentKind:'claude-code'}).botMessaging!;
      const delivered=await messaging.messageAgent({callerSessionId:id,targetBotId:peer.id,message:'Original peer message'});
      expect(delivered).toMatchObject({ok:true});
      if(!delivered.ok)throw new Error(delivered.errorCode);
      await vi.waitFor(()=>expect(native.sentFor(delivered.targetSessionId)).toHaveLength(1));
      const [receipt]=await (await host.database).getDbClient().drizzle.select().from(botDirectMessages).where(eq(botDirectMessages.id,delivered.messageId!));
      expect(receipt.deliveryStatus).toBe('delivered');
      expect(await host.invoke('maker:bot-direct-message-thread:get',[receipt.threadId,profile.id],{source:'remote',deviceId:'released-gui'})).toMatchObject({ok:true,thread:{messages:[{content:'Original peer message'}]}});
      expect(pushes.some(push=>push.channel===MAKER_PUSH.BOT_DIRECT_MESSAGE_CHANGED)).toBe(true);
      // Public helper -> original task controls/delegation -> native runtime ->
      // original remote GUI projection, all against the same owner database.
      const helper=host.helperDeps({sessionId:id,workingDir:task!.workDir,agentKind:task!.agentKind});
      expect(await helper.sessionControl!.getSessionRuntime({targetSessionId:id})).toMatchObject({ok:true,runtime:{effectiveProfile:{model:'test-model'}}});
      let delegated:({ok:true;delegationId:string;childSessionId:string}|{ok:false;errorCode:string;message:string})|undefined;
      let toolResponse:unknown;
      ownerToolCall=async(input,start)=>{
        const client=new McpClient({name:'original-owner-task',version:'1'});
        const ctx={sessionId:id,workingDir:start.workingDir,agentKind:'claude-code' as const,vendorOptions:start.vendorOptions,
          getSessionContext:()=>({sessionId:id,workingDir:start.workingDir,agentKind:'claude-code' as const})};
        const sdk=input.tools!.providers.find(provider=>provider.name==='cindy_helper')!.toClaudeSdkConfig!(ctx) as {instance:McpServer};
        const [left,right]=InMemoryTransport.createLinkedPair();await sdk.instance.connect(left);await client.connect(right);
        try{
          const result=await client.callTool({name:'call_tool',arguments:{name:'start_session_task',args:{instruction:'Original native task fixture',working_dir:root}}});
          toolResponse=result;
          expect(result.isError,JSON.stringify(result)).not.toBe(true);
          const payload=JSON.parse((result.content as Array<{text:string}>)[0].text) as {task_id:string;session_id:string};
          expect(payload.task_id).toBeTypeOf('string');expect(payload.session_id).toBeTypeOf('string');
          delegated={ok:true,delegationId:payload.task_id,childSessionId:payload.session_id};
        }finally{await client.close();await sdk.instance.close();}
      };
      await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient,id,'Create the requested task now','owner-delegation-input');
      await vi.waitFor(()=>expect(delegated?.ok,JSON.stringify(toolResponse??delegated)).toBe(true));
      if(!delegated?.ok)throw new Error('Original task creation was not accepted');
      const taskResult=delegated;
      await vi.waitFor(async()=>expect(await helper.sessionTasks!.getSessionTask({callerSessionId:id,taskId:taskResult.delegationId})).toMatchObject({ok:true,task:{status:'completed'}}));
      expect(await host.invoke('maker:bot-delegations:list',[id],{source:'remote',deviceId:'released-gui'})).toMatchObject({ok:true,delegations:[{id:delegated.delegationId,status:'completed'}]});
      await vi.waitFor(()=>expect(host.isBusy()).toBe(false));
      const beforeRestartCount=native.sentFor(id).length;
      expect(await host.invoke('maker:bot-lifecycle:action',[{botId:profile.id,action:'pause'}])).toMatchObject({action:'pause',status:'paused'});
      expect(await host.invoke('local-db:bots:get',[profile.id])).toMatchObject({status:'paused'});
      expect(await host.invoke('maker:bot-lifecycle:action',[{botId:profile.id,action:'resume'}])).toMatchObject({action:'resume',status:'active'});
      await expect(access(path.join(root,'companions','profiles.json'))).rejects.toThrow();
      await host.close();await first.knowledge.close();
      const restored=create();await restored.ready;
      const second=await connect(restored);
      try{
        expect(await restored.invoke('local-db:bots:get',[profile.id])).toMatchObject({canonicalSessionId:id,identitySource:'Updated original identity',currentVersion:local.currentVersion});
        expect(await restored.invoke('maker:bot-direct-message-thread:get',[receipt.threadId,profile.id],{source:'remote',deviceId:'released-gui'})).toMatchObject({ok:true,thread:{messages:[{content:'Original peer message'}]}});
        expect(await restored.invoke('local-db:bots:memory:read',[profile.id,'project_fixture.md'])).toMatchObject({body:'After editing'});
        await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>restored.invoke(channel,args)} as TerminalClient,id,'Continue after restart','restored-bot-input');
        await vi.waitFor(()=>expect(native.sentFor(id)).toHaveLength(beforeRestartCount+1));
        await vi.waitFor(()=>expect(restored.isBusy()).toBe(false));
      }finally{await restored.close();await second.knowledge.close();}
    }finally{await host.close();await first.knowledge.close();}
  });

  it('uses original default-model preferences across terminal, remote GUI and restart', async () => {
    const {host,create,native}=await setup();
    const provider=host.models.snapshot().providers[0]!;
    await host.invoke('maker:provider:custom:update',[{...provider,runtimes:{'claude-code':{
      ...provider.runtimes['claude-code']!,models:[...provider.runtimes['claude-code']!.models,
        {id:'default-second',name:'Second',contextWindow:200000,efforts:['low','high'],defaultEffort:'low',supportsFastMode:true,supportsUltrafastMode:true}],
    }}},{}]);
    await host.models.setVisibility('claude-code','fixture',['test-model','default-second'],true);
    host.models.defaults.preferences.setWorktreePreference(true);
    host.models.defaults.preferences.setFastModeForModel('default-second',true);
    const available=await host.defaultModels.inspectAppDefaultModel();
    const second=available.available.find(item=>item.route.model==='default-second')!;
    expect(second).toBeDefined();
    expect(await host.defaultModels.changeAppDefaultModel(second.id,'high')).toMatchObject({current:{model:'default-second',effort:'high',fastMode:true}});
    expect(await host.invoke('maker:get-new-maker-defaults',['claude-code'],{source:'remote',deviceId:'released-gui'})).toMatchObject({
      model:'default-second',providerId:'fixture',effort:'high',fastMode:true,modelChosenByUser:true,worktreeEnabled:true,
    });
    await host.close();const restored=create();await restored.ready;
    const task=await restored.invoke('maker:create-session',[{}]) as {id:string};
    expect(native.starts.at(-1)).toMatchObject({model:'default-second',effort:'high',fastMode:true});
    await restored.invoke('maker:close-session',[task.id]);
    const db=(await restored.database).db;
    await db.exec("CREATE TRIGGER reject_default_provider_delete BEFORE DELETE ON custom_providers BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_DEFAULT_DELETE_FAILURE'); END");
    try {
      await expect(restored.invoke('maker:provider:custom:delete',['fixture'])).rejects.toThrow('SYNTHETIC_DEFAULT_DELETE_FAILURE');
      expect(restored.models.snapshot().defaultSelection).toMatchObject({model:'default-second',effort:'high'});
    } finally {await db.exec('DROP TRIGGER reject_default_provider_delete');}
    await restored.invoke('terminal:models:reset-default');
    expect(restored.models.snapshot().defaultSelection).toBeUndefined();
    expect(await restored.invoke('maker:get-new-maker-defaults',['claude-code'])).toMatchObject({worktreeEnabled:true});
    await restored.close();const reset=create();await reset.ready;
    expect(reset.models.snapshot().defaultSelection).toBeUndefined();
    expect(await reset.invoke('maker:get-new-maker-defaults',['claude-code'])).toMatchObject({worktreeEnabled:true});
  });

  it('imports legacy provider settings once and rolls back keys when SQLite rejects an edit', async () => {
    const {host, root, create, vault} = await setup();
    const original = host.models.snapshot().providers[0]!;
    await host.close();
    await writeFile(path.join(root, 'models.json'), JSON.stringify({version: 1, disabled: {disabledProviders: {imported: true}}, providers: [
      {...original, name: 'Stale JSON name'}, {...original, id: 'imported', name: 'Imported provider'},
    ]}));
    const resumed = create(); await resumed.ready;
    expect(resumed.models.snapshot().providers.map(p => [p.id, p.name])).toEqual([['fixture', 'Fixture'], ['imported', 'Imported provider']]);
    expect(JSON.parse(await readFile(path.join(root, 'models.json'), 'utf8'))).not.toHaveProperty('providers');
    expect(resumed.models.snapshot().disabled?.disabledProviders?.imported).toBe(true);
    const db = (await resumed.database).db;
    await db.exec("CREATE TRIGGER reject_provider_save BEFORE UPDATE ON custom_providers BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PROVIDER_SQL_FAILURE'); END");
    try {
      await expect(resumed.invoke('maker:provider:custom:update', [{...original, name: 'Rejected'}, {'claude-code': 'replacement-synthetic-key'}])).rejects.toThrow('SYNTHETIC_PROVIDER_SQL_FAILURE');
      expect(vault.get('terminal:provider:fixture:claude-code')).toBe('invalid-test-key-only');
      expect(resumed.models.snapshot().providers[0]!.name).toBe('Fixture');
      expect(await db.queryOne<{name: string}>("SELECT name FROM custom_providers WHERE id = 'fixture'")).toMatchObject({name: 'Fixture'});
    } finally {await db.exec('DROP TRIGGER reject_provider_save');}
    await db.exec("CREATE TRIGGER reject_provider_delete BEFORE DELETE ON custom_providers BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PROVIDER_DELETE_FAILURE'); END");
    try {
      await expect(resumed.invoke('maker:provider:custom:delete', ['imported'])).rejects.toThrow('SYNTHETIC_PROVIDER_DELETE_FAILURE');
      expect(resumed.models.snapshot().disabled?.disabledProviders?.imported).toBe(true);
    } finally {await db.exec('DROP TRIGGER reject_provider_delete');}
    await resumed.close();
    const restarted = create(); await restarted.ready;
    expect(restarted.models.snapshot().providers.map(p => p.id)).toEqual(['fixture', 'imported']);
    expect(restarted.models.snapshot().disabled?.disabledProviders?.imported).toBe(true);
  });

  // Lifecycle: the native adapter treats account teardown differently from an
  // ordinary session close. Exercise the public task endpoint and both actual
  // host shutdown boundaries through Maker instead of inspecting call text.
  it.each(['app-quit', 'account-boundary'] as const)('preserves native close reasons through %s', async reason => {
    const {host, native} = await setup();
    const first = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [first.id, {text: 'close normally', clientId: 'close-normal'}]);
    await host.invoke('terminal:tasks:wait', [first.id, 'close-normal']);
    await host.invoke('maker:close-session', [first.id]);
    expect(native.teardowns).toEqual([{id: first.id, reason: 'navigation'}]);
    const second = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [second.id, {text: 'close at host boundary', clientId: 'close-host'}]);
    await host.invoke('terminal:tasks:wait', [second.id, 'close-host']);
    await host.close({reason});
    expect(native.teardowns).toEqual([{id: first.id, reason: 'navigation'}, {id: second.id, reason}]);
  });

  // Integration: model budgets are owner overrides, not edits to catalog facts.
  // The public GUI handler must retire an idle process and preserve its SDK
  // history; stale owner writes and a host restart cross boundaries absent from
  // the original store/handler unit tests.
  it('persists original model context settings and rebuilds only the matching runtime', async () => {
    const {host, native, create} = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'preserve budget history', clientId: 'budget-history'}]);
    await host.invoke('terminal:tasks:wait', [task.id, 'budget-history']);
    const sdk = (await host.storage.get(task.id))!.sdkSessionId;
    const target = {agent: 'claude-code', providerId: 'fixture', modelId: 'test-model'};
    const owner = await host.invoke('terminal:models:context-owner', []);
    expect(await host.invoke('maker:model-context-limit:get', [target])).toMatchObject({limit: null, isCustomized: false});
    await expect(host.invoke('maker:model-context-limit:set', [target, 64000, {dataOwnerId: null, ownerGeneration: 99}])).rejects.toThrow(/account changed/);
    expect(await host.invoke('maker:model-context-limit:set', [target, 64000, owner])).toMatchObject({limit: 64000, isCustomized: true});
    expect(host.models.activeCatalog().providers.find(p => p.id === 'fixture')!.models['claude-code']![0]!.contextWindow).toBe(200000);
    expect(host.models.nativeContextLimit('claude-code', 'fixture', 'test-model')).toBe(64000);
    expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
    await host.invoke('maker:send', [task.id, {text: 'continue with saved budget', clientId: 'budget-resumed'}]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'budget-resumed'])).toMatchObject({status: 'completed'});
    expect(native.starts.at(-1)?.resumeSessionId).toBe(sdk);
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.invoke('maker:model-context-limit:get', [target])).toMatchObject({limit: 64000, isCustomized: true});
    expect(await restarted.invoke('maker:model-context-limit:reset', [target, await restarted.invoke('terminal:models:context-owner', [])])).toMatchObject({limit: null, isCustomized: false});
    expect(restarted.models.nativeContextLimit('claude-code', 'fixture', 'test-model')).toBe(200000);
  });
  // Recovery: if native teardown refuses a budget refresh, the original file
  // transaction must roll back before the GUI/TUI receives failure.
  it('rolls model context preferences back when the native runtime cannot refresh', async () => {
    const {host} = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'keep current budget', clientId: 'budget-before-failure'}]);
    await host.invoke('terminal:tasks:wait', [task.id, 'budget-before-failure']);
    const target = {agent: 'claude-code', providerId: 'fixture', modelId: 'test-model'};
    const session = host.channelRuntime().getSession(task.id)!;
    const close = vi.spyOn(session, 'close').mockRejectedValueOnce(new Error('synthetic native close rejection'));
    try {
      await expect(host.invoke('maker:model-context-limit:set', [target, 64000, await host.invoke('terminal:models:context-owner', [])])).rejects.toThrow(/persist model context limit/);
      expect(await host.invoke('maker:model-context-limit:get', [target])).toMatchObject({limit: null, isCustomized: false});
      expect(host.models.nativeContextLimit('claude-code', 'fixture', 'test-model')).toBe(200000);
    } finally {close.mockRestore();}
    expect(await host.invoke('maker:model-context-limit:set', [target, 96000, await host.invoke('terminal:models:context-owner', [])])).toMatchObject({limit: 96000});
  });

  // Recovery tier: SET_MODEL may reach a native hot switch before SQLite rejects
  // persistence. The public send boundary must restore the route and retain the
  // original native history; lower-level runtime tests do not cross that boundary.
  it('restores the original model and native history after route persistence fails', async () => {
    const {host, native} = await setup();
    await host.models.saveProvider({id: 'fixture', name: 'Fixture', auth: {method: 'apiKey'}, runtimes: {'claude-code': {
      baseUrl: 'http://127.0.0.1:1', models: [
        {id: 'test-model', name: 'First', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high'},
        {id: 'rejected-model', name: 'Rejected', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high'},
      ],
    }}}, {'claude-code': 'synthetic-only'}, false);
    const task = await host.invoke('maker:create-session', [{}]) as {id: string};
    await host.invoke('maker:send', [task.id, {text: 'keep the original history', clientId: 'before-model-failure'}]);
    await host.invoke('terminal:tasks:wait', [task.id, 'before-model-failure']);
    const original = (await host.storage.get(task.id))!.sdkSessionId;
    const db = (await host.database).db;
    await db.exec("CREATE TRIGGER reject_model_route BEFORE UPDATE OF model ON sessions WHEN NEW.model = 'rejected-model' BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_ROUTE_WRITE_FAILURE'); END");
    try {
      await host.invoke('maker:set-model', [task.id, 'rejected-model', {providerId: 'fixture', effort: 'high', fastMode: false}]);
      await host.invoke('maker:send', [task.id, {text: 'do not send on an uncommitted route', clientId: 'blocked-model-input'}]);
      expect(await host.invoke('terminal:tasks:wait', [task.id, 'blocked-model-input'])).toMatchObject({status: 'failed'});
      expect(native.modelChanges).toContainEqual({sessionId: task.id, model: 'rejected-model', providerId: 'fixture'});
      expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({model: 'test-model', providerId: 'fixture'});
      expect(host.routes.provider(task.id)).toBe('fixture');
      expect(host.channelRuntime().getSession(task.id)).toBeUndefined();
      expect(native.sentFor(task.id)).toHaveLength(1);
    } finally { await db.exec('DROP TRIGGER reject_model_route'); }
    await host.invoke('maker:input:remove', [task.id, 'blocked-model-input']);
    await host.invoke('maker:set-model', [task.id, 'test-model', {providerId: 'fixture'}]);
    await host.invoke('maker:send', [task.id, {text: 'continue with the original route', clientId: 'model-rollback-recovery'}]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'model-rollback-recovery'])).toMatchObject({status: 'completed'});
    expect(native.starts.at(-1)?.resumeSessionId).toBe(original);
    expect(native.inputs.at(-1)?.selection.model).toBe('test-model');
  });
  it.each([false, true])('applies a queued engine choice and returns to its parked engine (expired: %s)', async expired => {
    const { host, native, create } = await setup();
    await host.invoke('maker:provider:custom:create', [{ id: 'codex-fixture', name: 'Codex fixture', auth: { method: 'apiKey' }, runtimes: { codex: { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'codex-model', name: 'Codex model', contextWindow: 200000 }] } } }, { codex: 'invalid-codex-key-only' }]);
    const task = await host.invoke('maker:create-session', [{ title: 'Engine switch' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'remember the original work' }]);
    const original = (await host.storage.get(task.id))?.sdkSessionId;
    expect(await host.invoke('maker:switch-session-agent', [task.id, 'codex', 'codex-model', 'codex-fixture'])).toMatchObject({ deferred: true });
    expect((await host.storage.get(task.id))?.agentKind).toBe('claude-code');
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toMatchObject({ targetAgentKind: 'codex', model: 'codex-model' });
    await host.invoke('maker:send', [task.id, { text: 'continue with Codex', clientId: 'switched-message' }]);
    expect(await host.invoke('terminal:tasks:wait', [task.id, 'switched-message'])).toMatchObject({ status: 'completed' });
    await host.storage.flush();
    expect(native.inputs.at(-1)?.selection.agentKind).toBe('codex');
    expect(JSON.stringify(native.sent.at(-1))).toContain('remember the original work');
    expect((await host.storage.get(task.id))?.agentKind).toBe('codex');
    expect((await host.storage.submission(task.id, 'switched-message'))?.status).toBe('completed');
    expect(await host.invoke('maker:get-session-agent-switch-intent', [task.id])).toBeNull();
    await host.close();
    const restarted = create(); await restarted.ready;
    if (expired) native.resumeFailures.add(original!);
    await restarted.invoke('maker:switch-session-agent', [task.id, 'claude-code', 'test-model', 'fixture']);
    await restarted.invoke('maker:send', [task.id, { text: 'return to the original engine' }]);
    expect(native.starts.at(-1)?.resumeSessionId).toBe(expired ? undefined : original);
    if (expired) expect(JSON.stringify(native.sent.at(-1))).toContain('remember the original work');
    expect(native.inputs.at(-1)?.selection.agentKind).toBe('claude-code');
    const messages = await restarted.invoke('local-db:messages:list', [task.id, { limit: 50 }]) as Array<{ role: string; content: string }>;
    expect(messages.filter(row => row.role === 'agent_switch')).toHaveLength(2);
    expect(messages.find(row => row.role === 'agent_switch')!.content).toMatchObject({ fromAgentKind: 'codex', toAgentKind: 'cc', resumed: !expired });
    expect(messages.filter(row => row.role === 'user').map(row => row.content)).toEqual(['return to the original engine', 'continue with Codex', 'remember the original work']);
  });
  // Recovery tier: the original SQLite fallback must update the parked native
  // session and its boundary together, including a failure between writes.
  it('rolls back a failed native resume fallback and restores its handoff after restart', async () => {
    const { host, create, root } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.storage.update(task.id, { sdkSessionId: 'parked-native' });
    const runtime = await host.conversations;
    const boundary = { fromAgentKind: 'cc' as const, toAgentKind: 'codex' as const,
      fromModel: 'old-model', toModel: 'new-model', fromSdkSessionId: 'old-native',
      handoff: 'Preserve the previous context', consumed: false, resumed: true };
    await runtime.messages.createMessage(task.id, { clientId: 'fallback-boundary', role: 'agent_switch', content: boundary });
    const db = (await host.database).db;
    await db.exec("CREATE TRIGGER fail_resume_fallback BEFORE UPDATE OF content ON messages WHEN OLD.client_id = 'fallback-boundary' BEGIN SELECT RAISE(ABORT, 'SIMULATED_FALLBACK_FAILURE'); END");
    const fallback = { ...boundary, resumed: false, handoff: 'Full context after resume failure' };
    try {
      await expect(runtime.agentSwitch.applyAgentSwitchResumeFallbackAtomically(task.id, 'fallback-boundary', fallback)).rejects.toThrow('SIMULATED_FALLBACK_FAILURE');
      expect((await host.storage.get(task.id))?.sdkSessionId).toBe('parked-native');
      expect(await runtime.messages.findPendingAgentHandoff(task.id)).toBe(boundary.handoff);
    } finally { await db.exec('DROP TRIGGER fail_resume_fallback'); }
    await runtime.agentSwitch.applyAgentSwitchResumeFallbackAtomically(task.id, 'fallback-boundary', fallback);
    expect((await host.storage.get(task.id))?.sdkSessionId).toBeUndefined();
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.channelTurnHost().agentHandoffPending.peek(task.id)).toBe(fallback.handoff);
    const messages = await (await restarted.conversations).messages.readMessagesList(task.id, { limit: 20 }, true);
    expect(messages.filter(row => row.role === 'agent_switch')).toHaveLength(1);
    expect(messages.find(row => row.role === 'agent_switch')!.content).toMatchObject(fallback);
    await expect(access(path.join(root, 'tasks', task.id, 'route-commit.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // Integration: use the real shared channel runner, Maker, task journal and
  // restart recovery. Only network delivery and the native vendor are replaced.
  it('resumes a GUI task through the shared channel runner after restart and consumes its durable handoff once', async () => {
    const { host, create, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Existing GUI task' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'before restart' }]);
    await persistHandoffFixture(host, task.id, 'route-boundary', 'Preserved route context');
    await host.close();
    const resumed = create(); await resumed.ready;
    await resumed.channelBindings.store.attach({ channel: 'wechat', botContextId: 'bot', userId: 'owner' }, task.id);
    const delivered: ImFinalOutput[] = [];
    const notices: string[] = [];
    const im: TextChannelIM = {
      name: 'wechat', getStatus: () => ({ kind: 'connected', appId: 'bot', botName: 'Test' }),
      onMessage: () => () => {}, onStatusChange: () => () => {},
      sendText: async (_user, text) => { notices.push(text); return { messageId: String(notices.length) }; },
      sendMarkdownText: async (_user, text) => { notices.push(text); return { messageId: String(notices.length) }; },
      sendFile: async () => ({ ok: true, messageId: 'file' }),
    };
    const adapter: ImChannelAdapter = {
      channel: 'wechat', im, output: { kind: 'chunked-text', im, commitFinal: async output => { delivered.push(output); } },
      config: { agentKind: 'claude-code', defaultModel: 'test-model', defaultPermissionMode: 'ask' }, ui: wechatUi,
      sessions: { source: 'wechat', sessionIdFor: (bot, user) => `wechat_${bot}_${user}`, defaultTitle: () => 'Channel task', ensureWorkingDir: () => root, extraInsertColumns: () => ({}) },
      processingEmoji: '', buildVendorOptions: () => ({ source: 'wechat' }),
    };
    const repo = resumed.channelRepository(adapter.config, adapter.sessions);
    const runner = createTurnRunner(adapter, repo, createCardBuilders(adapter.ui, repo.getDefaultEffortFor), resumed.channelTurnDependencies(), resumed.channelTurnHost());
    let dispatches = 0;
    try {
      for (const text of ['continue remotely', 'next message']) {
        const result = await runner.dispatchAgentTurn({ botContextId: 'bot', userId: 'owner', userMessageId: text, text, attachments: [], queueMode: 'external', beforeProviderStart: async () => { dispatches++; } });
        expect(result.kind).toBe('accepted');
        if (result.kind !== 'accepted') throw new Error(result.reason);
        expect(result.sessionId).toBe(task.id);
        expect((await result.terminal).kind).toBe('done');
      }
      expect(dispatches).toBe(2);
      expect(delivered).toHaveLength(2);
      expect(JSON.stringify(delivered[0])).toContain('continue remotely');
      expect(native.starts.at(-1)?.resumeSessionId).toBe(`native-${task.id}`);
      expect(native.starts.at(-1)?.providerId).toBe('fixture');
      expect(JSON.stringify(native.sent.at(-2))).toContain('Preserved route context');
      expect(JSON.stringify(native.sent.at(-1))).not.toContain('Preserved route context');
      await resumed.taskContext.enqueue('read after acceptance', () => resumed.storage.flush());
      expect(await (await resumed.conversations).messages.findPendingAgentHandoff(task.id)).toBeNull();
      const messages = await resumed.invoke('local-db:messages:list', [task.id, { limit: 20 }]) as Array<{ role: string; content: string; agentMeta: Record<string, unknown> | null }>;
      expect(messages.filter(row => row.role === 'user').map(row => row.content)).toEqual(['next message', 'continue remotely', 'before restart']);
      expect(messages.find(row => row.content === 'continue remotely')?.agentMeta?.imSource).toBeDefined();
      expect(notices).toEqual([]);
    } finally { await runner.disposeAllSessions(); }
    await resumed.close();
    const restarted = create(); await restarted.ready;
    expect(await restarted.channelTurnHost().agentHandoffPending.peek(task.id)).toBeNull();
  });
  // A late accepted send may only retire its own context boundary. The next
  // GUI send must still receive a newer committed boundary after restart.
  it('keeps a newer handoff when an older dispatch settles and rejects stale channel hydration', async () => {
    const { host, root, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await persistHandoffFixture(host, task.id, 'old', 'old handoff');
    expect(await host.channelTurnHost().agentHandoffPending.peek(task.id)).toBe('old handoff');
    await persistHandoffFixture(host, task.id, 'same-text-new-boundary', 'old handoff');
    host.channelTurnHost().agentHandoffPending.consume(task.id);
    await host.taskContext.enqueue('accepted context flush', () => host.storage.flush());
    expect(await (await host.conversations).messages.findPendingAgentHandoffSnapshot(task.id)).toMatchObject({ clientId: 'same-text-new-boundary', handoff: 'old handoff' });
    await persistHandoffFixture(host, task.id, 'new', 'new handoff');
    await host.close();
    const resumed = create(); await resumed.ready;
    const ports = resumed.channelTurnHost();
    ports.hydrateSessionProvider(task.id, 'fixture'); ports.setSessionEffort(task.id, 'high');
    await resumed.storage.update(task.id, { effort: 'low' });
    await expect(ports.getMaker().createSession({ id: task.id, agentKind: 'claude-code', workingDir: root, model: 'test-model' })).rejects.toThrow('CHANNEL_TASK_ROUTE_CHANGED');
    await resumed.invoke('maker:send', [task.id, { text: 'GUI continues' }]);
    expect(JSON.stringify(native.sent.at(-1))).toContain('new handoff');
    expect(JSON.stringify(native.sent.at(-1))).not.toContain('old handoff');
    await resumed.taskContext.enqueue('flush GUI acceptance', () => resumed.storage.flush());
    expect(await (await resumed.conversations).messages.findPendingAgentHandoff(task.id)).toBeNull();
    const messages = await resumed.invoke('local-db:messages:list', [task.id, { limit: 10 }]) as Array<{ role: string; content: string }>;
    expect(messages.find(row => row.role === 'user')?.content).toBe('GUI continues');
  });
  // Integration: an accepted turn must continue after a dropped response without
  // replaying an already completed write. Exercise public Node send/abort and
  // original coordinator/bookkeeping/SQLite; only native transport is synthetic.
  it.each(['resume', 'process-close', 'stop'] as const)('preserves original interrupted-turn ownership through %s', async action => {
    const { host, native, root } = await setup();
    const task = await host.invoke('maker:create-session', [{workingDir: root}]) as {id: string};
    const observed = (kind: string) => new Promise<void>(resolve => {
      const off = host.observeTask(task.id, event => { if (event.type === kind) { off(); resolve(); } });
    });
    vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
    try {
      const interrupted = observed('error');
      await host.invoke('maker:send', [task.id, {text:'interrupted-after-write',clientId:'interrupted-receipt'}]);
      await interrupted;
      expect(await readFile(path.join(root,'effect.txt'),'utf8')).toBe('completed\n');
      expect((await host.storage.submission(task.id,'interrupted-receipt'))?.status).not.toBe('completed');
      if (action === 'stop') {
        await host.invoke('maker:abort-session', [task.id]);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(native.sent).toHaveLength(1);
        expect(host.isTurnRunning(task.id)).toBe(false);
      } else {
        if(action==='process-close'){
          const session=host.routes.deps.getLiveSession(task.id) as Session;
          const closed=new Promise<void>(resolve=>{const off=session.onStatusChange(status=>{if(status==='closed'){off();resolve();}});});
          native.crashTransport.get(task.id)!();
          await closed;
          expect(session.wasClosedByRuntime()).toBe(true);
        }
        const finished = observed('done');
        await vi.advanceTimersByTimeAsync(4_000);
        await finished;
        await (await host.conversations).persistence.drainPersistQueue();
        await host.storage.flush();
        expect(native.sent.map(message => String(message.content).replace(buildUiLanguageErrorNote('en')+'\n\n','')))
          .toEqual(['interrupted-after-write',CONTINUE_AFTER_ERROR_PROMPT]);
        expect(await readFile(path.join(root,'effect.txt'),'utf8')).toBe('completed\n');
        const rows=await host.invoke('local-db:messages:list',[task.id]) as Array<{role:string;content:string;agentMeta?:{autoResume?:boolean}}>;
        expect(rows.filter(row=>row.role==='user' && !row.agentMeta?.autoResume).map(row=>row.content)).toEqual(['interrupted-after-write']);
        expect(rows.filter(row=>row.agentMeta?.autoResume)).toHaveLength(1);
        expect((await host.storage.submission(task.id,'interrupted-receipt'))?.status).toBe('completed');
        expect(host.isTurnRunning(task.id)).toBe(false);
      }
    } finally { vi.useRealTimers(); }
  });
  // Regression: vendor silent-stop previously completed the terminal receipt
  // immediately and could leave a shared IM turn waiting forever. Real Maker
  // drives generation, terminal and abort callbacks; only its transport is fake.
  it.each(['resume', 'stop', 'exhausted'] as const)('keeps a silent task occupied until %s settles its logical turn', async outcome => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const terminal = (silent: boolean) => new Promise<void>(resolve => {
      const off = host.observeTask(task.id, event => {
        if (event.type === 'done' && Boolean((event.data as { silentStop?: boolean })?.silentStop) === silent) { off(); resolve(); }
      });
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const first = terminal(true);
      await host.invoke('maker:send', [task.id, { text: outcome === 'exhausted' ? 'silent-loop' : 'silent-once', clientId: 'silent-receipt' }]);
      await first;
      expect(await host.invoke('maker:session:turn-active', [task.id])).toEqual({ inTurn: true });
      expect((await host.storage.submission(task.id, 'silent-receipt'))?.status).not.toBe('completed');
      if (outcome === 'stop') {
        await host.invoke('maker:abort-session', [task.id]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(native.sent).toHaveLength(1);
        expect(host.isTurnRunning(task.id)).toBe(false);
      } else if (outcome === 'resume') {
        const finished = terminal(false);
        await vi.advanceTimersByTimeAsync(1_500);
        await finished;
        await host.storage.flush();
        expect(native.sent.map(message => String(message.content).replace(buildUiLanguageErrorNote('en') + '\n\n', ''))).toEqual(['silent-once', '继续']);
        const messages = await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; agentMeta?: { autoResume?: boolean } }>;
        expect(messages.filter(message => message.agentMeta?.autoResume)).toHaveLength(1);
        expect(host.isTurnRunning(task.id)).toBe(false);
      } else {
        const repeated = terminal(true);
        await vi.advanceTimersByTimeAsync(1_500);
        await repeated;
        const settled = new Promise<string>(resolve => { const off = host.turnLifecycle.onSettled(task.id, (_id, reason) => { off(); resolve(reason); }); });
        await vi.advanceTimersByTimeAsync(1_500);
        expect(await settled).toBe('exhausted');
        await host.storage.flush();
        expect(native.sent).toHaveLength(2);
        expect(host.isTurnRunning(task.id)).toBe(false);
      }
    } finally { vi.useRealTimers(); }
  });
  // Integration: the Desktop sidecar tests do not cover terminal send admission,
  // journal anchors, runtime capture hooks, or remote restore against live tasks.
  it('captures real turn edits for GUI restore, rejects conflicts, and preserves patches after restart', async () => {
    const { host, root, create, nextPush } = await setup();
    const file = path.join(root, 'revision.txt');
    await writeFile(file, 'before\n');
    const task = await host.invoke('maker:create-session', [{ workingDir: root }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'edit-fixture' }]);
    await host.changes.store.waitForTurnChangeSetPersistence();
    const [change] = await host.invoke('maker:turn-change-sets:list', [task.id]) as Array<{ id: string; anchorClientId: string; isReversible: boolean }>;
    expect(change.isReversible).toBe(true);
    expect(await readFile(file, 'utf8')).toBe('after\n');
    const user = (await host.invoke('local-db:messages:list', [task.id]) as Array<{ role: string; clientId: string }>).find(row => row.role === 'user');
    expect(change.anchorClientId).toBe(user!.clientId);
    const context = { source: 'remote' as const, deviceId: 'test-controller' };
    await host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context);
    expect(await readFile(file, 'utf8')).toBe('before\n');
    await host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'reapply'], context);
    expect(await readFile(file, 'utf8')).toBe('after\n');
    await writeFile(file, 'changed separately\n');
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('STALE_DIFF');
    expect(await readFile(file, 'utf8')).toBe('changed separately\n');
    const approval = nextPush('maker:interaction-request');
    const sending = host.invoke('maker:send', [task.id, { text: 'permission' }]);
    const request = await approval as { request: { requestId: string } };
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('SESSION_RUNNING');
    await host.invoke('maker:resolve-interaction', [request.request.requestId, { kind: 'permission', behavior: 'deny' }]);
    await sending;
    await host.close();
    const reopened = create(); await reopened.ready;
    expect(await reopened.invoke('maker:turn-change-sets:list', [task.id])).toMatchObject([{ id: change.id }]);
    await expect(host.invoke('maker:turn-change-set:apply', [task.id, change.id, 'undo'], context)).rejects.toThrow('TASK_HOST_CLOSED');
  });
  // Regression from native CI: a fresh computer has no agent binaries yet.
  // Starting the host and showing model/permission choices must precede engine
  // installation. The normal fixture has a provisioned Claude binary.
  it('starts on a fresh computer before any native engine is installed', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-no-engines-'));roots.push(root);
    const missing=path.join(root,'not-installed');
    const host=new TerminalTaskHost({profileDir:root,logger,binaryPaths:{'claude-code':missing,codex:missing,pi:missing},secretStore:{get:async()=>null,set:async()=>{},delete:async()=>{}},emit(){}});hosts.push(host);
    await host.ready;
    for(const kind of ['claude-code','codex','pi']) {
      const capabilities=await host.invoke('maker:get-capabilities',[kind]) as {permissionModes:Array<{id:string}>};
      expect(capabilities.permissionModes.length).toBeGreaterThan(0);
    }
    expect(await host.invoke('terminal:tasks:list',[])).toEqual([]);
  });
  // Integration: Desktop's settings tests do not cover the terminal's owner
  // retirement, queued atomic writes, or resolution against its actual vault.
  it('persists independent channel defaults and resolves only enabled model routes after restart', async () => {
    const { host, root, create } = await setup();
    const config = { agentKind: 'claude-code' as const, defaultModel: 'test-model', defaultPermissionMode: 'auto' as const };
    const originalGlobal = host.channelDefaults.read();
    await Promise.all([
      host.channelDefaults.update({ permissionMode: 'plan', agents: { 'claude-code': { providerId: 'fixture', model: 'test-model', effort: 'high' } } }, 'discord'),
      host.channelDefaults.update({ permissionMode: 'ask' }, 'feishu'),
    ]);
    expect(host.channelDefaults.read()).toEqual(originalGlobal);
    expect(host.channelDefaults.read('feishu').permissionMode).toBe('ask');
    expect(await host.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'test-model', providerId: 'fixture', permissionMode: 'plan' });
    const persisted = JSON.parse(await readFile(path.join(root, 'im-default-settings.json'), 'utf8'));
    expect(persisted.channels.discord.agents.pi).toBeUndefined();
    expect(() => host.channelDefaults.update({ apiKey: 'must-not-persist' }, 'discord')).toThrow();
    await host.close();
    expect(() => host.channelDefaults.update({ permissionMode: 'auto' }, 'discord')).toThrow('IM_DEFAULTS_CLOSED');
    const restarted = create(); await restarted.ready;
    expect(restarted.channelDefaults.state('discord')).toMatchObject({ isCustomized: true, value: { permissionMode: 'plan' } });
    expect(await restarted.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'test-model', providerId: 'fixture' });
    const provider = restarted.models.snapshot().providers.find(value => value.id === 'fixture')!;
    provider.runtimes['claude-code']!.models.push({ id: 'channel-fallback', name: 'Channel fallback' });
    await restarted.models.saveProvider(provider);
    await restarted.models.setDisabled({ kind: 'model', providerId: 'fixture', modelIds: ['test-model'], disabled: true }, () => {});
    expect(await restarted.channelSessionDefaults.resolveImSessionDefaults(config, undefined, 'discord')).toMatchObject({ model: 'channel-fallback', providerId: 'fixture', permissionMode: 'plan' });
    await restarted.channelDefaults.reset('discord');
    expect(restarted.channelDefaults.state('discord').isCustomized).toBe(false);
    expect(restarted.channelDefaults.read('feishu').permissionMode).toBe('ask');
  });
  // Recovery tier / IM /new: fail the new row inside the real SQLite transaction.
  // The previous task and takeover must survive together; retry and restart
  // must preserve the original history and any newer takeover.
  it('rolls back a failed channel rotation and preserves a newer binding after restart', async () => {
    const { host, root, create } = await setup();
    const config = { agentKind: 'claude-code' as const, defaultModel: 'test-model', defaultPermissionMode: 'auto' as const };
    const namespace = { source: 'telegram' as const, createTaskOnNew: true,
      sessionIdFor: (bot: string, user: string) => `telegram_${bot}_${user}`,
      defaultTitle: () => 'Telegram task', ensureWorkingDir: () => root, workspaceKind: 'dialogue' as const,
      extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }) };
    await host.channelDefaults.update({ agents: { 'claude-code': { providerId: 'fixture', model: 'test-model', effort: 'high' } } }, 'telegram');
    const repo = host.channelRepository(config, namespace);
    const old = await repo.createSession('bot', 'owner');
    await host.storage.update(old.id, { sdkSessionId: 'native-context' });
    await host.storage.append(old.id, { kind: 'user', message: { type: 'user', content: 'preserve original history' } });
    const takeover = await host.invoke('maker:create-session', [{ workingDir: root }]) as { sessionId: string };
    const identity = { channel: 'telegram', botContextId: 'bot', userId: 'owner' };
    await host.channelBindings.store.attach(identity, takeover.sessionId);
    const db = (await host.database).db;
    await db.exec("CREATE TRIGGER fail_channel_rotation BEFORE INSERT ON sessions WHEN NEW.source = 'telegram' BEGIN SELECT RAISE(ABORT, 'SIMULATED_ROTATION_FAILURE'); END");
    try {
      await expect(repo.createFreshSession!('bot', 'owner', undefined, undefined,
        { identity, targetSessionId: takeover.sessionId })).rejects.toThrow('SIMULATED_ROTATION_FAILURE');
      expect(await host.storage.get(old.id)).toMatchObject({ archived: false, sdkSessionId: 'native-context' });
      expect(host.channelBindings.store.get(identity)).toBe(takeover.sessionId);
      expect((await host.storage.list()).filter(row => row.source === 'telegram')).toHaveLength(1);
    } finally { await db.exec('DROP TRIGGER fail_channel_rotation'); }
    const fresh = await repo.createFreshSession!('bot', 'owner', undefined, undefined,
      { identity, targetSessionId: takeover.sessionId });
    expect(await host.storage.get(old.id)).toMatchObject({ archived: true, sdkSessionId: 'native-context' });
    expect(host.channelBindings.store.get(identity)).toBeNull();
    await host.close();
    const restarted = create(); await restarted.ready;
    expect((await restarted.storage.history(old.id)).records[0].message?.content).toBe('preserve original history');
    expect(await restarted.storage.get(fresh.current.id)).toMatchObject({ archived: false, source: 'telegram' });
    const newer = await restarted.invoke('maker:create-session', [{ workingDir: root }]) as { sessionId: string };
    await restarted.channelBindings.store.attach(identity, newer.sessionId);
    const next = await restarted.channelRepository(config, namespace).createFreshSession!('bot', 'owner', undefined, undefined,
      { identity, targetSessionId: takeover.sessionId });
    expect(restarted.channelBindings.store.get(identity)).toBe(newer.sessionId);
    expect(await restarted.storage.get(fresh.current.id)).toMatchObject({ archived: true });
    expect(next.current.id).not.toBe(fresh.current.id);
    await expect(access(path.join(root, 'channel-rotation.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(path.join(root, 'channel-bindings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // Integration: channel identity creation/revival/rotation must produce the
  // same tasks that GUI clients read and the real Maker runtime resumes.
  it('creates, revives and rotates channel tasks through the shared GUI task host', async () => {
    const { host, root, create, native, pushes } = await setup();
    const config = { agentKind: 'claude-code' as const, defaultModel: 'test-model', defaultPermissionMode: 'auto' as const };
    const namespace = { source: 'telegram' as const, createTaskOnNew: true, sessionIdFor: (bot: string, user: string) => `telegram_${bot}_${user}`, defaultTitle: () => 'Telegram task', ensureWorkingDir: () => root, workspaceKind: 'dialogue' as const, extraInsertColumns: (bot: string, user: string) => ({ imBotContextId: bot, imUserId: user }) };
    await host.channelDefaults.update({ agents: { 'claude-code': { providerId: 'fixture', model: 'test-model', effort: 'high' } } }, 'telegram');
    const repo = host.channelRepository(config, namespace);
    const [first, duplicate] = await Promise.all([repo.createSession('bot', 'owner'), repo.createSession('bot', 'owner')]);
    expect(first.id).toBe(duplicate.id);
    expect(native.starts).toHaveLength(0);
    expect((await host.invoke('local-db:sessions:list', [])) as unknown[]).toHaveLength(1);
    expect(await host.invoke('local-db:sessions:get', [first.id])).toMatchObject({ source: 'telegram', workspaceKind: 'dialogue', userSendAt: expect.any(String) });
    expect(await host.storage.get(first.id)).toMatchObject({ imUserId: 'owner', imBotContextId: 'bot' });
    const runtime = await host.channelRuntime().createSession({ id: first.id, agentKind: first.agentKind, workingDir: first.workingDir, model: first.model, vendorOptions: { source: 'telegram' } });
    await host.invoke('maker:send', [first.id, { text: 'original channel task' }]);
    const sdkSessionId = (await host.storage.get(first.id))!.sdkSessionId;
    expect(runtime).toBe(host.channelRuntime().getSession(first.id));
    await host.invoke('local-db:sessions:patch-meta', [first.id, { status: 'archived' }]);
    expect((await repo.peekSession('bot', 'owner'))?.sdkSessionId).toBe(sdkSessionId);
    expect((await host.storage.get(first.id))?.archived).toBe(true);
    expect((await repo.findActiveSession('bot', 'owner'))?.id).toBe(first.id);
    expect((await host.storage.get(first.id))?.archived).toBe(false);
    const target = await host.invoke('maker:create-session', [{ title: 'Existing GUI task' }]) as { id: string };
    const identity = { channel: 'telegram', botContextId: 'bot', userId: 'owner' };
    await host.channelBindings.store.attach(identity, target.id);
    const rotated = await repo.createFreshSession!('bot', 'owner', undefined, undefined, { identity, targetSessionId: target.id });
    expect(rotated.current.id).not.toBe(first.id);
    expect(rotated.current.sdkSessionId).toBeNull();
    expect((await host.storage.get(first.id))?.archived).toBe(true);
    expect((await host.storage.get(target.id))?.archived).not.toBe(true);
    expect(host.channelBindings.store.get(identity)).toBeNull();
    expect((await host.invoke('local-db:messages:list', [first.id, { limit: 10 }]) as Array<{content:string}>).some(row => row.content === 'original channel task')).toBe(true);
    expect(pushes.some(event => event.channel === 'local-db:sessions:created' && (event.payload as {sessionId:string}).sessionId === rotated.current.id)).toBe(true);
    await host.close();
    const restarted = create(); await restarted.ready;
    const resumedRepo = restarted.channelRepository(config, namespace);
    expect((await resumedRepo.peekSession('bot', 'owner'))?.id).toBe(rotated.current.id);
    await expect(repo.findActiveSession('bot', 'owner')).rejects.toThrow('TASK_HOST_CLOSED');
  });
  // Integration / im-turn-flow: Desktop's mocked SQL tests do not cover the
  // terminal owner's atomic file or daemon retirement. Two identities claiming
  // one real task must survive restart, and a stale card must not revoke the new
  // target. Deleting the task must durably retire its takeover.
  it('restores channel takeovers and retires deleted targets at owner startup', async () => {
    const { host, create } = await setup();
    const first = await host.invoke('maker:create-session', [{ title: 'First takeover' }]) as { id: string };
    const second = await host.invoke('maker:create-session', [{ title: 'Second takeover' }]) as { id: string };
    const discord = { channel: 'discord', botContextId: 'bot', userId: 'owner' };
    const feishu = { channel: 'feishu', botContextId: 'app', userId: 'owner' };
    await host.channelBindings.store.attach(discord, first.id, { attachedViaCardMessageId: 'card-1' });
    expect(await host.channelBindings.store.attachWithResult(feishu, first.id)).toEqual({ displaced: { identity: discord, attachedViaCardMessageId: 'card-1' } });
    await host.channelBindings.store.attach(feishu, second.id, { attachedViaCardMessageId: 'card-2' });
    await host.close();
    const resumed = create();
    await resumed.ready;
    expect(resumed.channelBindings.store.get(discord)).toBeNull();
    expect(resumed.channelBindings.store.get(feishu)).toBe(second.id);
    expect(resumed.channelBindings.store.getAttachCardMessageId(feishu)).toBe('card-2');
    expect(await resumed.channelBindings.store.detachIfTarget(feishu, first.id)).toBe(false);
    await expect(host.channelBindings.store.attach(discord, first.id)).rejects.toThrow('IM_BINDINGS_CLOSED');
    await resumed.invoke('terminal:tasks:delete', [second.id]);
    // The original session service retires the task; owner startup reconciles
    // stale channel bindings against that durable status.
    expect((await resumed.storage.get(second.id))?.deleted).toBe(true);
    await resumed.close();
    const afterDeletion = create();
    await afterDeletion.ready;
    expect(afterDeletion.channelBindings.store.listAttachedTargets()).toEqual([]);
  });
  // Integration: deleting a terminal task must retire adopted channel files
  // without deleting an unrelated message still waiting for its own task.
  it('cleans adopted channel attachments through task deletion and preserves unclaimed files', async () => {
    const { host } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Channel files' }]) as { id: string };
    const staged = await host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('task attachment'), fileName: '验收.txt' });
    const unclaimed = await host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('later message'), fileName: 'later.txt' });
    const attachments: import('@cindy/im').IMAttachment[] = [{ kind: 'file', absPath: staged.absPath, originalName: '验收.txt', mimeType: 'text/plain' }];
    await host.channelFiles.adoptStagedInboundFiles(task.id, attachments);
    expect(attachments[0]!.absPath).not.toBe(staged.absPath);
    expect(await readFile(attachments[0]!.absPath, 'utf8')).toBe('task attachment');
    await host.invoke('terminal:tasks:delete', [task.id]);
    await vi.waitFor(async () => { await expect(readFile(attachments[0]!.absPath)).rejects.toMatchObject({ code: 'ENOENT' }); }, { interval: 5 });
    expect(await readFile(unclaimed.absPath, 'utf8')).toBe('later message');
    await host.close();
    await expect(host.channelFiles.stageInboundFile({ integration: 'discord', buffer: Buffer.from('old owner'), fileName: 'closed.txt' })).rejects.toThrow('TASK_HOST_CLOSED');
  });
  // Integration: channel takeover must reuse the GUI/TUI task runtime, expose
  // the same approval, and restore its saved route after that runtime closes.
  it('shares live tasks, approvals and cold channel startup with the GUI task host', async () => {
    const { host, native, nextPush } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Channel takeover' }]) as { id: string };
    const runtime = host.channelRuntime();
    const events: import('@cindy/maker-core').MakerEvent[] = [];
    const off = runtime.on(event => events.push(event));
    const session = await runtime.createSession({ id: task.id, agentKind: 'claude-code', workingDir: 'ignored-existing-task', model: 'ignored-existing-model', vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    expect(runtime.getSession(task.id)).toBe(session);
    expect(native.starts).toHaveLength(1);
    expect(native.starts[0]?.vendorOptions?.discordChatId).toBeUndefined();
    const approval = nextPush('maker:interaction-request');
    const sending = session.send({ type: 'user', content: 'permission' });
    const request = await approval as { request: import('@cindy/maker-core').InteractionRequest };
    await host.invoke('maker:resolve-interaction', [request.request.requestId, { kind: 'permission', behavior: 'allow' }]);
    await sending;
    expect(native.decisions).toHaveLength(1);
    await host.storage.update(task.id, { fastMode: true });
    await host.invoke('maker:close-session', [task.id]);
    expect(runtime.getSession(task.id)).toBeUndefined();
    expect(events.filter(event => event.type === 'session:closed')).toHaveLength(1);
    const resumed = await runtime.createSession({ id: task.id, agentKind: 'claude-code', model: 'ignored-existing-model', workingDir: 'ignored-existing-task', vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    expect(resumed).not.toBe(session);
    expect(native.starts).toHaveLength(2);
    expect(native.starts[1]).toMatchObject({ model: 'test-model', fastMode: true, vendorOptions: { source: 'discord', discordChatId: 'owner' } });
    await host.invoke('maker:send', [task.id, { text: 'shared-again' }]);
    expect(native.starts).toHaveLength(2);
    off();
  });
  // Integration: the live CLI could not create any task once the market tools
  // were wired. The full plugin composition must precede native session startup
  // without eagerly requiring its not-yet-created incarnation. Real SQLite,
  // native MCP transport and restart recovery use the integration time budget.
  it('starts and sends a task with the full plugin market composition installed',async()=>{
    const {host,root,vault,native}=await setup();
    const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid'}),membership:()=>null,token:()=>null,refresh:async()=>{},assertCurrent:()=>{}});
    const plugins=new TerminalPlugins({root,runtimeDirectory:root,executablePath:'unused',account,models:{models:host.models,utility:host.utility},assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},receive:async()=>({}),
      secrets:{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);},getSync:key=>vault.get(key)??null,setSync:(key,value)=>{vault.set(key,value);},deleteSync:key=>{vault.delete(key);},setManySync:entries=>{for(const [key,value] of Object.entries(entries))if(value===null)vault.delete(key);else vault.set(key,value);}},
      cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false,reason:'cancelled'}),writeSaveDeposit:async()=>null},
    });
    const market=new TerminalPluginMarket({root,host:plugins,account,assertCurrent:()=>{}});
    await connectCompanionFixture(host,root);
    const createCompanion=()=>new TerminalCompanionHost({ tasks: host, root: path.join(root, 'companions'), profileDir: root, logger, guard: () => { }, emit: () => { }, binary: async () => process.execPath });
    let companions=createCompanion();
    const tasks=new TerminalPluginTasks({root,runtimeDirectory:root,host:plugins,account,market,tasks:host,companions:()=>companions,projectDirectories:async()=>[root],protectedInput:{configurePlugins:()=>{}},deposits:new DirDepositVault(),saves:new SaveDepositVault(),owner:()=>({mode:'local',dataOwnerId:'test',generation:1}),signedIn:()=>false,remoteAvailable:()=>false,locale:()=> 'en',assertCurrent:()=>{},emit:()=>{}});
    try{
      await plugins.ready;await tasks.ready;tasks.connectCompanions();await companions.modelSettings.saveDefaults([{...(await host.models.select()).selection,fastMode:false}]);
      // Integration tier: task ownership, durable replay, terminal input source
      // and cancellation were previously unavailable behind the plugin pipe.
      const installed = {dir:path.join(root,'_root__fixture-plugin'),enabled:true,approval:{state:'approved',revision:'00000000-0000-4000-8000-000000000001'},taskCapabilityApproved:true,
        instanceKey:'_root__fixture-plugin',namespace:null,manifest:{id:'fixture-plugin',name:'Task fixture',version:'1.0.0',mainView:{html:'main.html'},agent:{tasks:true,hiddenTasks:true}}} as unknown as import('@cindy/plugin-runtime/shared/ghost').InstalledGhost;
      const lookup=vi.spyOn(plugins.native,'list').mockReturnValue([installed]);
      const call=async(kind:string,args:Record<string,unknown>={})=>{
        const result=await plugins.receive('_root__fixture-plugin',{type:'tasks-request',kind,...args}) as {ok:boolean;data:any;error?:{code:string;message?:string}};
        if(!result.ok)throw new Error(`${result.error?.code}: ${result.error?.message}`);return result.data;
      };
      let created=await call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true});
      expect(await call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true})).toMatchObject({taskId:created.taskId,hidden:true});
      expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(false);
      {
      // Integration/security: targets used to fall through the real sandbox
      // pipe. Exercise owner-task and Profile delivery, independent approval,
      // receipt replay, revocation and cancellation through that same entry.
      const target=(kind:string,args:Record<string,unknown>={})=>plugins.receive('_root__fixture-plugin',{type:'targets-request',kind,...args}) as Promise<{ok:boolean;data:any;error?:{code:string}}>;
      expect(await target('list',{targetKind:'task'})).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
      installed.manifest.agent!.targets=true;installed.targetCapabilityApproved=true;
      const existing=await host.invoke('maker:create-session',[{title:'Owner target'}]) as {id:string};
      expect((await target('list',{targetKind:'task'})).data.targets.map((row:{id:string})=>row.id)).toContain(existing.id);
      expect((await target('list',{targetKind:'task'})).data.targets.map((row:{id:string})=>row.id)).not.toContain(created.taskId);
      const request={target:{kind:'task',id:existing.id},requestKey:'target-once',text:'Target queue'};
      const delivered=await target('send',request);expect(delivered).toMatchObject({ok:true,data:{taskId:existing.id,delivery:'queue'}});
      await expect.poll(()=>host.storage.queued(existing.id),{interval:5}).toEqual([]);
      await expect.poll(async()=>((await host.invoke('local-db:messages:list',[existing.id])) as Array<{role:string}>).some(row=>row.role==='assistant'),{interval:5}).toBe(true);
      expect(await target('send',request)).toEqual(delivered);expect(native.sentFor(existing.id)).toHaveLength(1);
      expect(await host.invoke('local-db:sessions:get',[existing.id])).not.toHaveProperty('source','plugin');
      expect(await host.invoke('local-db:messages:list',[existing.id])).toContainEqual(expect.objectContaining({role:'user',agentMeta:expect.objectContaining({sourcePlugin:{pluginId:'_root__fixture-plugin',name:'Task fixture'},autoReviewUserText:{kind:'delegated-continuation'}})}));
      await host.invoke('maker:send',[existing.id,{text:'wait-for-steer'}]);await native.waitForHeld(existing.id);
      expect(await target('send',{target:request.target,requestKey:'target-steer',text:'Target steer',delivery:'steer'})).toMatchObject({ok:true,data:{delivery:'steer'}});
      const cancelled=await target('send',{target:request.target,requestKey:'target-cancel',text:'Must not execute'});expect(cancelled.ok).toBe(true);
      expect(await target('cancel',{requestKey:'target-cancel'})).toMatchObject({ok:true});
      await target('send',{target:request.target,requestKey:'target-revoke',text:'Revoked queue'});
      delete installed.targetCapabilityApproved;native.finishHeld(existing.id);
      await expect.poll(()=>host.storage.queued(existing.id),{interval:5}).toEqual([]);
      expect(native.sentFor(existing.id)).toHaveLength(2);installed.targetCapabilityApproved=true;
      const project=await target('send',{target:{kind:'project',id:root},requestKey:'project-target',text:'Project target',title:'Project target'});
      expect(project.ok).toBe(true);expect(await host.storage.get(project.data.taskId)).toMatchObject({workDir:await realpath(root)});
      const profile=await companions.create({name:'Target companion'});
      expect((await target('list',{targetKind:'bot'})).data.targets).toContainEqual(expect.objectContaining({id:profile.id}));
      const companionRequest={target:{kind:'bot',id:profile.id},requestKey:'companion-target',text:'Companion queue'};
      const firstCompanionDelivery=await target('send',companionRequest);
      profile.sessionId=(await companions.profiles.get(profile.id))!.sessionId;
      expect(firstCompanionDelivery).toMatchObject({ok:true,data:{taskId:profile.sessionId}});
      await expect.poll(async()=>(await companions.messages(profile.sessionId)).some(row=>row.role==='assistant'),{interval:5}).toBe(true);
      expect(await target('send',companionRequest)).toMatchObject({ok:true});expect(native.sentFor(profile.sessionId)).toHaveLength(1);
      expect((await companions.messages(profile.sessionId)).find(row=>row.role==='user')?.agentMeta).toMatchObject({sourcePlugin:{pluginId:'_root__fixture-plugin',name:'Task fixture'}});
      // A real companion runtime mounts the shared plugin gateway. File
      // consent must reach the same owner RPC, and abort must retire its card.
      const companionRuntime=native.inputs.findLast(input=>input.taskId===profile.sessionId)!;
      const gateway=companionRuntime.tools!.providers.find(provider=>provider.name==='cindy');
      expect(gateway).toBeDefined();
      const pluginClient=new McpClient({name:'companion-plugins',version:'1'});
      const pluginServer=await gateway!.toClaudeSdkConfig!({sessionId:profile.sessionId,workingDir:path.join(companions.profiles.home(profile.id),'workspace'),agentKind:'claude-code'}) as {instance:McpServer};
      const [pluginLeft,pluginRight]=InMemoryTransport.createLinkedPair();await pluginServer.instance.connect(pluginLeft);await pluginClient.connect(pluginRight);
      try {
        expect((await pluginClient.listTools()).tools.some(tool=>tool.name==='ghost_info')).toBe(true);
        const info=await pluginClient.callTool({name:'ghost_list',arguments:{}});
        expect(info.isError).not.toBe(true);
      } finally { await pluginClient.close(); }
      const snapshot=await companions.pluginPermissionSnapshot(profile.sessionId);
      expect(snapshot?.isCurrent?.()).toBe(true);
      for (const behavior of ['deny','allow'] as const) {
        const decision=companions.requestPluginWrite(profile.sessionId,{ghostId:'_root__fixture-plugin',ghostName:'Task fixture',lane:'save_dir',operation:'write',items:[{name:'outside',absPath:root,size:0,isDirectory:true}]});
        const pending=await companions.invoke('maker:get-pending-interactions',[profile.sessionId],{source:'remote',deviceId:'owner-controller'}) as Array<{request:{requestId:string;toolName:string}}>;
        expect(pending).toHaveLength(1);expect(pending[0].request.toolName).toBe('cindy.plugin.write');
        companions.resolveInteraction(pending[0].request.requestId,{kind:'permission',behavior},{source:'remote',deviceId:'owner-controller'});
        expect((await decision).confirmed).toBe(behavior==='allow');
      }
      const abort=new AbortController();
      const cancelledPermission=companions.requestPluginWrite(profile.sessionId,{ghostId:'_root__fixture-plugin',ghostName:'Task fixture',lane:'save_dir',items:[{name:'outside',absPath:root,size:0,isDirectory:true}]},abort.signal);
      abort.abort();expect((await cancelledPermission).confirmed).toBe(false);
      expect(await companions.invoke('maker:get-pending-interactions',[profile.sessionId],{source:'local'})).toEqual([]);
      await companions.send(profile.id,'wait-for-steer','companion-held');await native.waitForHeld(profile.sessionId);
      expect(await target('send',{target:companionRequest.target,requestKey:'companion-steer',text:'Companion steer',delivery:'steer'})).toMatchObject({ok:true,data:{delivery:'steer'}});
      await target('send',{target:companionRequest.target,requestKey:'companion-cancel',text:'Cancelled companion'});
      await target('cancel',{requestKey:'companion-cancel'});
      await target('send',{target:companionRequest.target,requestKey:'companion-revoke',text:'Revoked companion'});
      delete installed.targetCapabilityApproved;native.finishHeld(profile.sessionId);
      await expect.poll(()=>companions.isBusy(profile.id),{interval:5}).toBe(false);
      await expect.poll(async()=>(await companions.storage.latestSubmission(profile.sessionId))?.status,{interval:5}).toBe('failed');
      expect(native.sentFor(profile.sessionId)).toHaveLength(2);installed.targetCapabilityApproved=true;
      await companions.send(profile.id,'wait-for-steer','companion-uncertain-held');await native.waitForHeld(profile.sessionId);
      await expect.poll(()=>host.channelRuntime().getSession(profile.sessionId)?.isTurnRunning(),{interval:5}).toBe(true);
      native.steer.reply=async()=>{throw new Error('The provider did not acknowledge within its deadline');};
      const uncertainRequest={target:companionRequest.target,requestKey:'companion-uncertain',text:'Uncertain companion',delivery:'steer'};
      const uncertainReply=await target('send',uncertainRequest);
      expect(uncertainReply,JSON.stringify(uncertainReply)).toMatchObject({ok:false,error:{code:'DELIVERY_UNCERTAIN'}});
      expect(await companions.projection(profile.sessionId)).toMatchObject({queuePaused:true});
      expect(await target('send',uncertainRequest)).toMatchObject({ok:false,error:{code:'DELIVERY_UNCERTAIN'}});
      native.finishHeld(profile.sessionId);
      expect(await host.invoke('terminal:tasks:wait',[profile.sessionId,'companion-uncertain-held'])).toMatchObject({status:'completed'});
      await host.invoke('maker:close-session',[profile.sessionId]);await companions.close();expect(snapshot?.isCurrent?.()).toBe(false);companions=createCompanion();await companions.ready;tasks.connectCompanions();
      native.steer.reply=async()=>{};
      await companions.resumePending();
      expect(await companions.projection(profile.sessionId)).toMatchObject({queuePaused:true,pendingQueue:[expect.objectContaining({text:'Uncertain companion'})]});
      expect(native.sentFor(profile.sessionId)).toHaveLength(3);
      // The restored durable input must check current approval at the native
      // boundary, even though its original process-local guard no longer exists.
      delete installed.targetCapabilityApproved;
      await companions.invoke('maker:input:resume',[profile.sessionId],{source:'local'});
      await expect.poll(()=>companions.isBusy(profile.id),{interval:5}).toBe(false);
      expect(native.sentFor(profile.sessionId)).toHaveLength(3);
      expect(await companions.projection(profile.sessionId)).toMatchObject({pendingQueue:[]});
      expect(await target('send',uncertainRequest)).toMatchObject({ok:false,error:{code:'PERMISSION_DENIED'}});
      installed.targetCapabilityApproved=true;
      }
      // Owner-facing resource entry remains usable after disabling the plugin.
      const registry=new RemoteResourceRegistry();registerPluginResources(registry,plugins,tasks.pages,tasks.sessions);
      const owner={controllerDeviceId:'terminal-owner'},client={protocolVersion:1,primitives:['text','actions'],locale:'en'};
      const get=vi.spyOn(plugins,'get').mockResolvedValue(installed);
      try{
        const detail=await registry.get(owner,{client,ref:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'}});
        const target=detail.links.find(link=>link.rel==='background-tasks')!.target;
        expect(target.kind).toBe('resource');if(target.kind!=='resource')throw new Error('Expected task list');
        installed.enabled=false;
        const background=await registry.get(owner,{client,ref:target.ref});
        expect(background.links).toEqual(expect.arrayContaining([expect.objectContaining({target:{kind:'session',sessionId:created.taskId}})]));
        const controller:TerminalClient={invoke:(async(channel:string,args:unknown[]=[],device?:string)=>{
          expect(device).toBe('plugin-server');const request=args[0] as never;
          // These child pages are deliberately absent from the root list.
          if(channel.endsWith(':list'))throw new Error('CHILD_IS_NOT_A_COLLECTION_ITEM');
          return channel.endsWith(':manifest')?registry.manifest(owner,request):channel.endsWith(':get')?registry.get(owner,request):registry.invoke(owner,request);
        }) as TerminalClient['invoke'],subscribe:()=>()=>{},close(){}};
        expect(await runResourceCommand(controller,{collection:'plugins',operation:'get',id:target.ref.id,device:'plugin-server',locale:'en'})).toMatchObject({ref:target.ref});
        await runResourceCommand(controller,{collection:'plugins',operation:'reveal-background',id:target.ref.id,input:{taskId:created.taskId},device:'plugin-server',locale:'en'});
        expect(await tasks.sessions.background('_root__fixture-plugin')).toEqual([]);
        expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(true);
      }finally{installed.enabled=true;get.mockRestore();}
      await call('setHidden',{taskId:created.taskId,hidden:true});
      expect((await call('models')).models).toEqual(expect.arrayContaining([expect.objectContaining({route:expect.objectContaining({model:'test-model'})})]));
      const provider=host.models.snapshot().providers.find(p=>p.id==='fixture')!;
      await host.models.saveProvider({...provider,runtimes:{'claude-code':{...provider.runtimes['claude-code']!,models:[...provider.runtimes['claude-code']!.models,{id:'test-second',name:'Second',contextWindow:200000,efforts:['medium','high'],supportsFastMode:true}]},pi:{baseUrl:'http://127.0.0.1:1',wireProtocol:'openai-chat',models:[{id:'test-pi',name:'Pi fixture',contextWindow:200000}]}}},{pi:'invalid-test-key-only'});
      // Owner settings must expose task routes even for a task-only plugin,
      // and persist the chosen engine/model without changing existing tasks.
      const preferences=await registry.get(owner,{client,ref:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'}});
      const modelField=preferences.actions?.find(action=>action.id==='model')?.fields?.find(field=>field.id==='model');
      if(modelField?.kind!=='select')throw new Error('TASK_MODEL_PICKER_MISSING');
      const second=modelField.options?.find(option=>String(option.label).includes('Second'));
      expect(second).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:second!.value}});
      const tuning=await registry.get(owner,{client,ref:preferences.ref});
      const tuningValues=(tuning.blocks?.find(block=>block.id==='task-tuning')?.data as {values:Record<string,unknown>}|undefined)?.values;
      expect(tuningValues).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'task-tuning',input:{...tuningValues,effort:'high',fastMode:'true'}});
      const usingPreference=await call('create',{title:'Plugin default model',requestKey:'configured-model'});
      expect(usingPreference.resolvedConfig).toMatchObject({agentKind:'cc',providerId:'fixture',model:'test-second',effort:'high',fastMode:true});
      expect((await call('get',{taskId:created.taskId})).resolvedConfig.model).toBe('test-model');
      const pi=modelField.options?.find(option=>String(option.label).includes('Pi fixture'));
      expect(pi).toBeDefined();
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:pi!.value}});
      const piTask=await call('create',{title:'Plugin Pi model',requestKey:'configured-pi-model'});
      expect(piTask.resolvedConfig).toMatchObject({agentKind:'pi',providerId:'fixture',model:'test-pi'});
      const piRun=await call('send',{taskId:piTask.taskId,requestKey:'pi-send',expectedRevision:piTask.revision,text:'plugin-pi-input'});
      await vi.waitFor(async()=>expect(await call('getRun',{runId:piRun.runId})).toMatchObject({status:'completed'}));
      expect(native.inputs.at(-1)?.selection.agentKind).toBe('pi');
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:preferences.ref,actionId:'model',input:{model:''}});
      // Released GUI/Mobile actions must reach the same preferences as TUI.
      const request={client,collectionId:'plugins',resourceRef:preferences.ref};
      const remotePrefs=await registry.invoke(owner,{...request,actionId:'task-settings:get'});
      const before=remotePrefs.result as import('@cindy/device-link').PluginTaskPreferences;
      const saved=await registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:before.revision,model:{agentKind:'cc',providerId:'fixture',model:'test-second',fastMode:false}}});
      expect((saved.result as typeof before).config.model).toBe('test-second');
      await expect(registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:before.revision,permissionMode:'auto'}})).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
      const updated=saved.result as typeof before;
      await registry.invoke(owner,{...request,actionId:'task-settings:set',input:{expectedRevision:updated.revision,model:null}});
      // Current GUI management is a separate released action family. Exercise
      // the real resource dispatcher, durable preferences and stale-page CAS.
      const managementOwner={controllerDeviceId:'local'};
      const manage=async(action:string,input:Record<string,unknown>={})=>(await registry.invoke(managementOwner,{...request,actionId:`management:${action}`,input})).result;
      const snapshot=await manage('snapshot') as import('@cindy/plugin-runtime/shared/pluginManagement').PluginManagementSnapshot;
      expect(snapshot).toMatchObject({hostPreferences:true,settingsPage:true,projectBrowse:true});
      expect(snapshot.ghosts[0]?.instanceKey).toBe(installed.instanceKey);
      const approval='approved:00000000-0000-4000-8000-000000000001';
      const guiBefore=await manage('preferences',{expectedInstalledApproval:approval}) as import('@cindy/plugin-runtime/shared/pluginPreferences').RemotePluginPreferenceSnapshot;
      expect(guiBefore.sidebarVisible).toBe(true);
      const guiSaved=await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiBefore.revision,kind:'tasks',patch:{model:{agentKind:'cc',providerId:'fixture',model:'test-second',effort:'high',fastMode:false}}}) as typeof guiBefore;
      expect(guiSaved.tasks?.config).toMatchObject({model:'test-second',effort:'high'});
      await expect(manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiBefore.revision,kind:'sidebar',visible:false})).rejects.toThrow('PLUGIN_SETTINGS_CHANGED');
      const guiHidden=await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiSaved.revision,kind:'sidebar',visible:false}) as typeof guiBefore;
      await tasks.preferences.refresh();expect(tasks.preferences.sidebarVisible(installed.instanceKey!)).toBe(false);
      await manage('preferences-set',{expectedInstalledApproval:approval,expectedRevision:guiHidden.revision,kind:'tasks',patch:{model:null}});
      const project=await manage('project-select',{path:root}) as {id:string};
      const projectBefore=await manage('project-state',{projectId:project.id}) as {revision:string};
      await manage('begin',{operationId:'project-disable',kind:'disable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectBefore.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-disable'})).toMatchObject({phase:'succeeded'}));
      await tasks.preferences.refresh();expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(true);
      await manage('begin',{operationId:'project-stale',kind:'enable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectBefore.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-stale'})).toMatchObject({phase:'failed'}));
      expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(true);
      const projectAfter=await manage('project-state',{projectId:project.id}) as {revision:string};
      await manage('begin',{operationId:'project-enable',kind:'enable',expectedInstalledApproval:approval,projectId:project.id,expectedProjectRevision:projectAfter.revision});
      await vi.waitFor(async()=>expect(await manage('operation',{operationId:'project-enable'})).toMatchObject({phase:'succeeded'}));
      expect(tasks.preferences.disabled(installed.instanceKey!,root)).toBe(false);
      const previous=created;
      created=(await call('setModel',{taskId:created.taskId,expectedRevision:created.revision,route:{...created.resolvedConfig,model:'test-second'}})).task;
      expect(created.resolvedConfig.model).toBe('test-second');
      await expect(call('setModel',{taskId:created.taskId,expectedRevision:previous.revision,route:'plugin-default'})).rejects.toThrow('STALE_REVISION');
      created=(await call('setModel',{taskId:created.taskId,expectedRevision:created.revision,route:'plugin-default'})).task;
      expect(created.resolvedConfig.model).toBe('test-model');
      // The real pending-interaction path supplies owner consent. Refusing once
      // must not let a plugin reopen it; only the local owner's retry can do so.
      const confirm=async(id:string,behavior:'allow'|'deny')=>{
        const request=await vi.waitFor(async()=>{
          const pending=await host.invoke('maker:get-pending-interactions',[id]) as Array<{request:{requestId:string;toolName?:string}}>;
          expect(pending).toHaveLength(1);expect(pending[0].request.toolName).toBe('cindy.plugin.task.writeAccess');return pending[0].request;
        });
        await host.invoke('maker:resolve-interaction',[request.requestId,{kind:'permission',behavior}]);
      };
      const denied=call('requestWriteAccess',{taskId:created.taskId});
      await confirm(created.taskId,'deny');expect(await denied).toEqual({granted:false});
      expect(await call('requestWriteAccess',{taskId:created.taskId})).toEqual({granted:false});
      expect(await host.invoke('maker:get-pending-interactions',[created.taskId])).toEqual([]);
      expect(await host.invoke('maker:get-plugin-write-access-recovery',[created.taskId])).toEqual({granted:false,available:true});
      await expect(host.invoke('maker:retry-plugin-write-access',[created.taskId],{source:'remote',deviceId:'other'})).rejects.toThrow('LOCAL_ONLY_COMMAND');
      const granted=host.invoke('maker:retry-plugin-write-access',[created.taskId]);
      await confirm(created.taskId,'allow');expect(await granted).toMatchObject({granted:true,available:false,mode:'acceptEdits'});
      created=await call('get',{taskId:created.taskId});
      expect(created.permissionMode).toBe('acceptEdits');expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('acceptEdits');
      const run=await call('send',{taskId:created.taskId,requestKey:'send-1',expectedRevision:created.revision,text:'plugin-owned-input'});
      await vi.waitFor(async()=>expect(await call('getRun',{runId:run.runId})).toMatchObject({status:'completed'}));
      const firstPage=await call('readMessages',{taskId:created.taskId,limit:1});expect(firstPage.items[0]).toMatchObject({role:'user',content:'plugin-owned-input'});
      const secondPage=await call('readMessages',{taskId:created.taskId,limit:1,after:firstPage.nextCursor});expect(secondPage.items[0].role).toBe('assistant');
      const sent=native.sent.length;
      expect(await call('send',{taskId:created.taskId,requestKey:'send-1',expectedRevision:created.revision,text:'plugin-owned-input'})).toMatchObject({runId:run.runId,status:'completed'});
      expect(native.sent).toHaveLength(sent);
      expect(native.sends.at(-1)?.[AUTO_REVIEW_USER_INTENT]).toBe('');
      const history=await host.invoke('local-db:messages:list',[created.taskId,{limit:20}]) as Array<{role:string;agentMeta?:any}>;
      expect(history.find(row=>row.role==='user')?.agentMeta).toMatchObject({sourcePlugin:{pluginId:'_root__fixture-plugin'},autoReviewUserText:{kind:'delegated-continuation'}});
      await host.invoke('maker:set-permission-mode',[created.taskId,'ask']);
      await expect(call('requestWriteAccess',{taskId:created.taskId})).rejects.toThrow('TASK_BUSY');
      created=await call('get',{taskId:created.taskId});
      await host.invoke('maker:input:stop',[created.taskId]);
      const cancelled=await call('send',{taskId:created.taskId,requestKey:'queued-1',expectedRevision:created.revision,text:'never-dispatched'});
      expect(await call('cancel',{runId:cancelled.runId,requestKey:'cancel-1'})).toMatchObject({status:'cancelled'});
      expect(native.sent).toHaveLength(sent);
      const changing=await call('create',{title:'Changing permission',requestKey:'permission-race'});
      const stale=call('requestWriteAccess',{taskId:changing.taskId,mode:'auto'}).then(value=>value,error=>error);
      await vi.waitFor(async()=>expect(await host.invoke('maker:get-pending-interactions',[changing.taskId])).toHaveLength(1));
      await host.invoke('maker:set-permission-mode',[changing.taskId,'ask']);
      await confirm(changing.taskId,'allow');
      expect(await stale).toMatchObject({message:expect.stringContaining('TASK_BUSY')});
      expect((await host.storage.get(changing.taskId))?.permissionMode).toBe('ask');
      const rollback=await call('create',{title:'Failed preference commit',requestKey:'permission-rollback'});
      const stoppedRollback=await host.invoke('maker:input:stop',[rollback.taskId]) as {queuePaused:boolean};
      const persist=vi.spyOn(plugins.models!,'setPermission').mockRejectedValueOnce(new Error('PREFERENCE_DISK_FAILURE'));
      const failed=call('requestWriteAccess',{taskId:rollback.taskId,mode:'auto'}).then(value=>value,error=>error);
      await confirm(rollback.taskId,'allow');expect(await failed).toBeInstanceOf(Error);persist.mockRestore();
      expect((await host.storage.get(rollback.taskId))?.permissionMode).toBe('acceptEdits');
      expect(native.permissionModes.slice(-2)).toEqual(['auto','acceptEdits']);
      expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('acceptEdits');
      expect(await host.invoke('maker:input:get-projection',[rollback.taskId])).toMatchObject({queuePaused:stoppedRollback.queuePaused});
      await registry.invoke(owner,{client,collectionId:'plugins',resourceRef:{collectionId:'plugins',kind:'plugin',id:'_root__fixture-plugin'},actionId:'task-permission',input:{permissionMode:'ask'}});
      expect((await plugins.models!.config('_root__fixture-plugin')).permissionMode).toBe('ask');
      await expect(call('send',{taskId:rollback.taskId,expectedRevision:rollback.revision,requestKey:'after-owner-revocation',text:'must not dispatch'})).rejects.toThrow('PERMISSION_DENIED');
      await expect(plugins.setTaskPermission('_root__fixture-plugin','bypassPermissions')).rejects.toThrow('INVALID_PERMISSION_MODE');
      // Integration: the native plugin pipe must persist an immutable plan only
      // before work starts, and a plan cannot grant a new directory.
      const planned=await call('create',{title:'Registered team plan',requestKey:'team-plan'});
      const plan={concurrency:1,items:[{label:'review',workingDir:planned.workingDir,route:planned.resolvedConfig,task:'Inspect the selected directory'}]};
      await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,items:[{...plan.items[0],workingDir:path.dirname(planned.workingDir)}]}})).rejects.toThrow('PERMISSION_DENIED');
      expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
      expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
      await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,concurrency:2}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
      await expect(call('setTeamPlan',{taskId:created.taskId,plan:{...plan,items:[{...plan.items[0],workingDir:created.workingDir}]}})).rejects.toThrow('TASK_BUSY');
      // Integration: plugin team commands share real Worker admission, final
      // completion receipts and Auto-review scope. The previous plan-only test
      // did not create/release a Worker or exercise revoked delegation.
      await expect(call('startTeam',{taskId:planned.taskId})).rejects.toThrow('PERMISSION_DENIED');
      const teamGrant=call('requestWriteAccess',{taskId:planned.taskId,mode:'auto'});
      await confirm(planned.taskId,'allow');expect(await teamGrant).toMatchObject({granted:true});
      await host.invoke('maker:input:stop',[planned.taskId]);
      expect(await call('startTeam',{taskId:planned.taskId})).toMatchObject({ok:true});
      expect(await call('getTeam',{taskId:planned.taskId})).toMatchObject({worker_count:0,capacity:{hardLimit:1,remainingSlots:1}});
      const workerArgs={leadSessionId:planned.taskId,role:'developer',label:'review',agent:planned.resolvedConfig.agentKind==='cc'?'claude-code' as const:planned.resolvedConfig.agentKind,
        model:planned.resolvedConfig.model,providerId:planned.resolvedConfig.providerId,effort:planned.resolvedConfig.effort||undefined,fast:planned.resolvedConfig.fastMode,workingDir:planned.workingDir};
      await expect(host.orcaLifecycle.createWorker({...workerArgs,label:'unplanned'})).rejects.toThrow('Worker is not pending');
      const workerResult=await host.orcaLifecycle.createWorker({...workerArgs,initialTask:'Inspect the selected directory'});
      if(!workerResult.ok)throw new Error(workerResult.message);
      const workerId=workerResult.workerId,workerSessionId=workerResult.workerSessionId;
      expect((await host.storage.get(workerSessionId))?.permissionMode).toBe('auto');
      const completedTeam=await vi.waitFor(async()=>{
        const team=await call('getTeam',{taskId:planned.taskId});
        expect(team.workers[0]?.completedAt).toEqual(expect.any(Number));return team;
      });
      expect(completedTeam.capacity).toMatchObject({hardLimit:1,occupiedSlots:1,remainingSlots:0});
      const reviewRequest:import('@cindy/maker-core').AutoReviewRequest={sessionId:workerSessionId,agentKind:workerArgs.agent,model:workerArgs.model,
        userIntent:'',workspaceRoots:[planned.workingDir],platform:process.platform,action:{kind:'exec',command:'pwd',cwd:planned.workingDir}};
      expect(await tasks.sessions.review(reviewRequest)).toMatchObject({delegatedTask:{role:'worker',task:plan.items[0].task}});
      await expect(call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt+1})).rejects.toThrow('STALE_REVISION');
      await plugins.setTaskPermission('_root__fixture-plugin','ask');
      const revokedReview=await tasks.sessions.review(reviewRequest);
      expect(revokedReview.authorizationError).toContain('no longer active');
      expect(revokedReview.delegatedTask).toBeUndefined();
      await plugins.setTaskPermission('_root__fixture-plugin','auto');
      expect(await call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt})).toMatchObject({ok:true,workerId});
      expect(await call('releaseWorker',{taskId:planned.taskId,workerId,completedAt:completedTeam.workers[0].completedAt})).toMatchObject({ok:true,workerId});
      expect((await host.storage.get(workerSessionId))?.archived).toBe(true);
      expect(await call('getTeam',{taskId:planned.taskId})).toMatchObject({worker_count:0,capacity:{remainingSlots:1}});
      await expect(host.orcaLifecycle.createWorker(workerArgs)).rejects.toThrow('Worker is not pending');
      await tasks.sessions.close();
      const reopened=new TerminalPluginSessions({root,host:plugins,tasks:host,guard:()=>{}});plugins.configureTaskSessions(reopened);
      try{
        await reopened.ready;
        expect(await call('getRun',{runId:run.runId})).toMatchObject({status:'completed'});
        expect(await call('setTeamPlan',{taskId:planned.taskId,plan})).toEqual({ok:true});
        await expect(call('setTeamPlan',{taskId:planned.taskId,plan:{...plan,concurrency:2}})).rejects.toThrow('IDEMPOTENCY_CONFLICT');
        await reopened.withUninstall('_root__fixture-plugin',async()=>{});
        expect((await host.invoke('terminal:tasks:list',[]) as Array<{id:string}>).some(row=>row.id===created.taskId)).toBe(true);
        await expect(call('get',{taskId:created.taskId})).rejects.toThrow('TASK_NOT_FOUND');
        await expect(call('create',{title:'Plugin-owned',requestKey:'create-1',hidden:true})).rejects.toThrow('TASK_NOT_FOUND');
      }finally{await reopened.close();lookup.mockRestore();}
      const task=await host.invoke('maker:create-session',[{title:'Plugin composition'}]) as {id:string};
      await host.invoke('maker:send',[task.id,{text:'plugin-ready'}]);
      const normalHistory=await host.invoke('local-db:messages:list',[task.id,{limit:10}]) as Array<{content:string}>;
      expect(normalHistory.map(item=>item.content)).toContain('Echo: plugin-ready');
    }finally{await companions.close();await host.close();await tasks.close();await market.close();await plugins.close();account.close();}
  },30_000);
  it('persists user/assistant history and resumes the original native task after a daemon restart', async () => {
    const { host, root, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{ title: 'Persistent task' }]) as { id: string };
    await host.invoke('maker:send', [task.id, { text: 'hello' }]);
    expect(native.sent[0]?.content).toBe(buildUiLanguageErrorNote('en') + '\n\nhello');
    await host.storage.flush();
    const history = await host.invoke('local-db:messages:list', [task.id, { limit: 10 }]) as Array<{ role: string; content: string }>;
    expect(history.map(m => [m.role, m.content])).toEqual([['assistant', 'Echo: hello'], ['user', 'hello']]);
    const disk = await readFile(path.join(root, 'models.json'), 'utf8');
    expect(disk).not.toContain('invalid-test-key-only');
    await host.close();
    const resumed = create();
    expect(await resumed.invoke('local-db:sessions:list', [100, 'active'])).toMatchObject([{ id: task.id, title: 'Persistent task', providerId: 'fixture' }]);
    expect(await resumed.invoke('maker:session-in-turn', [task.id])).toBe(false);
    await resumed.invoke('maker:send', [task.id, { text: 'again' }]);
    expect(native.starts.at(-1)?.resumeSessionId).toBe(native.starts[0].sessionId ? `native-${native.starts[0].sessionId}` : undefined);
    expect(native.starts.at(-1)?.providerId).toBe('fixture');
  });

  it('keeps disconnected approvals pending, rejects mismatched replies, and runs a second task', async () => {
    const { host, nextPush, native } = await setup();
    const a = await host.invoke('maker:create-session', [{ title: 'A' }]) as { id: string };
    const b = await host.invoke('maker:create-session', [{ title: 'B' }]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const running = host.invoke('maker:send', [a.id, { text: 'permission' }]);
    await requested;
    const requests = await host.invoke('maker:get-pending-interactions', [a.id]) as Array<{ request: { requestId: string } }>;
    expect(requests).toHaveLength(1);
    expect(host.sessionActivity.service.getSessionActivitySnapshot(a.id)).toMatchObject({ phase: 'needs-interaction', interactionKind: 'permission' });
    await expect(host.invoke('maker:resolve-interaction', [requests[0].request.requestId, { kind: 'ask_user_question', answers: {} }])).rejects.toThrow('INTERACTION_KIND_MISMATCH');
    await host.invoke('maker:send', [b.id, { text: 'independent' }]);
    expect(await host.invoke('maker:session-in-turn', [a.id])).toBe(true);
    expect(native.decisions).toEqual([]);
    await host.invoke('maker:resolve-interaction', [requests[0].request.requestId, { kind: 'permission', behavior: 'allow' }]);
    await running;
    expect(native.decisions).toEqual([{ kind: 'permission', behavior: 'allow' }]);
    expect(host.sessionActivity.service.getSessionActivitySnapshot(a.id)?.phase).not.toBe('needs-interaction');
    expect(await host.invoke('maker:get-pending-interactions', [a.id])).toEqual([]);
  });

  // Integration: the terminal's direct listener used to replace IM routing.
  // A real Maker permission now reaches both surfaces, retains source metadata,
  // and accepts exactly the first response through the public remote handler.
  it.each(['terminal','channel'] as const)('shares one permission decision when %s answers first',async winner=>{
    const {host,nextPush,native}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    let shared!:SharedPermission;
    const route=await host.beginChannelInteraction(task.id,{
      route:{sessionId:task.id,turnId:'channel-turn',origin:{kind:'im',channel:'telegram'},interactionSurface:'channel-card',sourceDescription:'Test group · original message'},
      handle:async(_request,permission)=>{shared=permission!;return permission!.result;},
    });
    try{
      const requested=nextPush('maker:interaction-request');
      const running=host.invoke('maker:send',[task.id,{text:'permission'}]);
      const event=await requested as {request:{requestId:string;description:string}};
      expect(event.request.description).toContain('Test group · original message');
      if(winner==='terminal')await host.invoke('maker:resolve-interaction',[event.request.requestId,{kind:'permission',behavior:'allow'}],{source:'remote',deviceId:'controller'});
      else expect(shared.decide({kind:'permission',behavior:'allow'})).toBe(true);
      expect(shared.decide({kind:'permission',behavior:'deny'})).toBe(false);
      await running;
      expect(native.decisions).toEqual([{kind:'permission',behavior:'allow'}]);
      expect(await shared.result).toEqual(native.decisions[0]);
      expect(await host.invoke('maker:get-pending-interactions',[task.id])).toEqual([]);
      await expect(host.invoke('maker:resolve-interaction',[event.request.requestId,{kind:'permission',behavior:'deny'}])).rejects.toThrow('INTERACTION_NOT_PENDING');
    }finally{route.release();}
  });

  // Cancellation must clear the public request even though the channel/router
  // correlates the original native request ID and the terminal publishes a UUID.
  it('retires both channel and terminal permissions when their turn lease ends',async()=>{
    const {host,nextPush,native}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    let shared!:SharedPermission;
    const route=await host.beginChannelInteraction(task.id,{route:{sessionId:task.id,turnId:'cancelled-channel-turn',origin:{kind:'im',channel:'feishu'},interactionSurface:'channel-card'},handle:async(_request,permission)=>{shared=permission!;return permission!.result;}});
    const requested=nextPush('maker:interaction-request'),running=host.invoke('maker:send',[task.id,{text:'permission'}]);
    await requested;route.release('turn_terminal');await running;
    expect(native.decisions).toMatchObject([{kind:'permission',behavior:'deny',reason:'turn_terminal'}]);
    expect(shared.decide({kind:'permission',behavior:'allow'})).toBe(false);
    expect(await host.invoke('maker:get-pending-interactions',[task.id])).toEqual([]);
  });

  it('protects local configuration and preserves prior settings on invalid route input', async () => {
    const { host } = await setup();
    await expect(host.invoke('terminal:models:reset-default', [], { source: 'remote', deviceId: 'fixture' })).rejects.toThrow('LOCAL_CONFIGURATION_REQUIRED');
    await expect(host.invoke('terminal:models:set-default', [{ agentKind: 'claude-code', providerId: 'fixture', model: 'missing' }])).rejects.toThrow('MODEL_ROUTE_UNAVAILABLE');
    expect(await host.invoke('terminal:models:get')).toMatchObject({ defaultSelection: { model: 'test-model' } });
  });

  // Behavior: a disk failure must not leave a more permissive live task behind
  // while GUI/IM settings still report the previous saved permission mode.
  it('rolls back the live permission when its durable update fails', async () => {
    const { host, native } = await setup();
    const task = await host.invoke('maker:create-session', [{ permissionMode: 'ask' }]) as { id: string };
    const update = vi.spyOn(host.storage, 'update').mockRejectedValueOnce(new Error('fixture disk failure'));
    try { await expect(host.invoke('maker:set-permission-mode', [task.id, 'auto'])).rejects.toThrow('fixture disk failure'); }
    finally { update.mockRestore(); }
    expect(native.permissionModes).toEqual(['auto', 'ask']);
    expect((await host.storage.get(task.id))!.permissionMode).toBe('ask');
    expect(host.channelRuntime().getSession(task.id)!.stablePermissionModeState?.mode).toBe('ask');
    expect(await host.invoke('maker:set-permission-mode', [task.id, 'acceptEdits'])).toEqual({ success: true });
    expect((await host.storage.get(task.id))!.permissionMode).toBe('acceptEdits');
  });

  // Behavior: a GUI title request must use the terminal owner's configured
  // route without creating another task; settings changes invalidate late text.
  it('generates titles on the auxiliary route and rejects a stale model result', async () => {
    const { host, native } = await setup();
    const auxiliary=await auxiliaryFixture(host, () => native.title.reply());
    try {
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    expect(await host.invoke('maker:generate-title', [{ message: 'Configure my server', sessionId: task.id, agentKind: 'claude-code' }])).toEqual({ title: 'Server task' });
    expect(auxiliary.requests[0].model).toBe('test-utility');
    expect(native.starts).toHaveLength(1);
    expect(await host.storage.list()).toHaveLength(1);
    let entered!: () => void, finish!: (text: string) => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    native.title.reply = () => { entered(); return new Promise<string>(resolve => { finish = resolve; }); };
    const pending = host.invoke('maker:generate-title', [{ message: 'A late reply', sessionId: task.id }]);
    await started;
    await host.invoke('terminal:models:reset-default');
    finish('Old model result');
    expect(await pending).toEqual({ title: null });
    } finally { await auxiliary.close(); }
  });

  // Behavior: attaching a channel after the native permission is already open
  // must retain one host decision, including cancellation of the old surface.
  it.each(['terminal', 'channel', 'close'] as const)('transfers an existing approval without duplicating its %s decision', async winner => {
    const { host, nextPush, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const running = host.invoke('maker:send', [task.id, { text: 'permission' }]);
    await requested;
    const [taken] = host.takeChannelInteractions(task.id);
    expect(taken.sharedPermission).toBeDefined();
    expect(host.takeChannelInteractions(task.id)).toEqual([]);
    expect(await host.invoke('maker:get-pending-interactions', [task.id])).toHaveLength(1);
    if (winner === 'terminal') await host.invoke('maker:resolve-interaction', [taken.requestId, { kind: 'permission', behavior: 'allow' }]);
    else if (winner === 'channel') taken.resolve({ kind: 'permission', behavior: 'allow' });
    else await host.invoke('maker:close-session', [task.id]);
    await running;
    expect(native.decisions).toHaveLength(1);
    expect(native.decisions[0]).toMatchObject({ kind: 'permission', behavior: winner === 'close' ? 'deny' : 'allow' });
    expect(await taken.sharedPermission!.result).toEqual(native.decisions[0]);
    expect(taken.sharedPermission!.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    expect(await host.invoke('maker:get-pending-interactions', [task.id])).toEqual([]);
  });

  // Behavior: the shared IM runner enriches a pre-persisted triggering message
  // after gathering group context. It must survive restart as one message and
  // cannot recreate a missing or cleared row, or touch another task's message.
  it('enriches the original channel message durably without copying its body', async () => {
    const { host, create } = await setup();
    const a = await host.invoke('maker:create-session', [{}]) as { id: string };
    const b = await host.invoke('maker:create-session', [{}]) as { id: string };
    const first = await host.persistChannelMessage({ sessionId: a.id, text: 'hello', source: { im: 'telegram', userText: 'hello' } });
    const source = { im: 'telegram', userText: 'hello', contextSnapshot: { groupContext: 'Relevant group context', groupMessageCount: 1 } };
    expect(await host.persistChannelMessage({ sessionId: a.id, text: 'must not replace', existingClientId: first!.clientId, source })).toEqual(first);
    expect(await host.persistChannelMessage({ sessionId: b.id, text: 'must not copy', existingClientId: first!.clientId, source })).toBeNull();
    await host.close();
    const restarted = create(); await restarted.ready;
    const rows = await restarted.invoke('local-db:messages:list', [a.id]) as Array<{ content: string; agentMeta: unknown }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ content: 'hello', agentMeta: { imSource: source } });
    const canonical = await (await restarted.conversations).messages.readMessagesList(a.id, {}, true);
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({ clientId: first!.clientId, content: 'hello', agentMeta: { imSource: source } });
    expect(await restarted.invoke('local-db:messages:list', [b.id])).toEqual([]);
    await restarted.storage.update(a.id, { clearedAt: Date.now() });
    // /clear preserves the original row for history, while the visible window stays empty.
    expect(await restarted.persistChannelMessage({ sessionId: a.id, text: 'must not recreate', existingClientId: first!.clientId, source })).toEqual(first);
    const stored = await (await restarted.storage.database()).getDbClient().query<{clientId:string}>(
      'SELECT client_id AS clientId FROM messages WHERE session_id = ?', [a.id]);
    expect(stored).toEqual([{clientId:first!.clientId}]);
    expect(await restarted.invoke('local-db:messages:list', [a.id])).toEqual([]);
  });

  // Behavior: channel output must upload managed bytes, not expose server paths.
  // Reading outside the task is rejected by the shared source policy; generated
  // bytes keep their original provenance when another message references them.
  it('delivers task images from the media ledger with scope and origin intact', async () => {
    const { host, root, create } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string; workDir: string };
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4sAAAAASUVORK5CYII=', 'base64');
    const image = path.join(task.workDir, 'output.png');
    const outside = path.join(root, 'outside.png');
    await writeFile(image, png); await writeFile(outside, png);
    const result = await host.materializeChannelImages({ sessionId: task.id, workingDir: task.workDir, text: `Done ![Result](${image})\n![Outside](${outside})` });
    expect(result.absPaths).toHaveLength(1);
    expect(result.absPaths[0]).toContain(`${path.sep}cindy-media${path.sep}blobs${path.sep}`);
    expect(await readFile(result.absPaths[0])).toEqual(png);
    expect(result.text).not.toContain(image);
    expect(result.text).not.toContain(outside);
    const url = `cindy-media://blobs/${path.basename(result.absPaths[0])}`;
    expect((await host.media.preparePluginAttachment(url, task.id, () => {})).originKind).toBe('tool');
    await host.persistChannelMessage({ sessionId: task.id, text: 'Use this', attachments: [{ kind: 'image', absPath: image, originalName: 'output.png', mimeType: 'image/png', url }] });
    const canonical = await (await host.conversations).messages.readMessagesList(task.id, {}, true);
    expect(canonical[0]?.content).toMatchObject({ text: 'Use this', images: [{ url }] });
    // A message reference does not rewrite an existing blob's birth provenance.
    expect((await host.media.preparePluginAttachment(url, task.id, () => {})).originKind).toBe('tool');
    await host.close();
    const restarted = create(); await restarted.ready;
    expect(await realpath((await restarted.media.resolveManaged(url, task.id)).path)).toBe(result.absPaths[0]);
    await expect(restarted.media.resolveManaged(url, 'another-task')).rejects.toThrow('MEDIA_SESSION_ACCESS_DENIED');
  });

  it('durably deduplicates asynchronous submissions while an approval remains answerable', async () => {
    const { host, nextPush, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const requested = nextPush('maker:interaction-request');
    const accepted = await host.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }]);
    expect(accepted).toMatchObject({ accepted: true, requestId: 'unique-request' });
    await requested;
    expect(host.isBusy()).toBe(true);
    expect(await host.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }])).toMatchObject({ accepted: true });
    await expect(host.invoke('maker:send', [task.id, { text: 'other', clientId: 'unique-request' }])).rejects.toThrow('IDEMPOTENCY_KEY_REUSED');
    const waiting = await host.invoke('terminal:tasks:turn-status', [task.id, 'unique-request']) as { status: string; pendingRequests: Array<{ requestId: string }> };
    expect(waiting.status).toBe('waiting');
    const completion = host.invoke('terminal:tasks:wait', [task.id, 'unique-request']);
    await host.invoke('maker:resolve-interaction', [waiting.pendingRequests[0].requestId, { kind: 'permission', behavior: 'allow' }]);
    expect(await completion).toMatchObject({ status: 'completed', finalText: 'Echo: permission' });
    await host.close();
    const resumed = create();
    expect(await resumed.invoke('maker:send', [task.id, { text: 'permission', clientId: 'unique-request' }])).toMatchObject({ status: 'completed' });
    expect(native.starts).toHaveLength(1);
  });

  it('runs the existing Cindy helper over an authenticated task-bound MCP bridge', async () => {
    const { host, native } = await setup();
    // Host authorization may carry a per-turn scope. A bridge that keeps only
    // `ok` silently drops that authority, including its revocation check.
    const helper = host.helperDeps.bind(host); let authorityActive = false, authorized = true;
    vi.spyOn(host, 'helperDeps').mockImplementation(input => {
      const deps = helper(input);
      return { ...deps, authorizeCall: async () => ({ ok: true, run: async operation => {
        if (!authorized) throw new Error('TURN_AUTHORITY_REVOKED');
        authorityActive = true; try { return await operation(); } finally { authorityActive = false; }
      } }), setCurrentSessionTitle: async value => {
        if (!authorityActive) throw new Error('HOST_AUTHORITY_CONTEXT_MISSING');
        return deps.setCurrentSessionTitle!(value);
      } };
    });
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const tools = native.inputs[0].tools!;
    const config = tools.providers[0].toCodexMcpConfig!({ agentKind: 'codex', workingDir: '/', sessionId: task.id })!;
    const headers = { authorization: `Bearer ${tools.env[config.bearerTokenEnvVar!]}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const init = await fetch(config.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'terminal-test', version: '1' } } }) });
    expect(init.status).toBe(200);
    await init.text();
    const sessionId = init.headers.get('mcp-session-id')!;
    const unauthorized = await fetch(config.url, { method: 'POST', headers: { ...headers, authorization: 'Bearer wrong' }, body: '{}' });
    expect(unauthorized.status).toBe(401);
    const unbound = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Must not rename' } } } }) });
    expect(await unbound.text()).toContain('NO_SESSION_CONTEXT');
    tools.registerCodexMcpThreadContext({ threadId: 'real-thread', sessionId: task.id, sessionInstanceId: native.starts[0].sessionInstanceId, workingDir: native.starts[0].workingDir, vendorOptions: {}, mcpCallerKind: 'root', mcpCallerAttested: true });
    const call = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Renamed by actual MCP' } }, _meta: { threadId: 'real-thread' } } }) });
    const payload = await call.text();
    expect(payload).toContain('Renamed by actual MCP');
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({ title: 'Renamed by actual MCP' });
    const capabilities = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'get_capabilities', args: { scope: 'runtime' } }, _meta: { threadId: 'real-thread' } } }) });
    const catalog = await capabilities.text();
    expect(catalog).toContain('cindy_helper');
    expect(catalog).toContain('registered');
    expect(catalog).toContain('hostCapabilities');
    expect(catalog).not.toContain('CALLER_UNAVAILABLE');
    authorized = false;
    const revoked = await fetch(config.url, { method: 'POST', headers: { ...headers, 'mcp-session-id': sessionId }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'call_tool', arguments: { name: 'set_current_session_title', args: { title: 'Revoked rename' } }, _meta: { threadId: 'real-thread' } } }) });
    await revoked.text();
    expect(await host.storage.get(task.id)).toMatchObject({ title: 'Renamed by actual MCP' });
  });

  // The original SQLite transcript is authoritative after restart. A partial
  // old terminal journal must neither truncate it nor duplicate the next input.
  it('preserves the original transcript when a legacy journal has an incomplete append', async () => {
    const { host, root, create, native } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    await host.invoke('maker:send', [task.id, 'hello']);
    await host.close();
    await appendFile(path.join(root, 'tasks', task.id, 'events.jsonl'), '{"sequence":');
    const restarted = create(); await restarted.ready;
    const before = await restarted.invoke('local-db:messages:list', [task.id]) as Array<{role: string; content: string}>;
    expect(before.map(row => [row.role, row.content])).toEqual([['assistant', 'Echo: hello'], ['user', 'hello']]);
    await restarted.invoke('maker:send', [task.id, 'after crash']);
    const after = await restarted.invoke('local-db:messages:list', [task.id]) as Array<{role: string; content: string}>;
    expect(after.filter(row => row.role === 'user').map(row => row.content)).toEqual(['after crash', 'hello']);
    expect(native.sent).toHaveLength(2);
  });
  it('serves released remote history cursors and enforces shared task author and scope', async () => {
    const { host } = await setup();
    const task = await host.invoke('maker:create-session', [{}]) as { id: string };
    const other = await host.invoke('maker:create-session', [{}]) as { id: string };
    const context = { source: 'remote' as const, deviceId: 'peer', ownerId: 'owner', assertCurrent() {}, sharedTask: { sharedTaskId: 'share', sessionId: task.id, memberId: 'member', accountId: 'account', name: 'Member' } };
    await expect(host.invoke('maker:set-model', [task.id, 'test-model'], context)).rejects.toThrow('SHARED_TASK_PERMISSION_DENIED');
    await expect(host.invoke('maker:send', [other.id, 'wrong'], context)).rejects.toThrow('SHARED_TASK_SCOPE_MISMATCH');
    await host.invoke('maker:send', [task.id, { text: 'shared message' }], context);
    await host.storage.flush();
    const historyArgs = { sessionId: task.id, workdir: null, fromMs: null, toMs: null, agentKind: null, roles: ['user', 'assistant'], includeRewound: false, limit: 1, cursor: null, order: 'asc', contentCharLimit: null };
    const first = await host.invoke('local-db:history:messages', [historyArgs], context) as { items: Array<{ role: string; agentMeta: unknown }>; nextCursor: unknown; hasMore: boolean };
    expect(first.items[0]).toMatchObject({ role: 'user', agentMeta: { sharedTaskAuthor: { memberId: 'member', accountId: 'account', displayName: 'Member' } } });
    expect(first.hasMore).toBe(true);
    const second = await host.invoke('local-db:history:messages', [{ ...historyArgs, cursor: first.nextCursor }], context) as { items: Array<{ role: string }> };
    expect(second.items.map(item => item.role)).toEqual(['assistant']);
    expect(await host.invoke('local-db:history:query', [{ tool: 'list_sessions', args: { limit: 10 } }], { source: 'remote', assertCurrent() {} })).toMatchObject({ ok: true });
    expect(await host.invoke('local-db:history:query', [{tool:'search_chat_history',args:{query:'shared message',limit:10}}])).toMatchObject({ok:true});
  });

  it('keeps custom headers in the vault and injects upstream credentials only behind the task proxy', async () => {
    const { host, root, vault } = await setup();
    let received: { path?: string; headers?: import('node:http').IncomingHttpHeaders; body?: Record<string, unknown> } = {};
    const server = createServer((req, res) => {
      let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
        received = { path: req.url, headers: req.headers, body: JSON.parse(body) };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'chat-fixture', object: 'chat.completion', created: 1, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'proxy result' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    let proxy: Awaited<ReturnType<typeof createProviderProxy>> | undefined;
    let claudeProxy: Awaited<ReturnType<typeof createProviderProxy>> | undefined;
    try {
      await host.invoke('maker:provider:custom:create', [{ id: 'chatfixture', name: 'Chat', runtimes: { codex: { baseUrl: `http://127.0.0.1:${addr.port}`, wireProtocol: 'openai-chat', headers: { 'X-Private': 'secret-header-value' }, models: [{ id: 'test-model', name: 'Test' }] } } }, { codex: 'secret-key-value' }]);
      expect(await readFile(path.join(root, 'models.json'), 'utf8')).not.toMatch(/secret-header-value|secret-key-value/);
      expect([...vault.values()]).toContain('{"x-private":"secret-header-value"}');
      const { route } = await host.models.select({ agentKind: 'codex', providerId: 'chatfixture', model: 'test-model' });
      proxy = await createProviderProxy(route, 'codex', await host.models.credential('chatfixture', 'codex'), await host.models.headers('chatfixture', 'codex'));
      const body = JSON.stringify({ model: 'test-model', input: 'hello', stream: false });
      expect((await fetch(`${proxy.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' }, body })).status).toBe(403);
      const response = await fetch(`${proxy.url}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${proxy.token}` }, body });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('proxy result');
      expect(received.path).toBe('/chat/completions');
      expect(received.headers).toMatchObject({ authorization: 'Bearer secret-key-value', 'x-private': 'secret-header-value' });
      expect(received.body).toMatchObject({ messages: [{ role: 'user', content: 'hello' }] });
      // Claude's Messages protocol omits non-Anthropic effort. The host must
      // carry live preferences through both bridge layers into the Chat API.
      await host.invoke('maker:provider:custom:create', [{ id:'claudechat',name:'Claude Chat',runtimes:{'claude-code':{baseUrl:`http://127.0.0.1:${addr.port}`,wireProtocol:'openai-chat',models:[{id:'test-model',name:'Test',reasoning:true,reasoningEfforts:['low','high'],reasoningDefaultEffort:'high'}]}}},{'claude-code':'private-claude-key'}]);
      const claudeRoute=(await host.models.select({agentKind:'claude-code',providerId:'claudechat',model:'test-model'})).route;
      let effort='low';
      claudeProxy=await createProviderProxy(claudeRoute,'claude-code','private-claude-key',{},undefined,undefined,undefined,()=>({reasoningEffort:effort}));
      for(const selected of ['low','high']){
        effort=selected;
        const reply=await fetch(`${claudeProxy.url}/v1/messages`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${claudeProxy.token}`},body:JSON.stringify({model:'test-model',max_tokens:128,stream:false,messages:[{role:'user',content:'hello'}]})});
        expect(reply.status).toBe(200);await reply.text();
        expect(received.body?.reasoning_effort).toBe(selected);
        expect(received.headers?.authorization).toBe('Bearer private-claude-key');
      }
      expect(await host.invoke('maker:provider:test-connection',[{kind:'saved',providerId:'chatfixture',agent:'codex'}])).toMatchObject({ok:true});
      await host.invoke('maker:model-disable:set',[{kind:'model',providerId:'chatfixture',modelIds:['test-model'],disabled:true}]);
      await expect(host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).rejects.toThrow('MODEL_ROUTE_UNAVAILABLE');
      await host.invoke('maker:model-disable:set',[{kind:'reset',providerId:'chatfixture'}]);
      expect((await host.models.select({agentKind:'codex',providerId:'chatfixture',model:'test-model'})).selection.model).toBe('test-model');

    } finally { await proxy?.close(); await claudeProxy?.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('accepts the production queue client and restores original SQLite queue ownership with attachments', async () => {
    const {host,create,root,native,pushes}=await setup();
    const task=await host.invoke('maker:create-session',[{}]) as {id:string};
    const client={invoke:(channel:string,args:unknown[]=[])=>host.invoke(channel,args)} as TerminalClient;
    await enqueueMessage(client,task.id,'from CLI','cli_input');
    expect(await waitForTurn(client,task.id,'cli_input')).toMatchObject({status:'completed',finalText:'Echo: from CLI'});
    // Mobile outbox settles through around-client-id and uses created events to
    // separate turns. Missing either makes an executed send appear unsent.
    expect(await host.invoke('local-db:messages:around-client-id',[task.id,'cli_input',{radius:1}])).toMatchObject([{role:'user',clientId:'cli_input'},{role:'assistant',content:'Echo: from CLI'}]);
    expect(pushes.some(push=>push.channel==='local-db:messages:created'&&(push.payload as {message?:{clientId:string}}).message?.clientId==='cli_input')).toBe(true);
    const view=await host.invoke('local-db:messages:view',[task.id,{lazyDetails:true}]);
    expect(JSON.stringify(view)).toContain('Echo: from CLI');
    await host.invoke('maker:input:set-interaction-lock',[task.id,'composer-edit',true]);
    const attachment = path.join(root, 'note.txt');
    await writeFile(attachment, 'frozen attachment');
    const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4sAAAAASUVORK5CYII=';
    const imagePath=path.join(root,'pixel.png');await writeFile(imagePath,Buffer.from(png,'base64'));
    await enqueueMessage(client,task.id,'Read these','delayed_input',undefined,{files:[{name:'note.txt',path:attachment},{name:'pixel.png',path:imagePath}]});
    const pending=(await (await host['database']).inputQueue.loadAgentInputQueueSnapshot(task.id))[0];
    const file=pending.files!.find(file=>file.name==='note.txt')!;
    expect(await readFile(file.path,'utf8')).toBe('frozen attachment');
    const image=pending.files!.find(file=>file.name==='pixel.png')!;
    expect(image.url).toMatch(/^cindy-media:/);
    expect((await host.resolveManaged(image.url!,task.id)).path).toBe(image.path);
    await expect(host.resolveManaged(image.url!,'unrelated')).rejects.toThrow('MEDIA_SESSION_ACCESS_DENIED');
    const helper = host.helperDeps({sessionId:task.id,workingDir:root,agentKind:'claude-code'});
    expect(await helper.sessionQueue!.listSessionQueue(task.id)).toMatchObject({ok:true,messages:[{queuedMessageId:'delayed_input',content:'Read these',consuming:false}]});
    expect(await helper.sessionQueue!.listSessionQueuedCounts([task.id])).toEqual({ok:true,counts:{[task.id]:1}});
    await host.close();const restored=create();
    await restored.ready;
    // Inspect the cold SQLite queue before any public projection restores it.
    const cold = restored.helperDeps({sessionId:task.id,workingDir:root,agentKind:'claude-code'});
    expect(await cold.sessionQueue!.listSessionQueuedCounts([task.id])).toEqual({ok:true,counts:{[task.id]:1}});
    expect(await cold.sessionQueue!.listSessionQueue(task.id)).toMatchObject({ok:true,messages:[{queuedMessageId:'delayed_input'}]});
    const projection=await restored.invoke('maker:input:get-projection',[task.id]) as {pendingQueue:Array<{clientId:string;sendAtMs:number}>};
    expect(projection.pendingQueue).toMatchObject([{clientId:'delayed_input'}]);
    expect(native.sent).toHaveLength(1);
    const snapshots = await (await restored['database']).inputQueue.loadAgentInputQueueSnapshot(task.id);
    expect(snapshots.map(row=>row.clientId)).toEqual(['delayed_input']);
    expect(JSON.stringify(snapshots)).not.toContain(png);
    expect(await restored.invoke('maker:input:get-projection',[task.id,{deliveryClientIds:['delayed_input','missing']}])).toMatchObject({inputDeliveryVersion:1,queuePaused:true,deliveryReceipts:[{clientId:'delayed_input',state:'pending'},{clientId:'missing',state:'unknown'}]});
    await restored.invoke('maker:input:set-interaction-lock',[task.id,'composer-edit',true]);
    await enqueueMessage({invoke:(channel:string,args:unknown[]=[])=>restored.invoke(channel,args)} as TerminalClient,task.id,'second','second_queued');
    await restored.invoke('maker:input:move',[task.id,'second_queued',0]);
    await restored.close();const ordered=create();
    expect(await ordered.invoke('maker:input:get-projection',[task.id])).toMatchObject({pendingQueue:[{clientId:'second_queued'},{clientId:'delayed_input'}]});
    await ordered.invoke('maker:input:remove',[task.id,'delayed_input',{durableDelivery:true}]);
    expect(await ordered.invoke('maker:input:get-projection',[task.id,{deliveryClientIds:['delayed_input']}])).toMatchObject({deliveryReceipts:[{state:'removed'}]});
    const latest=await ordered.invoke('local-db:messages:list',[task.id,{limit:1}]) as Array<{id:string;role:string}>;
    const previous=await ordered.invoke('local-db:messages:list',[task.id,{limit:1,before:latest[0].id}]) as Array<{id:string;role:string}>;
    expect(latest[0].role).toBe('assistant');expect(previous[0].role).toBe('user');

  });

  // Integration: released queue IPC must preserve structured references and
  // attachments through a real native steer, reject stale clear tokens, and
  // deduplicate a controller resend against the original SQLite user row.
  it('uses the original rich steer transaction and durable remote deduplication', async () => {
    const { host, native, root, nextPush } = await setup();
    const client = { invoke: (channel: string, args: unknown[] = []) => host.invoke(channel, args) } as TerminalClient;
    const source = await host.invoke('maker:create-session', [{title:'Reference source'}]) as {id:string};
    const task = await host.invoke('maker:create-session', [{title:'Receiving task'}]) as {id:string};
    const conversations = await host.conversations;
    await conversations.messages.createMessage(source.id, {clientId:'reference-body',role:'user',content:'Authoritative reference text'});
    await enqueueMessage(client,task.id,'wait-for-steer','rich-owner-turn');
    await native.waitForHeld(task.id);
    const imagePath = path.join(root,'steer.png');
    await writeFile(imagePath,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ4sAAAAASUVORK5CYII=','base64'));
    let item!: import('@cindy/maker-shared/agent-input-queue').AgentInputQueuedMessage;
    const capture = { invoke: (channel: string, args: unknown[] = []) => {
      if (channel === 'maker:input:enqueue') { item = args[1] as typeof item; return Promise.resolve({}); }
      return host.invoke(channel,args);
    } } as TerminalClient;
    await enqueueMessage(capture,task.id,'Use this reference and image','rich-steer',undefined,{files:[{path:imagePath,name:'steer.png'}]});
    item.sessionRefs=[{sessionId:source.id}];
    item.trustedSessionReferenceContexts=[{sessionId:source.id,source:'local',range:'recent',messageCount:1,truncated:false,messages:[{role:'user',content:'Forged local reference text'}]}];
    item.sourceDevice={deviceId:'forged-phone',name:'Forged phone',platform:'mobile'};
    item.fromMobileClient=true;
    expect(await host.invoke('maker:input:steer',[task.id,item,{expectedClearBoundaryMs:null}])).toBe(true);
    expect(native.steered).toHaveLength(1);
    const sent = JSON.stringify(native.steered[0]);
    expect(sent).toContain('Authoritative reference text');
    expect(sent).not.toContain('Forged local reference text');
    expect(sent).not.toContain('Forged phone');
    expect(sent).toContain('cindy-media');
    const remote={source:'remote' as const,deviceId:'controller',ownerId:'owner',assertCurrent(){},sourceDevice:{deviceId:'controller',platform:'desktop' as const}};
    const retry={...item,sessionRefs:[],trustedSessionReferenceContexts:undefined};
    expect(await host.invoke('maker:input:steer',[task.id,retry,{expectedClearBoundaryMs:null}],remote)).toBe(true);
    expect(native.steered).toHaveLength(1);
    await expect(host.invoke('maker:input:steer',[task.id,{...retry,clientId:'stale-steer'},{expectedClearBoundaryMs:1}],remote)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(host.invoke('maker:input:stop',[task.id,{expectedClearBoundaryMs:1}],remote)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(host.invoke('maker:input:resume',[task.id,{expectedClearBoundaryMs:1}],remote)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
    await expect(host.invoke('maker:input:steer',[task.id,{...retry,clientId:'unresolved-reference',sessionRefs:[{sessionId:source.id}]},{}],remote)).rejects.toMatchObject({code:'SESSION_REFERENCE_UNAVAILABLE'});
    expect(native.steered).toHaveLength(1);
    const done=nextPush('maker:event',payload=>{const value=payload as {sessionId:string;event:{type:string}};return value.sessionId===task.id&&value.event.type==='done';});
    native.finishHeld(task.id);await done;
    expect(await host.invoke('maker:input:get-projection',[task.id,{deliveryClientIds:['rich-steer']}],remote)).toMatchObject({deliveryReceipts:[{clientId:'rich-steer',state:'accepted'}]});
  });

  // Integration: a headless completion uses the actual persisted answer and
  // durable turn identity; replay and input handoff must not leak other text.
  it('notifies from the original persisted reply and keeps handoff text private', async () => {
    const f = await setup();
    const im = new TerminalImConnections({ tasks: f.host, root: f.root, logger, assertCurrent() {}, emit() {}, secrets: {
      getSync: key => f.vault.get(key) ?? null, setSync: (key, value) => { f.vault.set(key, value); }, deleteSync: key => { f.vault.delete(key); }, available: () => true,
    } });
    let current = true, generation = 1;
    const sent = vi.fn((_payload: { sessionId: string; kind: string; detail?: string; eventId?: string }) => true);
    const notifications = await createTerminalTaskNotifications({ tasks: f.host, im, logger,
      remote: { getNotificationGeneration: () => generation, notifications: { sendMobileSessionNotify: sent, sendMobileBotGroupNotify: () => false } },
      current: () => current, t: key => key, emit() {},
    });
    try {
      const task = await f.host.invoke('maker:create-session', [{ title: 'Notification task' }]) as { id: string };
      const done = f.nextPush('maker:event', value => (value as {event?: AgentEvent}).event?.type === 'done');
      await enqueueMessage({ invoke: (channel: string, args: unknown[] = []) => f.host.invoke(channel, args) } as TerminalClient, task.id, 'real persisted reply', 'notification-input');
      const event = await done;
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      notifications.event('maker:event', event);
      notifications.event('maker:event', event);
      await vi.advanceTimersByTimeAsync(500);
      vi.useRealTimers();
      await vi.waitFor(() => expect(sent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: task.id, kind: 'done', detail: 'Echo: real persisted reply', eventId: expect.stringMatching(/^turn:/) })), { interval: 1 });
      await notifications.notify(task.id, 'done');
      expect(sent).toHaveBeenCalledTimes(1);
      notifications.event('maker:interaction-request', { sessionId: task.id, request: { kind: 'input_handoff', requestId: 'handoff', stepNumber: 1, purpose: 'private purpose', value: 'secret-never-forward' } });
      await vi.waitFor(() => expect(sent).toHaveBeenCalledTimes(2), { interval: 1 });
      expect(sent.mock.calls[1][0]).toMatchObject({ kind: 'needs-reply', eventId: 'input-handoff:handoff:1', fallbackBody: 'settings.notifications.sessionEvent.inputHandoff' });
      expect(JSON.stringify(sent.mock.calls)).not.toMatch(/private purpose|secret-never-forward/);
      const activity = f.pushes.filter(push => push.channel === SESSION_ACTIVITY_CHANNEL)
        .map(push => push.payload as SessionActivityPayload).filter(value => value.sessionId === task.id);
      expect(activity).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'running' }), expect.objectContaining({ phase: 'completed', attention: true, compactDetail: 'Echo: real persisted reply' })]));
      const completed = activity.at(-1)!;
      expect(completed.completionToken).toEqual(expect.any(String));
      const replayed: SessionActivityPayload[] = [];
      f.host.sessionActivity.service.replaySessionActivity(value => replayed.push(value));
      expect(replayed).toContainEqual(expect.objectContaining({ sessionId: task.id, completionToken: completed.completionToken, attention: true }));
      expect(await f.host.invoke('agent-island:completion-action', [task.id, 'archive', 'stale-completion'], { source: 'remote' })).toBe(false);
      expect((await f.host.storage.get(task.id))?.archived).toBeFalsy();
      expect(await f.host.invoke('agent-island:completion-action', [task.id, 'mark-read', completed.completionToken], { source: 'remote' })).toBe(true);
      replayed.length = 0;
      f.host.sessionActivity.service.replaySessionActivity(value => replayed.push(value));
      expect(replayed).toContainEqual(expect.objectContaining({ sessionId: task.id, attention: false }));
      current = false; generation++;
      await notifications.notify(task.id, 'error');
      expect(sent).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); notifications.close(); await im.close(); }
  });

  // Integration: configured notification resources must feed the real
  // scheduler completion, preserve the originating task and redact the URL.
  it('delivers scheduled results through Feishu and the configured WeCom group', async () => {
    const { host, root, vault } = await setup(), webhooks: string[] = [], notices: unknown[] = [];
    const connections = new TerminalImConnections({ tasks: host, root, logger, assertCurrent() {}, emit: (channel, payload) => { if (channel === 'terminal:notification') notices.push(payload); }, secrets: {
      getSync: key => vault.get(key) ?? null, setSync: (key, value) => { vault.set(key, value); }, deleteSync: key => { vault.delete(key); }, available: () => true,
    } }, { wecomGroupFetch: async (_url, init) => { webhooks.push(String(init?.body)); return new Response('{"errcode":0}', { headers: { 'content-type': 'application/json' } }); } });
    const spies = [vi.spyOn(connections.feishu, 'getStatus').mockReturnValue({ kind: 'connected', appId: 'cli_schedule' }),
      vi.spyOn(connections.feishu, 'getOwnerOpenId').mockReturnValue('ou_owner'),
      vi.spyOn(connections.feishu, 'sendNotification').mockResolvedValue({ messageId: 'om_schedule', chatId: 'oc_owner' })];
    const configuration = new TerminalConfiguration(host.capabilities, undefined, { revision: () => connections.version(), save: (id, input) => connections.saveConfiguration(id, input) });
    const registry = new RemoteResourceRegistry(); registerImResources(registry, connections, host, configuration);
    const ref = { collectionId: 'channels', kind: 'im-channel', id: 'wecom-group' }, context = { controllerDeviceId: 'terminal' }, client = { protocolVersion: 1, primitives: ['text', 'form', 'actions'], locale: 'en' };
    const scheduler = new TerminalSchedulerHost({ profileDir: root, tasks: host, logger, emit() {}, notify: (schedule, run) => connections.notify(schedule, run) }); schedulers.push(scheduler);
    try {
      await connections.start();
      const webhookUrl = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=synthetic-test-webhook-key';
      await configuration.save({ collectionId: 'channels', resourceId: ref.id, actionId: 'edit' }, { webhookUrl, testMessage: 'configured group test' }, { source: 'local' });
      const resource = await registry.get(context, { ref, client });
      expect(JSON.stringify(resource)).not.toContain(webhookUrl);
      expect(resource.actions?.find(action => action.id === 'edit')?.fields?.[0].kind).toBe('secret');
      expect(webhooks).toHaveLength(1);
      const scheduled = await scheduler.invoke('maker:schedule:create', [{ name: 'Channel completion', prompt: 'scheduled notification fixture', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: true,
        agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', workspaceKind: 'dialogue', useWorktree: false, persistentSession: true, notify: { desktop: true, feishu: true, wecomGroup: true } }]) as { id: string };
      await scheduler.invoke('maker:schedule:run-now', [scheduled.id]);
      await vi.waitFor(() => expect(webhooks).toHaveLength(2));
      expect(webhooks[1]).toContain('scheduled notification fixture'); expect(notices).toHaveLength(1);
      expect(connections.feishu.sendNotification).toHaveBeenCalledWith('ou_owner', expect.stringContaining('scheduled notification fixture'));
      const [run] = await scheduler.invoke('maker:schedule:list-runs', [scheduled.id]) as Array<{ sessionId: string }>;
      expect(await connections.notifications.resolveFeishuNotificationReply(connections.feishu, { senderId: 'ou_owner', contextId: 'cli_schedule', chatId: 'oc_owner', replyThread: { rootMessageId: 'om_schedule', threadId: 'omt_schedule' } } as IMMessageEvent)).toBe(run.sessionId);
      await registry.invoke(context, { client, collectionId: 'channels', resourceRef: ref, actionId: 'enabled', input: { enabled: false } });
      expect(connections.wecomGroup.getState().enabled).toBe(false);
      await expect(connections.wecomGroup.publishMarkdown('disabled notification')).rejects.toThrow('WECOM_GROUP_NOTIFICATIONS_DISABLED');
      expect(webhooks).toHaveLength(2);
    } finally { await scheduler.close(); await connections.close(); configuration.close(); for (const spy of spies) spy.mockRestore(); }
  });
  // Integration: native script I/O must use the original capability catalog,
  // reject host-owned overrides, and dispatch with saved model choices.
  it('dispatches native script calls through the original capability broker', async () => {
    const { host, root } = await setup();
    const file = path.join(root, 'script-broker.cjs');
    await writeFile(file, `
const { createInterface } = require('node:readline');
const send = value => process.stdout.write(JSON.stringify({protocol:'cindy-script/1', ...value})+'\\n');
let catalog;
createInterface({input:process.stdin}).on('line', line => {
  const frame = JSON.parse(line);
  if (frame.type === 'start') send({type:'call',id:'catalog',method:'host.capabilities',params:{}});
  if (frame.id === 'catalog') {
    catalog=frame.result;
    send({type:'call',id:'denied',method:'sessions.dispatch',params:{message:'must not send',model:'unauthorized-model'}});
  }
  if (frame.id === 'denied') {
    if (frame.ok || frame.error.code !== 'INVALID_ARGS') process.exit(3);
    send({type:'call',id:'dispatch',method:'sessions.dispatch',params:{message:'script dispatch fixture',title:'Script child'}});
  }
  if (frame.id === 'dispatch') {
    if (!frame.ok) { send({type:'complete',resultText:JSON.stringify(frame)}); process.exit(4); }
    send({type:'complete',primarySessionId:frame.result.target_session_id,resultText:JSON.stringify({catalog,dispatch:frame.result})});
    process.stdin.destroy();
  }
});
`);
    const scheduler = new TerminalSchedulerHost({ profileDir: root, tasks: host, logger, emit() {} }); schedulers.push(scheduler);
    const created = await scheduler.invoke('maker:schedule:create', [{ name: 'Script broker', prompt: '', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: true,
      agentKind: 'claude-code', providerId: 'fixture', model: 'test-model', effort: 'high', workspaceKind: 'project', workingDir: root,
      executionMode: 'script', scriptConfig: { command: `"${process.execPath}" "${file}"`, capabilities: ['sessions.dispatch'] },
      useWorktree: false, persistentSession: false, notify: { desktop: false, feishu: false } }]) as { id: string };
    await scheduler.invoke('maker:schedule:run-now', [created.id]);
    const runs = await scheduler.invoke('maker:schedule:list-runs', [created.id]) as Array<{ status: string; resultText: string; sessionId: string }>;
    expect(runs[0]).toMatchObject({ status: 'success' });
    const result = JSON.parse(runs[0].resultText);
    expect(result.catalog).toMatchObject({ protocol: 'cindy-script/1', granted: ['sessions.dispatch'], methods: expect.arrayContaining([
      expect.objectContaining({ method: 'sessions.dispatch', available: true }), expect.objectContaining({ method: 'jira.get', available: false }),
    ]) });
    expect(await host.storage.get(result.dispatch.target_session_id)).toMatchObject({ model: 'test-model', providerId: 'fixture', permissionMode: 'bypassPermissions' });
    expect(await scheduler.invoke('maker:schedule:script-capability-status')).toMatchObject({ statuses: expect.arrayContaining([
      { capability: 'sessions.dispatch', state: 'ok' }, { capability: 'jira.read', state: 'ghost-missing', ghostName: 'xd-atlassian' },
    ]) });
  });

  // Integration: the old Node prompt runner skipped the original busy queue and
  // lost the owner's model preference. Real SQLite/public schedule and GUI input
  // APIs drive Maker; only the native process transport is replaced.
  it('keeps original scheduled queue cancellation and restores owner model preferences after restart', async () => {
    const f = await setup();
    const { host, root, native } = f;
    const task = await host.invoke('maker:create-session', [{ workingDir: root, model: 'test-model', providerId: 'fixture', agentKind: 'claude-code' }]) as { id: string };
    const scheduler = new TerminalSchedulerHost({ profileDir: root, tasks: host, logger, emit() {} }); schedulers.push(scheduler);
    const base = { name: 'Original queue', prompt: 'queued schedule message', kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', manual: true,
      recurring: true, agentKind: 'claude-code', targetSessionId: task.id, persistentSession: true, notify: { desktop: false, feishu: false } };
    const schedule = await scheduler.invoke('maker:schedule:create', [base]) as { id: string };
    await host.invoke('maker:send', [task.id, 'wait-for-steer']); await native.waitForHeld(task.id);
    const queued = f.nextPush('maker:input:projection', payload => JSON.stringify(payload).includes('queued schedule message'));
    const cancelled = scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    await queued;
    await scheduler.invoke('maker:schedule:pause', [schedule.id]); await cancelled;
    expect(native.sentFor(task.id)).toHaveLength(1);
    expect(JSON.stringify(await host.invoke('maker:input:get-projection', [task.id]))).not.toContain('queued schedule message');
    native.finishHeld(task.id);
    await vi.waitFor(() => expect(host.isTurnRunning(task.id)).toBe(false));
    await scheduler.invoke('maker:schedule:resume', [schedule.id]);
    await host.invoke('maker:send', [task.id, 'wait-for-steer']); await native.waitForHeld(task.id);
    const secondQueued = f.nextPush('maker:input:projection', payload => JSON.stringify(payload).includes('queued schedule message'));
    const delivered = scheduler.invoke('maker:schedule:run-now', [schedule.id]); await secondQueued;
    native.finishHeld(task.id); await delivered;
    expect(native.sentFor(task.id).filter(message => JSON.stringify(message.content).includes('queued schedule message'))).toHaveLength(1);
    expect((await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{status:string}>)[0].status).toBe('success');
    await host.models.saveProvider({ id: 'other-fixture', name: 'Other', auth: { method: 'none' }, runtimes: { 'claude-code': { baseUrl: 'http://127.0.0.1:1', models: [{ id: 'scheduled-model', name: 'Scheduled', contextWindow: 200000 }] } } }, {}, true);
    await scheduler.invoke('maker:schedule:update', [schedule.id, { modelAgentKind: 'claude-code', providerId: 'other-fixture', model: 'scheduled-model', prompt: 'selected model message' }]);
    await scheduler.invoke('maker:schedule:run-now', [schedule.id]);
    const selectionRun = (await scheduler.invoke('maker:schedule:list-runs', [schedule.id]) as Array<{status:string;errorMsg?:string}>)[0];
    expect(selectionRun, JSON.stringify(selectionRun)).toMatchObject({status:'success'});
    expect(native.starts.at(-1)?.model).toBe('scheduled-model');
    expect(await host.invoke('local-db:sessions:get', [task.id])).toMatchObject({ model: 'test-model', providerId: 'fixture' });
    await scheduler.close(); await host.close();
    const restarted = f.create(); await restarted.ready;
    const restoredScheduler = new TerminalSchedulerHost({ profileDir: root, tasks: restarted, logger, emit() {} }); schedulers.push(restoredScheduler); await restoredScheduler.ready;
    await restarted.invoke('maker:send', [task.id, 'owner after schedule']);
    await vi.waitFor(() => expect(native.sentFor(task.id).at(-1)?.content).toContain('owner after schedule'));
    expect(native.starts.at(-1)?.model).toBe('test-model');
    expect(await restarted.storage.get(task.id)).toMatchObject({ model: 'test-model', providerId: 'fixture' });
    await vi.waitFor(() => expect(restarted.isTurnRunning(task.id)).toBe(false));
    await restoredScheduler.invoke('maker:schedule:run-now', [schedule.id]);
    // A manual choice while the automation baseline exists must survive both
    // the next dispatch and subsequent dispatches. Restoring the baseline first
    // would overwrite this explicit selection on the following turn.
    await restarted.invoke('maker:set-model', [task.id, 'scheduled-model', 'other-fixture']);
    for (const text of ['owner explicit choice', 'owner retains choice']) {
      await restarted.invoke('maker:send', [task.id, text]);
      await vi.waitFor(() => expect(native.sentFor(task.id).at(-1)?.content).toContain(text));
      await vi.waitFor(() => expect(restarted.isTurnRunning(task.id)).toBe(false));
      expect(native.starts.at(-1)?.model).toBe('scheduled-model');
      expect(await restarted.invoke('local-db:sessions:get', [task.id])).toMatchObject({model:'scheduled-model', providerId:'other-fixture'});
    }
  });

  // Integration: GUI project-automation commands were absent from the Node
  // host, as was startup reconciliation. Exercise the original file loader and
  // SQLite through public commands, including paused state across restart.
  it('keeps original project automation editing and startup reconciliation available remotely', async () => {
    const f = await setup();
    await f.host.invoke('maker:create-session', [{workingDir:f.root,agentKind:'claude-code',providerId:'fixture',model:'test-model'}]);
    const scheduler = new TerminalSchedulerHost({profileDir:f.root,tasks:f.host,logger,emit(){}}); schedulers.push(scheduler);
    const context = {source:'remote' as const,deviceId:'owner-controller'};
    const config = {id:'project-check',name:'Project check',prompt:'check project',cronExpr:'0 * * * *',timezone:'UTC',manual:true,
      agentKind:'claude-code',providerId:'fixture',model:'test-model',notify:{desktop:false,feishu:false}};
    expect(await scheduler.invoke('maker:project-automation:upsert-schedule', [{workingDir:f.root,config}], context)).toMatchObject({inserted:1});
    const schedulesBefore = await scheduler.invoke('maker:schedule:list') as Array<{id:string;source:string;projectConfigId:string}>;
    const task = schedulesBefore.find(row => row.projectConfigId === 'project-check')!;
    expect(task.source).toBe('project');
    await scheduler.invoke('maker:schedule:pause', [task.id]);
    await scheduler.close();
    const configFile = path.join(f.root,'.cindy','automations','schedules.json');
    const saved = JSON.parse(await readFile(configFile,'utf8'));
    saved.schedules[0].prompt='check project after restart';
    await writeFile(configFile,JSON.stringify(saved));
    const restarted = new TerminalSchedulerHost({profileDir:f.root,tasks:f.host,logger,emit(){}}); schedulers.push(restarted);
    await vi.waitFor(async () => expect(await restarted.invoke('maker:schedule:get',[task.id])).toMatchObject({prompt:'check project after restart',status:'paused'}));
    expect(await restarted.invoke('maker:project-automation:list-consents', [], context)).toMatchObject([{workingDir:f.root,configHash:expect.any(String)}]);
    expect(await restarted.invoke('maker:project-automation:remove-schedule', [{workingDir:f.root,id:'project-check'}], context)).toMatchObject({deleted:1});
    expect(await restarted.invoke('maker:schedule:get',[task.id])).toBeNull();
    expect(JSON.parse(await readFile(configFile,'utf8')).schedules).toEqual([]);
    expect(f.native.sent).toHaveLength(0);
  });

  it('runs and resumes owner-scoped schedules through the real engine and persists script completion', async () => {
    const { host, root } = await setup();
    const scheduler = new TerminalSchedulerHost({profileDir:root,tasks:host,logger,emit(){}});schedulers.push(scheduler);
    const base = {name:'Scheduled echo',prompt:'scheduled hello',kind:'cron',cronExpr:'0 * * * *',timezone:'UTC',recurring:true,manual:true,agentKind:'claude-code',providerId:'fixture',model:'test-model',workspaceKind:'dialogue',useWorktree:false,persistentSession:true,notify:{desktop:false,feishu:false}};
    const schedule = await scheduler.invoke('maker:schedule:create',[base]) as {id:string};
    await scheduler.invoke('maker:schedule:run-now',[schedule.id]);
    const runs = await scheduler.invoke('maker:schedule:list-runs',[schedule.id]) as Array<{status:string;sessionId:string;resultText:string}>;
    expect(runs[0]).toMatchObject({status:'success'});
    expect(runs[0].resultText).toContain('scheduled hello');
    // The public history must be the original SQLite/sidebar projection,
    // including read receipts, rather than the discarded schedules.json store.
    const sidebar=await scheduler.invoke('maker:schedule:list-sidebar-index-runs') as {runs:Array<{scheduleId:string}>;inflightRunIds:string[]};
    expect(sidebar.runs.some(run=>run.scheduleId===schedule.id)).toBe(true);
    expect(sidebar.inflightRunIds).toEqual([]);
    expect(await scheduler.invoke('maker:schedule:get-unread-count')).toBeGreaterThan(0);
    await scheduler.invoke('maker:schedule:mark-schedule-runs-read',[schedule.id]);
    expect(await scheduler.invoke('maker:schedule:get-unread-count')).toBe(0);
    await expect(access(path.join(root,'schedules.json'))).rejects.toMatchObject({code:'ENOENT'});
    const row=await scheduler.invoke('maker:schedule:get',[schedule.id]) as {targetSessionId:string};
    expect(row.targetSessionId).toBe(runs[0].sessionId);
    const script = await scheduler.invoke('maker:schedule:create',[{...base,name:'Script',workspaceKind:'project',workingDir:root,persistentSession:false,executionMode:'script',scriptConfig:{command:process.platform==='win32'?'echo {"protocol":"cindy-script/1","type":"complete","resultText":"script ok"}':`printf '%s\n' '{"protocol":"cindy-script/1","type":"complete","resultText":"script ok"}'`,capabilities:[]}}]) as {id:string};
    await scheduler.invoke('maker:schedule:run-now',[script.id]);
    expect(await scheduler.invoke('maker:schedule:list-runs',[script.id])).toMatchObject([{status:'success',resultText:'script ok'}]);
    // Original script admission restores an ordinary archived owner, but never
    // revives a deleted owner or runs its command after retirement.
    await host.invoke('local-db:sessions:patch-meta',[row.targetSessionId,{status:'archived'}]);
    await scheduler.invoke('maker:schedule:update',[script.id,{targetSessionId:row.targetSessionId}]);
    await scheduler.invoke('maker:schedule:run-now',[script.id]);
    expect(await host.invoke('local-db:sessions:get',[row.targetSessionId])).toMatchObject({status:'active'});
    await host.invoke('local-db:sessions:patch-meta',[row.targetSessionId,{status:'deleted'}]);
    await scheduler.invoke('maker:schedule:run-now',[script.id]);
    expect((await scheduler.invoke('maker:schedule:list-runs',[script.id]) as Array<{status:string}>)[0]).toMatchObject({status:'skipped'});
    expect(await host.invoke('local-db:sessions:get',[row.targetSessionId])).toMatchObject({status:'deleted'});
    await scheduler.close();
    const reopened=new TerminalSchedulerHost({profileDir:root,tasks:host,logger,emit(){}});schedulers.push(reopened);
    expect(await reopened.invoke('maker:schedule:get',[schedule.id])).toMatchObject({targetSessionId:row.targetSessionId});
    const registry=new RemoteResourceRegistry();reopened.registerResources(registry);
    const context={controllerDeviceId:'local'};const client={protocolVersion:1,primitives:['text','actions'],locale:'zh-CN'};
    const resourceInput={name:'Resource schedule',prompt:'resource instruction',workingDir:root,agentKind:'claude-code',providerId:'fixture',model:'test-model',kind:'interval',intervalSeconds:'3600',timezone:'Asia/Shanghai',persistentSession:true};
    await registry.invoke(context,{client,collectionId:'schedules',actionId:'create',input:resourceInput});
    const page=await registry.list(context,{client,collectionId:'schedules'});
    const created=page.items.find(item=>item.display.title==='Resource schedule')!;
    expect(created).toBeTruthy();
    await registry.invoke(context,{client,collectionId:'schedules',resourceRef:created.ref,actionId:'edit',input:{name:'Edited schedule'}});
    expect(await reopened.invoke('maker:schedule:get',[created.ref.id])).toMatchObject({name:'Edited schedule',timezone:'Asia/Shanghai',intervalMs:3_600_000,persistentSession:true,model:'test-model'});
    await expect(registry.invoke(context,{client,collectionId:'schedules',actionId:'create',input:{...resourceInput,intervalSeconds:'-1'}})).rejects.toThrow('INVALID_INTERVAL');
    await registry.invoke(context,{client,collectionId:'schedules',resourceRef:created.ref,actionId:'delete'});
    expect(await reopened.invoke('maker:schedule:get',[created.ref.id])).toBeNull();
  });

  it('exports peer and OSS files without overwriting an existing destination', async () => {
    const root=await mkdtemp(path.join(os.tmpdir(),'cindy-download-test-'));roots.push(root);
    const destination=path.join(root,'download.txt');
    const files={receive:async <T>(_peer:string,_url:string,makeSink:Parameters<import('../remote/files.js').TerminalFilePeerService['receive']>[2]):Promise<T>=>{
      const metadata={ticket:'fixture',size:5,mimeType:'text/plain'};
      const sink=await makeSink(metadata);
      try {await sink.write(0,Buffer.from('hello'));return await sink.finish(metadata) as T;}
      catch(error){await sink.abort();throw error;}
    }};
    const media=new TerminalMediaTransfer({ownerDir:root,getOwnerScope:()=> 'owner',getToken:async()=> 'fixture-token',getApiBaseUrl:()=> 'https://fixture.invalid',fetch:(async(url)=>String(url).includes('presign-get')?Response.json({getUrl:'https://fixture.invalid/body'}):new Response('world')) as typeof fetch});
    const options={files,media,invokeRemote:async()=>({inlineBase64:Buffer.from('world').toString('base64'),size:5,mimeType:'text/plain'})};
    expect(await downloadRemoteFile(options,['device','xdt-file:///file',destination],{source:'local'})).toMatchObject({path:destination,size:5});
    await expect(downloadRemoteFile(options,['device','xdt-file:///file',destination],{source:'local'})).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(destination,'utf8')).toBe('hello');
    await expect(media.download('fixture-key',destination)).rejects.toMatchObject({code:'EEXIST'});
    expect(await readFile(destination,'utf8')).toBe('hello');
    const fallback=path.join(root,'fallback.txt');
    expect(await downloadRemoteFile({...options,files:{receive:async()=>{throw new Error('FILE_PEER_UNAVAILABLE');}}},['device','xdt-file:///file',fallback],{source:'local'})).toMatchObject({size:5});
    expect(await readFile(fallback,'utf8')).toBe('world');
  });

  // Integration: sharing only the MCP proxy left Node without persisted App
  // grants or remote interaction. Exercise the actual task bridge and GUI wire
  // against the existing independent App fixture, including a real next turn.
  it('keeps original MCP App cards and remote interaction without a renderer', async () => {
    const { startMockAppServer } = await import('../../../desktop/scripts/mcp-apps-mock.mjs');
    const { createRawAppServer, RAW_APP_HTML } = await import('../../../desktop/scripts/mcp-apps-raw-fixture.mjs');
    const endpoint = await startMockAppServer({ createServer: createRawAppServer });
    const { host, root, native, nextPush } = await setup();
    const client = new McpClient({ name: 'headless-app-integration', version: '1' });
    try {
      await host.invoke('maker:mcp:custom:create', [{ id: 'metrics', name: 'Metrics', url: endpoint.url, transport: 'http', headers: {} }]);
      const task = await host.invoke('maker:create-session', [{ workingDir: root, permissionMode: 'bypassPermissions' }]) as { id: string };
      const runtime = native.inputs.at(-1)!, start = native.starts.at(-1)!;
      const ctx = { sessionId: task.id, sessionInstanceId: start.sessionInstanceId, workingDir: root, agentKind: 'claude-code' as const };
      const provider = runtime.tools!.providers.find(item => item.name === 'metrics')!;
      const server = (provider.toClaudeSdkConfig!(ctx) as { instance: McpServer }).instance;
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(left); await client.connect(right);
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('open_metrics');
      const result = await client.callTool({ name: 'open_metrics', arguments: { threshold: 42 } });
      expect(result.isError).not.toBe(true);
      expect(result._meta).toBeUndefined();
      const rows = await host.invoke('local-db:messages:list', [task.id]) as Array<{ clientId: string; agentMeta?: { mcpApp?: boolean }; content: unknown }>;
      const card = rows.find(row => row.agentMeta?.mcpApp)!;
      expect(card).toBeDefined();
      const controller = { source: 'remote' as const, deviceId: 'gui-controller' };
      const invoke = (input: unknown) => host.invoke('maker:mcp-apps:v1', [task.id, input], controller);
      const opened = await invoke({ op: 'open', clientId: card.clientId, context: { platform: 'desktop', theme: 'dark' } }) as { viewId: string; html: string };
      expect(opened.html).toBe(RAW_APP_HTML);
      let after = 0, rpcId = 0;
      const rpc = async (method: string, params: Record<string, unknown>) => {
        const id = ++rpcId;
        await invoke({ op: 'message', viewId: opened.viewId, message: { jsonrpc: '2.0', id, method, params } });
        for (;;) {
          const events = await invoke({ op: 'poll', viewId: opened.viewId, after }) as Array<{ seq: number; message?: { id?: number; result?: unknown; error?: unknown } }>;
          for (const event of events) {
            after = event.seq;
            if (event.message?.id === id) { expect(event.message.error).toBeUndefined(); return event.message.result; }
          }
        }
      };
      expect(await rpc('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'Remote GUI', version: '1' }, appCapabilities: {} })).toMatchObject({ hostContext: { theme: 'dark' } });
      await invoke({ op: 'message', viewId: opened.viewId, message: { jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} } });
      await rpc('ui/update-model-context', { content: [{ type: 'text', text: 'HEADLESS_APP_CONTEXT' }] });
      expect(await rpc('tools/call', { name: 'refresh_metrics', arguments: { threshold: 55 } })).toMatchObject({ structuredContent: { metrics: expect.any(Object) } });
      const done = nextPush('maker:event', value => (value as { event?: AgentEvent }).event?.type === 'done');
      await rpc('ui/message', { role: 'user', content: [{ type: 'text', text: 'Discuss these metrics' }] });
      await done;
      expect(JSON.stringify(native.sent.at(-1))).toContain('HEADLESS_APP_CONTEXT');
      expect(JSON.stringify(native.sent.at(-1))).toContain('Discuss these metrics');
      await expect(host.invoke('maker:mcp-apps:v1', [task.id, { op: 'poll', viewId: opened.viewId, after }], { source: 'remote', deviceId: 'another-controller' })).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
      await host.mcpApps.releaseDevice(controller.deviceId);
      await expect(invoke({ op: 'poll', viewId: opened.viewId, after })).rejects.toThrow('MCP_APP_VIEW_UNAVAILABLE');
      const reopened = await invoke({ op: 'open', clientId: card.clientId, context: {} }) as { viewId: string };
      await invoke({ op: 'teardown', viewId: reopened.viewId, alreadyNotified: true });
      await host.invoke('maker:mcp:custom:update', [{ id: 'metrics', name: 'Metrics', url: endpoint.url, transport: 'http', headers: {} }, 'changed-test-token']);
      await expect(invoke({ op: 'open', clientId: card.clientId, context: {} })).rejects.toThrow('MCP_APP_SERVER_CHANGED');
    } finally { await client.close(); await host.close(); await endpoint.close(); }
  });

  it('mounts project MCP tools with vaulted credentials and managed skills in the actual task runtime', async () => {
    const {host,root,native}=await setup();const peers:McpServer[]=[];let authenticated=false;
    // Custom models start hidden; explicitly enable the route whose selection
    // this test exercises through the companion's real MCP controls.
    await host.models.setVisibility('claude-code', 'fixture', ['test-model'], true);
    const upstream=createServer(async(req,res)=>{
      authenticated=req.headers.authorization==='Bearer fixture-mcp-secret';
      if(!authenticated){res.writeHead(401).end();return;}
      const server=new McpServer({name:'fixture',version:'1'});peers.push(server);
      server.registerTool('echo',{inputSchema:{text:z.string()}},async({text})=>({content:[{type:'text',text:`upstream:${text}`}]}));
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined});
      await server.connect(transport);await transport.handleRequest(req,res);
    });
    await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));
    const client=new McpClient({name:'test',version:'1'});
    try {
      await host.invoke('maker:mcp:custom:create',[{id:'fixture_mcp',name:'Fixture MCP',url:`http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}/mcp`,transport:'http',headers:{},scope:'project',workingDir:root},'fixture-mcp-secret']);
      await host.invoke('terminal:skills:create',[{name:'fixture_skill',description:'A test skill',body:'Use the fixture skill.',scope:'project',workingDir:root}]);
      const task=await host.invoke('maker:create-session',[{workingDir:root}]) as {id:string};
      const runtime=native.inputs.at(-1)!;
      expect((await runtime.capabilities!.getManagedSkills()).some(skill=>skill.name==='fixture_skill')).toBe(true);
      const provider=runtime.tools!.providers.find(provider=>provider.name==='fixture_mcp')!;
      expect(provider.capability).toMatchObject({title:'Fixture MCP',source:'custom'});
      const sdk=await provider.toClaudeSdkConfig!({sessionId:task.id,workingDir:root,agentKind:'claude-code'}) as {instance:McpServer};
      const [left,right]=InMemoryTransport.createLinkedPair();await sdk.instance.connect(left);await client.connect(right);
      expect((await client.listTools()).tools.map(tool=>tool.name)).toEqual(['echo']);
      expect(await client.callTool({name:'echo',arguments:{text:'hello'}})).toMatchObject({content:[{type:'text',text:'upstream:hello'}]});
      expect(authenticated).toBe(true);
      expect(await readFile(path.join(root,'capabilities.json'),'utf8')).not.toContain('fixture-mcp-secret');
      expect(JSON.stringify(await host.invoke('maker:mcp:custom:list',[]))).not.toContain('fixture-mcp-secret');
      // A companion uses the real shared MCP source, but keeps its own choice,
      // memory scope and next-turn runtime. It must honor the account switch.
      const knowledge = new TerminalKnowledge({ root, logger, assertCurrent() {}, changed() {}, workingDirs: async () => [root] });
      await knowledge.configure({ memory: false });
      await connectCompanionFixture(host,root,knowledge);
      const companion = new TerminalCompanionHost({ tasks: host, root: path.join(root, 'companions'), profileDir: root,
    logger, guard() { }, emit() { }, binary: async () => process.execPath });
      const peer = new McpClient({ name: 'companion-fixture', version: '1' });
      const helper = new McpClient({ name: 'companion-control', version: '1' });
      try {
        await companion.modelSettings.saveDefaults([{...(await host.models.select()).selection,fastMode:false}]);
        const profile = await companion.create({ name: 'MCP companion' });
        // Native MCP calls happen during a turn. Keep that turn alive so a
        // next-turn profile edit cannot retire an already-idle MCP transport.
        const firstTurn = await companion.send(profile.id, 'wait-for-steer', 'first');
        const currentProfile = await companion.profiles.get(profile.id);
        expect(currentProfile?.sessionId).toBeTruthy();
        await native.waitForHeld(currentProfile!.sessionId);
        const runtime = native.inputs.at(-1)!, start = native.starts.at(-1)!;
        expect(runtime.memory?.isEnabled()).toBe(false);
        expect(start.botRuntimeProfile?.mcpPolicy.catalog).toContainEqual(expect.objectContaining({ name: 'fixture_mcp', source: 'custom', available: true }));
        const ctx = { sessionId: currentProfile!.sessionId, workingDir: start.workingDir, agentKind: 'claude-code' as const,
          getSessionContext: () => ({ sessionId: currentProfile!.sessionId, workingDir: start.workingDir, agentKind: 'claude-code' as const }) };
        const connect = async (name: string, client: McpClient) => {
          const server = runtime.tools!.providers.find(provider => provider.name === name)!.toClaudeSdkConfig!(ctx) as { instance: McpServer };
          const [left, right] = InMemoryTransport.createLinkedPair(); await server.instance.connect(left); await client.connect(right);
        };
        await connect('fixture_mcp', peer);
        expect(await peer.callTool({ name: 'echo', arguments: { text: 'companion' } })).toMatchObject({ content: [{ type: 'text', text: 'upstream:companion' }] });
        await connect('cindy_helper', helper);
        const control=async(name:string,args:Record<string,unknown>={})=>{
          const response=await helper.callTool({name:'call_tool',arguments:{name,args}});
          const payload=response.isError?null:JSON.parse((response.content as Array<{text:string}>)[0].text);
          return {response,payload};
        };
        expect((await control('get_capabilities',{scope:'runtime'})).payload).toMatchObject({ok:true,capabilities:expect.arrayContaining([{server:'fixture_mcp',title:'Fixture MCP',description:'',source:'custom',status:'registered'}])});
        const before=await control('get_teammate_state');
        // This reports the companion's preference; the global memory switch
        // is independently enforced by runtime.memory.isEnabled() above.
        expect(before.payload.state).toMatchObject({profile:{id:profile.id,name:'MCP companion',version:1},memory:{enabled:true,scope:'self'}});
        const available=await control('get_app_default_model');
        const model=available.payload.available.find((choice:any)=>choice.route.providerId==='fixture'&&choice.route.harness==='claude');
        expect(model).toBeDefined();
        const edit={expectedVersion:1,name:'Personal companion',identitySource:'Independent personality',modelChain:[{id:model.id,fastMode:false}]};
        expect((await control('update_teammate_profile',edit)).payload).toMatchObject({ok:true,effective:'next-turn'});
        expect(await companion.profiles.read(profile.id,'SOUL.md')).toBe('Independent personality');
        expect((await control('update_teammate_profile',edit)).response.isError).toBe(true);
        expect((await control('set_app_default_model',{id:model.id})).payload).toMatchObject({ok:true,effective:'new-tasks-and-following-bots'});
        expect((await companion.modelSettings.defaults())[0].providerId).toBe('fixture');
        const selected = await helper.callTool({ name: 'call_tool', arguments: { name: 'set_teammate_capability', args: { kind: 'mcp', id: 'fixture_mcp', joined: false } } });
        expect(selected.isError).not.toBe(true);
        expect((await companion.profiles.get(profile.id))?.capabilities).toMatchObject({ mcpMode: 'allowlist', mcpServers: [] });
        native.finishHeld(currentProfile!.sessionId);
        await firstTurn.completion;
        await (await companion.send(profile.id, 'next turn', 'second')).completion;
        expect(native.inputs.at(-1)!.tools!.providers.map(provider => provider.name)).not.toContain('fixture_mcp');
        expect(native.starts.at(-1)?.botProfilePrompt).toContain('Independent personality');
        expect((await host.invoke('maker:mcp:custom:list', []))).toMatchObject({ servers: [expect.objectContaining({ id: 'fixture_mcp', enabled: true })] });
        await knowledge.configure({ memory: true });
        await (await companion.send(profile.id, 'memory enabled', 'third')).completion;
        expect(native.inputs.at(-1)!.memory?.isEnabled()).toBe(true);
        expect(native.starts.at(-1)?.resumeSessionId).toBe(start.resumeSessionId ?? `native-${currentProfile!.sessionId}`);
      } finally { await helper.close(); await peer.close(); await companion.close(); await knowledge.close(); }
      await host.invoke('terminal:mcp:set-enabled',['fixture_mcp',false]);
      await expect(client.listTools()).rejects.toThrow();
      const other=await host.capabilities.runtime({workingDir:path.dirname(root),agentKind:'claude-code'});
      expect(other.factories).toEqual({});expect(await other.getManagedSkills()).toEqual([]);await other.close();
    }finally{await client.close();upstream.closeAllConnections();await Promise.all(peers.map(peer=>peer.close()));await new Promise<void>(resolve=>upstream.close(()=>resolve()));}
  });

});
