import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';
import { TerminalGuestRoutes } from './guest-routes.js';
import { TerminalRemoteModelGrants } from './model-grants.js';
import { TerminalProviderGroups } from './groups.js';
import { TerminalRemoteAccountService } from './account.js';
import { TerminalCrossRegionShares } from './cross-region.js';
import { TerminalSharedTasks } from './shared-tasks.js';
import { openStandaloneNodeDatabase } from '../database.js';
import { createSharedTaskJournal } from '@cindy/runtime-db/sharedTasks';

// Standard tier: these new production boundaries had no coverage. The minimum
// regressions are a stale capability, a reopened restriction, a restarted
// cooling entry, and a signed cross-region request leaking the home token.
const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));});
async function directory(){const dir=await mkdtemp(path.join(tmpdir(),'cindy-remote-auth-'));directories.push(dir);return dir;}

it('binds every guest request to the current run, owner and live model grant',async()=>{
  let owner='owner-a';let allowed=true;let finish!:(value:boolean)=>void;
  const routes=new TerminalGuestRoutes(()=>owner);
  const old=routes.register('task','provider',async()=>allowed,()=>true);
  expect(await routes.check({sessionId:'task',providerId:'other',routeToken:old.token,model:'m'})).toBe(false);
  const next=routes.register('task','provider',async()=>allowed,()=>true);old.release();
  expect(await routes.check({sessionId:'task',providerId:'provider',routeToken:old.token,model:'m'})).toBe(false);
  expect(await routes.check({sessionId:'task',providerId:'provider',routeToken:next.token,model:'m'})).toBe(true);
  allowed=false;expect(await routes.check({sessionId:'task',providerId:'provider',routeToken:next.token,model:'m'})).toBe(false);
  const delayed=routes.register('task','provider',()=>new Promise(resolve=>{finish=resolve;}),()=>true);
  const pending=routes.check({sessionId:'task',providerId:'provider',routeToken:delayed.token,model:'m'});
  owner='owner-b';finish(true);expect(await pending).toBe(false);routes.close();
});

it('persists provider/member intersections and fails closed for malformed permissions',async()=>{
  const dir=await directory();const grants=new TerminalRemoteModelGrants(dir,()=> 'owner');await grants.open();
  expect(grants.allows('p','model-b','member')).toBe(true);
  await grants.set('p',['model-a','model-b'],undefined,()=>{});
  await grants.set('p',['model-a'],'member',()=>{});await grants.close();
  const reopened=new TerminalRemoteModelGrants(dir,()=> 'owner');await reopened.open();
  expect(reopened.allows('p','model-a','member')).toBe(true);
  expect(reopened.allows('p','model-b','member')).toBe(false);
  expect(reopened.allows('p','model-b','other-member')).toBe(true);
  await expect(reopened.set('p',null,undefined,()=>{throw new Error('stale');})).rejects.toThrow('stale');
  expect(reopened.allows('p','model-c')).toBe(false);await reopened.close();
  await writeFile(path.join(dir,'remote-model-access.json'),'{"providers":null}');
  const broken=new TerminalRemoteModelGrants(dir,()=> 'owner');await expect(broken.open()).rejects.toThrow('INVALID_REMOTE_MODEL_GRANTS');
  expect(broken.allows('p','model-a')).toBe(false);await broken.close();
});

it('restores cooling before routing and keeps concurrent group edits on disk',async()=>{
  const dir=await directory();
  const provider={id:'p',name:'Provider',agents:['codex'],connected:true,models:{codex:[{id:'m',name:'Model',efforts:[],defaultEffort:null}]},routing:{codex:{}},auth:{method:'none'}} as unknown as ProviderView;
  const make=()=>new TerminalProviderGroups({profileDir:dir,getOwnerScope:()=> 'owner',invoke:async()=>({ok:true}),isRemoteAllowed:()=>true,listBindings:()=>({}),isTurnRunning:()=>false,sessionGroup:async()=>null,listLocalProviders:async()=>[provider],localDeviceName:()=> 'Host',listDevices:async()=>[],readDeviceProviders:async()=>[],listReceivedShares:()=>[],isMobilePlatform:()=>false});
  const group=make();const config={strategy:'least',autoSwitch:true,members:[{key:'local',kind:'local',agentDeviceId:null,providerId:'p',limit:4,weight:1,paused:false}]};
  await Promise.all([group.save('p',config,()=>{}),group.save('p',{...config,strategy:'round'},()=>{})]);
  const until=Date.now()+60_000;group.router.markCooling('p','local',until,'m');await group.close();
  const reopened=make();await reopened.list();
  expect(reopened.router.coolingUntil('p','local','m')).toBe(until);
  expect(reopened.read('p')?.strategy).toBe('round');
  await expect(reopened.resolveExecutionRoute({providerId:'p',agentKind:'codex',model:'m'},'task')).rejects.toThrow('REMOTE_AGENT_GROUP_UNAVAILABLE');
  await reopened.close();
});

it('uses signed identity only across regions and rejects arbitrary invitation hosts before any request',async()=>{
  const dir=await directory();const home=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify({card:'signed-card'}))); 
  const peer=vi.fn<typeof fetch>().mockImplementation(async(_url,options)=>{
    const route=String(_url);expect((options?.headers as Record<string,string>).authorization).toBeUndefined();
    if(route.endsWith('/requests'))return new Response(JSON.stringify({requestId:'request',status:'pending',pairingCode:'1234',expiresAt:'2030-01-01T00:00:00Z',requestToken:'x'.repeat(43)}));
    if(route.endsWith('/session'))return new Response(JSON.stringify({shares:[],credential:null}));
    return new Response(JSON.stringify({shareId:'share',providerId:'p',providerLabel:'P',deviceName:'Host',owner:{displayName:'Owner',avatarUrl:null,region:'cn'},state:'unused',expiresAt:'2030-01-01T00:00:00Z'}));
  });
  const account=new TerminalRemoteAccountService({getOwnerScope:()=> 'owner',getToken:async()=> 'home-secret',getApiBaseUrl:()=> 'https://global.test',getAuthBaseUrl:()=> 'https://auth.test',fetch:home});
  const cross=new TerminalCrossRegionShares({profileDir:dir,account,region:'global',endpoints:{global:'https://global.test',cn:'https://cn.test'},getOwnerScope:()=> 'owner',deviceId:'device',getHello:()=>({deviceName:'Host',platform:'linux',appVersion:'1',remoteControlEnabled:false,busy:false}),createWebSocket:()=>{throw new Error('No shares, so no connection');},onPush:()=>{},fetch:peer});
  await cross.open();expect(peer).not.toHaveBeenCalled();
  const token='a'.repeat(43);
  await expect(cross.preview(`https://untrusted.test/provider-share/join#${token}`)).rejects.toThrow('UNKNOWN_PROVIDER_SHARE_REGION');
  expect(home).not.toHaveBeenCalled();
  await expect(cross.preview(`https://cn.test/provider-share/join#${token}`)).resolves.toMatchObject({providerId:'p'});
  await cross.join(`https://cn.test/provider-share/join#${token}`);await cross.refresh();
  expect(home.mock.calls[0][1]?.headers).toMatchObject({authorization:'Bearer home-secret'});
  const disk=await readFile(path.join(dir,'provider-share-regions.json'),'utf8');
  expect(disk).toBe('{"version":1,"region":"cn"}');expect(disk).not.toContain('home-secret');cross.close();
});

it('journals a late committed share and cleans it with the original account only',async()=>{
  const dir=await directory();let owner='owner-a';let finish!:(response:Response)=>void;let entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const calls:Array<{url:string;token:unknown}>=[];
  const request=vi.fn<typeof fetch>().mockImplementation(async(url,options)=>{
    const route=String(url);calls.push({url:route,token:(options?.headers as Record<string,string>).authorization});
    if(route.endsWith('/shared-tasks')&&options?.method==='POST'){entered();return new Promise(resolve=>{finish=resolve;});}
    if(route.endsWith('/close'))return new Response(JSON.stringify({ok:true}));
    return new Response(JSON.stringify({sharedTasks:[]}));
  });
  const account=new TerminalRemoteAccountService({getApiBaseUrl:()=> 'https://home.test',getToken:async()=> owner==='owner-a'?'token-a':'token-b',getOwnerScope:()=>owner,fetch:request});
  const database=await openStandaloneNodeDatabase(dir,{debug(){},info(){},warn(){},error(){}});
  await database.sessionStorage.create({id:'task',title:'Title',workDir:dir,agentKind:'pi',model:'fixture-model'});
  const shares=new TerminalSharedTasks({database,ownerAccountId:'account-a',account,getOwnerScope:()=>owner,deviceId:'host',
    readTask:id=>database.sessionStorage.get(id),revoke:()=>{}});
  try {
    await shares.open();const creation=shares.create('task','Title');await started;
    owner='owner-b';finish(new Response(JSON.stringify({sharedTaskId:'shared',revision:1})));
    await expect(creation).rejects.toThrow();
    expect(calls.filter(call=>call.url.endsWith('/close'))).toEqual([{url:'https://home.test/api/device-link/shared-tasks/shared/close',token:'Bearer token-a'}]);
    const journal=await createSharedTaskJournal(database.db).latest();
    expect(journal).toEqual([{sharedTaskId:'shared',sessionId:'task',terminal:true,snapshot:null}]);
    expect(JSON.stringify(journal)).not.toContain('token-');
    await expect(access(path.join(dir,'shared-task-cleanup.json'))).rejects.toMatchObject({code:'ENOENT'});
    expect(shares.isBlocked('task')).toBe(true);
  } finally {await shares.close();await database.close();}
});
