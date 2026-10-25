import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat, realpath, open } from 'node:fs/promises';
import { z } from 'zod';
import { validateCustomMcpConfig, prepareCodexGlobalSkillsLinks, type CustomMcpConfig, type AgentKind, type AgentSkillCommand } from '@cindy/maker-core';
import { scanClaudeCustomizations, scanCodexCustomizations, scanPiCustomizations, parseFrontmatter } from '@cindy/maker-core/customization-scanner';
import { atomicPrivateWrite, privateDirectory, readPrivateFile } from '../platform.js';
import type { InvocationContext, TerminalSecrets } from '../contracts.js';
import type { TerminalMcpApps } from './mcp-apps.js';
import type { McpProviderContext } from '@cindy/maker-core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PROVIDER_NAME_TO_PLUGIN_ID } from '@cindy/app-runtime/builtinPluginIds';
import { TERMINAL_PLUGIN_MCP_NAME, TASK_CORE_MCP_NAMES } from './mcp-names.js';

const skillSchema=z.object({id:z.string(),path:z.string(),scope:z.enum(['user','project']),workingDir:z.string().optional()}).strict();
const stateSchema=z.object({version:z.literal(1),mcp:z.array(z.object({id:z.string(),name:z.string(),url:z.string(),transport:z.enum(['http','sse']),headers:z.record(z.string(),z.string())})),skills:z.array(skillSchema),disabledSkills:z.array(z.string()).default([]),disabledMcp:z.array(z.string()).default([]),mcpScopes:z.record(z.string(),z.string()).default({})});
type State=z.infer<typeof stateSchema>;
const RESERVED=[...new Set([...Object.keys(PROVIDER_NAME_TO_PLUGIN_ID),...Object.values(TASK_CORE_MCP_NAMES),TERMINAL_PLUGIN_MCP_NAME,'cindy_skills','cindy_ghosts','cindy_telegram_bot','cindy_group_history','orca_worker_bridge'])];
export const CAPABILITY_CHANNELS=['maker:mcp:custom:list','maker:mcp:custom:create','maker:mcp:custom:update','maker:mcp:custom:delete','maker:mcp:custom:refresh','terminal:mcp:set-enabled','terminal:skills:list','terminal:skills:import','terminal:skills:create','terminal:skills:set-enabled','terminal:skills:remove'];
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_ARGUMENT');return value as Record<string,unknown>;};
const text=(value:unknown)=>{if(typeof value!=='string'||!value.trim())throw new Error('INVALID_ARGUMENT');return value;};

/** Explicit user configuration only. Native user/project discovery remains in
 * each harness; companion hosts opt into selected entries separately. */
export class TerminalCapabilities {
  private state:State={version:1,mcp:[],skills:[],disabledSkills:[],disabledMcp:[],mcpScopes:{}};
  private configs:CustomMcpConfig[]=[];
  private pending:Promise<unknown>=Promise.resolve();
  private closed=false;
  private generation=0;
  readonly ready:Promise<void>;
  constructor(private options:{root:string;secrets:TerminalSecrets;secretsLocked?:()=>boolean;apps:TerminalMcpApps;assertCurrent():void;changed():void;workingDirs():Promise<string[]>}){this.ready=this.open();void this.ready.catch(()=>{});}
  revision(){return this.generation;}
  disabledSkillPaths(){this.guard();return this.state.disabledSkills;}
  guard(){if(this.closed)throw new Error('CAPABILITIES_CLOSED');this.options.assertCurrent();}
  private async open(){
    const raw=await readPrivateFile(path.join(this.options.root,'capabilities.json'));this.guard();if(raw)this.state=stateSchema.parse(JSON.parse(raw.toString()));
    const store=await this.options.apps.configuration();this.guard();
    // Earlier terminal previews used a sidecar. Import once into Cindy's original
    // account table, then keep only terminal preferences in this file.
    if(this.state.mcp.length){
      for(const config of this.state.mcp)if(validateCustomMcpConfig(config,RESERVED).ok&&!await store.customMcpServerExists(config.id))await store.createCustomMcpServer(config);
      this.state.mcp=[];await atomicPrivateWrite(path.join(this.options.root,'capabilities.json'),JSON.stringify(this.state));
    }
    await this.refreshMcp();
  }
  private async refreshMcp(){
    const store=await this.options.apps.configuration();const configs=await store.listCustomMcpServers();this.guard();
    const entries=[];
    for(const config of configs){
      if(this.options.secretsLocked?.())break;
      if(!validateCustomMcpConfig(config,RESERVED).ok||this.state.disabledMcp.includes(config.id))continue;
      const raw=await this.options.secrets.get(this.key(config.id));this.guard();const secret=raw?object(JSON.parse(raw)):{};
      entries.push({config:{...config,headers:secret.headers?object(secret.headers) as Record<string,string>:config.headers},token:typeof secret.token==='string'?secret.token:null,remoteEligible:!this.state.disabledMcp.includes(config.id)&&!this.state.mcpScopes[config.id]});
    }
    this.configs=configs;this.options.apps.replaceConfigs(entries);
  }
  private async change(work:(next:State,undo:Array<()=>Promise<void>>)=>Promise<void>,context?:InvocationContext){
    await this.ready;
    const run=this.pending.then(async()=>{
      this.guard();context?.assertCurrent?.();const next=structuredClone(this.state),undo:Array<()=>Promise<void>>=[];
      try {await work(next,undo);this.guard();context?.signal?.throwIfAborted();context?.assertCurrent?.();await atomicPrivateWrite(path.join(this.options.root,'capabilities.json'),JSON.stringify(next));}
      catch(error){for(const restore of undo.reverse())await restore();throw error;}
      this.state=next;await this.refreshMcp();this.generation++;this.options.changed();
    });this.pending=run.catch(()=>{});await run;
  }
  private within(file:string,root:string){const relative=path.relative(root,path.resolve(file));return relative===''||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);}
  private key(id:string){return `terminal:mcp:${id}`;}
  async mcpEntries(workingDir:string){
    await this.ready;this.guard();const root=await realpath(workingDir);this.guard();
    return this.configs.filter(config=>!this.state.mcpScopes[config.id]||this.within(root,this.state.mcpScopes[config.id])).map(config=>({id:config.id,name:config.name,enabled:!this.state.disabledMcp.includes(config.id)}));
  }
  async listSkills(workingDirs?:string[],kind?:AgentKind){
    await this.ready;this.guard();const dirs=workingDirs??await this.options.workingDirs();
    const scans=await Promise.all((kind?[kind]:['claude-code','codex','pi'] as AgentKind[]).map(engine=>{
      const scan=engine==='claude-code'?scanClaudeCustomizations:engine==='pi'?scanPiCustomizations:scanCodexCustomizations;
      return scan({workingDirs:dirs,kinds:['skill']});
    }));this.guard();
    const seen=new Set<string>();
    const result={items:scans.flatMap(scan=>scan.items).filter(item=>{const id=item.mdPath??item.absolutePath;if(seen.has(id))return false;seen.add(id);return true;}),errors:scans.flatMap(scan=>scan.errors)};
    const managed=await this.managed(dirs);
    for(const skill of managed)if(!result.items.some(item=>item.mdPath===skill.path))result.items.push({engine:kind??'codex',kind:'skill',scope:skill.scope??'user',name:skill.name,description:skill.description,absolutePath:path.dirname(skill.path!),mdPath:skill.path,enabled:skill.enabled});
    return {...result,items:result.items.map(item=>({...item,id:createHash('sha256').update(item.mdPath??item.absolutePath).digest('hex'),enabled:item.enabled!==false&&!this.state.disabledSkills.includes(item.mdPath??item.absolutePath),managed:this.state.skills.some(skill=>skill.path===(item.mdPath??item.absolutePath))}))};
  }
  async managed(dirs:string[]):Promise<Array<AgentSkillCommand&{claudeCommandName:string}>>{
    await this.ready;this.guard();const result:Array<AgentSkillCommand&{claudeCommandName:string}>=[];
    dirs=await Promise.all(dirs.map(dir=>realpath(dir).catch(()=>path.resolve(dir))));this.guard();
    for(const skill of this.state.skills){
      if(skill.scope==='project'&&!dirs.some(dir=>this.within(dir,skill.workingDir!)))continue;
      const raw=await readFile(skill.path,'utf8').catch(()=>null);if(!raw)continue;
      const front=parseFrontmatter(raw);const name=typeof front.frontmatter?.name==='string'?front.frontmatter.name:path.basename(path.dirname(skill.path));
      result.push({kind:'agent-skill',name,description:front.description,path:skill.path,source:'user',scope:skill.scope,enabled:!this.state.disabledSkills.includes(skill.path),claudeCommandName:`terminal_${skill.id}`});
    }
    return result;
  }
  mcpProviders(input:{workingDir:string;remoteHostId?:string|null;mcpIds?:string[]}) {
    this.guard();
    return this.options.apps.providers().filter(provider=>{
      const scope=this.state.mcpScopes[provider.name];
      return !(scope&&(input.remoteHostId||!this.within(input.workingDir,scope)))&&!this.state.disabledMcp.includes(provider.name)&&(!input.mcpIds||input.mcpIds.includes(provider.name));
    });
  }
  async runtime(input:{workingDir:string;agentKind:AgentKind;remoteHostId?:string|null;skillIds?:string[];mcpIds?:string[]}){
    await this.ready;this.guard();const generation=this.generation;let closed=false;
    const workingDir=input.remoteHostId?input.workingDir:await realpath(input.workingDir);this.guard();
    const isCurrent=()=>{if(closed||this.closed||generation!==this.generation)return false;try{this.guard();return true;}catch{return false;}};
    const bindings=this.mcpProviders({...input,workingDir});
    const managed=(await this.managed(input.remoteHostId?[]:[workingDir])).filter(skill=>!input.skillIds||input.skillIds.includes(this.state.skills.find(item=>item.path===skill.path)?.id??''));
    return {revision:generation,factoryCapabilities:Object.fromEntries(bindings.map(binding=>[binding.name,{title:this.configs.find(config=>config.id===binding.name)?.name??binding.name,description:'',source:'custom' as const}])),appServerIds:bindings.map(binding=>binding.name),factories:Object.fromEntries(bindings.map(binding=>[binding.name,(context:McpProviderContext)=>{if(!isCurrent())throw new Error('MCP_CONFIGURATION_CHANGED');return (binding.toClaudeSdkConfig(context) as {instance:McpServer}).instance;}])),
      getManagedSkills:async()=>managed.filter(skill=>skill.enabled),getDisabledSkillPaths:()=>this.state.disabledSkills,
      prepareCodexSkills:async(home:string)=>{this.guard();await prepareCodexGlobalSkillsLinks(home,{managedRoots:[this.options.root],managedSkills:managed.filter(skill=>skill.enabled)});},
      close:async()=>{closed=true;}};
  }
  async invoke(channel:string,args:unknown[],context:InvocationContext){
    await this.ready;this.guard();if(context.sharedTask)throw new Error('OWNER_REQUIRED');context.assertCurrent?.();
    if(channel==='maker:mcp:custom:list')return {servers:this.configs.map(config=>({...config,scope:this.state.mcpScopes[config.id]?'project':'user',workingDir:this.state.mcpScopes[config.id],enabled:!this.state.disabledMcp.includes(config.id),headers:{}}))};
    if(channel==='terminal:skills:list')return this.listSkills();
    if(context.source!=='local')throw new Error('LOCAL_ONLY_COMMAND');
    if(channel==='maker:mcp:custom:create'||channel==='maker:mcp:custom:update'){
      const input=object(args[0]);
      return this.saveMcp(channel,[input,...args.slice(1)],context);
    }
    return this.invokeOther(channel,args,context);
  }
  /** Only the local controller or an authenticated configuration lease calls this. */
  async configureMcp(action:'create'|'edit',raw:Record<string,unknown>,context:InvocationContext){
    const {token,headers,...input}=raw;
    if(headers!==undefined&&headers!=='')input.headers=typeof headers==='string'?object(JSON.parse(headers)):object(headers);
    else if(action==='create')input.headers={};
    return this.saveMcp(`maker:mcp:custom:${action==='edit'?'update':'create'}`,[input,...(token!==undefined&&token!==''?[token]:[])],context);
  }
  private async saveMcp(channel:string,args:unknown[],context:InvocationContext){
      this.guard();if(context.sharedTask)throw new Error('OWNER_REQUIRED');context.assertCurrent?.();
      const input=object(args[0]);const validation=validateCustomMcpConfig(input,RESERVED);if(!validation.ok)throw new Error('INVALID_MCP_CONFIG');
      const config=input as unknown as CustomMcpConfig;const endpoint=new URL(config.url);if(endpoint.username||endpoint.password||endpoint.hash)throw new Error('INVALID_MCP_URL');
      const project=input.scope==='project'?await realpath(text(input.workingDir)):undefined;if(project&&!(await stat(project)).isDirectory())throw new Error('INVALID_WORKING_DIRECTORY');
      await this.change(async (next,undo)=>{const store=await this.options.apps.configuration(),existing=await store.getCustomMcpServer(config.id);if(channel.endsWith(':create')&&existing)throw new Error('MCP_ALREADY_EXISTS');if(channel.endsWith(':update')&&!existing)throw new Error('MCP_NOT_FOUND');
        const previous=await this.options.secrets.get(this.key(config.id));const secret=previous?object(JSON.parse(previous)):{};undo.push(async()=>{if(previous===null)await this.options.secrets.delete(this.key(config.id));else await this.options.secrets.set(this.key(config.id),previous);});
        if(Object.hasOwn(input,'headers'))secret.headers=config.headers;if(args[1]!==undefined){if(typeof args[1]!=='string')throw new Error('INVALID_MCP_TOKEN');secret.token=args[1];}
        await this.options.secrets.set(this.key(config.id),JSON.stringify(secret));
        if(input.scope!==undefined){if(!['user','project'].includes(String(input.scope)))throw new Error('INVALID_MCP_SCOPE');if(project)next.mcpScopes[config.id]=project;else delete next.mcpScopes[config.id];}
        const safe={id:config.id,name:config.name.trim(),transport:config.transport,url:endpoint.href,headers:{}};undo.push(async()=>{if(existing)await store.updateCustomMcpServer(config.id,existing);else await store.deleteCustomMcpServer(config.id);});if(existing)await store.updateCustomMcpServer(config.id,safe);else await store.createCustomMcpServer(safe);
      },context);return {ok:true};
  }
  private async invokeOther(channel:string,args:unknown[],context:InvocationContext){
    if(channel==='maker:mcp:custom:delete'){const id=text(args[0]);await this.change(async (next,undo)=>{const store=await this.options.apps.configuration(),existing=await store.getCustomMcpServer(id);if(existing){undo.push(async()=>{if(!await store.customMcpServerExists(id))await store.createCustomMcpServer(existing);});await store.deleteCustomMcpServer(id);}delete next.mcpScopes[id];const previous=await this.options.secrets.get(this.key(id));undo.push(async()=>{if(previous!==null)await this.options.secrets.set(this.key(id),previous);});await this.options.secrets.delete(this.key(id));},context);return {ok:true};}
    if(channel==='maker:mcp:custom:refresh'){await this.refreshMcp();this.generation++;this.options.changed();return {ok:true};}
    if(channel==='terminal:mcp:set-enabled'){const id=text(args[0]);if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');await this.change(async next=>{if(!this.configs.some(item=>item.id===id))throw new Error('MCP_NOT_FOUND');next.disabledMcp=args[1]?next.disabledMcp.filter(value=>value!==id):[...new Set([...next.disabledMcp,id])];},context);return {ok:true};}
    if(channel==='terminal:skills:import'||channel==='terminal:skills:create'){
      const input=object(args[0]);const scope=input.scope==='project'?'project':'user';const workingDir=scope==='project'?await realpath(text(input.workingDir)):undefined;
      let source:string;
      if(channel.endsWith(':create')){const name=text(input.name);if(!/^[a-z0-9_-]{1,80}$/.test(name))throw new Error('INVALID_SKILL_NAME');const root=path.join(this.options.root,'managed-agent-skills','cindy',name);await privateDirectory(root);source=path.join(root,'SKILL.md');const file=await open(source,'wx',0o600);try{await file.writeFile(`---\nname: ${name}\ndescription: ${JSON.stringify(text(input.description))}\n---\n\n${text(input.body)}\n`);}finally{await file.close();}}
      else {source=await realpath(text(input.path));if((await stat(source)).isDirectory())source=path.join(source,'SKILL.md');}
      const info=await stat(source);if(!info.isFile()||info.size>1024*1024||path.basename(source)!=='SKILL.md')throw new Error('INVALID_SKILL_FILE');
      const parsed=parseFrontmatter(await readFile(source,'utf8'));if(parsed.parseError)throw new Error('INVALID_SKILL_FILE');
      const id=createHash('sha256').update(source).digest('hex');await this.change(async next=>{if(next.skills.some(skill=>skill.id===id))throw new Error('SKILL_ALREADY_EXISTS');next.skills.push({id,path:source,scope,...(workingDir?{workingDir}:{})});},context);return {id};
    }
    if(channel==='terminal:skills:set-enabled'||channel==='terminal:skills:remove'){
      const id=text(args[0]);const row=(await this.listSkills()).items.find(item=>item.id===id);if(!row)throw new Error('SKILL_NOT_FOUND');const file=row.mdPath??row.absolutePath;
      await this.change(async next=>{if(channel.endsWith(':remove')){if(!row.managed)throw new Error('NATIVE_SKILL_UNREGISTER_NOT_SUPPORTED');next.skills=next.skills.filter(skill=>skill.path!==file);}else{if(typeof args[1]!=='boolean')throw new Error('INVALID_ARGUMENT');next.disabledSkills=args[1]?next.disabledSkills.filter(path=>path!==file):[...new Set([...next.disabledSkills,file])];}},context);return {ok:true};
    }
    throw new Error('UNSUPPORTED_CHANNEL');
  }
  async close(){this.closed=true;await this.pending;}
}
