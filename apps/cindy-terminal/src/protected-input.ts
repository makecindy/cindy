import { listenForOauthCallback } from '@cindy/plugin-runtime/authorization/loopbackListener';
import { openAuthorizationOffer } from '@cindy/plugin-runtime/authorization/authorizationAdapters';
import { parsePluginOauthAction,parsePluginSecretPresentation,parsePluginConnectionPresentation,parsePluginConnectionInput } from '@cindy/device-link';
import type { OauthControllerDeps } from '@cindy/plugin-runtime/authorization/controller';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { InputHandoffService } from '@cindy/remote-agent/input-handoff/service';
import type { InputHandoffServiceDeps } from '@cindy/remote-agent/input-handoff/service';
import { AskpassHost } from '@cindy/remote-agent/input-handoff/askpass/host';
import { OauthIdentityStore, oauthIdentityScopeKey, type OauthIdentityScope } from '@cindy/plugin-runtime/authorization/identityStore';
import { AuthenticatedOauthHost, OauthHostIdentity, authenticateOauthController } from '@cindy/plugin-runtime/authorization/authentication';
import { OauthTransactions, type OauthTransactionDeps } from '@cindy/plugin-runtime/authorization/transactions';
import { createInputHandoffAuthorization } from '@cindy/plugin-runtime/authorization/inputHandoffBinding';
import { resolveOauthPeerIdentity } from '@cindy/plugin-runtime/authorization/identityResolver';
import { assistPluginOauth } from '@cindy/plugin-runtime/authorization/controller';
import { onOauthCardClosed } from '@cindy/plugin-runtime/authorization/context';
import { PLUGIN_SETTINGS_ACTION, oauthId } from '@cindy/device-link';
import { INPUT_HANDOFF_GHOST_ID, INPUT_HANDOFF_ACTION_ID, PLUGIN_OAUTH_CHANNEL, parseInputHandoffPresentation, parseInputHandoffSubmission, type InputHandoffPresentation, type InputHandoffSubmission, type InvokeResultPayload } from '@cindy/device-link';
import type { TerminalSecrets } from './contracts.js';
import { privateDirectory } from './platform.js';
import { CONFIGURATION_ID, type TerminalConfiguration, configurationOperation } from './configuration.js';
import type { ChannelRegistrationState } from './im/registration.js';

export interface ProtectedInputOptions {
  root: string;
  secrets: TerminalSecrets;
  scope(): OauthIdentityScope | null;
  assertCurrent(): void;
  remoteEnabled(): boolean;
  taskExists(id: string): Promise<boolean>;
  emit(channel: string, payload: unknown): void;
  invoke(device: string, channel: string, args: unknown[]): Promise<InvokeResultPayload>;
  createDriver?: InputHandoffServiceDeps['createDriver'];
  liveViewAvailable?: InputHandoffServiceDeps['liveViewAvailable'];
  continueAgent?: InputHandoffServiceDeps['continueAgent'];
}

/** Owner values stay in this host boundary and the existing signed v3 exchange.
 * No generic interaction response, task event or history append receives them. */
export class TerminalProtectedInput {
  readonly handoff: InputHandoffService;
  readonly askpass: AskpassHost;
  private readonly transactions: OauthTransactions;
  private readonly authenticated: AuthenticatedOauthHost;
  private identity?: OauthHostIdentity;
  private identityFlight?: Promise<OauthHostIdentity>;
  private store?: OauthIdentityStore;
  private key?: Buffer;
  private preparing?: Promise<OauthIdentityStore>;
  private closed = false;
  private readonly unsubscribeClosed:()=>void;
  private plugins?:Pick<OauthTransactionDeps,'bind'|'run'|'settingsRequest'>;
  private configuration?:TerminalConfiguration;
  private readonly channelRegistrations = new Map<string, { invoke: OauthControllerDeps['invoke']; current(): void; timer: NodeJS.Timeout }>();

  constructor(private readonly options: ProtectedInputOptions) {
    this.handoff = new InputHandoffService({
      createDriver: () => options.createDriver?.() ?? null, hostPid: process.pid,
      liveViewAvailable: () => options.liveViewAvailable?.() ?? false,
      remoteInputAvailable: () => Boolean(options.scope()) && options.remoteEnabled(),
      broadcast: (channel, payload) => { this.guard(); options.emit(channel, payload); },
      continueAgent: async (...args) => {
        this.guard();
        if (!options.continueAgent) throw new Error('INPUT_HANDOFF_CONTINUATION_UNAVAILABLE');
        await options.continueAgent(...args);
      },
    });
    this.askpass = new AskpassHost({
      startTerminalPrompt: request => { this.guard(); return this.handoff.startTerminalPrompt(request); },
      isDisabledForSession: async id => this.closed || !await options.taskExists(id),
    });
    const binding = createInputHandoffAuthorization(() => this.handoff);
    const deps = {
      owner: () => this.closed ? null : options.scope() ? oauthIdentityScopeKey(options.scope()!) : `local:${options.root}`,
      available: (peer: string) => !this.closed && (peer==='terminal-local' || options.remoteEnabled() && Boolean(options.scope())),
      bind: async (action: Parameters<typeof binding.find>[0]) => this.configuration?.bind(action) ?? (await this.plugins?.bind(action)) ?? binding.find(action)?.binding ?? null,
      run: async (action: Parameters<typeof binding.find>[0]) => await this.plugins?.bind(action) ? this.plugins!.run(action) : binding.run(action),
      settingsRequest: (peer:string,request:import('@cindy/device-link').PluginSettingsRequest) => this.configuration?.owns(request.id)?this.configuration.request(peer,request):this.plugins?.settingsRequest?.(peer,request) ?? Promise.reject(new Error('PLUGIN_PAGE_UNAVAILABLE')),
    };
    this.transactions = new OauthTransactions(deps);
    this.unsubscribeClosed=onOauthCardClosed(id=>this.transactions.cancelRequest(id));
    this.authenticated = new AuthenticatedOauthHost({ ...deps,
      identity: async () => {
        this.guard(); const scope = options.scope(); if (!scope) return null;
        const store = await this.identityStore();
        this.identityFlight ??= store.load(scope, () => this.guard()).then(stored => {
          this.guard(); return this.identity = new OauthHostIdentity(stored);
        }).catch(error => { this.identityFlight=undefined; throw error; });
        const key=await this.identityFlight;
        this.guard(); return { ...scope, key };
      },
      request: (peer, raw) => {
        const request=raw as import('@cindy/device-link').PluginOauthRequest;
        return request.op==='settings'?deps.settingsRequest(peer,request):this.transactions.request(peer,raw);
      },
    });
  }
  private guard() { if (this.closed) throw new Error('INPUT_HANDOFF_CLOSED'); this.options.assertCurrent(); }
  configurePlugins(plugins:Pick<OauthTransactionDeps,'bind'|'run'|'settingsRequest'>){this.guard();this.plugins=plugins;}
  configureSettings(configuration:TerminalConfiguration){this.guard();this.configuration=configuration;}
  async prepare() { this.guard(); await this.askpass.prepare(); this.guard(); }
  request(peer: string, raw: unknown) { this.guard(); return this.authenticated.request(peer, raw); }
  envFor(id: string) { this.guard(); return this.askpass.envFor(id); }

  async submitRemote(device: string, rawPresentation: unknown, rawSubmission: unknown) {
    this.guard();
    const presentation: InputHandoffPresentation = parseInputHandoffPresentation(rawPresentation);
    const submission: InputHandoffSubmission = parseInputHandoffSubmission(rawSubmission);
    if (presentation.picture || presentation.revision !== submission.expectedRevision) throw new Error('INPUT_HANDOFF_STALE');
    const scope = this.options.scope(); if (!scope) throw new Error('AUTH_REQUIRED');
    const assertCurrent = () => { this.guard(); if (JSON.stringify(this.options.scope()) !== JSON.stringify(scope)) throw new Error('OWNER_CHANGED'); };
    const target = await resolveOauthPeerIdentity({ scope: this.options.scope, invoke: this.options.invoke }, device, assertCurrent);
    const store = await this.identityStore();
    const action = { requestId: presentation.requestId, actionId: INPUT_HANDOFF_ACTION_ID, expectedRevision: presentation.revision };
    const exchange = await authenticateOauthController({ target, peer: scope.deviceId, action, ghostId: INPUT_HANDOFF_GHOST_ID, assertCurrent,
      trustIdentity: (identity, check) => store.trustPeer(scope, identity.deviceId, identity.publicKey, check),
      invoke: async raw => { const result = await this.options.invoke(device, PLUGIN_OAUTH_CHANNEL, [raw]); if (!result.ok) throw new Error('OAUTH_BRIDGE_UNAVAILABLE'); return result.result; },
    });
    return assistPluginOauth({ inputPresentation: presentation, inputSubmission: submission, invoke: exchange, assertCurrent,
      openExternal: async () => { throw new Error('INPUT_HANDOFF_UNEXPECTED_AUTHORIZATION'); },
    }, action);
  }

  async assistPlugin(raw:unknown,present:Pick<OauthControllerDeps,'openExternal'|'presentDeviceCode'|'presentBrowserAuthorization'>){
    this.guard();if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('PLUGIN_AUTHORIZATION_INVALID');
    const value=raw as Record<string,unknown>,action=parsePluginOauthAction(value.action);
    if(!action||typeof value.ghostId!=='string'||!value.ghostId||value.ghostId.length>256)throw new Error('PLUGIN_AUTHORIZATION_INVALID');
    const ghostId=value.ghostId;
    const scope=this.options.scope(),owner=JSON.stringify(scope);
    const assertCurrent=()=>{this.guard();if(JSON.stringify(this.options.scope())!==owner)throw new Error('OWNER_CHANGED');};
    let invoke:OauthControllerDeps['invoke'];
    if(value.deviceId!==undefined){
      if(typeof value.deviceId!=='string'||!value.deviceId||!scope)throw new Error('AUTH_REQUIRED');
      const device=value.deviceId,target=await resolveOauthPeerIdentity({scope:this.options.scope,invoke:this.options.invoke},device,assertCurrent),store=await this.identityStore();
      invoke=await authenticateOauthController({target,peer:scope.deviceId,action,ghostId,assertCurrent,
        trustIdentity:(identity,check)=>store.trustPeer(scope,identity.deviceId,identity.publicKey,check),
        invoke:async request=>{const result=await this.options.invoke(device,PLUGIN_OAUTH_CHANNEL,[request]);if(!result.ok)throw new Error('OAUTH_BRIDGE_UNAVAILABLE');return result.result;},
      });
    }else{
      const binding=await this.plugins?.bind(action);assertCurrent();
      if(!binding||binding.ghostId!==ghostId||!binding.current())throw new Error('PLUGIN_AUTHORIZATION_STALE');
      invoke=request=>this.transactions.request('terminal-local',request);
    }
    const deps:OauthControllerDeps={...present,invoke,assertCurrent,listenForOauthCallback,openAuthorizationOffer,
      // A terminal displays a device code; it does not need a system clipboard.
      copyDeviceCode:()=>()=>{},
    };
    if(value.kind==='secret'){
      if(typeof value.value!=='string')throw new Error('PLUGIN_SECRET_INVALID');
      deps.secretPresentation=parsePluginSecretPresentation(value.presentation);deps.secretValue=value.value;
    }else if(value.kind==='connection'){
      deps.connectionPresentation=parsePluginConnectionPresentation(value.presentation);
      deps.connectionValue=parsePluginConnectionInput(value.value);
    }else if(value.kind!=='oauth')throw new Error('PLUGIN_AUTHORIZATION_INVALID');
    return assistPluginOauth(deps,action);
  }

  async saveRemotePluginSecret(device:string,ghostId:string,key:string,expectedInstalledApproval:string,value:string){
    this.guard();const scope=this.options.scope();if(!scope)throw new Error('AUTH_REQUIRED');
    const owner=JSON.stringify(scope);
    const assertCurrent=()=>{this.guard();if(JSON.stringify(this.options.scope())!==owner)throw new Error('OWNER_CHANGED');};
    const target=await resolveOauthPeerIdentity({scope:this.options.scope,invoke:this.options.invoke},device,assertCurrent);
    const opened=await this.options.invoke(device,'maker:remote-resources:invoke',[{client:{protocolVersion:1,primitives:['text','actions']},collectionId:'plugins',resourceRef:{collectionId:'plugins',kind:'plugin',id:ghostId},actionId:'settings:form',input:{expectedInstalledApproval}}]);
    assertCurrent();
    if(!opened.ok)throw new Error('PLUGIN_SECRET_FORM_STALE');
    const document=(opened.result as {result?:{pageId?:unknown;pluginId?:unknown}}|undefined)?.result;
    if(!document||!oauthId(document.pageId)||document.pluginId!==ghostId)throw new Error('PLUGIN_SECRET_FORM_STALE');
    const id=document.pageId,store=await this.identityStore();
    const invoke=await authenticateOauthController({target,peer:scope.deviceId,ghostId,action:{requestId:id,actionId:PLUGIN_SETTINGS_ACTION,expectedRevision:0},assertCurrent,
      trustIdentity:(identity,check)=>store.trustPeer(scope,identity.deviceId,identity.publicKey,check),
      invoke:async request=>{const result=await this.options.invoke(device,PLUGIN_OAUTH_CHANNEL,[request]);if(!result.ok)throw new Error('OAUTH_BRIDGE_UNAVAILABLE');return result.result;},
    });
    try{
      const result=await invoke({op:'settings',id,command:{kind:'fetch',path:`/secrets/${encodeURIComponent(key)}`,method:value?'PUT':'DELETE',...(value?{body:JSON.stringify({value})}:{})}}) as {status?:number};
      assertCurrent();if(result?.status!==204)throw new Error('PLUGIN_SECRET_SAVE_FAILED');
    }finally{await invoke({op:'settings',id,command:{kind:'close'}}).catch(()=>{});}
  }

  async saveRemoteConfiguration(device:string,rawOperation:unknown,input:unknown){
    this.guard();const operation=configurationOperation(rawOperation);
    // Validate the size locally before opening a lease. Nothing from input goes
    // into the capability request, diagnostics, or task history.
    const body=JSON.stringify(input);
    if(typeof body!=='string'||Buffer.byteLength(body)>65_536)throw new Error('INVALID_CONFIGURATION');
    const { id, invoke, assertCurrent } = await this.openConfiguration(operation, device);
    try{
      const saved=await invoke({op:'settings',id,command:{kind:'fetch',path:'/configuration',method:'PUT',body}}) as {status?:number};
      assertCurrent();if(saved?.status!==204)throw new Error('CONFIGURATION_SAVE_FAILED');
    }finally{await invoke({op:'settings',id,command:{kind:'close'}}).catch(()=>{});}
  }

  private async openConfiguration(operation: ReturnType<typeof configurationOperation>, device?: string) {
    this.guard(); const scope = this.options.scope(), owner = JSON.stringify(scope);
    const assertCurrent=()=>{this.guard();if(JSON.stringify(this.options.scope())!==owner)throw new Error('OWNER_CHANGED');};
    if (!device) {
      if (!this.configuration) throw new Error('PROTECTED_CONFIGURATION_UNAVAILABLE');
      const configuration = this.configuration;
      const { id } = configuration.open(operation, { source: 'local', assertCurrent });
      const invoke: OauthControllerDeps['invoke'] = async request => {
        assertCurrent(); if (request.op !== 'settings') throw new Error('INVALID_CONFIGURATION');
        return configuration.request('terminal-local', request);
      };
      return { id, invoke, assertCurrent };
    }
    if (!scope) throw new Error('AUTH_REQUIRED');
    const target=await resolveOauthPeerIdentity({scope:this.options.scope,invoke:this.options.invoke},device,assertCurrent);
    const opened=await this.options.invoke(device,'maker:remote-resources:invoke',[{
      client:{protocolVersion:1,primitives:['text','actions']},collectionId:operation.collectionId,actionId:'configuration:open',
      ...(operation.resourceId?{resourceRef:{collectionId:operation.collectionId,kind:operation.collectionId==='mcp'?'mcp-server':operation.collectionId==='channels'?'im-channel':'provider',id:operation.resourceId}}:{}),
      input:{actionId:operation.actionId},
    }]);
    assertCurrent();
    const result=opened.ok?(opened.result as {result?:{id?:unknown;configurationId?:unknown}}|undefined)?.result:undefined;
    if(!result||!oauthId(result.id)||result.configurationId!==CONFIGURATION_ID)throw new Error('PROTECTED_CONFIGURATION_UNAVAILABLE');
    const id=result.id,store=await this.identityStore();
    const invoke=await authenticateOauthController({target,peer:scope.deviceId,ghostId:CONFIGURATION_ID,action:{requestId:id,actionId:PLUGIN_SETTINGS_ACTION,expectedRevision:0},assertCurrent,
      trustIdentity:(identity,check)=>store.trustPeer(scope,identity.deviceId,identity.publicKey,check),
      invoke:async request=>{const response=await this.options.invoke(device,PLUGIN_OAUTH_CHANNEL,[request]);if(!response.ok)throw new Error('OAUTH_BRIDGE_UNAVAILABLE');return response.result;},
    });
    return { id, invoke, assertCurrent };
  }

  async channelRegistration(raw: unknown, collection: 'channels'|'providers' = 'channels'): Promise<{ id: string; state?: ChannelRegistrationState }> {
    this.guard();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('INVALID_CONFIGURATION');
    const value = raw as Record<string, unknown>;
    if (value.command === 'begin') {
      if ((collection === 'channels' ? !['feishu', 'lark'].includes(String(value.service)) : typeof value.providerId !== 'string' || !value.providerId) || value.deviceId !== undefined && (typeof value.deviceId !== 'string' || !value.deviceId)) throw new Error('INVALID_CONFIGURATION');
      const { id, invoke, assertCurrent } = await this.openConfiguration({ collectionId: collection, resourceId: collection === 'channels' ? 'feishu' : String(value.providerId), actionId: 'connect' }, value.deviceId as string | undefined);
      const timer = setTimeout(() => { void this.closeChannelRegistration(id); }, (collection === 'providers' ? 20 : 5) * 60_000); timer.unref();
      this.channelRegistrations.set(id, { invoke, current: assertCurrent, timer });
      try {
        const response = await invoke({ op: 'settings', id, command: { kind: 'fetch', path: '/connection', method: 'POST', body: JSON.stringify({ service: value.service }) } }) as { status?: number; body?: ChannelRegistrationState };
        assertCurrent();
        if (response.status !== 200 || !response.body) throw new Error('REGISTRATION_FAILED');
        return { id, state: response.body };
      } catch { await this.closeChannelRegistration(id); throw new Error('REGISTRATION_FAILED'); }
    }
    if (typeof value.id !== 'string') throw new Error('INVALID_CONFIGURATION');
    const entry = this.channelRegistrations.get(value.id);
    if (value.command === 'cancel') { await this.closeChannelRegistration(value.id); return { id: value.id }; }
    if (!entry || !['read','submit'].includes(String(value.command))) throw new Error('REGISTRATION_STALE');
    entry.current();
    const response = await entry.invoke({ op: 'settings', id: value.id, command: { kind: 'fetch', path: '/connection', method: value.command === 'submit' ? 'POST' : 'GET', ...(value.command === 'submit' ? {body: JSON.stringify({callback:value.callback})} : {}) } }) as { status?: number; body?: ChannelRegistrationState };
    if (value.command === 'submit') delete value.callback;
    entry.current();
    if (response.status !== 200 || !response.body) throw new Error('REGISTRATION_FAILED');
    return { id: value.id, state: response.body };
  }

  private async closeChannelRegistration(id: string) {
    const entry = this.channelRegistrations.get(id);
    if (!entry) return;
    this.channelRegistrations.delete(id); clearTimeout(entry.timer);
    await entry.invoke({ op: 'settings', id, command: { kind: 'close' } }).catch(() => {});
  }

  private identityStore(): Promise<OauthIdentityStore> {
    if (this.store) return Promise.resolve(this.store);
    this.preparing ??= (async () => {
      this.guard();
      let encoded = await this.options.secrets.get('protected-input-key'); this.guard();
      if (!encoded) { encoded = randomBytes(32).toString('base64'); await this.options.secrets.set('protected-input-key', encoded); this.guard(); }
      const key = Buffer.from(encoded, 'base64'); if (key.length !== 32) throw new Error('OAUTH_IDENTITY_UNAVAILABLE');
      this.key = key;
      const root = path.join(this.options.root, 'protected-input'); await privateDirectory(root); this.guard();
      this.store = new OauthIdentityStore({
        filePath: scope => path.join(root, `${oauthIdentityScopeKey(scope)}.enc`), available: () => !this.closed,
        encrypt: text => { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from('cindy-terminal-protected-input-v1')); return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]); },
        decrypt: data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12)); decipher.setAAD(Buffer.from('cindy-terminal-protected-input-v1')); decipher.setAuthTag(data.subarray(-16)); return Buffer.concat([decipher.update(data.subarray(12,-16)),decipher.final()]).toString('utf8'); },
      });
      return this.store;
    })().finally(() => { this.preparing = undefined; });
    return this.preparing;
  }
  async close() {
    await Promise.allSettled([...this.channelRegistrations.keys()].map(id => this.closeChannelRegistration(id)));
    this.unsubscribeClosed();
    this.handoff.cleanupAll(); this.closed = true;this.plugins=undefined;this.configuration?.close();this.configuration=undefined;
    this.authenticated.invalidate(); this.transactions.cancelPeer();
    await this.askpass.close(); await this.preparing?.catch(() => {}); await this.identityFlight?.catch(() => {});
    this.key?.fill(0); this.identity = undefined; this.identityFlight=undefined; this.store = undefined;
  }
}
