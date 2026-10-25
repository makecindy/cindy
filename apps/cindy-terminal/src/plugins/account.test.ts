// Behavior tier: the native host must keep login and enterprise Connection JWT
// credentials on their own audiences and revoke late issuance after owner change.
import {expect,it,vi} from 'vitest';
import {TerminalPluginAccount} from './account.js';
const member={id:'fixture-member',kind:'org' as const,role:'member' as const,displayName:'Fixture',email:null,orgId:'fixture-org',orgName:'Fixture organization'};
const catalog={schemaVersion:2,plugins:[],nextCursor:null,currentOrganization:{organizationId:member.orgId,orgSlug:'fixture-org',pluginPrefix:'fixture'}};
const upload={uploadId:'fixture-upload',putUrl:'https://storage.example.invalid/package',headers:{'Content-Type':'application/octet-stream','x-oss-forbid-overwrite':'true'},expiresAt:'2099-01-01T00:00:00.000Z',status:'awaiting_upload'};

it('uses organization identity from the validated catalog and refreshes only an expired Connection JWT',async()=>{
  let issuance=0,prepares=0;
  const refresh=vi.fn(async()=>{}),authorization:string[]=[];
  const host=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid'}),membership:()=>member,token:()=> 'synthetic-login-token',refresh,assertCurrent:()=>{},
    fetch:async(url,init)=>{
      const request=new URL(String(url));const headers=new Headers(init?.headers);authorization.push(headers.get('authorization')!);
      if(request.pathname==='/api/plugins'){expect(request.hostname).toBe('plugins.example.invalid');return Response.json(catalog);}
      if(request.pathname==='/api/auth/connections/token'){
        expect(request.hostname).toBe('auth.example.invalid');expect(headers.get('authorization')).toBe('Bearer synthetic-login-token');
        expect(JSON.parse(String(init?.body))).toEqual({audience:'fixture-org:cindy-publisher'});
        return Response.json({token:`synthetic-connection-${++issuance}`,expiresIn:600,audience:'fixture-org:cindy-publisher'});
      }
      expect(request.pathname).toBe('/api/publisher/uploads');expect(headers.get('authorization')).toBe(`Bearer synthetic-connection-${issuance}`);
      if(++prepares===1)return Response.json({error:{code:'CONNECTION_TOKEN_EXPIRED',message:'must remain private'}},{status:401});
      return Response.json(upload);
    },
  });
  try{
    expect(await host.publisher.prepare({sizeBytes:3,sha256:'a'.repeat(64)})).toMatchObject({uploadId:'fixture-upload'});
    expect(issuance).toBe(2);expect(refresh).not.toHaveBeenCalled();expect(authorization).toHaveLength(5);
  }finally{host.close();}
});

it('never sends a late token to the publisher after its account is revoked',async()=>{
  let active=true,release!:(response:Response)=>void;const issued=new Promise<Response>(resolve=>{release=resolve;});
  const fetcher=vi.fn(async(url:URL|RequestInfo)=>new URL(String(url)).pathname==='/api/plugins'?Response.json(catalog):issued);
  const host=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid'}),membership:()=>member,token:()=> 'synthetic-login',refresh:async()=>{},assertCurrent:()=>{if(!active)throw new Error('OWNER_CHANGED');},fetch:fetcher});
  const pending=host.publisher.prepare({sizeBytes:3,sha256:'a'.repeat(64)});
  const rejected=pending.then(()=>null,error=>error as Error);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2));active=false;
  release(Response.json({token:'synthetic-late',expiresIn:600,audience:'fixture-org:cindy-publisher'}));
  expect(await rejected).toMatchObject({message:'OWNER_CHANGED'});expect(fetcher).toHaveBeenCalledTimes(2);host.close();
});

it('distinguishes broker refresh rejection from login expiry and transport failure without returning upstream details',async()=>{
  let failure='TOKEN_EXPIRED';const refresh=vi.fn(async()=>{});
  const host=new TerminalPluginAccount({endpoints:()=>({authApiBaseUrl:'https://auth.example.invalid',pluginApiBaseUrl:'https://plugins.example.invalid',oauthBrokerApiBaseUrl:'https://broker.example.invalid'}),membership:()=>member,token:()=> 'synthetic-login',refresh,assertCurrent:()=>{},fetch:async url=>{
    expect(new URL(String(url)).hostname).toBe('broker.example.invalid');
    if(failure==='network')throw new Error('Sensitive transport diagnostics');
    return Response.json({error:{code:failure,message:'Sensitive upstream response'}},{status:401});
  }});
  try{
    expect(await host.broker.refresh('jira',{refreshToken:'synthetic-refresh'})).toMatchObject({ok:false,invalidGrant:false});expect(refresh).toHaveBeenCalledTimes(1);
    failure='JIRA_OAUTH_FAILED';const rejected=await host.broker.refresh('jira',{refreshToken:'synthetic-refresh'});expect(rejected).toMatchObject({ok:false,invalidGrant:true});expect(JSON.stringify(rejected)).not.toContain('Sensitive');
    failure='network';expect(await host.broker.refresh('jira',{refreshToken:'synthetic-refresh'})).toMatchObject({ok:false,error:'NETWORK',invalidGrant:false});
  }finally{host.close();}
});
