import { PluginSetupView } from './plugin-setup.js';
import type { GhostSetupInteractionSnapshot } from '@cindy/plugin-runtime/ghostSetupInteractionBridge';
/** Behavior: the real Ink login surface must discover enabled methods, route
 * every action locally, and keep submitted codes/return URLs out of rendering.
 * Existing controller tests cannot catch missing keyboard routes or visible
 * secrets. Minimal failure: a pasted CAPTCHA fragment echoed by the form.
 * Tier: unit, real Ink + in-memory transport, fake credentials only. */
import React, { act } from 'react';
import { PassThrough, Writable } from 'node:stream';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { render, type Instance } from 'ink';
import type { AuthFlowState, TerminalAuthSnapshot } from '@cindy/auth-client';
import type { TerminalClient } from '../contracts.js';
import type { Locale } from './i18n.js';
import { Authentication } from './authentication.js';
import { InteractionView } from './interaction.js';
import { Resources } from './resources.js';
import { ChannelRegistration } from './channel-registration.js';
import type { InteractionRequest } from '@cindy/maker-core';
import { Input, terminalText } from './input.js';

const membership = { id:'fictional-member', kind:'personal' as const, role:'owner' as const, displayName:'Example person', email:'person@example.invalid', orgId:null, orgName:null };
const providers = { region:'global' as const, email:true, phone:true, social:['google' as const,'apple' as const,'wechat' as const], attribution:'email' as const };
const initialFlow: AuthFlowState = { step:'identifier', providers };
const instances: Instance[] = [];
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const originalActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
afterAll(() => { if (originalActEnvironment === undefined) delete actEnvironment.IS_REACT_ACT_ENVIRONMENT; else actEnvironment.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment; });
afterEach(async () => { for (const instance of instances.splice(0)) { const exited = instance.waitUntilExit(); await act(async()=>instance.unmount()); await exited; instance.cleanup(); } });

// Unit: an older GUI issues new opaque grants on every read and exposes model
// routes as serialized fields. The TUI must edit them with real keyboard
// selectors, retaining the remote location and tuning without displaying JSON.
it('edits a GUI companion model chain with refreshed grants and portable remote routes', async()=>{
  let generation=0;
  const submitted:Array<{actionId:string;input:{modelChain:string}}> = [];
  const ref={collectionId:'teammates',kind:'bot',id:'fixture'};
  const provider={id:'fixture-provider',name:'Fixture',connected:true,remoteInvocationEnabled:true,models:{pi:[{id:'model',name:'Remote model',efforts:['medium','high'],supportsFastMode:true}]}};
  const client:TerminalClient={close(){},subscribe:()=>()=>{},invoke:vi.fn(async(channel,args=[],device)=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[{id:'teammates',resourceKind:'bot',title:'Teammates'}]};
    if(channel==='maker:remote-resources:list')return {items:[{ref,revision:'1',display:{title:'Fixture'},links:[]}]};
    if(channel==='maker:remote-resources:get'){
      const actionId=`opaque-${++generation}`;
      return {ref,revision:'1',display:{title:'Fixture'},links:[],actions:[{id:actionId,label:'Models',fields:[{id:'modelChain',kind:'multiline',label:'Models'}]}],blocks:[{id:'models',primitive:'form',fallbackMarkdown:'',data:{actionId,values:{modelChain:'[]'}}}]};
    }
    if(channel==='terminal:status')return {deviceId:'controller'};
    if(channel==='terminal:devices:list')return [{deviceId:'execution',name:'Remote computer',online:true}];
    if(channel==='maker:provider-share:received-catalogs')return {shares:[]};
    if(channel==='maker:provider:list')return {providers:device==='execution'?[provider]:[]};
    if(channel==='maker:remote-resources:invoke'){submitted.push(args[0] as typeof submitted[number]);return {effects:[]};}
    throw new Error('UNEXPECTED_CHANNEL');
  }) as TerminalClient['invoke']};
  const screen=await mount(client,{node:<Resources client={client} locale="en" initialCollection="teammates" onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('\r');
  expect(screen.latest()).toContain('Add model');
  await screen.press('\r');
  expect(screen.latest()).toContain('Remote computer');
  await screen.press('\r');
  await screen.burst(['\x1b[B','\x1b[B','\r']);
  await screen.burst(['\x1b[B','\r']);
  expect(screen.latest()).toContain('high');expect(screen.latest()).toContain('Fast');
  await screen.burst(['\x1b[B','\x1b[B','\r']);
  expect(submitted).toHaveLength(1);
  expect(submitted[0].actionId).toBe('opaque-2');
  expect(JSON.parse(submitted[0].input.modelChain)).toEqual([{harness:'pi',providerId:'model-route:'+JSON.stringify(['execution','fixture-provider']),model:'model',effort:'high',fastMode:true,agentDeviceId:'execution'}]);
  expect(screen.all()).not.toContain('"harness":');
});

function fakeClient(flow: AuthFlowState | null = initialFlow, locked = false) {
  let snapshot: TerminalAuthSnapshot = { accounts:[], session:null, flow, error:null };
  const listeners = new Set<(channel:string,args:unknown[])=>void>();
  let handler: ((channel: string, args: unknown[]) => unknown) | undefined;
  const publish = (next: AuthFlowState, completed = false) => {
    snapshot = { ...snapshot, flow:next, error:null, ...(completed ? { session:{ key:'fictional-key', realm:'global', membership, status:'authenticated' }, accounts:[{key:'fictional-key',realm:'global',membership}] } : {}) };
    for (const listener of listeners) listener('terminal:auth:changed',[snapshot]);
    return snapshot;
  };
  const client: TerminalClient = {
    invoke:vi.fn(async (channel,args = [],deviceId) => {
      if (deviceId) throw new Error('UNEXPECTED_REMOTE_TARGET');
      const handled = handler?.(channel,args);
      if (handled !== undefined) return handled;
      if (channel === 'terminal:status') return {vault:{locked,initialized:true},auth:snapshot};
      if (channel === 'terminal:auth:begin') return publish(initialFlow);
      if (channel === 'terminal:auth:email') return publish({step:'method-choice',email:String(args[0]),methods:[{type:'email_code'}]});
      if (channel === 'terminal:auth:request-code') return publish({step:'verification-code',kind:args[0] as 'email'|'phone',identifier:String(args[1])});
      if (channel === 'terminal:auth:verify') return publish({step:'completed',membership},true);
      if (channel === 'terminal:auth:cancel') { snapshot = {...snapshot,flow:null};return snapshot; }
      throw new Error('UNEXPECTED_CHANNEL');
    }) as TerminalClient['invoke'],
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    close(){},
  };
  return {client,publish,handle:(next:typeof handler)=>{handler=next;}};
}

async function mount(client: TerminalClient, options: {locale?:Locale;sso?:boolean;node?:React.ReactNode} = {}) {
  const frames: string[] = [];
  const input = Object.assign(new PassThrough(), {isTTY:true,setRawMode(){},ref(){},unref(){}});
  const output = Object.assign(new Writable({write(chunk,_encoding,callback){frames.push(String(chunk));callback();}}),{isTTY:true,columns:72,rows:32});
  const onDone = vi.fn(); const onNeedsVault = vi.fn();
  let instance!: Instance;
  await act(async()=>{ instance = render(options.node??<Authentication client={client} locale={options.locale ?? 'en'} sso={options.sso} onDone={onDone} onNeedsVault={onNeedsVault} />,{
    stdin:input as unknown as NodeJS.ReadStream,stdout:output as unknown as NodeJS.WriteStream,stderr:output as unknown as NodeJS.WriteStream,
    debug:true,interactive:true,patchConsole:false,exitOnCtrlC:false,maxFps:1000,
  }); });
  instances.push(instance);
  async function flush() { await act(async()=>{await new Promise<void>(resolve=>setImmediate(resolve));});await instance.waitUntilRenderFlush(); }
  await flush();
  return {
    all:()=>terminalText(frames.join('')), latest:()=>frames.map(terminalText).findLast(frame=>frame.trim()) ?? '', onDone,onNeedsVault,
    async press(keys:string){await act(async()=>{input.write(keys);await new Promise<void>(resolve=>setImmediate(resolve));});await flush();},
    async burst(keys:string[]){await act(async()=>{for(const key of keys)input.write(key);});await flush();},
    async update(work:()=>unknown){await act(async()=>{work();});await flush();},
  };
}

describe('terminal authentication surface',()=>{
  it('keeps a long pasted draft inside the input viewport without truncating submission',async()=>{
    const submit=vi.fn();
    function Draft(){const [value,setValue]=React.useState('');return <Input value={value} onChange={setValue} onSubmit={submit} multiline/>;}
    const screen=await mount(fakeClient().client,{node:<Draft/>});
    const draft=Array.from({length:20},(_,i)=>`中文第${i+1}行`).join('\n');
    await screen.press(`\x1b[200~${draft}\x1b[201~`);
    expect(screen.latest()).toContain('中文第20行');
    expect(screen.latest()).not.toContain('中文第1行');
    await screen.press('\x01');
    expect(screen.latest()).toContain('中文第1行');
    await screen.press('\r');
    expect(submit).toHaveBeenCalledExactlyOnceWith(draft);
  });
  // Same-frame input must resolve the visible choice, including each question
  // in a multi-question request. This guards actual authorization decisions.
  it('resolves approval and successive questions using the latest keyboard selection',async()=>{
    const resolve=vi.fn();const host=fakeClient();
    const screen=await mount(host.client,{node:<InteractionView request={{requestId:'permission',kind:'permission',toolName:'fixture',input:{}} as InteractionRequest} locale="en" resolve={resolve} back={()=>{}} busy={false}/>});
    await screen.burst(['\x1b[B','\r']);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({kind:'permission',behavior:'allow'});
    resolve.mockClear();
    const questions=await mount(host.client,{node:<InteractionView request={{requestId:'question',kind:'ask_user_question',questions:[{question:'First',options:[{label:'A'},{label:'B'}]},{question:'Second',options:[{label:'C'},{label:'D'}]}]} as InteractionRequest} locale="en" resolve={resolve} back={()=>{}} busy={false}/>});
    await questions.burst(['\x1b[B','\r','\x1b[B','\r']);
    expect(resolve).toHaveBeenCalledExactlyOnceWith({kind:'ask_user_question',answers:{First:'B',Second:'D'}});
  });
  // Regression from real PTY typing: several input events can precede a React
  // render. Each event must see the previous edit, including Enter's payload.
  it('retains rapid edits received before the next frame',async()=>{
    const host=fakeClient();const screen=await mount(host.client);
    await screen.press('\r');
    await screen.burst(['person@example.invalix','\x7f','d']);
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:email',['person@example.invalid']);
  });
  it('opens the selected row when arrow and Enter share a stream read',async()=>{
    const host=fakeClient();const screen=await mount(host.client);
    await screen.burst(['\x1b[B','\r']);
    await screen.press('+15550001111');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:request-code',['phone','+15550001111']);
  });
  it.each(['en','zh-CN','zh-TW','ja','ko'] as const)('discovers all enabled login methods in %s',async locale=>{
    const host = fakeClient();const screen = await mount(host.client,{locale});
    expect(screen.all()).toContain('Google');expect(screen.all()).toContain('Apple');expect(screen.all()).toContain('SSO');
    expect(screen.all()).not.toContain('method-choice');
    expect(vi.mocked(host.client.invoke).mock.calls.every(call=>call[2] === undefined)).toBe(true);
  });

  it('signs in by email through keyboard actions while the code stays hidden',async()=>{
    const host = fakeClient();const screen = await mount(host.client);
    await screen.press('\r');
    await screen.press('person@example.invalid');await screen.press('\r');
    await screen.press('\r');await screen.press('\r');
    await screen.press('fictional-private-code');
    expect(screen.all()).not.toContain('fictional-private-code');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:email',['person@example.invalid']);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:verify',['fictional-private-code']);
    expect(screen.all()).toContain('Example person');
  });

  it('uses protected CAPTCHA completion and lets a malformed paste be corrected',async()=>{
    const host = fakeClient({step:'method-choice',email:'person@example.invalid',methods:[{type:'email_code'}]});
    const challenge = {id:'fictional-challenge',url:'https://auth.example.invalid/captcha/turnstile?action=email_request_code&theme=light&lang=en',action:'email_request_code',expiresAt:Date.now()+120_000};
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:request-code') throw Object.assign(new Error('CAPTCHA_REQUIRED'),{code:'CAPTCHA_REQUIRED'});
      if (channel === 'terminal:auth:captcha-start') return challenge;
      if (channel === 'terminal:auth:captcha-complete') {
        if (args[1] === 'wrong-private-paste') throw new Error('CAPTCHA_RETURN_INVALID');
        return host.publish({step:'verification-code',kind:'email',identifier:'person@example.invalid'});
      }
    });
    const screen = await mount(host.client);await screen.press('\r');
    await screen.press('wrong-private-paste');await screen.press('\r');
    expect(screen.all()).toContain('verification address is not valid');
    const returned = `${challenge.url}#cindy-captcha=ok.fictional-private-token`;
    await screen.press(returned);
    expect(screen.all()).not.toContain('fictional-private-token');expect(screen.all()).not.toContain('wrong-private-paste');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:captcha-complete',[challenge.id,returned]);
    expect(screen.latest()).toContain('Verification code');
  });

  it('offers enterprise discovery directly, then follows realm confirmation and SSO',async()=>{
    const host = fakeClient(null);
    const method = {type:'sso' as const,connectionId:'fictional-connection',connectionName:'Example enterprise',orgName:'Example organization',protocol:'saml' as const,ssoRequired:false};
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:organization') return host.publish({step:'realm-confirmation',targetRegion:'cn',providers,methods:[method]});
      if (channel === 'terminal:auth:realm') return host.publish({step:'method-choice',email:'',methods:[method]});
      if (channel === 'terminal:auth:authorize') return {started:true};
    });
    const screen = await mount(host.client,{sso:true});
    await screen.press('example-enterprise');await screen.press('\r');
    expect(screen.latest()).toContain('Mainland China');
    await screen.press('\r');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:organization',['example-enterprise']);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:realm',[true]);
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:authorize',['sso','fictional-connection']);
  });

  it('routes binding, MFA, and account selection without exposing submitted values',async()=>{
    const host = fakeClient({step:'binding',bindType:'email',codeRequested:false});
    host.handle((channel,args)=>{
      if (channel === 'terminal:auth:binding-code') return host.publish({step:'binding',bindType:'email',codeRequested:true,contact:String(args[0])});
      if (channel === 'terminal:auth:binding-verify') return host.publish({step:'sso-verification',channel:'sms',targetMasked:'+1***',codeRequested:false});
      if (channel === 'terminal:auth:sso-verify') return host.publish({step:'account-selection',accounts:[membership]});
      if (channel === 'terminal:auth:select') return host.publish({step:'completed',membership},true);
    });
    const screen = await mount(host.client);
    await screen.press('\r');await screen.press('person@example.invalid');await screen.press('\r');
    await screen.press('\r');await screen.press('fictional-binding-code');await screen.press('\r');
    await screen.press('\r');await screen.press('fictional-mfa-code');await screen.press('\r');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:select',['fictional-member']);
    expect(screen.all()).not.toContain('fictional-binding-code');expect(screen.all()).not.toContain('fictional-mfa-code');
  });

  it('routes a locked vault to its settings without starting login',async()=>{
    const host = fakeClient(null,true);const screen = await mount(host.client);
    expect(screen.all()).toContain('Unlock your credentials');
    await screen.press('\r');expect(screen.onNeedsVault).toHaveBeenCalledOnce();
    expect(vi.mocked(host.client.invoke).mock.calls.map(call=>call[0])).toEqual(['terminal:status']);
  });

  it('does not render raw failures and can cancel while a protected input is pending',async()=>{
    const host = fakeClient({step:'verification-code',kind:'email',identifier:'person@example.invalid'});
    let stalled = false;
    host.handle(channel=>{
      if (channel === 'terminal:auth:verify') {
        if (stalled) return new Promise(()=>{});
        throw new Error('fictional-private-provider-error');
      }
    });
    const screen = await mount(host.client);
    await screen.press('\r');await screen.press('fictional-first-code');await screen.press('\r');
    expect(screen.all()).toContain('Sign-in could not be completed');
    expect(screen.all()).not.toContain('fictional-private-provider-error');
    stalled = true;
    await screen.press('fictional-second-code');await screen.press('\r');
    // Kitty's explicit Escape avoids the parser's ambiguous ESC-prefix delay.
    await screen.press('\x1b[27u');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:cancel',[]);
    expect(screen.latest()).toContain('Google');
    expect(screen.all()).not.toContain('fictional-second-code');
  });

  it('loads available memberships, switches locally, and signs out',async()=>{
    const host = fakeClient();host.publish({step:'completed',membership},true);
    host.handle(channel=>{
      if (channel === 'terminal:auth:memberships') return [{...membership,id:'second-membership',displayName:'Second account',orgSlug:null}];
      if (channel === 'terminal:auth:membership') return host.publish({step:'completed',membership},true);
      if (channel === 'terminal:auth:logout') return host.publish(initialFlow);
    });
    const screen = await mount(host.client);
    await screen.press('\x1b[B');await screen.press('\r');
    expect(screen.latest()).toContain('Second account');
    await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:membership',['second-membership']);
    await screen.press('\x1b[B');await screen.press('\x1b[B');await screen.press('\x1b[B');await screen.press('\r');
    expect(host.client.invoke).toHaveBeenCalledWith('terminal:auth:logout',[]);
    expect(vi.mocked(host.client.invoke).mock.calls.every(call=>call[2] === undefined)).toBe(true);
  });
});


// Unit: actual resource keyboard navigation must create a protected local
// controller for the selected remote host, then cancel a late begin on Esc.
it('opens remote channel registration locally and cancels a late authorization after leaving', async () => {
  const calls: Array<{ channel: string; args: unknown[]; device?: string }> = [];
  let finish!: (value: unknown) => void;
  const pending = new Promise(resolve => { finish = resolve; });
  const ref = { collectionId: 'channels', kind: 'im-channel', id: 'feishu' };
  const client: TerminalClient = { subscribe: () => () => {}, close() {}, invoke: (async (channel: string, args: unknown[] = [], device?: string) => {
    calls.push({ channel, args, device });
    if (channel === 'maker:remote-resources:manifest') return { collections: [{ id: 'channels', resourceKind: 'im-channel', title: 'Channels' }] };
    if (channel === 'maker:remote-resources:list') return { items: [{ ref, revision: '1', links: [], display: { title: 'Feishu' } }] };
    if (channel === 'maker:remote-resources:get') return { ref, revision: '1', links: [], display: { title: 'Feishu' }, blocks: [], actions: [{ id: 'connect', label: 'Create and connect', fields: [{ id: 'service', kind: 'select', label: 'Service', options: [{ value: 'lark', label: 'Lark' }] }] }] };
    if (channel === 'terminal:channel-registration') return (args[0] as { command: string }).command === 'begin' ? pending : {};
    throw new Error('UNEXPECTED_CHANNEL');
  }) as TerminalClient['invoke'] };
  const screen = await mount(client, { node: <Resources client={client} device="remote-host" locale="en" initialCollection="channels" onTask={() => {}} /> });
  await screen.press('\r'); await screen.press('\r'); await screen.press('\r');
  expect(calls.find(call => call.channel === 'terminal:channel-registration')).toEqual({ channel: 'terminal:channel-registration', args: [{ command: 'begin', service: 'lark', deviceId: 'remote-host' }], device: undefined });
  await screen.press('\x1b[27u');
  await screen.update(() => finish({ id: 'private-request', state: { status: 'pending', userCode: 'ABCD-EFGH', verificationUrl: 'https://open.larksuite.com/page/cli?user_code=ABCD-EFGH' } }));
  expect(calls.some(call => call.channel === 'terminal:channel-registration' && (call.args[0] as { command: string; id: string }).command === 'cancel' && (call.args[0] as { id: string }).id === 'private-request')).toBe(true);
  expect(screen.all()).not.toContain('ABCD-EFGH');
  expect(calls.filter(call => call.device).every(call => call.channel !== 'terminal:channel-registration')).toBe(true);
});

// The production resource controller must retain server form defaults and its
// revision token. Deletion must leave the stale detail screen (unit tier).
it('edits resource defaults and returns to the collection after deletion',async()=>{
  const host=fakeClient();let removed=false;let submitted:unknown;const actionInputs:Record<string,unknown>={};
  const ref={collectionId:'fixture',kind:'fixture',id:'one'};
  const collection={id:'fixture',resourceKind:'fixture',title:'Records'};
  const item={ref,revision:'1',links:[],display:{title:'Saved record'}};
  host.handle((channel,args)=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[collection]};
    if(channel==='maker:remote-resources:list')return {collectionId:'fixture',items:removed?[]:[item]};
    if(channel==='maker:remote-resources:get')return {...item,actions:[
      {id:'edit',label:'Edit',fields:[{id:'title',label:'Title',kind:'text',required:true},{id:'mode',label:'Mode',kind:'select',options:[{value:'a',label:'A'},{value:'b',label:'B'}]},{id:'enabled',label:'Enabled',kind:'toggle'}]},
      {id:'delete',label:'Delete',confirmation:{title:'Delete record?',confirmLabel:'Delete'}},
      {id:'refresh',label:'Refresh'},
    ],blocks:[{id:'edit',primitive:'form',fallbackMarkdown:'',data:{actionId:'edit',values:{title:'Existing title',mode:'b',enabled:true,__revision:'rev-1'}}},
      ...['delete','refresh'].map(actionId=>({id:actionId,primitive:'form',fallbackMarkdown:'',data:{actionId,values:{__revision:'rev-1'}}}))]};
    if(channel==='maker:remote-resources:invoke'){
      const request=args[0] as {actionId:string;input:unknown};
      actionInputs[request.actionId]=request.input;
      if(request.actionId==='edit')submitted=request.input;else if(request.actionId==='delete')removed=true;
      return {effects:[{kind:'refresh-collection',collectionId:'fixture'}]};
    }
  });
  const screen=await mount(host.client,{node:<Resources client={host.client} locale="en" initialCollection="fixture" onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('\r');
  expect(screen.latest()).toContain('Existing title');
  await screen.press('\r');await screen.press('\r');await screen.press('\r');
  expect(submitted).toEqual({title:'Existing title',mode:'b',enabled:true,__revision:'rev-1'});
  expect(screen.latest()).toContain('Records');
  await screen.press('\r');await screen.burst(['\x1b[B','\x1b[B','\r']);
  expect(actionInputs.refresh).toEqual({__revision:'rev-1'});
  await screen.press('\r');await screen.burst(['\x1b[B','\r']);
  await screen.press('\r');expect(removed).toBe(false);
  await screen.burst(['\x1b[B','\r']);await screen.burst(['\x1b[B','\r']);
  expect(removed).toBe(true);expect(actionInputs.delete).toEqual({__revision:'rev-1'});expect(screen.latest()).toContain('Records');expect(screen.latest()).not.toContain('Saved record');
});

// Unit: channel forms return both refresh effects. The list refresh must not
// erase the explicitly refreshed detail, while collection-only actions exit it.
it('keeps the edited resource when the host explicitly refreshes its detail', async () => {
  const host = fakeClient();
  const ref = { collectionId: 'channels', kind: 'im-channel', id: 'fixture' };
  let saved = false;
  host.handle(channel => {
    if (channel === 'maker:remote-resources:manifest') return { collections: [{ id: 'channels', resourceKind: 'im-channel', title: 'Channels' }] };
    if (channel === 'maker:remote-resources:list') return { items: [{ ref, revision: '1', display: { title: 'My channel' }, links: [] }] };
    if (channel === 'maker:remote-resources:get') return { ref, revision: '1', display: { title: 'My channel' }, links: [],
      blocks: [{ id: 'state', primitive: 'text', fallbackMarkdown: saved ? 'Updated configuration' : 'Initial configuration' }], actions: [{ id: 'save', label: 'Save' }] };
    if (channel === 'maker:remote-resources:invoke') { saved = true; return { effects: [{ kind: 'refresh-resource', ref }, { kind: 'refresh-collection', collectionId: 'channels' }] }; }
  });
  const screen = await mount(host.client, { node: <Resources client={host.client} locale="en" initialCollection="channels" onTask={() => {}} /> });
  await screen.press('\r'); await screen.press('\r');
  expect(screen.latest()).toContain('My channel'); expect(screen.latest()).toContain('Updated configuration');
});

// Unit: long auxiliary pickers must submit the filtered option's real value,
// not the first unfiltered entry, and an empty search cannot submit a blank.
it('searches a model selector and submits the matched route', async () => {
  const host = fakeClient(), submitted: unknown[] = [];
  const ref = { collectionId: 'auxiliary-models', kind: 'auxiliary-models', id: 'chain' };
  host.handle((channel, args) => {
    if (channel === 'maker:remote-resources:manifest') return { collections: [{ id: ref.collectionId, resourceKind: ref.kind, title: 'Auxiliary models' }] };
    if (channel === 'maker:remote-resources:list') return { items: [{ ref, revision: '1', display: { title: 'Auxiliary models' }, links: [] }] };
    if (channel === 'maker:remote-resources:get') return { ref, revision: '1', display: { title: 'Auxiliary models' }, links: [], blocks: [], actions: [{ id: 'edit', label: 'Edit', fields: [{ id: 'model1', kind: 'select', label: 'Primary model', options: [
      ...Array.from({ length: 12 }, (_, index) => ({ value: `route-${index}`, label: `Model ${index}` })), { value: 'exact-route', label: 'DeepSeek' },
    ] }] }] };
    if (channel === 'maker:remote-resources:invoke') { submitted.push((args[0] as { input: unknown }).input); return { effects: [] }; }
  });
  const screen = await mount(host.client, { node: <Resources client={host.client} locale="en" initialCollection={ref.collectionId} onTask={() => {}} /> });
  await screen.press('\r'); await screen.press('\r');
  await screen.press('missing'); await screen.press('\r'); expect(submitted).toEqual([]);
  await screen.press('\x1b[27u'); await screen.press('DeepSeek');
  expect(screen.latest()).toContain('DeepSeek'); expect(screen.latest()).not.toContain('Model 0');
  await screen.press('\r'); expect(submitted).toEqual([{ model1: 'exact-route' }]);
});

// Unit: settings forms previously sent raw secrets to generic remote resources.
// Exercise the real keyboard path and assert the local-only protected entry.
it('saves remote plugin credentials through the local protected controller without echo',async()=>{
  const host=fakeClient(),ref={collectionId:'plugins',kind:'plugin',id:'fixture'};
  const key=Buffer.from(JSON.stringify(['key','installed-1'])).toString('base64url');
  const item={ref,revision:'1',links:[],display:{title:'Fixture'}};
  const calls:Array<{channel:string;args:unknown[];device?:string}>=[];
  host.handle((channel)=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[{id:'plugins',resourceKind:'plugin',title:'Plugins'}]};
    if(channel==='maker:remote-resources:list')return {items:[item]};
    if(channel==='maker:remote-resources:get')return {...item,actions:[{id:'credentials',label:'Credentials',fields:[{id:'key',label:'Key',kind:'select',options:[{value:key,label:'API Key'}]},{id:'value',label:'New value',kind:'secret'}]}]};
    if(channel==='terminal:plugin-secret')return {saved:true};
  });
  const client:TerminalClient={...host.client,invoke:(async(channel,args=[],device)=>{calls.push({channel,args,device});return host.client.invoke(channel,args);}) as TerminalClient['invoke']};
  const screen=await mount(client,{node:<Resources client={client} device="target-device" locale="en" initialCollection="plugins" onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('\r');await screen.press('\r');
  await screen.press('synthetic-protected-key');await screen.press('\r');
  expect(calls.find(call=>call.channel==='terminal:plugin-secret')).toEqual({channel:'terminal:plugin-secret',args:[{pluginId:'fixture',key,value:'synthetic-protected-key',deviceId:'target-device'}],device:undefined});
  expect(JSON.stringify(calls.filter(call=>call.device))).not.toContain('synthetic-protected-key');
  expect(calls.some(call=>call.channel==='maker:remote-resources:invoke')).toBe(false);
  expect(screen.all()).not.toContain('synthetic-protected-key');
});

// Unit: MCP credentials must leave Ink only through the local protected
// controller. The plugin form above does not exercise collection-level create.
it('submits MCP token fields through protected configuration without echo',async()=>{
  const host=fakeClient(),calls:Array<{channel:string;args:unknown[];device?:string}>=[];
  host.handle(channel=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[{id:'mcp',resourceKind:'mcp-server',title:'MCP',actions:[{id:'create',label:'Create',fields:[{id:'token',label:'Token',kind:'secret'}]}]}]};
    if(channel==='maker:remote-resources:list')return {items:[]};
    if(channel==='terminal:configuration')return {saved:true};
  });
  const client:TerminalClient={...host.client,invoke:(async(channel,args=[],device)=>{calls.push({channel,args,device});return host.client.invoke(channel,args);}) as TerminalClient['invoke']};
  const screen=await mount(client,{node:<Resources client={client} device="target-device" locale="en" initialCollection="mcp" onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('synthetic-mcp-token');await screen.press('\r');
  expect(calls.find(call=>call.channel==='terminal:configuration')).toEqual({channel:'terminal:configuration',args:[{collectionId:'mcp',actionId:'create',input:{token:'synthetic-mcp-token'},deviceId:'target-device'}],device:undefined});
  expect(JSON.stringify(calls.filter(call=>call.device))).not.toContain('synthetic-mcp-token');
  expect(calls.some(call=>call.channel==='maker:remote-resources:invoke')).toBe(false);
  expect(screen.all()).not.toContain('synthetic-mcp-token');
});

// Unit: real Ink typing must use the dedicated setup submission, never a
// generic permission answer or unmasked frame. Replaces the absent TUI route.
it('submits a market installation confirmation to the destination plugin collection',async()=>{
  const host=fakeClient(),invoked:string[]=[];
  const market={id:'plugin-market',resourceKind:'market-plugin',title:'Plugin market'};
  const plugins={id:'plugins',resourceKind:'plugin',title:'Installed plugins'};
  const marketRef={collectionId:market.id,kind:market.resourceKind,id:'fixture'},pendingRef={collectionId:plugins.id,kind:plugins.resourceKind,id:'install:fixture'};
  host.handle((channel,args)=>{
    const request=args[0] as {collectionId?:string;ref?:typeof marketRef;actionId?:string};
    if(channel==='maker:remote-resources:manifest')return {collections:[market,plugins]};
    if(channel==='maker:remote-resources:list')return {items:request.collectionId===market.id?[{ref:marketRef,revision:'1',display:{title:'Fixture'},links:[]}]:[]};
    if(channel==='maker:remote-resources:get')return {ref:request.ref,revision:'1',display:{title:request.ref?.collectionId===market.id?'Fixture':'Review plugin permissions'},links:[],blocks:[],actions:request.ref?.collectionId===market.id?[{id:'install:release',label:'Install'}]:[{id:'confirm-install',label:'Confirm installation',confirmation:{title:'Install plugin?'}}]};
    if(channel==='maker:remote-resources:invoke'){
      invoked.push(String(request.collectionId));
      return {effects:request.actionId==='confirm-install'?[{kind:'refresh-collection',collectionId:plugins.id}]:[{kind:'navigate',target:{kind:'resource',ref:pendingRef}}]};
    }
  });
  const screen=await mount(host.client,{node:<Resources client={host.client} locale="en" initialCollection={market.id} onTask={()=>{}}/>});
  await screen.press('\r');await screen.press('\r');expect(screen.latest()).toContain('Review plugin permissions');
  await screen.press('\r');await screen.burst(['\x1b[B','\r']);
  expect(invoked).toEqual(['plugin-market','plugins']);expect(screen.latest()).toContain('Installed plugins');
});

// Unit: a bound card keeps owner-entered credentials out of terminal frames.
it('submits a plugin secret through its bound card without rendering the value',async()=>{
  const client=fakeClient().client,submit=vi.fn(),resolve=vi.fn();
  const request:GhostSetupInteractionSnapshot={kind:'plugin_setup',requestId:'fixture-setup',revision:7,ghost:{id:'fixture',name:'Fixture plugin'},remoteSecret:true,steps:[{id:'key',groupId:'group',groupMode:'any_of',title:'Connect account',description:'API key',phase:'pending',action:{id:'inline:key',kind:'inline_form',form:{fields:[{id:'value',type:'secret',label:'API key',required:true,maxLength:4096}]}}}]};
  const screen=await mount(client,{node:<PluginSetupView request={request} locale="en" busy={false} back={()=>{}} resolve={resolve} submit={submit}/>});
  await screen.press('\r');await screen.press('synthetic-tui-secret');
  expect(screen.all()).not.toContain('synthetic-tui-secret');
  await screen.press('\r');
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({kind:'secret',ghostId:'fixture',value:'synthetic-tui-secret',action:{requestId:'fixture-setup',actionId:'inline:key',expectedRevision:7}}));
  expect(resolve).not.toHaveBeenCalled();expect(screen.all()).not.toContain('synthetic-tui-secret');
});

// Unit: remote provider callback is secret input, routed through the local
// encrypted controller. It must never become a remote generic invocation.
it('submits an OAuth callback to the selected host without echoing it in the TUI',async()=>{
  const host=fakeClient(),calls:Array<{command:unknown;providerId?:unknown;deviceId?:unknown;callback?:unknown}>=[];
  host.handle((channel,args)=>{
    if(channel!=='terminal:provider-login')throw new Error('UNEXPECTED_CHANNEL');
    const value=args[0] as Record<string,unknown>;calls.push({...value,command:value.command});
    return {id:'provider-login-fixture',state:value.command==='submit'?{status:'success'}:{status:'pending',verificationUrl:'https://idp.example/authorize',callbackRequired:true,expiresAt:Date.now()+60_000}};
  });
  const screen=await mount(host.client,{node:<ChannelRegistration client={host.client} device="remote-host" providerId="fixture" locale="en" onDone={()=>{}}/>});
  await screen.press('http://127.0.0.1:3000/callback?code=synthetic-private-callback&state=fixture');
  expect(screen.all()).not.toContain('synthetic-private-callback');
  await screen.press('\r');
  expect(calls[0]).toMatchObject({command:'begin',providerId:'fixture',deviceId:'remote-host'});
  expect(calls.find(call=>call.command==='submit')?.callback).toContain('synthetic-private-callback');
  expect(screen.latest()).toContain('Connected');
  expect(screen.all()).not.toContain('synthetic-private-callback');
});

// Handoff: replacing Ink with the native foreground terminal must retain the
// protected lease, otherwise the CLI is killed by the component cleanup.
it('hands the selected remote native login to the terminal without cancelling its lease', async () => {
  const host = fakeClient(), calls: unknown[] = [], handoff = vi.fn();
  host.handle((channel, args) => {
    expect(channel).toBe('terminal:provider-login'); calls.push(args[0]);
    return { id: 'native-remote-lease', state: { status: 'pending', terminal: true, expiresAt: Date.now() + 60_000 } };
  });
  function Flow() {
    const [visible, setVisible] = React.useState(true);
    return visible ? <ChannelRegistration client={host.client} device="selected-server" providerId="anthropic" locale="en" onDone={()=>{}} onTerminal={id=>{handoff(id);setVisible(false);}}/> : null;
  }
  await mount(host.client, { node: <Flow/> });
  expect(handoff).toHaveBeenCalledExactlyOnceWith('native-remote-lease');
  expect(calls).toEqual([{ command: 'begin', providerId: 'anthropic', deviceId: 'selected-server' }]);
});

// UI regression: a transient progress refresh error must clear after a later
// successful read without restarting the download or switching the target.
it('recovers the selected host progress view after a transient refresh failure', async () => {
  vi.useFakeTimers({toFake: ['setInterval', 'clearInterval']});
  try {
    const host = fakeClient(); let failing = false, complete = false;
    const ref = {collectionId: 'local-models', kind: 'local-model', id: 'ollama'};
    const resource = () => ({ref, revision: '1', display: {title: 'Ollama'}, links: [], actions: [], blocks: [{id: 'progress', primitive: 'text', fallbackMarkdown: complete ? 'Installed 100%' : 'Downloading 42%'}]});
    host.handle(channel => {
      if (channel === 'maker:remote-resources:manifest') return {collections: [{id: 'local-models', resourceKind: 'local-model', title: 'Local models'}]};
      if (channel === 'maker:remote-resources:list') return {items: [resource()]};
      if (channel === 'maker:remote-resources:get') { if (failing) throw new Error('BACKPRESSURE'); return resource(); }
    });
    const client: TerminalClient = {...host.client, invoke: (channel, args, device) => {expect(device).toBe('selected-server'); return host.client.invoke(channel,args);} };
    const screen = await mount(client, {node: <Resources client={client} device="selected-server" locale="en" initialRef={ref} onTask={()=>{}}/>});
    expect(screen.latest()).toContain('Downloading 42%');
    failing = true; await act(async()=>{ await vi.advanceTimersByTimeAsync(2000); });
    await screen.update(()=>{}); expect(screen.latest()).toContain('RESOURCE_REQUEST_FAILED');
    failing = false; complete = true; await act(async()=>{ await vi.advanceTimersByTimeAsync(2000); });
    await screen.update(()=>{}); expect(screen.latest()).toContain('Installed 100%');
    expect(screen.latest()).not.toContain('RESOURCE_REQUEST_FAILED');
    expect(vi.mocked(host.client.invoke).mock.calls.some(([channel])=>channel.endsWith(':invoke'))).toBe(false);
  } finally { vi.useRealTimers(); }
});

// Unit: another controller can change preferences while a detail stays open.
// Reload at form entry; preserve the revision and values once editing begins.
it('loads the latest resource before editing and keeps an active draft revision',async()=>{
  const host=fakeClient(),ref={collectionId:'plugins',kind:'plugin',id:'fixture'};
  let revision=1,submitted:unknown;
  host.handle((channel,args)=>{
    if(channel==='maker:remote-resources:manifest')return {collections:[{id:'plugins',resourceKind:'plugin',title:'Plugins'}]};
    if(channel==='maker:remote-resources:list')return {items:[{ref,display:{title:'Fixture'},links:[]}]};
    if(channel==='maker:remote-resources:get')return {ref,revision:String(revision),display:{title:'Fixture'},links:[],actions:[{id:'edit',label:'Edit',fields:[{id:'name',label:'Name',kind:'text'}]}],blocks:[{id:'form',primitive:'form',data:{actionId:'edit',values:{name:`Value ${revision}`,expectedRevision:revision}}}]};
    if(channel==='maker:remote-resources:invoke'){submitted=(args[0] as {input:unknown}).input;throw new Error('PLUGIN_SETTINGS_CHANGED');}
  });
  const screen=await mount(host.client,{node:<Resources client={host.client} locale="en" initialCollection="plugins" onTask={()=>{}}/>});
  await screen.press('\r');revision=2;await screen.press('\r');expect(screen.latest()).toContain('Value 2');
  revision=3;await screen.press(' draft');await screen.press('\r');
  expect(submitted).toEqual({name:'Value 2 draft',expectedRevision:2});expect(screen.latest()).toContain('PLUGIN_SETTINGS_CHANGED');
  await screen.press('\x1b[27u');await screen.press('\r');expect(screen.latest()).toContain('Value 3');
});
