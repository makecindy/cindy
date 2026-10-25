/**
 * Production entries: encrypted store and authenticated local service transport.
 * Rule: credentials-and-local-storage + the terminal host's single-writer contract.
 * Coverage gap: neither exists on the Desktop transport. Minimal failures: wrong
 * passphrase, a second host, or an unauthenticated pipe client. Tier: integration
 * because the test uses a private temporary directory and actual local sockets.
 */
/**
 * Production entries: encrypted store and authenticated local service transport.
 * Rule: credentials-and-local-storage + the terminal host's single-writer contract.
 * Coverage gap: neither exists on the Desktop transport. Minimal failures: wrong
 * passphrase, a second host, or an unauthenticated pipe client. Tier: integration
 * because the test uses a private temporary directory and actual local sockets.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFile, spawn, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { buildLegacyAttachmentOssRef, RemoteResourceRegistry } from '@cindy/device-link';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { TerminalKnowledge } from './knowledge.js';
import { registerKnowledgeResources } from './knowledge-resources.js';
import type { Logger } from '@cindy/maker-core';
import { TerminalMediaTransfer } from './media-transfer.js';
import { TerminalSecretStore } from './secrets.js';
import { TerminalTransportServer, connectTerminal } from './transport.js';
import { TerminalService } from './service.js';
import { socketPath, privateDirectory, windowsSystemCommand, windowsPowerShellEnv } from './platform.js';
import { TerminalProtectedInput } from './protected-input.js';
import { TerminalConfiguration } from './configuration.js';
import { createServer } from 'node:http';
import sharp from 'sharp';

import { registerModelConfigurationResources } from './models/resources.js';
import { readModelConfiguration, saveModelProvider, invokeModelConfiguration } from './models/client.js';
import type { TerminalClient } from './contracts.js';

import { registerCapabilityResources } from './tasks/capability-resources.js';
import { inputHandoffPresentation, type InputHandoffSnapshot } from '@cindy/device-link';
import { fileURLToPath } from 'node:url';
import { openNodeDatabase } from './database.js';
import { createPersistedSessions } from '@cindy/app-runtime/persistedSessions';


import { withCrossProcessLock } from '@cindy/remote-agent/crossProcessLock';
import { originalEventRuntimeFixture } from './testing/original-event-runtime.js';
import { RemoteFileBrowserManager } from '@cindy/app-runtime/remoteFileBrowser';
import { createRemoteFileCache } from '@cindy/app-runtime/remoteFileCache';
import { createSshMedia } from '@cindy/app-runtime/sshMedia';
import { TerminalFileBrowser } from './file-browser.js';
import { buildRemoteMediaUrl } from '@cindy/maker-shared/remoteMediaUrl';

// Integration: the original media service was absent from the Node host. A
// configured image connection must execute, persist and recover its real blob;
// the original display/disable gates must still reject a stale prepared request.
it('runs original durable media without GUI and recovers it after restarting the host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-node-media-'));
  const bytes = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const calls: Array<{ path?: string; authorization?: string; model: unknown }> = [];
  const api = createServer(async (req, res) => {
    if (!req.url?.endsWith('/images/generations')) { res.writeHead(503).end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    calls.push({ path: req.url, authorization: req.headers.authorization, model: JSON.parse(raw).model });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ b64_json: bytes.toString('base64') }] }));
  });
  api.listen(0, '127.0.0.1'); await once(api, 'listening');
  const endpoint = `http://127.0.0.1:${(api.address() as net.AddressInfo).port}`;
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { values.set(key, value); }, delete: async (key: string) => { values.delete(key); } };
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  const { TerminalTaskHost } = await import('./tasks/host.js');
  const open = async () => {
    const host = new TerminalTaskHost({ profileDir: root, secretStore: secrets, logger, emit() {}, nativeStatus: async () => ({ authenticated: false }) });
    await host.ready;
    const owner = (await host.database).getCurrentDbClientSnapshot()!;
    host.mediaRuntime.bindAccount({ endpoint: () => endpoint,
      auth: { getAuthState: () => ({ mode: 'local', dataOwnerId: owner.userId, ownerGeneration: owner.clientEpoch }), getActiveAuthRealm: () => 'global' },
      apiAuth: { getAccessToken: () => null, refresh: async () => false, invalidateSession: () => { throw new Error('UNEXPECTED_ACCOUNT_INVALIDATION'); } } });
    return host;
  };
  let host: InstanceType<typeof TerminalTaskHost> | undefined;
  try {
    host = await open();
    await host.models.saveProvider({ id: 'media-fixture', name: 'Media fixture', auth: { method: 'apiKey' }, runtimes: {
      pi: { baseUrl: `${endpoint}/v1`, wireProtocol: 'openai-chat', imageApi: 'openai-images', models: [
        { id: 'fixture-image', name: 'Fixture image', mode: 'image_generation', modalities: { input: ['text', 'image'], output: ['image'] } },
      ] },
    } }, { pi: 'synthetic-media-key' }, true);
    expect(await host.mediaRuntime.callCindyMedia({ action: 'list_models', capability: 'image.generate' })).toMatchObject({ ok: true, models: [{ id: 'fixture-image', provider_id: 'media-fixture' }] });
    const prepared = await host.mediaRuntime.callCindyMedia({ action: 'prepare', providerId: 'media-fixture', modelId: 'fixture-image', capability: 'image.generate' });
    expect(prepared).toMatchObject({ ok: true, status: 'prepared' });
    const invocationId = prepared.invocation_id as string;
    const generated = await host.mediaRuntime.callCindyMedia({ action: 'request', invocationId, body: { prompt: 'A square' } });
    expect(generated).toMatchObject({ ok: true, status: 'complete' });
    const url = (generated.xdt_image_urls as string[])[0];
    expect(calls).toEqual([{ path: '/v1/images/generations', authorization: 'Bearer synthetic-media-key', model: 'fixture-image' }]);
    const original = await host.mediaRuntime.callCindyMedia({ action: 'resolve_local_path', url });
    expect(await fs.readFile(original.local_path as string)).toEqual(bytes);
    await host.close(); host = await open();
    const recovered = await host.mediaRuntime.callCindyMedia({ action: 'request', invocationId, body: { prompt: 'Must reuse completed result' } });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ ok: true, status: 'complete', xdt_image_urls: [url] });
    expect(calls).toHaveLength(1);
    const second = await host.mediaRuntime.callCindyMedia({ action: 'prepare', providerId: 'media-fixture', modelId: 'fixture-image', capability: 'image.generate' });
    await host.models.setVisibility('pi', 'media-fixture', ['fixture-image'], false);
    const rejected = await host.mediaRuntime.callCindyMedia({ action: 'request', invocationId: second.invocation_id as string, body: { prompt: 'Must not dispatch' } });
    expect(rejected.ok).toBe(false);
    expect(calls).toHaveLength(1);
  } finally {
    await host?.close();
    api.closeAllConnections(); await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('terminal private host', () => {
  let directory: string;
  beforeAll(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(),'cindy-terminal-host-')); });
  afterAll(async () => { await fs.rm(directory,{recursive:true,force:true}); });

  // Integration: the original file-service daemon, RPC manager, cache and media
  // handlers must run without Electron. Only the SSH byte transport is replaced
  // by a local pipe; permission, paths, bytes and persistence are real.
  it('uses the original remote file daemon through the Node file and media entry points', async () => {
    const root=path.join(directory,'ssh-files');
    const workdir=path.join(root,'work');
    await fs.mkdir(workdir,{recursive:true});
    await fs.writeFile(path.join(workdir,'说明.md'),'原始内容');
    const picture=Buffer.from('remote image bytes');
    await fs.writeFile(path.join(workdir,'image.png'),picture);
    const daemon=fileURLToPath(new URL('../../../packages/remote-file-service/dist/file-service.mjs',import.meta.url));
    const version=JSON.parse((await promisify(execFile)(process.execPath,[daemon,'--version'])).stdout);
    const children:ReturnType<typeof spawn>[]=[];
    const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return this;}};
    const files=new RemoteFileBrowserManager({
      logger,ensureHostReady:async()=>{},
      probe:async()=>({nodeReady:true,installed:true,schemaVersion:version.schemaVersion,bundleVersion:version.bundleVersion,binaryPath:daemon,nodeBinaryPath:process.execPath,rgPath:null}),
      install:async()=>{throw new Error('UNEXPECTED_INSTALL');},
      getHost:()=>({execStream:async()=>{
        const child=spawn(process.execPath,[daemon],{stdio:['pipe','pipe','pipe'],windowsHide:true});
        children.push(child);
        return {
          write:(data:string|Buffer)=>{child.stdin.write(data);},
          onStdout:(cb:(chunk:string)=>void)=>{const listener=(data:Buffer)=>cb(data.toString());child.stdout.on('data',listener);return ()=>{child.stdout.off('data',listener);};},
          onStdoutBytes:(cb:(chunk:Buffer)=>void)=>{child.stdout.on('data',cb);return ()=>{child.stdout.off('data',cb);};},
          onStderr:(cb:(chunk:string)=>void)=>{const listener=(data:Buffer)=>cb(data.toString());child.stderr.on('data',listener);return ()=>{child.stderr.off('data',listener);};},
          onClose:(cb:(info:{code:number|null;signal:string|null})=>void)=>{const listener=(code:number|null,signal:string|null)=>cb({code,signal});child.on('close',listener);return ()=>{child.off('close',listener);};},
          onError:(cb:(error:Error)=>void)=>{child.on('error',cb);return ()=>{child.off('error',cb);};},
          kill:()=>{child.kill();},
        };
      }}),
    });
    const cache=createRemoteFileCache({userDataDirectory:()=>root,activeOwnerScopeKey:()=>'fixture:1',dataOwnerStorageKey:id=>id,logger});
    let chunkReads=0;
    const media=createSshMedia({logger,fetchToCache:cache.fetchRemoteFileToCache,request:async(host,method,params)=>{
      if(method==='readFileChunk')chunkReads++;
      return await files.request(host,method,params as never) as never;
    }});
    const browser=new TerminalFileBrowser(root,()=>{},undefined,{files,media},logger);
    const origin={kind:'ssh' as const,remoteHostId:'fixture',workdir};
    const context={source:'local' as const,assertCurrent(){}};
    try {
      const entries=await browser.invoke('maker:file-browser:list-dir',[{remoteHostId:'fixture',workdir}],context);
      expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({name:'说明.md'})]));
      await expect(browser.invoke('maker:file-browser:read-file',[{remoteHostId:'fixture',workdir,relPath:'说明.md'}],context)).resolves.toMatchObject({ok:true,data:{content:'原始内容'}});
      await expect(browser.invoke('maker:file-browser:write-file',[{remoteHostId:'fixture',workdir,relPath:'说明.md',content:'新内容'}],context)).resolves.toMatchObject({ok:true});
      expect(await fs.readFile(path.join(workdir,'说明.md'),'utf8')).toBe('新内容');
      const source=`xdt-file://open?path=${encodeURIComponent(path.join(workdir,'image.png'))}`;
      const denied=await media.materializeSshRemoteMedia(origin,source,undefined,{maxBytes:1});
      expect(denied).toMatchObject({ok:false,status:403});
      expect(chunkReads).toBe(0);
      const opened=await browser.openMedia(buildRemoteMediaUrl(origin,source),context);
      try {expect(await opened.handle.readFile()).toEqual(picture);expect(opened.mimeType).toBe('image/png');}
      finally {await opened.handle.close();}
      expect(chunkReads).toBe(1);
      const again=await browser.openMedia(buildRemoteMediaUrl(origin,source),context);
      await again.handle.close();
      expect(chunkReads).toBe(1);
      await expect(media.materializeSshRemoteMedia(origin,`xdt-file://open?path=${encodeURIComponent(path.join(root,'outside.png'))}`)).resolves.toMatchObject({ok:false,status:403});
      await expect(browser.invoke('maker:file-browser:write-file',[{remoteHostId:'fixture',workdir,relPath:'说明.md',content:'revoked'}],{source:'remote',assertCurrent:()=>{throw new Error('OWNER_CHANGED');}})).rejects.toThrow('OWNER_CHANGED');
      expect(await fs.readFile(path.join(workdir,'说明.md'),'utf8')).toBe('新内容');
    } finally {
      browser.stop();
      await files.disposeAll();
      await Promise.all(children.map(async child=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'close');child.kill();await done;}}));
    }
  });

  // Integration: the Node host must use Desktop's real schema, worker, named
  // transactions and SessionStorage. A restart and an owner switch distinguish
  // it from the former separate JSON implementation; no Electron mock is used.
  it('uses the shared Desktop database runtime for tasks and companions across restart', async () => {
    const notices: unknown[] = [];
    const options = {
      userDataDirectory: path.join(directory, 'shared-runtime'),
      runtimeDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
      appDataRoot: path.join(directory, 'database-app-data'),
      ownerId: 'runtime-owner',
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      translate: (key: string) => key,
      broadcast: (_channel: string, payload: unknown) => { notices.push(payload); },
      reportFailure: (failure: unknown) => { notices.push(failure); },
      dialogueWorkspaceRoots: () => [],
    };
    let runtime = await openNodeDatabase(options);
    const now = Date.now();
    try {
      await runtime.sessionStorage.create({ id: 'runtime-task', agentKind: 'claude-code', workDir: directory, title: 'Shared runtime', model: 'fixture-model' });
      await runtime.db.tx('message.insert', {
        id: 'runtime-message', clientId: 'runtime-client', sessionId: 'runtime-task',
        role: 'user', content: '任务重启后保留', toolUseId: null, agentMeta: null,
        agentKind: 'cc', createdAt: now, guarded: false,
      });
      await runtime.db.tx('bots.createProfile', {
        id: 'runtime-companion', displayName: 'Runtime companion', description: '',
        avatar: '', avatarColor: '', identitySource: 'Original identity', capabilitiesJson: '{}', now,
      });
      await expect(runtime.db.tx('bots.updateProfile', {
        id: 'runtime-companion', identitySource: 'Stale edit', capabilitiesJson: '{}',
        profileContentChanged: true, expectedCurrentVersion: 0, now: now + 1,
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      await runtime.close();
      runtime = await openNodeDatabase(options);
      expect(await runtime.sessionStorage.get('runtime-task')).toMatchObject({ title: 'Shared runtime', agentKind: 'claude-code' });
      expect(await runtime.db.queryOne('SELECT content FROM messages WHERE id = ?', ['runtime-message'])).toEqual({ content: '任务重启后保留' });
      expect(await runtime.db.queryOne('SELECT identity_source FROM bot_profile_versions WHERE bot_id = ?', ['runtime-companion'])).toEqual({ identity_source: 'Original identity' });
      expect(await runtime.db.queryOne('SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH cjk_seg(?)', ['任务'])).toEqual({ n: 1 });
      await runtime.close();
      runtime = await openNodeDatabase({ ...options, ownerId: 'other-runtime-owner' });
      expect(await runtime.sessionStorage.get('runtime-task')).toBeNull();
      expect(await runtime.db.queryOne('SELECT count(*) AS n FROM bot_profiles')).toEqual({ n: 0 });
      expect(notices).toEqual([]);
    } finally { await runtime.close(); }
  }, 30_000);

  // Integration: execute the original Desktop message API and stream persistence
  // against the actual Node worker. This detects a second history/media store,
  // streamed-final duplication, lost restart history and stale-owner publication.
  it('runs original conversation and attachment services without an Electron process', async () => {
    const root = path.join(directory, 'shared-conversations');
    const options = {
      userDataDirectory: root, runtimeDirectory: fileURLToPath(new URL('../dist', import.meta.url)),
      appDataRoot: path.join(directory, 'conversation-app-data'), ownerId: 'conversation-owner',
      logger: { debug() {}, info() {}, warn() {}, error() {} }, translate: (key: string) => key,
      broadcast() {}, reportFailure(failure: unknown) { throw failure; },
      dialogueWorkspaceRoots: () => [path.join(root, 'dialogues')],
    };
    let database = await openNodeDatabase(options);
    let generation = 1;
    const published: Array<{channel:string;payload:unknown}> = [];
    const create = () => {
      const owner = database.getCurrentDbClientSnapshot()!;
      const ownerScopeKey = options.ownerId + ':' + generation;
      const ownerStamp = { dataOwnerId: options.ownerId, ownerGeneration: generation };
      const current = () => database.getCurrentDbClientSnapshot() === owner;
      const handlers = new Map<string, (event: object, ...args: any[]) => unknown>();
      const runtime = createPersistedSessions({
        database, logger: options.logger, region: 'global', userDataDirectory: () => root,
        piAgentHomeForSession: () => path.join(root, 'pi-agent-home'),
        piSubagentRunHomes: async () => [path.join(root, 'pi-agent-home')],
        mediaDirectory: () => root,
        ipc: {handle: (channel, handler) => { handlers.set(channel, handler); }},
        broadcastLocal: (channel, payload, ..._stamp) => { published.push({channel,payload}); },
        broadcastTrustedLocal: (channel, payload, ..._stamp) => { published.push({channel,payload}); },
        getActiveDataOwnerPushStamp: () => ownerStamp,
        broadcastTap: {
          captureDataOwnerBroadcastScope: () => ({ownerScopeKey,ownerStamp}),
          isDataOwnerBroadcastScopeCurrent: scope => current() && scope.ownerScopeKey === ownerScopeKey,
          getSafeDataOwnerPushStamp: () => current() ? ownerStamp : undefined,
          tapWindowBroadcast: (channel, payload) => { published.push({channel,payload}); },
        },
        owner: {
          activeOwnerScopeKey: () => current() ? ownerScopeKey : 'closed',
          getActiveAppSession: () => ({dataOwnerId: current() ? options.ownerId : null}),
          isAppSessionBoundaryPending: () => !current(),
          dataOwnerStorageKey: value => createHash('sha256').update(value).digest('hex').slice(0,20),
          withCrossProcessLock,
        },
        assertTrustedAppRendererEvent() {}, isDeviceLinkInvoke: () => false,
        getDeviceLinkInvokeContext: () => null, setHistoryWorkPageReader() {},
        scheduleBotRemoteResourceChangedForSession() {}, getSessionProvider: () => 'fixture-provider',
        materializeSshRemoteMedia: async () => { throw new Error('Unexpected SSH attachment'); },
        dialogueWorkspaceRoots: options.dialogueWorkspaceRoots,
        readDialogueWorkspaceSettings: () => ({directory: options.dialogueWorkspaceRoots()[0], isCustomized:false}),
        readGitSafetySettings: () => ({autoSnapshotEnabled:false,autoInitProjectGit:false}),
        ensureProjectGitInitialized: async () => undefined, admitModel: async body => body,
        localRecipients: () => [{isDestroyed:()=>false,isTrusted:()=>true,send:(channel,payload)=>{published.push({channel,payload});}}],
        senderId: () => 1, physicalWorktreeKey: async value => value,
        withWorktreeResourceLocks: (_resources, work) => work(), managedWorktreeRoot: () => null,
        notifyWorktreeRecycleOpportunity() {}, clearSessionAttention() {},
        commitBotProfileDeletion: async () => { throw new Error('No companion fixture'); },
        bindDeletedPiSubagentCleanupCancel() {},
        emitSessionCreated: sessionId => {published.push({channel:'local-db:sessions:created',payload:{sessionId}});},
        emitSessionListChangedLocally: sessionId => {published.push({channel:'local-db:sessions:created',payload:{sessionId}});},
        assertRendererSessionSourceAllowed: input => { if(input.source!==undefined)throw new Error('No privileged fixture source'); },
        notifyAgentIslandSessionPatch() {}, formatInterruptedToolDetail: name => name,
        removeTurnChangeSetsForSession: async () => undefined, settleMakeTasksForSession: async () => undefined,
        recycleCindyMakeTask: async () => undefined,
        consumeWritableDirectoryPickerGrants: async () => {throw new Error('No directory grants in fixture');},
        imAttachmentsRoot: () => path.join(root,'im-attachments'), removeImSessionAttachmentDirs: async () => undefined,
        loadSharedTasks: async () => ({prepareSharedTaskClosureForTask:async()=>null,rollbackPreparedSharedTaskClosure:async()=>undefined,
          finalizePreparedSharedTaskClosure:async()=>undefined,closeSharedTaskForTask:async()=>undefined}),
        loadMaker: async () => ({getMakerIfReady:()=>null}),
        loadWorktreeRecycle: async () => ({isSessionStillRemovable:async()=>true,hasRegisteredWorktreeForSession:()=>false,recycleWorktreeForRemovedSession:async()=>undefined}),
        loadPluginNotifications: async () => ({notifyGhostSessionEvent(){}}),
        loadSummaries: async () => ({backfillPinnedSessionSummaries(){},setPinnedSectionCardMode(){},maybeGenerateSessionTaskSummary(){}}),
        loadTranscriptRelocation: async () => ({relocateClaudeTranscriptsForSessionMove:async()=>{throw new Error('No Claude fixture');}}),
      });
      runtime.register();
      return {...runtime,invoke: (channel:string,...args:unknown[]) => handlers.get(channel)!({},...args),
        events:(id:string,workDir:string)=>originalEventRuntimeFixture({runtime,database,logger:options.logger,
          owner:{ownerScopeKey,ownerStamp},current,publish:(channel,payload)=>{published.push({channel,payload});},id,workDir})};
    };
    let runtime = create();
    let events: ReturnType<typeof originalEventRuntimeFixture> | undefined;
    try {
      await runtime.invoke('local-db:sessions:create',{id:'conversation-task',title:'Original runtime',agentKind:'pi',
        model:'fixture-model',providerId:'fixture-provider',workspaceKind:'dialogue',permissionMode:'ask'});
      const opened = await runtime.sessions.getSessionRowSnapshotStrict('conversation-task');
      expect(opened?.workingDir).toContain(path.join(root,'dialogues'));
      await runtime.invoke('local-db:sessions:update','conversation-task',{title:'GUI and TUI share this task'});
      expect(await runtime.invoke('local-db:sessions:get','conversation-task')).toMatchObject({id:'conversation-task',title:'GUI and TUI share this task'});

      const scope = runtime.media.journal.captureMediaRefCompensationScope();
      const image = await runtime.media.ingestMedia({
        buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64'),
        mimeType:'image/png',refs:[{refKind:'session-attachment',refId:'conversation-task',originKind:'user'}],
        assertStillValid:scope.assertStillValid,refCompensationScope:scope,
      },database.db.drizzle);
      const content={text:'保留这张图片',images:[{url:image.url}]};
      await runtime.invoke('local-db:messages:create','conversation-task',{clientId:'original-user',role:'user',content});
      // A retry traverses the same registered handler and returns the original row.
      await runtime.invoke('local-db:messages:create','conversation-task',{clientId:'original-user',role:'user',content});
      runtime.persistence.noteSessionAgentKind('conversation-task','pi');
      events=runtime.events('conversation-task',opened!.workingDir!);
      events.emit({type:'status',data:{isRunning:true}});
      for (const data of [{text:'保留'},{text:'成功'},
        {text:'保留成功',isFinal:true,isFullText:true},{text:'保留成功',isFinal:true,isFullText:true}]) {
        events.emit({type:'text',data:{...data,agentMessageId:'native-answer'}});
      }
      events.emit({type:'status',data:{isRunning:false,status:'Done',contextTokens:18,contextWindow:32000}});
      events.emit({type:'done',data:{usage:{inputTokens:10,outputTokens:5,cacheReadTokens:2,cacheCreationTokens:1}}});
      await events.settled();
      const page = await runtime.invoke('local-db:messages:list','conversation-task',{limit:50}) as Array<{role:string;content:unknown}>;
      expect(page.map(row=>row.role)).toEqual(['assistant','user']);
      expect(page[0].content).toBe('保留成功');
      const sealed=await database.db.queryOne<{agent_meta:string}>('SELECT agent_meta FROM messages WHERE session_id = ? AND role = ?',['conversation-task','assistant']);
      expect(JSON.parse(sealed!.agent_meta)).toMatchObject({turnCompleted:true,turnUsageDetails:{inputTokens:10,outputTokens:5,cacheReadTokens:2,cacheCreateTokens:1}});
      expect(await database.db.queryOne('SELECT total_token_usage AS tokens, context_tokens AS context, context_window_runtime AS budget FROM sessions WHERE id = ?',['conversation-task'])).toEqual({tokens:18,context:18,budget:32000});
      expect(await runtime.media.ledger.sessionCanRead(image.hash,'conversation-task')).toBe(true);
      expect(await database.db.queryOne('SELECT count(*) AS n FROM messages WHERE session_id = ?',['conversation-task'])).toEqual({n:2});
      await events.close();events=undefined;
      await database.close();
      const before = published.length;
      runtime.persistence.onAssistantTextEvent('conversation-task',{text:'stale answer',isFinal:true},null);
      await runtime.persistence.drainPersistQueue();
      expect(published).toHaveLength(before);
      generation += 1;
      database = await openNodeDatabase(options);
      runtime = create();
      const restored = await runtime.invoke('local-db:messages:list','conversation-task',{limit:50}) as typeof page;
      expect(restored).toEqual(page);
      expect(await runtime.media.ledger.sessionCanRead(image.hash,'conversation-task')).toBe(true);
      expect(await fs.readFile(runtime.media.blobStore.resolveSafe(image.url).absPath)).toHaveLength(68);
      await runtime.sessions.touchUserSendInDb('conversation-task',Date.now());
      expect((await runtime.invoke('local-db:sessions:list',50,'active',{})) as unknown).toMatchObject([{id:'conversation-task',title:'GUI and TUI share this task'}]);
      await runtime.sessions.clearSessionContextInDb('conversation-task');
      expect(await runtime.invoke('local-db:messages:list','conversation-task',{limit:50})).toEqual([]);
      await runtime.drain('conversation-task');
    } finally { await events?.close();await database.close(); }
  },30_000);

  // Native Windows integration: interpreter reuse must not cache permissions.
  // Reintroducing a broad explicit ACE is the minimum regression input; it must
  // disappear on the next privateDirectory call, even for the same directory.
  it.runIf(process.platform==='win32')('replaces modified Windows directory permissions on every write',async()=>{
    const root=path.join(directory,'权限 directory');await privateDirectory(root);
    const execute=promisify(execFile);
    const shell=async(script:string)=>(await execute(windowsSystemCommand('powershell'),['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,env:{...windowsPowerShellEnv(),CINDY_ACL_TEST:root}})).stdout.trim();
    await shell("$ErrorActionPreference='Stop'; $acl=[IO.Directory]::GetAccessControl($env:CINDY_ACL_TEST); $sid=[Security.Principal.SecurityIdentifier]::new('S-1-5-32-545'); $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); [IO.Directory]::SetAccessControl($env:CINDY_ACL_TEST,$acl)");
    await privateDirectory(root);
    const result=JSON.parse(await shell("$ErrorActionPreference='Stop'; $acl=[IO.Directory]::GetAccessControl($env:CINDY_ACL_TEST); $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; @{protected=$acl.AreAccessRulesProtected; owner=$owner; rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { @{sid=$_.IdentityReference.Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString()} })} | ConvertTo-Json -Compress"));
    expect(result.protected).toBe(true);
    expect(result.rules.map((rule:{sid:string})=>rule.sid).sort()).toEqual([result.owner,'S-1-5-18'].sort());
    expect(result.rules.every((rule:{inherited:boolean;type:string})=>!rule.inherited&&rule.type==='Allow')).toBe(true);
  });

  // Linux ARM64 native restart accepted IPC while listen() was still releasing
  // its lock, before initialize() had assigned tasks. Hold that exact boundary;
  // the real authenticated status request must wait and then return a full host.
  it('holds early authenticated requests until the host is initialized', async () => {
    const root=path.join(directory,'startup-barrier'),service=new TerminalService(root, 'global', { worktreeAppDataRoot: path.join(directory, 'worktree-app-data') });
    let publish!:()=>void,release!:()=>void,entered!:()=>void;
    const published=new Promise<void>(resolve=>{publish=resolve;});
    const releasing=new Promise<void>(resolve=>{release=resolve;});
    const requested=new Promise<void>(resolve=>{entered=resolve;});
    const listen=service.transport.listen.bind(service.transport);
    service.transport.listen=async()=>{await listen();publish();await releasing;};
    const boundary=service.transport as unknown as {invoke(channel:string,args:unknown[],device?:string):Promise<unknown>};
    const invoke=boundary.invoke.bind(boundary);
    boundary.invoke=(...args)=>{const pending=invoke(...args);entered();return pending;};
    const starting=service.start();let client:Awaited<ReturnType<typeof connectTerminal>>|undefined;
    try{
      await published;client=await connectTerminal(root);
      let settled=false;
      const status=client.invoke('terminal:status').then(value=>{settled=true;return value;},error=>{settled=true;throw error;});
      void status.catch(()=>{});
      await requested;await new Promise<void>(resolve=>setImmediate(resolve));
      expect(settled).toBe(false);
      release();await starting;
      expect(await status).toMatchObject({busy:false,deviceId:expect.any(String),version:expect.any(String)});
    }finally{release();await starting.catch(()=>{});client?.close();await service.close();}
    // This case opens the full private profile, including native Windows ACL
    // commands. Keep the local 5s budget while allowing the Windows CI host IO.
  },process.platform==='win32'?30_000:5_000);

  // Integration: resource edits must use GUI's project records and aliases,
  // including its hide/re-add behavior. A separate projects.json hid edits
  // from original recent-workdir IPC and Agent project tools.
  it('uses original project storage for terminal registration, rename and hide',async()=>{
    const root=path.join(directory,'original-projects'),project=path.join(directory,'registered-project');await fs.mkdir(project);
    const service=new TerminalService(root,'global',{worktreeAppDataRoot:path.join(directory,'worktree-app-data')});
    await service.start();const client=await connectTerminal(root);
    const descriptor={protocolVersion:1,primitives:['text','actions']};
    const list=()=>client.invoke<{items:Array<{ref:{collectionId:string;kind:string;id:string};display:{title:string}}>}>('maker:remote-resources:list',[{client:descriptor,collectionId:'projects'}]);
    try{
      await client.invoke('maker:remote-resources:invoke',[{client:descriptor,collectionId:'projects',actionId:'add',input:{directory:project,name:'Original project'}}]);
      expect(await client.invoke('local-db:recent-workdirs:list')).toEqual(expect.arrayContaining([expect.objectContaining({path:project})]));
      expect(await client.invoke('local-db:project-aliases:list')).toEqual(expect.arrayContaining([expect.objectContaining({projectKey:`local:${project}`,alias:'Original project'})]));
      const row=(await list()).items.find(item=>item.display.title==='Original project');expect(row).toBeDefined();
      await client.invoke('maker:remote-resources:invoke',[{client:descriptor,collectionId:'projects',resourceRef:row!.ref,actionId:'remove'}]);
      expect((await list()).items).not.toEqual(expect.arrayContaining([expect.objectContaining({ref:row!.ref})]));
      expect(await client.invoke('local-db:recent-workdirs:list')).toEqual(expect.arrayContaining([expect.objectContaining({path:project})]));
      await client.invoke('maker:remote-resources:invoke',[{client:descriptor,collectionId:'projects',actionId:'add',input:{directory:project}}]);
      expect((await list()).items).toEqual(expect.arrayContaining([expect.objectContaining({ref:row!.ref,display:expect.objectContaining({title:'Original project'})})]));
    }finally{client.close();await service.close();}
  },process.platform==='win32'?30_000:5_000);

  // Integration: original task metadata routes must reach their real DB
  // transactions in a terminal host, including after process recreation.
  it('persists original GUI task tags through the terminal IPC entry',async()=>{
    const root=path.join(directory,'original-task-tags'),options={worktreeAppDataRoot:path.join(directory,'worktree-app-data')};
    let service=new TerminalService(root,'global',options),client:Awaited<ReturnType<typeof connectTerminal>>|undefined;
    try{
      await service.start();client=await connectTerminal(root);
      const created=await client.invoke<{tags:Array<{id:string;name:string;revision:number}>}>('local-db:task-tags:execute',[{action:'create',name:'Fixture tag',color:'blue'}]);
      const tag=created.tags.find(row=>row.name==='Fixture tag');expect(tag).toBeDefined();
      client.close();client=undefined;await service.close();
      service=new TerminalService(root,'global',options);await service.start();client=await connectTerminal(root);
      const result=await client.invoke<{tags:unknown[]}>('local-db:task-tags:execute',[{action:'list'}]);
      expect(result.tags).toContainEqual(tag);
    }finally{client?.close();await service.close();}
  },process.platform==='win32'?30_000:5_000);

  // First-run/locked-vault regression: a persisted MCP must not prevent the
  // real local host from starting so the user can set up/unlock its vault.
  // This exercises socket requests and restart, not a mocked credential store.
  it('starts with a locked vault and activates persisted MCP and Cindy after local unlock', async () => {
    const root=path.join(directory,'locked-vault-startup');
    const options={worktreeAppDataRoot:path.join(directory,'worktree-app-data')};
    let service=new TerminalService(root,'global',options);
    let client:Awaited<ReturnType<typeof connectTerminal>>|undefined;
    try {
      await service.start();client=await connectTerminal(root);
      expect(await client.invoke('terminal:status')).toMatchObject({vault:{locked:true}});
      await client.invoke('terminal:vault:initialize',['passphrase','local-integration-test-passphrase']);
      await client.invoke('terminal:configuration',[{collectionId:'mcp',actionId:'create',input:{id:'locked-mcp',name:'Locked MCP',transport:'sse',url:'https://example.invalid/mcp',token:'fixture-token'}}]);
      expect(await client.invoke('maker:mcp:custom:list')).toBeDefined();
      // Opening WeChat creates the original default Cindy profile. Its model
      // projection used to read encrypted provider credentials during restart.
      const wechat={client:{protocolVersion:1,primitives:['text','actions']},ref:{collectionId:'channels',kind:'im-channel',id:'wechat'}};
      const before=await client.invoke('maker:remote-resources:get',[wechat]);
      expect(before).toBeDefined();
      client.close();client=undefined;await service.close();
      service=new TerminalService(root,'global',options);await service.start();client=await connectTerminal(root);
      expect(await client.invoke('terminal:status')).toMatchObject({vault:{locked:true}});
      await expect(client.invoke('terminal:vault:unlock',['wrong-passphrase'])).rejects.toThrow();
      expect(await client.invoke('terminal:status')).toMatchObject({vault:{locked:true}});
      await client.invoke('terminal:vault:unlock',['local-integration-test-passphrase']);
      expect(await client.invoke('terminal:status')).toMatchObject({vault:{locked:false}});
      expect((service as unknown as {tasks:{mcpApps:{providers():Array<{name:string}>}}}).tasks.mcpApps.providers().map(value=>value.name)).toContain('locked-mcp');
      expect(await client.invoke('maker:remote-resources:get',[wechat])).toEqual(before);
    } finally {client?.close();await service.close();}
  },process.platform==='win32'?30_000:5_000);

  // Integration: stopping the daemon must join its managed work and children,
  // not only do so on account changes. A live Node child catches orphan leaks.
  it('stops managed downloads and local runtime children on daemon shutdown', async () => {
    const root = path.join(directory, 'owned-runtime-close'), service = new TerminalService(root, 'global', { worktreeAppDataRoot: path.join(directory, 'worktree-app-data') });
    await service.start();
    const internals = service as unknown as {
      database: Awaited<ReturnType<typeof openNodeDatabase>>;
      engines: {install(kind: string, options?: {signal?: AbortSignal}): Promise<unknown>};
      localModels: {sidecar: {spawnManagedSidecar(binary: string, spawnImpl: typeof spawn): import('node:child_process').ChildProcess}};
    };
    const database=internals.database;
    let aborted = false;
    const install = internals.engines.install;
    internals.engines.install = async (_kind, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {aborted = true; reject(new Error('cancelled'));}, {once: true});
    });
    const child = internals.localModels.sidecar.spawnManagedSidecar(process.execPath, ((_binary: string, _args: string[], options: SpawnOptions) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options)) as unknown as typeof spawn);
    const closed = once(child, 'close');
    const client = await connectTerminal(root);
    try {
      const result = await client.invoke<{result: {state: string}}>('maker:remote-resources:invoke', [{client: {protocolVersion: 1, primitives: ['actions']}, collectionId: 'engines', resourceRef: {collectionId: 'engines', kind: 'engine', id: 'pi'}, actionId: 'install'}]);
      expect(result.result.state).toBe('running');
      await service.close(); await closed;
      expect(database.getCurrentDbClientSnapshot()).toBeNull();
      await expect(database.db.queryOne('SELECT 1')).rejects.toThrow();
      expect(aborted).toBe(true);
      expect(() => process.kill(child.pid!, 0)).toThrow();
    } finally {client.close(); internals.engines.install = install; await service.close(); if (child.exitCode === null && child.signalCode === null) child.kill();}
  }, process.platform === 'win32' ? 30_000 : 5_000);

  // Failed initialization happens after the private askpass listener starts.
  // The old catch closed only IPC, leaving a detached daemon alive forever.
  it('closes private listeners and finishes the host after failed initialization',async()=>{
    const root=path.join(directory,'failed-start'),owner=path.join(root,'owners',createHash('sha256').update('guest').digest('hex').slice(0,32));
    await privateDirectory(owner);await fs.writeFile(path.join(owner,'models.json'),'{invalid json', {mode:0o600});
    const listeners=()=>((process as unknown as {_getActiveHandles():Array<{address?:()=>unknown}>})._getActiveHandles()).flatMap(handle=>{const address=handle.address?.();return typeof address==='string'&&address.includes('cindy-ih-')?[address]:[];});
    const before=new Set(listeners()),service=new TerminalService(root, 'global', { worktreeAppDataRoot: path.join(directory, 'worktree-app-data') });let stopped=false;void service.stopped.then(()=>{stopped=true;});
    try{
      await expect(service.start()).rejects.toThrow();
      await new Promise<void>(resolve=>setImmediate(resolve));
      expect(listeners().filter(socket=>!before.has(socket))).toEqual([]);expect(stopped).toBe(true);
      await expect(connectTerminal(root)).rejects.toThrow('SERVICE_NOT_RUNNING');
    }finally{await service.close().catch(()=>{});}
  },process.platform==='win32'?30_000:5_000);

  // Integration: invoke the callback installed at the authentication boundary.
  // A plugin close error previously skipped the task input listener and other
  // owner stores. No sign-in/network fake is needed to exercise this teardown.
  it('revokes every owner service when one plugin cleanup fails during account change',async()=>{
    const root=path.join(directory,'owner-cleanup'),service=new TerminalService(root, 'global', { worktreeAppDataRoot: path.join(directory, 'worktree-app-data') });
    await service.start();
    const internals=service as unknown as {
      auth:{options:{beforeAccountChange():Promise<void>}};
      pluginMarket:{close():Promise<void>};knowledge:{snapshot():unknown};
      protectedInput:TerminalProtectedInput;
    };
    const close=internals.pluginMarket.close.bind(internals.pluginMarket);
    internals.pluginMarket.close=async()=>{await close();throw new Error('Synthetic plugin cleanup failure');};
    try{
      const input=internals.protectedInput,socket=input.askpass.socketPath;
      expect(()=>input.envFor('fixture-task')).not.toThrow();
      if(input.askpass.supported){expect(socket).not.toBeNull();expect((await fs.stat(socket!)).isSocket()).toBe(true);}
      await expect(internals.auth.options.beforeAccountChange()).rejects.toThrow();
      expect(()=>internals.knowledge.snapshot()).toThrow('KNOWLEDGE_CLOSED');
      expect(()=>input.envFor('fixture-task')).toThrow('INPUT_HANDOFF_CLOSED');
      if(socket)await expect(fs.stat(socket)).rejects.toMatchObject({code:'ENOENT'});
    }finally{internals.pluginMarket.close=close;await service.close();}
  },process.platform==='win32'?30_000:5_000);

  // Existing GUI attachments use signed OSS URLs. A corrupt or cancelled
  // transfer must never be adopted, and account tokens belong only on the API.
  it('streams verified attachments without forwarding account credentials to storage', async () => {
    const bytes=Buffer.from('attachment content');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    let corrupt=false,deleted=0,uploaded:Buffer|undefined;
    const transfer=new TerminalMediaTransfer({ownerDir:path.join(directory,'media'),getOwnerScope:()=> 'owner',getToken:async()=> 'test-only-token',getApiBaseUrl:()=> 'https://api.test',
      fetch:async(input,init)=>{
        const url=new URL(String(input));
        if(url.host==='api.test'){
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-token');
          if(init?.method==='DELETE'){deleted++;return Response.json({deleted:true});}
          return Response.json(url.pathname.endsWith('presign-put')?{putUrl:'https://storage.test/upload',key:'object-key'}:{getUrl:'https://storage.test/download'});
        }
        expect(new Headers(init?.headers).has('authorization')).toBe(false);
        if(init?.method==='PUT'){
          uploaded=Buffer.from(await new Response(init.body as BodyInit).arrayBuffer());
          expect(new Headers(init.headers).get('x-oss-object-acl')).toBe('private');
          return new Response(null,{status:200});
        }
        return new Response(corrupt?Buffer.from('corrupt'):bytes);
      }});
    const reference=buildLegacyAttachmentOssRef({ossKey:'object-key',mimeType:'text/plain',size:bytes.length,sha256});
    const result=await transfer.resolve(reference,{source:'remote',deviceId:'sender'});
    expect(await fs.readFile(result.path)).toEqual(bytes);
    expect(deleted).toBe(0);
    const handle=await fs.open(result.path,'r');
    try{const sent=await transfer.upload(handle,'text/plain','note.txt');expect(sent.sha256).toBe(sha256);expect(uploaded).toEqual(bytes);}
    finally{await handle.close();}
    await result.afterAcceptance?.();expect(deleted).toBe(1);await result.cleanup();
    corrupt=true;
    await expect(transfer.resolve(reference,{source:'remote',deviceId:'sender'})).rejects.toThrow('ATTACHMENT_INTEGRITY_FAILED');
    expect(await fs.readdir(path.join(directory,'media','attachment-staging'))).toEqual([]);
  });

  it('persists encrypted credentials and rejects the wrong passphrase', async () => {
    const dir=path.join(directory,'passphrase');
    const store=new TerminalSecretStore(dir);await store.open();
    await store.initialize('passphrase','test-only-passphrase');
    await store.set('provider','invalid-test-key');
    expect((await fs.readFile(path.join(dir,'secrets.enc'),'utf8')).includes('invalid-test-key')).toBe(false);
    store.lock();await expect(store.get('provider')).rejects.toThrow('VAULT_LOCKED');
    const restored=new TerminalSecretStore(dir);await restored.open();
    await expect(restored.unlock('wrong-test-passphrase')).rejects.toThrow('VAULT_UNLOCK_FAILED');
    await restored.unlock('test-only-passphrase');
    expect(await restored.get('provider')).toBe('invalid-test-key');
    await restored.delete('provider');expect(await restored.get('provider')).toBeNull();
    restored.lock();
  // Native integration: the first Windows ACL operation starts Windows
  // PowerShell on a cold runner; it has its own 15-second process deadline.
  },process.platform==='win32'?30_000:5_000);

  it('automatically unlocks only an explicitly selected machine-key store', async () => {
    const dir=path.join(directory,'machine');
    const store=new TerminalSecretStore(dir);await store.open();
    expect(store.status().initialized).toBe(false);
    await store.initialize('machine');
    // Integration: plugin refresh writes must commit before returning and must
    // not be overwritten by an older queued account write (shared-vault rule).
    const earlier=store.set('one','old-value');store.setSync('one','invalid-one');
    const second=store.set('two','invalid-two');store.setSync('removed','synthetic');store.deleteSync('removed');
    await Promise.all([earlier,second]);
    expect(store.getSync('one')).toBe('invalid-one');expect(store.getSync('removed')).toBeNull();
    store.lock();const next=new TerminalSecretStore(dir);await next.open();
    expect(await next.get('one')).toBe('invalid-one');expect(await next.get('two')).toBe('invalid-two');
    next.lock();expect(()=>next.getSync('one')).toThrow('VAULT_LOCKED');expect(()=>next.setSync('one','changed')).toThrow('VAULT_LOCKED');
  });

  it('authenticates calls, fans out events, retains the owner and redacts errors', async () => {
    const dir=path.join(directory,'transport');let calls=0;
    const server=new TerminalTransportServer(dir,async channel => {
      calls++;
      if(channel==='test:failure') throw new Error('invalid-test-key in provider error');
      return { channel };
    });
    await server.listen();
    const client=await connectTerminal(dir);
    const second=await connectTerminal(dir);
    try {
      expect(await client.invoke('test:status')).toEqual({channel:'test:status'});
      const pushed=new Promise(resolve=>second.subscribe((channel,args)=>resolve({channel,args})));
      client.close();server.publish('test:changed',[42]);
      expect(await pushed).toEqual({channel:'test:changed',args:[42]});
      await expect(second.invoke('test:failure')).rejects.toThrow('OPERATION_FAILED');
      const duplicate=new TerminalTransportServer(dir,async()=>null);
      await expect(duplicate.listen()).rejects.toThrow('SERVICE_ALREADY_RUNNING');
      await duplicate.close();
      expect(await second.invoke('test:owner')).toEqual({channel:'test:owner'});
      const unauthenticated=net.createConnection(socketPath(dir));
      await once(unauthenticated,'connect');
      const closed=once(unauthenticated,'close');
      unauthenticated.write(JSON.stringify({type:'invoke',id:'attack',channel:'test:status',args:[]})+'\n');
      await closed;
      expect(calls).toBe(3);
    } finally { client.close();second.close();await server.close(); }
    expect(await fs.stat(path.join(dir,'service.json')).catch(()=>null)).toBeNull();
    if(process.platform!=='win32') await fs.rm(path.dirname(socketPath(dir)),{recursive:true,force:true});
  });

  it('serializes simultaneous stale-owner takeovers without unlinking the winner socket', async () => {
    const dir = path.join(directory, 'concurrent-takeover');
    await privateDirectory(dir);
    await fs.writeFile(path.join(dir, 'service.json'), JSON.stringify({ version: 1, pid: 2147483647, socket: socketPath(dir), key: '0'.repeat(64), instance: 'dead-owner' }), { mode: 0o600 });
    const first = new TerminalTransportServer(dir, async () => 'first');
    const second = new TerminalTransportServer(dir, async () => 'second');
    const results = await Promise.allSettled([first.listen(), second.listen()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results[0]!.status === 'fulfilled' ? first : second;
    const loser = winner === first ? second : first;
    try {
      await loser.close();
      const client = await connectTerminal(dir);
      try { expect(await client.invoke('test:owner')).toBe(winner === first ? 'first' : 'second'); }
      finally { client.close(); }
    } finally { await first.close(); await second.close(); }
    if (process.platform !== 'win32') await fs.rm(path.dirname(socketPath(dir)), { recursive: true, force: true });
  });
});

// Integration: a terminal controller must use the existing signed GUI protocol.
// The entered value reaches the program once, never the plain wire or snapshots;
// an old step cannot be replayed after completion or an owner change.
it('delivers protected input through the signed exchange without recording its value', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-protected-input-'));
  const wire:unknown[]=[],events:unknown[]=[],answers:Array<string|null>=[];
  let active=true;
  const make=(id:string):TerminalProtectedInput=>{
    const secrets=new Map<string,string>();
    return new TerminalProtectedInput({root:path.join(root,id),
      secrets:{get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);},delete:async key=>{secrets.delete(key);}},
      scope:()=>({realm:'global',membershipId:'test-owner',deviceId:id}),
      assertCurrent:()=>{if(!active)throw new Error('OWNER_CHANGED');},remoteEnabled:()=>true,taskExists:async()=>true,
      emit:(channel,payload)=>events.push({channel,payload}),
      invoke:async(_device,_channel,args)=>{wire.push(args);return {ok:true,result:await host.request(id,args[0])};},
    });
  };
  const host=make('host-device'),controller=make('controller-device');
  try {
    host.handoff.startTerminalPrompt({sessionId:'test-task',program:'sudo',command:'sudo -A true',prompt:'Password:',answer:value=>answers.push(value)});
    const snapshot=host.handoff.pendingSnapshots()[0].request as InputHandoffSnapshot;
    const submission={expectedRevision:snapshot.revision,values:{[snapshot.controls.find(control=>control.kind==='text')!.id]:'synthetic-private-value'},action:{kind:'submit' as const}};
    expect(await controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).toEqual({accepted:true});
    expect(answers).toEqual(['synthetic-private-value']);
    expect(JSON.stringify({wire,events})).not.toContain('synthetic-private-value');
    await expect(controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).rejects.toThrow();
    active=false;
    await expect(controller.submitRemote('host-device',inputHandoffPresentation(snapshot),submission)).rejects.toThrow('OWNER_CHANGED');
  } finally {active=true;await controller.close();await host.close();await fs.rm(root,{recursive:true,force:true});}
});

// Integration: MCP create/edit used to forward tokens and headers over generic
// resource invoke. Existing protected-input coverage had no configuration
// persistence or stale-form boundary. One secret-bearing form is the regression.
it('saves MCP and provider configuration on the selected host through controller-bound encrypted leases', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-protected-configuration-'));
  const secrets=new Map<string,string>(),wire:unknown[]=[],events:unknown[]=[];
  const vault={get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},delete:async(key:string)=>{secrets.delete(key);}};
  let active=true,changeBeforeHandshake=false,wrongPeer=false;
  const guard=()=>{if(!active)throw new Error('OWNER_CHANGED');};
  const {TerminalTaskHost}=await import('./tasks/host.js');
  const runtimeLogger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return this;}};
  const taskHost=new TerminalTaskHost({profileDir:root,secretStore:vault,logger:runtimeLogger,emit(){},nativeStatus:async()=>({authenticated:false})});
  await taskHost.ready;
  const capabilities=taskHost.capabilities;
  const models=taskHost.models;
  const configuration=new TerminalConfiguration(capabilities,{revision:()=>models.revision(),save:(action,provider,keys,context)=>models.saveProvider(provider,keys,action==='create',context.assertCurrent)}),registry=new RemoteResourceRegistry();
  registerCapabilityResources(registry,capabilities,configuration);
  registerModelConfigurationResources(registry,models,configuration,async(channel,args,context)=>{
    if(channel==='maker:model-disable:set')return models.setDisabled(args[0],context.assertCurrent!);
    if(channel==='maker:provider:custom:delete')return models.deleteProvider(String(args[0]),context.assertCurrent);
    if(channel==='maker:provider:custom:disconnect')return models.disconnect(String(args[0]),context.assertCurrent!);
    throw new Error('UNEXPECTED_MODEL_OPERATION');
  });
  const make=(deviceId:string):TerminalProtectedInput=>new TerminalProtectedInput({root:path.join(root,deviceId),secrets:vault,
    scope:()=>({realm:'global',membershipId:'owner',deviceId}),assertCurrent:guard,remoteEnabled:()=>true,taskExists:async()=>true,
    emit:(channel,payload)=>events.push({channel,payload}),
    invoke:async(_device,channel,args)=>{
      wire.push({channel,args});
      if(channel==='maker:remote-resources:invoke'){
        const result=await registry.invoke({controllerDeviceId:deviceId,assertCurrent:guard},args[0] as Parameters<typeof registry.invoke>[1]);
        if(changeBeforeHandshake){
          if((args[0] as {collectionId:string}).collectionId==='providers')await models.resetDefault(guard);
          else await capabilities.invoke('maker:mcp:custom:refresh',[],{source:'local'});
        }
        return {ok:true,result};
      }
      return {ok:true,result:await host.request(wrongPeer?'different-controller':deviceId,args[0])};
    },
  });
  const host=make('host'),controller=make('controller');host.configureSettings(configuration);
  const client:TerminalClient={subscribe:()=>()=>{},close(){},async invoke<T>(channel:string,args:unknown[]=[],device?:string):Promise<T>{
    if(channel==='terminal:configuration'){
      expect(device).toBeUndefined();
      const value=args[0] as {deviceId:string;input:unknown};
      expect(value.deviceId).toBe('host');
      await controller.saveRemoteConfiguration(value.deviceId,value,value.input);
      return {saved:true} as T;
    }
    // Selecting a remote computer must never read or mutate the controller's
    // local model configuration, even when provider IDs coincide.
    expect(device).toBe('host');expect(channel).toBe('maker:remote-resources:invoke');
    wire.push({channel,args});
    return await registry.invoke({controllerDeviceId:'controller',assertCurrent:guard},args[0] as Parameters<typeof registry.invoke>[1]) as T;
  }};
  const input={id:'test-mcp',name:'Fixture',transport:'http',url:'https://example.test/mcp',scope:'user',token:'synthetic-mcp-token',headers:JSON.stringify({'X-Test':'synthetic-header-value'})};
  try{
    await capabilities.ready;
    await expect(registry.invoke({controllerDeviceId:'controller'},{client:{protocolVersion:1,primitives:['text']},collectionId:'mcp',actionId:'create',input})).rejects.toThrow('PROTECTED_INPUT_REQUIRED');
    await controller.saveRemoteConfiguration('host',{collectionId:'mcp',actionId:'create'},input);
    expect(JSON.parse(secrets.get('terminal:mcp:test-mcp')!)).toEqual({token:input.token,headers:{'X-Test':'synthetic-header-value'}});
    const publicState=await fs.readFile(path.join(root,'capabilities.json'),'utf8');
    const storedMcp=await (await taskHost.mcpApps.configuration()).getCustomMcpServer('test-mcp');
    expect(storedMcp).toMatchObject({id:'test-mcp',name:'Fixture',url:input.url,headers:{}});
    expect(JSON.parse(publicState).mcp).toEqual([]);
    for(const value of [input.token,'synthetic-header-value'])expect(JSON.stringify({wire,events,publicState,storedMcp})).not.toContain(value);
    const provider={id:'remote-fixture',name:'Remote fixture',auth:{method:'apiKey'},runtimes:{pi:{baseUrl:'https://models.example.invalid/v1',wireProtocol:'openai-chat',models:[{id:'test-model',name:'Test model'}],headers:{'X-Test':'synthetic-provider-header'}}}};
    await expect(registry.invoke({controllerDeviceId:'controller'},{client:{protocolVersion:1,primitives:['text']},collectionId:'providers',actionId:'create',input:{provider}})).rejects.toThrow('PROTECTED_INPUT_REQUIRED');
    await saveModelProvider(client,provider,{pi:'synthetic-provider-key'},false,'host');
    expect(secrets.get('terminal:provider:remote-fixture:pi')).toBe('synthetic-provider-key');
    const remoteState=await readModelConfiguration(client,'host');
    const saved=remoteState.providers.find(item=>item.id===provider.id)!;
    expect(saved.name).toBe('Remote fixture');
    await saveModelProvider(client,{...saved,name:'Edited remotely'},{},true,'host');
    expect(models.snapshot().providers[0].name).toBe('Edited remotely');
    expect(secrets.get('terminal:provider:remote-fixture:pi')).toBe('synthetic-provider-key');
    expect(secrets.get('terminal:provider:remote-fixture:pi:headers')).toContain('synthetic-provider-header');
    for(const value of ['synthetic-provider-key','synthetic-provider-header'])expect(JSON.stringify({wire,events,remoteState,publicState:await fs.readFile(path.join(root,'models.json'),'utf8')})).not.toContain(value);
    await invokeModelConfiguration(client,'disabled',{providerId:provider.id,kind:'provider',disabled:true},'host');
    expect((await models.views()).find(item=>item.id===provider.id)?.suspended).toBe(true);
    await expect(controller.saveRemoteConfiguration('host',{collectionId:'providers',actionId:'edit',resourceId:provider.id},{provider:{...saved,id:'different-provider'},keys:{}})).rejects.toThrow('CONFIGURATION_SAVE_FAILED');
    changeBeforeHandshake=true;
    await expect(saveModelProvider(client,{...saved,name:'Stale overwrite'},{pi:'must-not-save'},true,'host')).rejects.toThrow();
    expect(models.snapshot().providers[0].name).toBe('Edited remotely');
    expect(secrets.get('terminal:provider:remote-fixture:pi')).toBe('synthetic-provider-key');
    changeBeforeHandshake=false;
    await invokeModelConfiguration(client,'disconnect',{providerId:provider.id},'host');
    expect(secrets.has('terminal:provider:remote-fixture:pi')).toBe(false);
    await invokeModelConfiguration(client,'remove',{providerId:provider.id},'host');
    expect(models.snapshot().providers).toEqual([]);
    changeBeforeHandshake=true;
    await expect(controller.saveRemoteConfiguration('host',{collectionId:'mcp',actionId:'edit',resourceId:'test-mcp'},{...input,token:'replacement'})).rejects.toThrow();
    changeBeforeHandshake=false;wrongPeer=true;
    await expect(controller.saveRemoteConfiguration('host',{collectionId:'mcp',actionId:'edit',resourceId:'test-mcp'},{...input,token:'replacement'})).rejects.toThrow();
    wrongPeer=false;active=false;
    await expect(controller.saveRemoteConfiguration('host',{collectionId:'mcp',actionId:'edit',resourceId:'test-mcp'},input)).rejects.toThrow('OWNER_CHANGED');
    expect(JSON.parse(secrets.get('terminal:mcp:test-mcp')!).token).toBe(input.token);
  }finally{active=true;await controller.close();await host.close();await taskHost.close();await fs.rm(root,{recursive:true,force:true});}
});


// Tier: integration. The same account records must be visible through resource
// forms and real MCP entry tools; disabled/stale runtimes must not disclose them.
it('shares memory and contacts between real resources and MCP without cross-task disposal', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'cindy-knowledge-'));
  const logger:Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child:()=>logger};
  let active=true;
  const knowledge=new TerminalKnowledge({root,logger,assertCurrent(){if(!active)throw new Error('OWNER_CHANGED');},changed(){},workingDirs:async()=>[root]});
  const clients:Client[]=[];
  try {
    await knowledge.ready;
    const registry=new RemoteResourceRegistry();registerKnowledgeResources(registry,knowledge);
    const host={controllerDeviceId:'local',assertCurrent(){if(!active)throw new Error('OWNER_CHANGED');}};
    const client={protocolVersion:1,primitives:['text','form'],locale:'zh-CN'};
    await registry.invoke(host,{client,collectionId:'memory',actionId:'create',input:{workingDir:root,type:'project',name:'fixture',title:'验收记录',description:'private fixture',body:'one task must not close another'}});
    const first=await knowledge.createRuntime({sessionId:'one',workingDir:root,agentKind:'codex'});
    const second=await knowledge.createRuntime({sessionId:'two',workingDir:root,agentKind:'codex'});
    await first.close();
    expect((await (await second.memory.getStore(second.scopeKey)).list())[0].frontmatter.title).toBe('验收记录');
    const connect=async(server:ReturnType<typeof second.factories.cindy_contacts>)=>{
      const connection=new Client({name:'acceptance',version:'1'});clients.push(connection);
      const [controller,target]=InMemoryTransport.createLinkedPair();await server.connect(target);await connection.connect(controller);return connection;
    };
    const contacts=await connect(second.factories.cindy_contacts());
    await registry.invoke(host,{client,collectionId:'contacts',actionId:'create',input:{displayName:'Acceptance Person',kind:'person',status:'confirmed',summary:'Private fixture'}});
    const listed=await registry.list(host,{client,collectionId:'contacts'});expect(listed.items).toHaveLength(1);
    const ref=listed.items[0].ref;
    await registry.invoke(host,{client,collectionId:'contacts',resourceRef:ref,actionId:'identity',input:{platform:'email',value:'fixture@example.invalid'}});
    const resolve=()=>contacts.callTool({name:'call_tool',arguments:{name:'contacts_resolve',args:{value:'fixture@example.invalid'}}});
    expect(JSON.stringify(await resolve())).toContain('CONTACTS_NOT_READY');
    await registry.invoke(host,{client,collectionId:'contacts',actionId:'settings',input:{enabled:true}});
    expect(JSON.stringify(await resolve())).toContain('Acceptance Person');
    const memories=await registry.list(host,{client,collectionId:'memory'});expect(memories.items).toHaveLength(1);
    const memory=await connect(second.factories.cindy_memory());
    expect(JSON.stringify(await memory.callTool({name:'call_tool',arguments:{name:'memory_list',args:{}}}))).toContain('验收记录');
    await knowledge.configure({memory:false});
    expect(JSON.stringify(await memory.callTool({name:'call_tool',arguments:{name:'memory_list',args:{}}}))).toContain('MAKER_MEMORY_NOT_READY');
    expect((await registry.list(host,{client,collectionId:'memory'})).items).toHaveLength(1);
    active=false;
    expect(JSON.stringify(await resolve())).not.toContain('Acceptance Person');
    await expect(registry.list(host,{client,collectionId:'memory'})).rejects.toThrow('OWNER_CHANGED');
    await second.close();
  } finally {for(const client of clients)await client.close();await knowledge.close();await fs.rm(root,{recursive:true,force:true});}
});
