import { appendProviderRequestPath, type AgentKind, type ProviderWireProtocol } from '@cindy/model-providers';
import { collectModelDiscoveryPages } from '@cindy/model-providers';
import { classifyProviderError } from '@cindy/maker-shared/provider-errors';
import { createChatgptProxy, createGrokProxy } from './subscription-proxy.js';
import { createProviderProxy } from './proxy.js';
import { ENGINES, TerminalModelConfig } from './config.js';

function object(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_PROVIDER_INPUT');return value as Record<string,unknown>;}
function agent(value:unknown):AgentKind{if(!ENGINES.includes(value as AgentKind))throw new Error('INVALID_ENGINE');return value as AgentKind;}
function endpoint(value:unknown):string{if(typeof value!=='string')throw new Error('INVALID_PROVIDER_URL');const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('INVALID_PROVIDER_URL');return value.replace(/\/+$/,'');}
function headers(value:unknown):Record<string,string>{const result:Record<string,string>={};if(value===undefined)return result;for(const [name,entry]of Object.entries(object(value))){if(typeof entry!=='string'||/[\r\n]/.test(entry)||!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||['host','connection','content-length','transfer-encoding','upgrade'].includes(name.toLowerCase()))throw new Error('INVALID_PROVIDER_HEADER');result[name.toLowerCase()]=entry;}return result;}
async function json(response:Response):Promise<unknown>{if(!response.body)throw new Error('EMPTY_PROVIDER_RESPONSE');const reader=response.body.getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>4*1024*1024)throw new Error('PROVIDER_RESPONSE_TOO_LARGE');chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
async function firstEvent(response:Response):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)throw new Error('EMPTY_PROVIDER_RESPONSE');
  let pending='',size=0,last:unknown;const decoder=new TextDecoder();
  try{for(;;){
    const {done,value}=await reader.read();if(value){size+=value.byteLength;pending+=decoder.decode(value,{stream:!done});}
    if(size>4*1024*1024)throw new Error('PROVIDER_RESPONSE_TOO_LARGE');
    const lines=pending.split('\n');pending=done?'':lines.pop()??'';
    for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]'){if(last)return last;continue;}
      let parsed:Record<string,unknown>;try{parsed=object(JSON.parse(data));}catch{continue;}
      if(parsed.error||['error','response.failed','response.incomplete'].includes(String(parsed.type)))return {...parsed,error:parsed.error??true};
      if(['response.completed','message_stop'].includes(String(parsed.type)))return parsed;
      if(Array.isArray(parsed.choices)&&parsed.choices.length||Array.isArray(parsed.candidates)&&parsed.candidates.length||['content_block_delta','response.output_text.delta'].includes(String(parsed.type)))last=parsed;
    }
    if(done){if(last)return last;throw new Error('EMPTY_PROVIDER_RESPONSE');}
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
const failure=(error:unknown,status?:number)=>({ok:false as const,code:classifyProviderError({status,networkErrorCode:error instanceof Error?String((error as Error & {code?:string;cause?:{code?:string}}).cause?.code??(error as Error & {code?:string}).code??error.name):undefined}).code,...(status?{status}:{})});

/** Probe through the same adapter/proxy path used by real native tasks. */
export async function testConnection(models:TerminalModelConfig,input:unknown,guard:()=>void,signal?:AbortSignal){
  const request=object(input);const started=Date.now();let chosen;let kind:AgentKind;let key:string|null;let extra:Record<string,string>;
  if(request.kind==='saved'){
    kind=agent(request.agent);const providerId=String(request.providerId??'');const provider=(await models.views()).find(p=>p.id===providerId);guard();const model=provider?.models[kind]?.find(m=>!m.disabled);
    if(!provider||!model)throw new Error('MODEL_ROUTE_UNAVAILABLE');if(provider.source!=='user')throw new Error('NATIVE_CONNECTION_REQUIRES_NATIVE_PROBE');
    chosen=await models.select({agentKind:kind,providerId,model:model.id});key=await models.credential(providerId,kind);extra=await models.headers(providerId,kind);
  }else if(request.kind==='adhoc'){
    const spec=object(request.spec);kind=agent(spec.agent);if(spec.authMethod!=='none'&&spec.authMethod!=='apiKey')throw new Error('NATIVE_LOGIN_REQUIRED');
    const id='probe';
    // Reuse provider parsing and shared route selection without persisting the form or secret.
    const config={id,name:'Probe',auth:{method:spec.authMethod},runtimes:{[kind]:{baseUrl:endpoint(spec.baseUrl),wireProtocol:spec.wireProtocol,models:[{id:String(spec.modelId??''),name:String(spec.modelId??'')}]}}};
    const provider=models.previewProvider(config);chosen={route:provider.route,selection:provider.selection};key=typeof spec.apiKey==='string'?spec.apiKey:null;extra=headers(spec.headers);
  }else throw new Error('INVALID_PROVIDER_INPUT');
  guard();
  const authorize = async () => { guard(); return true; };
  const openai = models.openAiAccount(chosen.selection.providerId), grok = models.grokAccount(chosen.selection.providerId);
  const proxy = openai ? await createChatgptProxy({ route: chosen.route, kind, taskId: 'provider-test', accounts: openai, authorize })
    : grok ? await createGrokProxy({ route: chosen.route, kind, taskId: 'provider-test', accounts: grok, authorize })
    : await createProviderProxy(chosen.route,kind,key,extra,authorize);
  try {
    guard();const wire=kind==='claude-code'?'anthropic-messages':kind==='codex'?'openai-responses':chosen.route.routing.wireProtocol??'openai-chat';const response=await fetch(appendProviderRequestPath(proxy.url,wire==='anthropic-messages'?'/v1/messages':wire==='openai-chat'?'/chat/completions':'/responses'),{method:'POST',headers:{authorization:`Bearer ${proxy.token}`,'content-type':'application/json'},body:JSON.stringify(wire==='anthropic-messages'?{model:chosen.selection.model,max_tokens:1,messages:[{role:'user',content:'ping'}],stream:false}:wire==='openai-chat'?{model:chosen.selection.model,max_tokens:16,messages:[{role:'user',content:'ping'}],stream:false}:{model:chosen.selection.model,input:'ping',max_output_tokens:16,stream:false,store:false}),signal:AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])])});
    const body=response.headers.get('content-type')?.includes('text/event-stream')?await firstEvent(response):await json(response);guard();if(!response.ok||object(body).error)return {...failure(new Error('Provider probe failed'),response.status),latencyMs:Date.now()-started};
    return {ok:true as const,latencyMs:Date.now()-started};
  }catch(error){guard();return {...failure(error),latencyMs:Date.now()-started};}finally{await proxy.close();}
}

export async function fetchModels(models:TerminalModelConfig,input:unknown,guard:()=>void,signal?:AbortSignal){
  const spec=object(input);const kind=agent(spec.agent);let base=endpoint(spec.baseUrl);let protocol=spec.wireProtocol as ProviderWireProtocol|undefined;let key=typeof spec.apiKey==='string'?spec.apiKey:null;let extra=headers(spec.headers);let modelsUrl=typeof spec.modelsUrl==='string'?endpoint(spec.modelsUrl):undefined;
  if(spec.savedProviderId && (models.openAiAccount(String(spec.savedProviderId)) || models.grokAccount(String(spec.savedProviderId)))) { await models.refresh(String(spec.savedProviderId)); guard(); const provider=(await models.views()).find(p=>p.id===spec.savedProviderId); return {ok:true,models:provider?.models[kind]??[]}; }
  if(spec.savedProviderId){const config=models.snapshot().providers.find(p=>p.id===spec.savedProviderId);const runtime=config?.runtimes[kind];if(!runtime)throw new Error('PROVIDER_RUNTIME_REQUIRED');base=runtime.baseUrl;modelsUrl=runtime.modelsUrl;protocol=runtime.wireProtocol;key=await models.credential(config!.id,kind);extra={...await models.headers(config!.id,kind),...extra};}
  if(spec.authMethod==='oauth'&&!spec.savedProviderId)throw new Error('SAVED_PROVIDER_REQUIRED');
  const url=modelsUrl&&(spec.savedProviderId||new URL(modelsUrl).origin===new URL(base).origin)?modelsUrl:appendProviderRequestPath(base,'/models');
  const authorization={...extra,...(key?(protocol==='anthropic-messages'||!protocol&&kind==='claude-code'?{'x-api-key':key,authorization:`Bearer ${key}`}: {authorization:`Bearer ${key}`}):{}),...(protocol==='anthropic-messages'||!protocol&&kind==='claude-code'?{'anthropic-version':'2023-06-01'}:{})};
  let status:number|undefined;
  try {const fetchPage=async(target:string)=>{guard();const response=await fetch(target,{headers:authorization,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])])});status=response.status;if(!response.ok){await response.body?.cancel();throw new Error('Provider discovery failed');}const body=await json(response);guard();return body;};const first=await fetchPage(url);const found=await collectModelDiscoveryPages(first,url,fetchPage);guard();return found?{ok:true,models:found}:{ok:false,code:'UNKNOWN'};}
  catch(error){guard();return failure(error,status);}
}
