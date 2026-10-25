/** Integration tier: exercise the terminal resource→download→native receipt
 * path. A substituted package or interrupted provenance write must never grant
 * enterprise credentials; restart must recover a committed exact package. */
import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { TerminalMediaTransfer } from '../media-transfer.js';
import { buildPeerAttachmentRef, RemoteResourceRegistry } from '@cindy/device-link';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { TerminalSecretStore } from '../secrets.js';
import { TerminalPlugins } from './host.js';
import { TerminalPluginAccount } from './account.js';
import { TerminalPluginMarket } from './market.js';
import { TerminalPluginPages } from './pages.js';
import { TerminalPluginPreferences } from './preferences.js';
import { pluginManagementDependencies } from './management.js';
import { ghostInstallApprovalToken } from '@cindy/plugin-runtime/shared/ghost';
import { registerPluginResources } from './resources.js';

it('pins market downloads, recovers the approved package after ledger interruption, and binds organization credentials',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'cindy-terminal-market-'));
  const vault=new TerminalSecretStore(path.join(directory,'vault'));await vault.open();await vault.initialize('machine');
  const member={id:'fixture-member',kind:'org' as const,role:'member' as const,displayName:'Fixture',email:null,orgId:'fixture-org',orgName:'Fixture'};
  const manifest={schemaVersion:2,id:'fixture-market',name:'Fixture market',version:'1.0.0',kind:'chip',entry:'main.js',settingsHtml:'settings.html',slots:['tool','network'],tools:[{name:'check',description:'Check'}],network:{hosts:['accounts.example.com','api.example.com'],secrets:[
    {key:'account',label:'Account',source:'oauth',inject:{header:'Authorization',format:'Bearer {value}',hosts:['accounts.example.com']},oauth:{authorizeUrl:'https://accounts.example.com/authorize',tokenUrl:'https://accounts.example.com/token',clientId:'fixture-client',tokenBroker:'jira'}},
    {key:'identity',label:'Organization',source:'oidc-token',inject:{header:'Authorization',format:'Bearer {value}',hosts:['api.example.com']}},
  ]}};
  const zip=new JSZip();zip.file('ghost.json',JSON.stringify(manifest));zip.file('main.js','cindy.onHostMessage(() => {});');zip.file('settings.html','<p>Fixture settings</p>');const bytes=await zip.generateAsync({type:'nodebuffer'});
  const plugin={id:'caaaaaaaaaaaaaaaaaaaaaaaa',ghostId:manifest.id,name:manifest.name,description:null,author:null,scope:'organization',namespace:'fixture-org',organizationId:member.orgId,defaultInstall:false,currentRelease:{id:'fixture-release',version:'1.0.0',sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,publishedAt:'2026-10-23T00:00:00.000Z',icon:null}};
  let host:TerminalPlugins,substitute=true;const organizations:string[]=[];
  const account=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid',oauthBrokerApiBaseUrl:'https://broker.example.invalid'}),membership:()=>member,token:()=> 'synthetic-login',refresh:async()=>{},assertCurrent:()=>{},
    onOrganization:organization=>{organizations.push(organization.organizationId);host.identity.rememberOrganization(organization);},
    fetch:async(url,init)=>{
      const request=new URL(String(url));expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic-login');
      if(request.pathname==='/api/plugins')return Response.json({schemaVersion:2,plugins:[plugin],removals:[],nextCursor:null,currentOrganization:{organizationId:member.orgId,orgSlug:'fixture-org',pluginPrefix:'fixture'}});
      if(request.pathname.endsWith('/download'))return Response.json({pluginId:plugin.id,releaseId:plugin.currentRelease.id,ghostId:plugin.ghostId,namespace:plugin.namespace,url:'https://storage.example.invalid/package.cindy',expiresAt:'2099-01-01T00:00:00.000Z',sha256:plugin.currentRelease.sha256,sizeBytes:bytes.length});
      if(request.pathname.startsWith('/api/plugins/'))return Response.json({schemaVersion:2,plugin:{...plugin,currentRelease:{...plugin.currentRelease,manifest:{...manifest,namespace:plugin.namespace}}}});
      if(request.pathname==='/api/auth/connections/token'){expect(JSON.parse(String(init?.body))).toEqual({audience:'fixture-org:fixture-market'});return Response.json({token:'synthetic-connection',expiresIn:600,audience:'fixture-org:fixture-market'});}
      expect(request.hostname).toBe('broker.example.invalid');expect(request.pathname).toBe('/api/integrations/jira/oauth/refresh');return Response.json({accessToken:'synthetic-broker-access',expiresIn:600});
    },
  });
  const options={root:path.join(directory,'owner'),runtimeDirectory:directory,executablePath:'unused',account,secrets:vault,assertCurrent:()=>{},locale:()=> 'en',changed:()=>{},receive:async()=>({}),cards:{persist:async()=>{},broadcast:()=>{}},fs:{getSessionSnapshot:async()=>null,requestWriteConfirm:async()=>({confirmed:false as const,reason:'cancelled' as const}),writeSaveDeposit:async()=>null}};
  host=new TerminalPlugins(options);
  const createMarket=()=>new TerminalPluginMarket({root:options.root,host,account,assertCurrent:()=>{},download:async input=>{
    expect(input.init?.headers).toBeUndefined();await input.beforeDispatch?.();return {response:new Response(new Uint8Array(substitute?Buffer.alloc(bytes.length):bytes)),finalUrl:input.url,release:async()=>{}};
  }});
  let market=createMarket();
  let pages:TerminalPluginPages|undefined;
  try{
    await host.ready;
    await expect(market.prepare(plugin.id,plugin.currentRelease.id,'controller')).rejects.toThrow('PLUGIN_MARKET_PACKAGE_MISMATCH');
    expect(await host.list()).toEqual([]);substitute=false;
    const registry=new RemoteResourceRegistry();market.register(registry);registerPluginResources(registry,host);
    const context={controllerDeviceId:'controller',assertCurrent:()=>{}},client={protocolVersion:1 as const,primitives:['text','actions'],locale:'en'};
    const resource=await registry.get(context,{client,ref:{collectionId:'plugin-market',kind:'market-plugin',id:plugin.id}});
    const pending=await registry.invoke(context,{client,collectionId:'plugin-market',resourceRef:resource.ref,actionId:resource.actions![0].id});
    const navigation=pending.effects[0];if(navigation.kind!=='navigate'||navigation.target.kind!=='resource')throw new Error('Expected permission resource');
    expect(await host.list()).toEqual([]);
    const write=vi.spyOn(host.identity.ledger,'upsertInstallation').mockImplementationOnce(()=>{throw new Error('Synthetic ledger interruption');});
    await expect(registry.invoke(context,{client,collectionId:'plugins',resourceRef:navigation.target.ref,actionId:'confirm-install'})).rejects.toThrow('Synthetic ledger interruption');write.mockRestore();
    const installed=(await host.list())[0],id=installedGhostStoragePart(installed);
    expect(host.identity.brokerAllowed(id)).toBe(false);
    await market.close();await host.close();host=new TerminalPlugins(options);await host.ready;market=createMarket();
    const restored=(await host.list())[0];expect(restored.manifest.id).toBe(plugin.ghostId);
    expect(host.identity.record(restored)).toMatchObject({installed:true,releaseId:plugin.currentRelease.id,sha256:plugin.currentRelease.sha256});
    expect(host.identity.brokerAllowed(id)).toBe(true);expect(host.identity.hostAllowed(id)).toBe(false);
    const connection=host.identity.connection(id);expect(connection).toMatchObject({audience:'fixture-org:fixture-market',allowedHosts:['api.example.com']});
    expect(await account.tokens.getToken(connection!)).toBe('synthetic-connection');
    expect(await account.broker.refresh('jira',{refreshToken:'synthetic-refresh'})).toMatchObject({ok:true,bundle:{accessToken:'synthetic-broker-access'}});
    const prepared=host.pendingFor('controller');expect(prepared).toEqual([]);expect(organizations.length).toBeGreaterThan(0);
    const savedOrg=member.orgId;member.orgId='foreign-org';expect(host.identity.brokerAllowed(id)).toBe(false);expect(host.identity.connection(id)).toBeNull();member.orgId=savedOrg;
    // Integration: the GUI uses receipt-driven operations rather than TUI
    // install resources. Confirm/cancel must mutate the same native package.
    const preferences=new TerminalPluginPreferences(options.root,()=>{});await preferences.refresh();
    const media=new TerminalMediaTransfer({ownerDir:options.root,getOwnerScope:()=> 'test-owner',getToken:async()=>null,getApiBaseUrl:()=> 'https://unused.invalid'});
    const management=pluginManagementDependencies({host,market,preferences,projects:async()=>[],media});
    const installFile=management.installFile!;let fileFailure:unknown;
    management.installFile=async(...args)=>{try{return await installFile(...args);}catch(error){fileFailure=error;throw error;}};
    pages=new TerminalPluginPages(host,{assertCurrent:()=>{},translate:key=>key,receiptAvailable:()=>true,management});
    const gui=new RemoteResourceRegistry();registerPluginResources(gui,host,pages);
    const managed=async(action:string,input:Record<string,unknown>={},target=true)=>(await gui.invoke(context,{client,collectionId:'plugins',...(target?{resourceRef:{collectionId:'plugins',kind:'plugin',id}}:{}),actionId:`management:${action}`,input})).result;
    expect(await managed('snapshot',{},false)).toMatchObject({market:{items:[{installState:'installed'}]}});
    expect(await managed('market-detail',{pluginId:plugin.id},false)).toMatchObject({manifest:{id:plugin.ghostId},installState:'installed'});
    let approval=ghostInstallApprovalToken(restored.approval);
    await managed('begin',{operationId:'disable',kind:'disable',expectedInstalledApproval:approval});
    await vi.waitFor(async()=>expect(await managed('operation',{operationId:'disable'})).toMatchObject({phase:'succeeded'}));
    expect(host.installed(id)?.enabled).toBe(false);
    await managed('begin',{operationId:'enable',kind:'enable',expectedInstalledApproval:approval});
    await vi.waitFor(async()=>expect(await managed('operation',{operationId:'enable'})).toMatchObject({phase:'succeeded'}));
    expect(host.installed(id)?.enabled).toBe(true);
    for(const confirmed of [false,true]){
      const operationId=confirmed?'install-confirmed':'install-cancelled';
      await managed('begin',{operationId,kind:'install',pluginId:plugin.id,expectedReleaseId:plugin.currentRelease.id,expectedInstalledApproval:approval});
      await vi.waitFor(async()=>expect(await managed('operation',{operationId})).toMatchObject({phase:'confirmation'}));
      const receipt=await managed('operation',{operationId}) as {consent:{requestId:string}};
      await managed('answer',{operationId,requestId:receipt.consent.requestId,confirmed});
      await vi.waitFor(async()=>expect(await managed('operation',{operationId})).toMatchObject({phase:confirmed?'succeeded':'cancelled'}));
      const next=ghostInstallApprovalToken(host.installed(id)!.approval);
      if(!confirmed)expect(next).toBe(approval);else expect(next).not.toBe(approval);
      approval=next;
    }
    // Lose controller authority after host cleanup preparation but before the
    // manager lock. The installed plugin and its authorization must survive.
    const stop=host.native.node.stopAndWait.bind(host.native.node);let authorized=true;
    const stopping=vi.spyOn(host.native.node,'stopAndWait').mockImplementation(async key=>{await stop(key);authorized=false;});
    await expect(host.uninstall(id,()=>{if(!authorized)throw new Error('CONTROLLER_GONE');})).rejects.toThrow('CONTROLLER_GONE');stopping.mockRestore();
    expect(host.installed(id)).toBeDefined();expect(host.identity.brokerAllowed(id)).toBe(true);
    await managed('begin',{operationId:'uninstall',kind:'uninstall',expectedInstalledApproval:approval});
    await vi.waitFor(async()=>expect(await managed('operation',{operationId:'uninstall'})).toMatchObject({phase:'succeeded'}));
    expect(host.installed(id)).toBeNull();expect(host.identity.ledger.isDefaultInstallSuppressed(member.id,plugin.id)).toBe(true);
    const localZip=new JSZip();localZip.file('ghost.json',JSON.stringify({schemaVersion:2,id:'fixture-file',name:'File fixture',version:'1.0.0',kind:'chip',entry:'main.js',slots:[]}));localZip.file('main.js','cindy.onHostMessage(() => {});');
    const fileBytes=await localZip.generateAsync({type:'nodebuffer'}),fileHash=createHash('sha256').update(fileBytes).digest('hex');
    const metadata={size:fileBytes.length,sha256:fileHash,mimeType:'application/octet-stream',originalName:'fixture.cindy'};
    const upload=await media.inbox.handlePeerAttachment('controller',{op:'begin',...metadata}) as {ticket:string};
    await media.inbox.handlePeerAttachment('controller',{op:'write',ticket:upload.ticket,offset:0,data:new Uint8Array(fileBytes)});
    await media.inbox.handlePeerAttachment('controller',{op:'finish',ticket:upload.ticket});
    const attachment=buildPeerAttachmentRef({...metadata,ticket:upload.ticket});
    // A different owner device cannot consume this controller's upload ticket.
    await expect(media.resolve(attachment,{source:'remote',deviceId:'other-controller'})).rejects.toThrow('FILE_PEER_DENIED');
    await managed('begin',{operationId:'install-file',kind:'install-file',attachment},false);
    await vi.waitFor(async()=>{if(fileFailure)throw new Error(String(fileFailure)+' '+JSON.stringify((fileFailure as Error).cause));expect(await managed('operation',{operationId:'install-file'},false)).toMatchObject({phase:'confirmation'});});
    const fileConsent=await managed('operation',{operationId:'install-file'},false) as {consent:{requestId:string}};
    await managed('answer',{operationId:'install-file',requestId:fileConsent.consent.requestId,confirmed:true},false);
    await vi.waitFor(async()=>expect(await managed('operation',{operationId:'install-file'},false)).toMatchObject({phase:'succeeded'}));
    expect((await host.list()).find(ghost=>ghost.manifest.id==='fixture-file')).toMatchObject({enabled:true,approval:{state:'approved'}});

  }finally{pages?.close();await market.close();await host!.close();account.close();vault.lock();await rm(directory,{recursive:true,force:true});}
});
