import type { AuthMembership } from '@cindy/auth-client';
import { PluginMarketApi, PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES } from '@cindy/plugin-runtime/market/api';
import { ConnectionTokenProvider, type IssuedConnectionToken } from '@cindy/plugin-runtime/connectionTokenProvider';
import { PluginPublisherApi, PluginPublisherApiError } from '@cindy/plugin-runtime/publisher/api';
import type { PluginApiFetchOptions } from '@cindy/plugin-runtime/apiTypes';
import type { PluginPublisherIdentity } from '@cindy/plugin-runtime/publisher/types';
import { VERSION } from '../platform.js';
import { createGhostOauthBrokerClient } from '@cindy/plugin-runtime/ghostOauthBroker';

export interface TerminalPluginAccountOptions {
  endpoints(): {authApiBaseUrl:string;pluginApiBaseUrl:string;oauthBrokerApiBaseUrl?:string};
  membership(): AuthMembership | null;
  token(): string | null;
  refresh(): Promise<unknown>;
  assertCurrent(): void;
  fetch?: typeof fetch;
  onOrganization?(organization:NonNullable<Awaited<ReturnType<PluginMarketApi['listAll']>>['currentOrganization']>):void;
}

/** Account credentials stay inside the host. Catalog uses the login token;
 * publishing uses the exact organization-scoped Connection JWT audience. */
export class TerminalPluginAccount {
  readonly market: PluginMarketApi;
  readonly publisher: PluginPublisherApi;
  readonly tokens: ConnectionTokenProvider;
  readonly broker:ReturnType<typeof createGhostOauthBrokerClient>;
  private readonly abort = new AbortController();
  private resolvedIdentity: PluginPublisherIdentity | null = null;
  constructor(private readonly options: TerminalPluginAccountOptions) {
    this.market = new PluginMarketApi((route, request) => this.request('plugin',route,{...request,allowedRedactedErrorCodes:PLUGIN_MARKET_PASSTHROUGH_ERROR_CODES}), () => VERSION);
    this.broker=createGhostOauthBrokerClient({hasLoginToken:()=>{this.guard();return Boolean(options.token());},apiPost:async(route,body)=>{
      try{return await this.request('broker',route,{method:'POST',body,allowedRedactedErrorCodes:['FEISHU_OAUTH_FAILED','JIRA_OAUTH_FAILED']});}
      catch(error){if(error instanceof PluginPublisherApiError)throw {code:error.code,statusCode:error.status,message:error.code};throw error;}
    }});
    this.tokens = new ConnectionTokenProvider({issue: audience => this.request<IssuedConnectionToken>('auth','/api/auth/connections/token',{method:'POST',body:{audience}})});
    this.publisher = new PluginPublisherApi({getClientVersion:()=>VERSION,
      getToken:async()=>{const identity=await this.publisherIdentity();if(!identity?.orgSlug)throw new Error('PLUGIN_ORGANIZATION_CONTEXT_UNAVAILABLE');return this.tokens.getToken({membershipId:identity.membershipId,audience:`${identity.orgSlug}:cindy-publisher`});},
      invalidateToken:()=>{const identity=this.resolvedIdentity;if(identity?.orgSlug)this.tokens.invalidate({membershipId:identity.membershipId,audience:`${identity.orgSlug}:cindy-publisher`});},
      fetchImpl:(route,request)=>this.request('plugin',route,request),
    });
  }
  private guard(){this.abort.signal.throwIfAborted();this.options.assertCurrent();}
  membership(){this.guard();return this.options.membership();}
  serverRoot(){this.guard();return new URL(this.options.endpoints().pluginApiBaseUrl).href;}
  brokerPublicUrl(route:string){
    this.guard();const base=this.options.endpoints().oauthBrokerApiBaseUrl;if(!base)return null;
    const url=new URL(route,base);return url.origin===new URL(base).origin&&url.protocol==='https:'&&!url.username&&!url.password?url.href:null;
  }
  async catalog(query?:string){
    const listed=await this.market.listAll(query);this.guard();const member=this.options.membership();
    if(listed.currentOrganization){
      if(member?.kind!=='org'||member.orgId!==listed.currentOrganization.organizationId)throw new Error('PLUGIN_ORGANIZATION_CONTEXT_CHANGED');
      this.options.onOrganization?.(listed.currentOrganization);
    }
    return listed;
  }
  async publisherIdentity():Promise<PluginPublisherIdentity|null>{
    this.guard();const member=this.options.membership();
    if(!member||member.kind!=='org'||!member.orgId)return null;
    if(this.resolvedIdentity?.membershipId===member.id)return this.resolvedIdentity;
    const {currentOrganization}=await this.catalog();this.guard();
    if(currentOrganization?.organizationId!==member.orgId||!currentOrganization.orgSlug||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(currentOrganization.orgSlug))return {membershipId:member.id,orgSlug:null,orgName:member.orgName};
    return this.resolvedIdentity={membershipId:member.id,orgSlug:currentOrganization.orgSlug,orgName:member.orgName};
  }
  private async request<T>(service:'plugin'|'auth'|'broker',route:string,options:PluginApiFetchOptions):Promise<T>{
    for(let attempt=0;attempt<2;attempt++){
      this.guard();const token=options.token===undefined?this.options.token():options.token;
      if(!token)throw new Error('AUTH_REQUIRED');
      const endpoint=this.options.endpoints()[service==='plugin'?'pluginApiBaseUrl':service==='broker'?'oauthBrokerApiBaseUrl':'authApiBaseUrl'];
      if(!endpoint)throw new Error('PLUGIN_SERVICE_UNAVAILABLE');
      const url=new URL(route,endpoint);
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.origin!==new URL(endpoint).origin)throw new Error('INVALID_ENDPOINT');
      const body=options.bodyFactory?options.bodyFactory():options.body;this.guard();
      let response:Response;
      try{response=await (this.options.fetch??fetch)(url,{method:options.method??'GET',redirect:'error',cache:options.cache,
        headers:{'content-type':'application/json',...options.headers,authorization:`Bearer ${token}`},
        ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.any([this.abort.signal,AbortSignal.timeout(options.timeoutMs??15_000)])});}
      catch{this.guard();throw new PluginPublisherApiError('NETWORK_ERROR',0,'NETWORK_ERROR');}
      this.guard();
      // Bound even chunked error responses; never echo upstream messages, URLs,
      // headers or bodies through the public terminal error path.
      const reader=response.body?.getReader();const chunks:Uint8Array[]=[];let size=0;
      try{if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>8*1024*1024)throw new Error('PLUGIN_RESPONSE_TOO_LARGE');chunks.push(part.value);}}
      finally{await reader?.cancel().catch(()=>{});reader?.releaseLock();}
      this.guard();let result:unknown;
      try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('PLUGIN_RESPONSE_INVALID');}
      if(response.ok)return result as T;
      const raw=(result as {error?:{code?:unknown}}|null)?.error?.code;
      const code=typeof raw==='string'?raw:'';
      if(attempt===0&&response.status===401&&options.token===undefined&&!options.skipAutoRefresh&&['TOKEN_EXPIRED','INVALID_TOKEN','UNAUTHORIZED'].includes(code)){
        await this.options.refresh();this.guard();continue;
      }
      const safe=options.allowedRedactedErrorCodes?.includes(code)?code:response.status===401?'UNAUTHORIZED':response.status===403?'FORBIDDEN':'PLUGIN_API_ERROR';
      throw new PluginPublisherApiError(safe,response.status,safe);
    }
    throw new Error('PLUGIN_API_ERROR');
  }
  close(){this.abort.abort();this.tokens.clearAll();this.resolvedIdentity=null;}
}
