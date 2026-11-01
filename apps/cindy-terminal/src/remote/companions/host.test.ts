import {TerminalKnowledge} from '../../knowledge.js';
import {createServer,type ServerResponse} from 'node:http';
import {TerminalCompanionCloud} from './cloud.js';
import {activeCompanionCloud} from '@cindy/companion-core/runtime';
import {createTerminalWorktrees} from '../../worktrees/host.js';
import { taskStorageFixture, closeTaskStorageFixtures } from '../../testing/task-storage.js';
import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, symlink, readFile, access } from "node:fs/promises";
import * as platform from "../../platform.js";
import { TerminalCompanionProfiles } from "./profiles.js";
import os from "node:os";
import path from "node:path";
import {
  ClaudeCodeAgent,
  type AgentEvent,
  type AgentSessionHandle,
  type Logger,
  type StartSessionOptions,
} from "@cindy/maker-core";
import { TerminalCompanionHost } from "./host.js";
import { TerminalModelConfig, modelFixtureDatabase, closeModelFixtureDatabases } from "../../testing/model-config.js";
import type { RuntimeInput } from "../../models/runtime.js";
import { RemoteResourceRegistry } from "@cindy/device-link";
import { registerCompanionResources } from "./resources.js";
import { TerminalCompanionRoutines } from "./routines.js";
import {createLiziMcpProviders} from '@cindy/mcps';
import {Client as McpClient} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import type {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import { TerminalSchedulerHost } from "../../tasks/scheduler.js";
import { companionModelsRef } from "./model-resources.js";
import { TerminalTaskHost } from "../../tasks/host.js";
const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => logger,
};
const roots: string[] = [];
const hosts: TerminalCompanionHost[] = [];
const schedulers: TerminalSchedulerHost[] = [];
const taskHosts:TerminalTaskHost[]=[];
const knowledgeHosts:TerminalKnowledge[]=[];
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    await host.routines?.close();
    await host.close();
  }
  for (const scheduler of schedulers.splice(0)) await scheduler.close();
  for(const tasks of taskHosts.splice(0))await tasks.close();
  for(const knowledge of knowledgeHosts.splice(0))await knowledge.close();
  await closeTaskStorageFixtures();
  await closeModelFixtureDatabases();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cindy-companion-"));
  roots.push(root);
  let active = true;
  const starts: StartSessionOptions[] = [];
  const sent: string[] = [];
  const configs: RuntimeInput[] = [];
  const vault = new Map<string, string>();
  const models = new TerminalModelConfig(
    root,
    {
      get: async (key) => vault.get(key) ?? null,
      set: async (key, value) => {
        vault.set(key, value);
      },
      delete: async (key) => {
        vault.delete(key);
      },
    },
    async () => ({ authenticated: true }),
  );
  await models.open();
  await models.saveProvider(
    {
      id: "fixture",
      name: "Fixture",
      auth: { method: "none" },
      runtimes: {
        "claude-code": {
          baseUrl: "http://127.0.0.1:1",
          models: [{ id: "test", name: "Test", contextWindow: 200000 }],
        },
      },
    },
    {},
    true,
  );
  await models.setDefault({
    agentKind: "claude-code",
    providerId: "fixture",
    model: "test",
  });
  const create = async (input: RuntimeInput) => {
    configs.push(input);
    const agent = new ClaudeCodeAgent({
      auth: {
        getState: async () => ({ authenticated: true }),
        getAuthEnv: async () => ({}),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
      },
      runtimeConfig: {},
      logger,
      binaryPath: process.execPath,
    });
    agent.startSession = async (options) => {
      input.runtimeAxes?.setSessionEffort(options.sessionId!,options.effort);
      input.runtimeAxes?.setSessionFastMode(options.sessionId!,options.fastMode??false);
      starts.push(options);
      const events: AgentEvent[] = [];
      let ended = false;
      let awaken: () => void = () => {};
      const handle: AgentSessionHandle = {
        id: "native-" + options.sessionId,
        agentKind: "claude-code",
        get model(){return options.model;},
        async send(message) {
          const text =
            typeof message.content === "string" ? message.content : "";
          sent.push(text);
          events.push(
            { type: "text", data: { text: "Reply: " + text, isFinal: true } },
            { type: "done", data: {} },
          );
          awaken();
        },
        async setModel(model){options.model=model;},
        async setEffort(effort){options.effort=effort;},
        getEffort:()=>options.effort??null,
        async setFastMode(fastMode){options.fastMode=fastMode;},
        getFastMode:()=>options.fastMode??false,
        async setPermissionMode(mode){options.permissionMode=mode;},
        getPlanMode:()=>options.planMode??false,
        async setPlanMode(planMode){options.planMode=planMode;},
        async setVendorOptions(patch){options.vendorOptions={...options.vendorOptions,...patch};},
        async steer() {},
        async abort() {},
        async close() {
          ended = true;
          awaken();
        },
        async *events() {
          while (!ended || events.length) {
            const event = events.shift();
            if (event) yield event;
            else
              await new Promise<void>((resolve) => {
                awaken = resolve;
              });
          }
        },
        getUsageSnapshot: () => ({
          tokenUsage: 0,
          contextTokens: 0,
          contextWindow: 200000,
          costUsd: 0,
        }),
        isTurnRunning: () => false,
        setInteractionResolver() {},
      };
      return handle;
    };
    return agent;
  };
  const tasks=new TerminalTaskHost({profileDir:root,database:await modelFixtureDatabase(root),logger,
    secretStore:{get:async key=>vault.get(key)??null,set:async(key,value)=>{vault.set(key,value);},delete:async key=>{vault.delete(key);}},
    emit(){},createAgent:create,binaryPaths:{'claude-code':process.execPath},nativeStatus:async()=>({authenticated:false})});
  taskHosts.push(tasks);await tasks.ready;
  await tasks.models.setVisibility('claude-code','fixture',['test'],true);
  const knowledge=new TerminalKnowledge({root,logger,assertCurrent:()=>{},changed:()=>{},workingDirs:async()=>[root]});
  knowledgeHosts.push(knowledge);await knowledge.ready;tasks.configureKnowledge(knowledge);
  vi.spyOn(tasks,'listAgentSkills').mockResolvedValue({skills:[]});
  await tasks.connectOriginalBotServices({memory:knowledge.memory,resourceRoot:()=>path.resolve(process.cwd(),'../desktop/resources'),
    listBotImChannels:({botId})=>tasks.botImConnections.listBotImConnectionsForBot(botId).map(row=>row.channel),isCompanionShadowed:()=>false});
  const storage=tasks.storage;
  const host = new TerminalCompanionHost({ tasks,
    root: path.join(root, "companions"),
    profileDir: root,
    logger,
    guard: () => {
        if (!active)
            throw new Error("OWNER_CHANGED");
    },
    emit() { },
    binary: async () => process.execPath });
  await host.modelSettings.saveDefaults([
    {
      agentKind: "claude-code",
      providerId: "fixture",
      model: "test",
      fastMode: false,
    },
  ]);
  hosts.push(host);
  return {
    root,
    host,
    starts,
    sent,
    configs,
    models:tasks.models,
    tasks,
    revoke: () => {
      active = false;
    },
  };
}

/** Tier: integration. A companion must keep Profile identity/history and real
 * Bot-runtime/memory/MCP isolation while replacing only its native handle. */
it("keeps one independent Profile and journal, mounts memory and personal skills, and does not replay duplicate delivery", async () => {
  const f = await setup();
  const profile = await f.host.create({ name: "Cindy", templateId: "cindy" });
  profile.sessionId=await f.host.ensureCanonical(profile);
  const first = await f.host.send(profile.id, "hello", "once");
  expect(await first.completion).toContain("hello");
  expect(f.starts[0].botRuntimeProfile?.botId).toBe(profile.id);
  expect(f.configs[0].tools?.providers.map((item) => item.name)).toContain(
    "cindy_memory",
  );
  expect(f.starts[0].botProfilePrompt).toContain("Cindy");
  const duplicate = await f.host.send(profile.id, "hello", "once");
  expect(await duplicate.completion).toContain("hello");
  expect(f.sent).toHaveLength(1);
  expect(
    (await f.host.messages(profile.sessionId)).map((row) => row.role),
  ).toEqual(["assistant", "user"]);
  await f.tasks.invoke('maker:close-session',[profile.sessionId]);
  const second = await f.host.send(profile.id, "again", "twice");
  await second.completion;
  expect(f.starts[1].resumeSessionId).toBe("native-" + profile.sessionId);
  expect(f.starts[1].botRuntimeProfile?.botId).toBe(profile.id);
  const another = await f.host.create({ name: "Other" });
  await f.host.profiles.writeMemory(
    profile.id,
    "reference_fact.md",
    "first profile only",
  );
  expect(await f.host.profiles.readMemory(another.id, "reference_fact.md")).toBeNull();
  await expect(
    f.host.profiles.change(profile.id, {
      models: [{ agentKind: "invalid", model: "x", providerId: "x" } as never],
    }),
  ).rejects.toThrow("INVALID_MODEL_SELECTION");
  expect((await f.host.profiles.get(profile.id))?.models).toEqual([]);
  const registry = new RemoteResourceRegistry();
  await registerCompanionResources(registry, f.host);
  const listed = await registry.list(
    { controllerDeviceId: "owner" },
    {
      client: { protocolVersion: 1, primitives: [], locale: "ja" },
      collectionId: "teammates",
    },
  );
  expect(listed.items[0].ref.kind).toBe("bot");
  expect(listed.items[0].display.status?.label).toMatchObject({
    translations: { ja: "利用可能", ko: "사용 가능", "zh-TW": "可用" },
  });
  f.revoke();
  await expect(f.host.send(profile.id, "stale")).rejects.toThrow(
    "OWNER_CHANGED",
  );
  await f.host.close();
});

// Integration: original Remote Resource actions must reach the original queue,
// persist acceptance once, and retain their controller/account authorization.
// Existing tests cover the store and desktop provider separately, not Node binding.
it('dispatches the original remote Todo once and revokes settings grants with the owner',async()=>{
  const f=await setup();
  const profile=await f.host.create({name:'Remote fixture'});
  profile.sessionId=await f.host.ensureCanonical(profile);
  const scheduler=new TerminalSchedulerHost({profileDir:f.root,tasks:f.tasks,companions:()=>f.host,logger,emit(){}});
  schedulers.push(scheduler);
  f.host.routines=new TerminalCompanionRoutines(f.host,scheduler);
  await f.host.routines.open();
  const todos=await f.host.services.todos.todoAccess(profile.id);
  const todo=await todos.patch({key:'owner-report',origin:'assigned',title:'Read the report',outcome:'Checked report',
    next:{kind:'advance',label:'Read it',instruction:'Read the report'},sources:[]});
  // The same stored Todo/routines must be usable by the actual native agent,
  // not only visible through the GUI's remote-resource facade.
  const helper=f.tasks.helperDeps({sessionId:profile.sessionId,workingDir:path.join(f.host.profiles.home(profile.id),'workspace'),agentKind:'claude-code'});
  const provider=createLiziMcpProviders({xdtHelper:helper}).find(p=>p.name==='cindy_helper')!;
  const sdk=provider.toClaudeSdkConfig!({sessionId:profile.sessionId,workingDir:f.root,agentKind:'claude-code'}) as {instance:McpServer};
  const [left,right]=InMemoryTransport.createLinkedPair(),clientMcp=new McpClient({name:'native-original-helper',version:'1'});
  try{
    await sdk.instance.connect(left);await clientMcp.connect(right);
    const catalog=await clientMcp.callTool({name:'list_tools',arguments:{category:'bots'}});
    for(const name of ['list_teammate_todos','get_workbench','routine_list','create_teammate','get_teammate_home'])expect(JSON.stringify(catalog)).toContain(name);
    const listed=await clientMcp.callTool({name:'call_tool',arguments:{name:'list_teammate_todos',args:{key:'owner-report'}}});
    expect(listed.isError,JSON.stringify(listed)).not.toBe(true);expect(JSON.stringify(listed)).toContain('Read the report');
    const routines=await clientMcp.callTool({name:'call_tool',arguments:{name:'routine_list',args:{}}});
    expect(routines.isError).not.toBe(true);expect(JSON.parse((routines.content as Array<{text:string}>)[0]!.text).ok).toBe(true);
  }finally{await clientMcp.close();}
  const registry=new RemoteResourceRegistry();
  await registerCompanionResources(registry,f.host);
  const context={controllerDeviceId:'controller-one'};
  const client={protocolVersion:1 as const,primitives:['form','teammate-todos'],locale:'en'};
  const ref={collectionId:'teammates',kind:'bot',id:profile.id};
  const todoRef={...ref,id:`todos:${profile.id}`};
  const page=await registry.get(context,{client,ref:todoRef});
  expect(page.blocks?.find(block=>block.id==='todos')?.data).toMatchObject({items:[{id:todo.id,title:'Read the report'}]});
  const action={client,collectionId:'teammates',resourceRef:todoRef,actionId:'todo-act',
    input:{id:todo.id,revision:todo.revision,requestId:'owner-step-0000001'}};
  await registry.invoke(context,action);
  await vi.waitFor(async()=>{
    expect(f.sent).toHaveLength(1);
    expect((await todos.list()).items[0].action).toMatchObject({requestId:'owner-step-0000001',state:'accepted'});
  },{interval:10,timeout:2000});
  await registry.invoke(context,action);
  expect(f.sent).toHaveLength(1);
  expect((await f.host.messages(profile.sessionId)).filter(row=>row.role==='user')).toHaveLength(1);
  const settings=await registry.get(context,{client,ref});
  const actionId=(settings.blocks!.find(block=>block.id==='profile')!.data as {actionId:string}).actionId;
  const rename={client,collectionId:'teammates',resourceRef:ref,actionId,input:{name:'Wrong owner'}};
  await expect(registry.invoke({controllerDeviceId:'controller-two'},rename)).rejects.toThrow('Refresh teammate settings');
  const db=(await f.tasks.database).getDbClient();
  f.revoke();
  await expect(registry.invoke(context,rename)).rejects.toThrow('Account changed');
  expect(await db.queryOne('SELECT display_name FROM bot_profiles WHERE id = ?',[profile.id])).toEqual({display_name:'Remote fixture'});
});

/** Integration: the terminal cloud adapter previously sliced a descending UI
 * page and wrote only an event journal. Exercise original cursor ordering,
 * rewind exclusion, GUI-visible imported history and durable attachment refs. */
it('uses original cloud history cursors and restores messages with owned attachments',async()=>{
  const f=await setup();
  const profile=await f.host.create({name:'History'});
  const sessionId=await f.host.ensureCanonical(profile);
  const history=await f.tasks.companionHistory();
  const media=await f.tasks.media.persisted();
  const image=await media.ingestChatImageBuffer({buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6L8AAAAASUVORK5CYII=','base64'),mimeType:'image/png'});
  const imagePath=(await f.tasks.media.resolveManaged(image.url)).path;
  const fence={assertCurrent(){}};
  await history.insertHistory(sessionId,{clientId:'cloud:first',role:'user',text:'Oldest',createdAt:1000,
    attachments:[{name:'image.png',url:image.url,mimeType:'image/png',category:'image',size:68,path:imagePath}]},fence);
  await history.insertHistory(sessionId,{clientId:'cloud:second',role:'assistant',text:'Same timestamp',createdAt:1000},fence);
  await history.insertHistory(sessionId,{clientId:'cloud:rewound',role:'user',text:'Removed',createdAt:2000},fence);
  const db=(await f.tasks.database).getDbClient();
  await db.exec('UPDATE messages SET rewind_at = ? WHERE session_id = ? AND client_id = ?',[3000,sessionId,'cloud:rewound']);
  const first=await history.readMirrorRowsAfter(sessionId,{createdAt:0,id:''},1);
  const second=await history.readMirrorRowsAfter(sessionId,first[0],1);
  expect([...first,...second].map(row=>row.clientId).sort()).toEqual(['cloud:first','cloud:second']);
  expect(await history.readMirrorRowsAfter(sessionId,second[0],1)).toEqual([]);
  expect((await history.readLatestMirrorRows(sessionId,2)).map(row=>row.id)).toEqual([second[0].id,first[0].id]);
  expect(await history.localMessageTimes(sessionId,0)).toContainEqual(expect.objectContaining({clientId:'cloud:rewound',removed:true}));
  const visible=await f.host.messages(sessionId);
  expect(visible.map(row=>row.clientId).sort()).toEqual(['cloud:first','cloud:second']);
  expect(JSON.stringify(visible.find(row=>row.clientId==='cloud:first')?.content)).toContain(image.url);
  const hash=media.blobStore.parseBlobUrl(image.url)!.hash;
  expect(await media.ledger.hasRef({hash,refKind:'session-attachment',refId:sessionId})).toBe(true);
});

// Integration: the original Chat Server must reach the Node-owned canonical
// task over its real HTTP protocol and discard replies after host disposal.
it('runs original cloud direct-room delivery and fences late network replies when the owner closes',async()=>{
  const f=await setup(),profile=await f.host.create({name:'Cloud fixture'});
  const secrets=new Map<string,string>();
  await f.tasks.connectWorktrees(await createTerminalWorktrees({profile:f.root,root:f.root,tasks:f.tasks.storage,logger,guard:()=>f.host.options.guard(),appDataRoot:path.join(f.root,'app-data'),
    secrets:{getSync:key=>secrets.get(key)??null,setSync:(key,value)=>{secrets.set(key,value);}}}));
  const scheduler=new TerminalSchedulerHost({profileDir:f.root,tasks:f.tasks,companions:()=>f.host,logger,emit(){}});
  schedulers.push(scheduler);f.host.routines=new TerminalCompanionRoutines(f.host,scheduler);await f.host.routines.open();
  const self='30000000-0000-4000-8000-000000000001',actor='20000000-0000-4000-8000-000000000001';
  const room='10000000-0000-4000-8000-000000000001',source='50000000-0000-4000-8000-000000000001',executionId='40000000-0000-4000-8000-000000000001';
  let home:string|null=null,claimed=false,holdHistory=false,late:ServerResponse|undefined,endpointUrl='';
  const calls:Array<{route:string;method:string;body:any}>=[],preferences=new Map<string,{key:string;value:unknown;revision:number}>();
  const send=(res:ServerResponse,value:unknown)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const server=createServer((req,res)=>{void(async()=>{
    const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
    const url=new URL(req.url!,endpointUrl),route=url.pathname.slice(3),method=req.method!,body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):undefined;
    calls.push({route,method,body});
    expect(req.headers.authorization).toBe('Bearer isolated-cloud-token');
    if(route==='/me')return send(res,{actor:{id:self,kind:'human'},deviceId:'node-fixture',capabilities:{companionHome:true,directRoomClaim:true}});
    if(route==='/actors')return send(res,[{id:actor,kind:'bot',externalId:profile.id,name:profile.name,homeDeviceId:home}]);
    if(route===`/actors/${actor}`){if(method==='PATCH')home=body.homeDeviceId;return send(res,{id:actor,homeDeviceId:home});}
    if(route==='/preferences'){
      if(method==='GET')return send(res,[...preferences.values()]);
      const row={key:body.key,value:body.value,revision:(preferences.get(body.key)?.revision??0)+1};preferences.set(body.key,row);return send(res,row);
    }
    if(route==='/conversations')return send(res,method==='POST'?{id:room}:[]);
    if(route==='/executions/claim'){
      const execution=claimed?null:{id:executionId,conversation_id:room,source_message_id:source,bot_id:actor,requester_id:self,context_seq:'1',epoch:1,status:'running',access_mode:'owner',access_revision:1};claimed=true;return send(res,{execution});
    }
    if(route===`/conversations/${room}/snapshot`)return send(res,{room:{id:room,kind:'direct',name:profile.name,revision:1},members:[{id:self,state:'joined'},{id:actor,state:'joined'}],messages:[],cursor:'1'});
    if(route===`/conversations/${room}/messages/${source}`)return send(res,{id:source,seq:'1',authorId:self,author:{kind:'human',name:'Owner'},deleted:false,threadRootId:null,createdAt:'2026-10-25T00:00:00Z',content:[{type:'text',text:'Read this from the phone.'}]});
    if(route===`/conversations/${room}/messages`&&method==='GET'){if(holdHistory){late=res;return;}return send(res,[]);}
    return send(res,{});
  })().catch(error=>{res.writeHead(500);res.end(JSON.stringify({error:{code:String(error)}}));});});
  server.on('upgrade',(_req,socket)=>socket.destroy());
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string')return reject(new Error('HTTP_FIXTURE_ADDRESS_UNAVAILABLE'));endpointUrl=`http://127.0.0.1:${address.port}`;resolve();});});
  vi.stubEnv('XDT_ISOLATED','1');vi.useFakeTimers({toFake:['setInterval','clearInterval']});
  const cloud=new TerminalCompanionCloud({host:f.host,routines:f.host.routines,userDataPath:f.root,
    endpoint:()=> endpointUrl,getToken:()=> 'isolated-cloud-token',refresh:async()=>false,
    remoteControlEnabled:()=>true,guard:()=>f.host.options.guard(),logger,deviceId:'node-fixture',locale:()=> 'en',
    listDevices:async()=>[],remoteInvoke:async()=>{throw new Error('NO_REMOTE_FIXTURE');},emit(){}});
  try{
    await cloud.open(new RemoteResourceRegistry(),file=>rm(file,{recursive:true,force:true}));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(()=>expect(activeCompanionCloud()?.installConfirmed(profile.id),JSON.stringify(calls.map(call=>[call.method,call.route]))).toBe(true),{interval:10,timeout:1500});
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(()=>expect(f.sent,JSON.stringify(calls.map(call=>[call.method,call.route,call.body?.action]))).toContainEqual(expect.stringContaining('Read this from the phone.')),{interval:10,timeout:1500});
    expect(cloud.homes.isHomeHere(profile.id)).toBe(true);
    await vi.waitFor(()=>expect(calls.find(call=>call.route.endsWith(`/executions/${executionId}`)&&call.body?.action==='complete')).toBeDefined(),{interval:10,timeout:1000});
    const canonical=(await f.host.profiles.get(profile.id))!.sessionId;
    expect((await f.host.messages(canonical)).filter(message=>message.role==='user')).toHaveLength(1);
    holdHistory=true;
    const pending=cloud.invoke('maker:companion-cloud:transcript',[profile.id]);
    const outcome=pending.then(()=>({ok:true as const}),error=>({ok:false as const,error}));
    await vi.waitFor(()=>expect(late).toBeDefined(),{interval:10,timeout:1000});
    await cloud.close();f.revoke();send(late!,[]);
    expect(await outcome).toMatchObject({ok:false});
    expect(activeCompanionCloud()).toBeNull();expect(()=>cloud.homes.snapshot()).toThrow('COMPANION_CLOUD_CLOSED');
    const count=calls.length;await vi.advanceTimersByTimeAsync(4000);expect(calls).toHaveLength(count);
    await expect(cloud.invoke('maker:companion-cloud:state',[])).rejects.toThrow('COMPANION_CLOUD_CLOSED');
  }finally{
    if(late&&!late.writableEnded)send(late,[]);await cloud.close();
    vi.useRealTimers();vi.unstubAllEnvs();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

/** Tier: security. Model-authored files cannot traverse a Profile boundary through
 * a local symlink; deleting a Profile must not resurrect it at daemon restart. */
it("rejects a linked private shelf and preserves deletion across restart", async () => {
  const f = await setup();
  const profile = await f.host.create({ id: "x".repeat(100), name: "A" });
  expect(profile.sessionId.length).toBeLessThan(100);
  const home = f.host.profiles.home(profile.id);
  await rm(path.join(home, "skills"), { recursive: true, force: true });
  await symlink(f.root, path.join(home, "skills"));
  await expect(
    f.host.profiles.writeSkill(profile.id, "escape", "body"),
  ).rejects.toThrow("UNSAFE_PROFILE_DIRECTORY");
  await f.host.remove(profile.id);
  expect(await f.host.profiles.list()).toEqual([]);
});

/** Tier: integration. A failed profile write used to leave the new identity
 * under the old runtime version. Exercise the real file/metadata commit and
 * startup recovery after a write fault, then reject an obsolete editor. */
it("keeps profile and identity version consistent when the original database rejects a change", async () => {
  const f=await setup(),profile=await f.host.create({name:'Before',soul:'Old identity'});
  const db=(await f.tasks.database).db;
  await db.exec("CREATE TRIGGER reject_profile_version BEFORE INSERT ON bot_profile_versions BEGIN SELECT RAISE(ABORT, 'FIXTURE_PROFILE_WRITE_FAILED'); END");
  try{
    await expect(f.host.change(profile.id,{name:'After',identitySource:'New identity',userContextSource:'Owner context'},profile.version)).rejects.toThrow('FIXTURE_PROFILE_WRITE_FAILED');
    expect(await f.host.profiles.get(profile.id)).toMatchObject({name:'Before',version:profile.version});
    expect(await f.host.profiles.read(profile.id,'SOUL.md')).toBe('Old identity');
  }finally{await db.exec('DROP TRIGGER reject_profile_version');}
  await f.host.change(profile.id,{name:'After',identitySource:'New identity',userContextSource:'Owner context'},profile.version);
  const restored=new TerminalCompanionProfiles(f.root,()=>{},f.tasks);
  expect(await restored.get(profile.id)).toMatchObject({name:'After',version:profile.version+1});
  expect(await restored.read(profile.id,'SOUL.md')).toBe('New identity');
  expect(await restored.read(profile.id,'USER.md')).toBe('Owner context');
  await expect(restored.change(profile.id,{identitySource:'Stale editor'},profile.version)).rejects.toThrow();
  expect(await restored.read(profile.id,'SOUL.md')).toBe('New identity');
});

/** Tier: integration. Task defaults previously leaked into companion routing,
 * and the remote resource had no editable chain or persisted tuning. */
it("edits companion defaults and individual chains through the published forms without inheriting task changes", async () => {
  const f = await setup();
  const provider = f.models
    .snapshot()
    .providers.find((provider) => provider.id === "fixture")!;
  await f.models.saveProvider(
    {
      ...provider,
      runtimes: {
        "claude-code": {
          ...provider.runtimes["claude-code"]!,
          models: [
            ...provider.runtimes["claude-code"]!.models,
            {
              id: "second",
              name: "Second",
              contextWindow: 200000,
              efforts: ["medium", "high"],
              supportsFastMode: true,
            },
          ],
        },
      },
    },
    {},
  );
  const profile = await f.host.create({ name: "Independent" });
  await f.models.setVisibility('claude-code','fixture',['second'],true);
  const registry = new RemoteResourceRegistry();
  await registerCompanionResources(registry, f.host);
  const client = {
    protocolVersion: 1,
    primitives: ["text", "form", "actions"],
    locale: "zh-CN",
  };
  const context = { controllerDeviceId: "owner" };
  const get = (id = "defaults") =>
    registry.get(context, { client, ref: companionModelsRef(id) });
  const invoke = (
    id: string,
    actionId: string,
    input: Record<string, unknown>,
  ) =>
    registry.invoke(context, {
      client,
      collectionId: "teammate-models",
      resourceRef: companionModelsRef(id),
      actionId,
      input,
    });
  await f.models.setDefault({
    agentKind: "claude-code",
    providerId: "fixture",
    model: "second",
  });
  await (
    await f.host.send(
      profile.id,
      "ordinary task defaults must not leak",
      "before",
    )
  ).completion;
  expect(f.starts.at(-1)?.model).toBe("test");
  const defaults = await get();
  const edit = defaults.actions!.find((action) =>
    action.id.startsWith("edit:"),
  )!;
  const selected = edit.fields![0].options!.find((option) =>
    String(option.label).includes("Second"),
  )!;
  const original = edit.fields![0].options!.find((option) =>
    String(option.label).endsWith(" · Test"),
  )!;
  await invoke("defaults", edit.id, {
    model1: selected.value,
    model2: original.value,
  });
  await expect(
    invoke("defaults", edit.id, { model1: original.value }),
  ).rejects.toThrow("COMPANION_MODEL_SETTINGS_CHANGED");
  const tuned = await get();
  await invoke(
    "defaults",
    tuned.actions!.find((action) => action.id.startsWith("tune-0:"))!.id,
    { effort: "high", speed: "fast" },
  );
  await (
    await f.host.send(profile.id, "independent default changed", "after")
  ).completion;
  profile.sessionId=(await f.host.profiles.get(profile.id))!.sessionId;
  expect(f.starts.at(-1)).toMatchObject({
    model: "second",
    effort: "high",
  });
  // Claude's proxy reads the original host axes at request time. Its native
  // handle does not apply the proxy's paid service tier during model switches.
  expect(f.configs.at(-1)?.runtimeAxes?.getSessionFastMode(profile.sessionId)).toBe(true);
  expect(await f.host.storage.get(profile.sessionId)).toMatchObject({
    model: "second",
    effort: "high",
    fastMode: true,
    source: "bot",
  });
  const personal = await get(profile.id);
  await invoke(
    profile.id,
    personal.actions!.find((action) => action.id.startsWith("edit:"))!.id,
    { model1: original.value },
  );
  expect((await f.host.profiles.get(profile.id))?.models).toEqual([
    {
      agentKind: "claude-code",
      providerId: "fixture",
      model: "test",
      fastMode: false,
    },
  ]);
  await (
    await f.host.send(profile.id, "own chain", "personal")
  ).completion;
  expect(f.starts.at(-1)).toMatchObject({ model: "test" });
  expect(f.configs.at(-1)?.runtimeAxes?.getSessionFastMode(profile.sessionId)).toBe(false);
  const invalid = await get(profile.id);
  await expect(
    invoke(
      profile.id,
      invalid.actions!.find((action) => action.id.startsWith("tune-0:"))!.id,
      { effort: "high", speed: "ultrafast" },
    ),
  ).rejects.toThrow();
  expect((await f.host.profiles.get(profile.id))?.models[0].fastMode).toBe(
    false,
  );
  f.revoke();
  await expect(
    invoke(
      "defaults",
      tuned.actions!.find((action) => action.id.startsWith("reset:"))!.id,
      {},
    ),
  ).rejects.toThrow("OWNER_CHANGED");
});

/** Tier: integration. Cloud transfer previously refused todos/workbench/routines.
 * A real companion turn through the shared scheduler must retain its source,
 * survive restart without replay, and suspend foreign-machine pre-run commands. */
it("runs a transferred routine in its companion and preserves portable owner data", async () => {
  const f = await setup();
  const profile = await f.host.create({ name: "Routine fixture" });
  profile.sessionId=await f.host.ensureCanonical(profile);
  const scheduler = new TerminalSchedulerHost({
    profileDir: f.root,
    tasks: f.tasks,
    companions: () => f.host,
    logger,
    emit() {},
  });
  schedulers.push(scheduler);
  const routines = new TerminalCompanionRoutines(f.host, scheduler);
  f.host.routines = routines;
  await routines.open();
  const store = await f.host.todos(profile.id);
  const todo = await store.patch({
    key: "owner-request",
    origin: "assigned",
    title: "Read the report",
    outcome: "A checked report",
    next: null,
    sources: [],
  });
  await store.importItems([{ ...todo, title: "Transferred report" }], []);
  expect((await store.read()).items[0].title).toBe("Transferred report");
  await f.host.workbench.mergeCompanionWorkbench(f.root, profile.id, "server", {
    directories: [
      {
        path: "C:\\Users\\test\\reports",
        deviceId: "desktop",
        addedAt: new Date(0).toISOString(),
      },
    ],
    tasks: {},
  });
  expect(
    (
      await f.host.workbench.readCompanionWorkbench(
        f.root,
        profile.id,
        "server",
      )
    ).directories,
  ).toEqual([
    {
      path: "C:\\Users\\test\\reports",
      deviceId: "desktop",
      addedAt: new Date(0).toISOString(),
    },
  ]);
  const input = {
    name: "Check",
    prompt: "Check the saved report",
    enabled: true,
    triggers: [
      { id: "hourly", kind: "interval" as const, intervalMs: 3_600_000 },
    ],
  };
  await routines.transfer.importCompanionRoutines(
    profile.id,
    [
      { id: "portable-routine-001", input, originDeviceId: "desktop" },
      {
        id: "foreign-check-routine-001",
        input: { ...input, preRunHook: { command: "desktop-only-command" } },
        originDeviceId: "desktop",
      },
    ],
    [],
    "server",
  );
  expect(
    (await routines.list(profile.id)).find(
      (row) => row.id === "foreign-check-routine-001",
    )?.enabled,
  ).toBe(false);
  const registry = new RemoteResourceRegistry();
  routines.registerResources(registry);
  const client = {
    protocolVersion: 1,
    primitives: ["text", "actions"],
    locale: "en",
  };
  await registry.invoke(
    { controllerDeviceId: "owner" },
    {
      client,
      collectionId: "routines",
      resourceRef: {
        collectionId: "routines",
        kind: "routine",
        id: "portable-routine-001",
      },
      actionId: "run",
    },
  );
  await vi.waitFor(()=>{const result=routines.engine.history('portable-routine-001')[0];expect(result?.status,JSON.stringify(result)).toBe('success');},{interval:10,timeout:2000});
  profile.sessionId=(await f.host.profiles.get(profile.id))!.sessionId;
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toContain("Check the saved report");
  profile.sessionId=(await f.host.profiles.get(profile.id))!.sessionId;
  const history = await f.host.messages(profile.sessionId);
  expect(
    history.find((row) => row.role === "user")?.agentMeta,
  ).toMatchObject({
    origin: { kind: "scheduler", scheduleId: "routine-portable-routine-001" },
  });
  expect(f.configs[0].tools?.providers.map((row) => row.name)).toContain(
    "cindy_helper",
  );
  await f.host.change(profile.id, { status: "paused" });
  expect(
    routines.engine
      .list(profile.id)
      .find((row) => row.id === "portable-routine-001")?.enabled,
  ).toBe(true);
  await routines.close();
  const restored = new TerminalCompanionRoutines(f.host, scheduler);
  f.host.routines = restored;
  await restored.open();
  expect(restored.engine.history("portable-routine-001")[0]?.status).toBe(
    "success",
  );
  await restored.engine.tick();
  expect(f.sent).toHaveLength(1);
  expect(
    (await restored.transfer.listCompanionRoutines(profile.id, "server"))
      .map((row) => row.id)
      .sort(),
  ).toEqual(["foreign-check-routine-001", "portable-routine-001"]);
});

// Integration: disabled terminal Skills previously remained in the native
// skills/ shelf, where harness discovery ignores .disabled sidecars. Exercise
// the original store/projection through the profile API and retain resources.
it('uses the original skill store and excludes disabled skills from native mounts without losing their files', async()=>{
  const f=await setup(),root=f.root;
  const profiles=f.host.profiles;
  try{
    const profile=await profiles.create({name:'Skill fixture'});
    await profiles.writeSkill(profile.id,'report','---\nname: report\ndescription: |\n  Make a careful report\n---\n\nCheck evidence.');
    await platform.atomicPrivateWrite(path.join(profiles.home(profile.id),'skills','report','template.txt'),'retained resource');
    expect((await profiles.runtimeSkills(profile.id)).skills).toEqual(expect.arrayContaining([expect.objectContaining({name:'report',description:'Make a careful report\n'})]));
    await profiles.setSkillEnabled(profile.id,'report',false);
    expect((await profiles.runtimeSkills(profile.id)).skills).toHaveLength(0);
    expect(await profiles.querySkills(profile.id,{query:'report'})).toMatchObject({total:1,skills:[{slug:'report',enabled:false}]});
    await expect(access(path.join(profiles.home(profile.id),'skills','report','SKILL.md'))).rejects.toMatchObject({code:'ENOENT'});
    expect(await readFile(path.join(profiles.home(profile.id),'disabled-skills','report','template.txt'),'utf8')).toBe('retained resource');
    await profiles.setSkillEnabled(profile.id,'report',true);
    expect((await profiles.runtimeSkills(profile.id)).skills).toHaveLength(1);
    expect(await readFile(path.join(profiles.home(profile.id),'skills','report','template.txt'),'utf8')).toBe('retained resource');
    await profiles.setSkillEnabled(profile.id,'report',false);
    const restored=new TerminalCompanionProfiles(root,()=>{},f.tasks);
    try{
      await vi.waitFor(async()=>expect((await restored.runtimeSkills(profile.id)).skills).toHaveLength(0));
      expect(await readFile(path.join(restored.home(profile.id),'disabled-skills','report','template.txt'),'utf8')).toBe('retained resource');
      expect(await restored.skillEnabled(profile.id,'report')).toBe(false);
    }finally{await restored.close();}
  }finally{await profiles.close();}
});
