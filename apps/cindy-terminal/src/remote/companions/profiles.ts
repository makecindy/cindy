import {readdir,realpath,lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {readPrivateFile,privateDirectory} from '../../platform.js';
import type {TerminalTaskHost} from '../../tasks/host.js';
import {botProfileDir,readBotProfileFolder,writeBotProfileFolder} from '@cindy/app-runtime/botProfileFolder';
import {createBotSkillStore,type BotSkillWriteInput} from '@cindy/companion-core/botSkillStore';
import {createBotSkillRuntimeSource} from '@cindy/companion-core/botSkillRuntimeSource';
import {cachedBotSkillRuntime} from '@cindy/companion-core/botSkillRuntimeCache';
import {projectBotSkillMounts} from '@cindy/companion-core/botSkillRuntimeProjection';
import {queryBotSkillIndex} from '@cindy/companion-core/botSkillQueryIndex';
import {parseCompanionModel,type CompanionModel} from './models.js';
const capabilityReferences = z
  .object({
    skills: z.array(z.string().min(1).max(4096)).max(4096).default([]),
    mcpMode: z.enum(["inherit", "allowlist"]).default("inherit"),
    mcpServers: z.array(z.string().min(1).max(80)).max(4096).default([]),
  })
  .strict();
export type CompanionCapabilityReferences = z.infer<
  typeof capabilityReferences
>;
export const companionCapabilities = (
  value?: unknown,
): CompanionCapabilityReferences => capabilityReferences.parse(value ?? {});

export interface TerminalCompanionProfile {
  id: string;
  name: string;
  description: string;
  avatar: string;
  status: "active" | "paused";
  version: number;
  createdAt: number;
  updatedAt: number;
  models: CompanionModel[];
  sessionId: string;
  templateId?: "cindy";
  capabilities?: CompanionCapabilityReferences;
}
const idOf = (value: string) => {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new Error("INVALID_COMPANION_ID");
  return value;
};
const fileOf = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(value) || value === "..")
    throw new Error("INVALID_COMPANION_FILE");
  return value;
};

/** Terminal/cloud projection of the original owner database and profile services. */
export class TerminalCompanionProfiles {
  private readonly skillStore=createBotSkillStore(botProfileDir);
  private readonly skillSource=createBotSkillRuntimeSource(this.skillStore);
  constructor(readonly root:string,private readonly guard:()=>void,private readonly tasks:TerminalTaskHost) {}
  private services(){this.guard();if(!this.tasks.bots)throw new Error('BOT_SERVICES_NOT_READY');return this.tasks.bots;}
  home(id:string){this.guard();return botProfileDir(this.root,idOf(id));}
  private async project(id:string):Promise<TerminalCompanionProfile>{
    const database=await this.tasks.database;
    const row=await this.services().profiles.readProfile(database.getDbClient(),id);
    this.guard();
    return {id:row.id,name:row.name,description:row.description,avatar:row.avatar??'',status:row.status==='paused'?'paused':'active',
      version:row.currentVersion,createdAt:row.createdAt,updatedAt:row.updatedAt,sessionId:row.canonicalSessionId??'',
      models:row.capabilities.modelChainOverride?.map(parseCompanionModel)??[],
      capabilities:{skills:row.skills,mcpMode:row.capabilities.mcpMode,mcpServers:row.capabilities.mcpServers},
      ...(row.templateId==='cindy'?{templateId:'cindy' as const}:{})};
  }
  async list(){
    const db=(await this.tasks.database).getDbClient();this.guard();
    const rows=await db.query<{id:string}>("SELECT id FROM bot_profiles WHERE status != 'deleting' ORDER BY created_at");
    return Promise.all(rows.map(row=>this.project(row.id)));
  }
  async get(id:string){
    idOf(id);this.guard();const db=(await this.tasks.database).getDbClient();
    const row=await db.queryOne<{id:string}>("SELECT id FROM bot_profiles WHERE id = ? AND status != 'deleting'",[id]);
    return row?this.project(id):undefined;
  }
  async create(input:{id?:string;name:string;description?:string;soul?:string;user?:string;avatar?:string;templateId?:'cindy'}){
    const row=await this.services().profiles.createBotProfile({...input,identitySource:input.soul,userContextSource:input.user});
    return this.project(row.id);
  }
  async change(id:string,patch:Partial<Pick<TerminalCompanionProfile,'name'|'description'|'avatar'|'status'|'models'|'capabilities'>> & {identitySource?:string;userContextSource?:string},expectedVersion?:number,guard:()=>void=()=>{}){
    this.guard();guard();const {models:rawModels,capabilities,status,...fields}=patch;const models=rawModels?.map(parseCompanionModel);
    const update={...fields,id,...(capabilities?{skills:capabilities.skills}:{}),
      ...((models||capabilities)?{capabilities:{...(capabilities?{mcpMode:capabilities.mcpMode,mcpServers:capabilities.mcpServers}:{}),
        ...(models?{modelChainOverride:models.length?models.map(model=>({...model,harness:model.agentKind==='claude-code'?'claude':model.agentKind,effort:model.effort??''})):null}:{})}}:{})};
    await this.services().profiles.updateBotProfile(update,expectedVersion,this.services().capabilities.validateAdditions);guard();this.guard();
    if(status)await this.tasks.botLifecycle!.run({botId:id,action:status==='paused'?'pause':'resume'});
    return this.project(id);
  }
  private async checkedPath(id: string, ...parts: string[]) {
    if (!(await this.get(id))) throw new Error("COMPANION_NOT_FOUND");
    return this.checkedExistingPath(id, ...parts);
  }
  private async checkedExistingPath(id: string, ...parts: string[]) {
    const home = this.home(id);
    for (const directory of [path.dirname(home), home]) {
      if ((await lstat(directory)).isSymbolicLink())
        throw new Error("UNSAFE_COMPANION_PATH");
    }
    const root = await realpath(this.root);
    const homeReal = await realpath(home);
    if (
      path.relative(root, homeReal).startsWith("..") ||
      path.isAbsolute(path.relative(root, homeReal))
    )
      throw new Error("UNSAFE_COMPANION_PATH");
    let directory = home;
    for (const part of parts.slice(0, -1)) {
      directory = path.join(directory, part);
      await privateDirectory(directory);
      const info = await lstat(directory);
      if (info.isSymbolicLink()) throw new Error("UNSAFE_COMPANION_PATH");
    }
    this.guard();
    return path.join(home, ...parts);
  }
  async read(id:string,name:string){
    await this.checkedPath(id,'_');const folder=await readBotProfileFolder(this.root,id,{strict:true});this.guard();
    if(name==='SOUL.md')return folder.identitySource;
    if(name==='USER.md')return folder.userContextSource;
    if(name==='system_prompt.md')return folder.systemPromptOverride;
    throw new Error('INVALID_COMPANION_FILE');
  }
  async write(id:string,name:string,text:string){
    if(name==='SOUL.md'||name==='USER.md'){await this.change(id,name==='SOUL.md'?{identitySource:text}:{userContextSource:text});return;}
    if(name!=='system_prompt.md')throw new Error('INVALID_COMPANION_FILE');
    await this.checkedPath(id,'_');await writeBotProfileFolder(this.root,id,{systemPromptOverride:text});
    this.guard();await this.services().profiles.reconcileBotProfileFolder(id);
  }
  async files(id:string,kind:'memories'|'skills'){
    await this.checkedPath(id,'_');
    return kind==='skills'?(await this.services().skills.listBotSkillSourcesForBot(id)).map(row=>row.slug)
      :(await this.services().memory.list(id)).map(row=>row.filename);
  }
  async readMemory(id:string,name:string){
    const file=await this.checkedPath(id,'memories',fileOf(name));
    const raw=await readPrivateFile(file);this.guard();return raw?.toString()??null;
  }
  async writeMemory(id:string,name:string,text:string){await this.services().memory.restoreRaw(id,name,text);this.guard();}
  async removeMemory(id:string,name:string){await this.services().memory.removeRaw(id,name);this.guard();}
  async readSkill(id: string, slug: string) {
    await this.checkedSkillPath(id,slug);
    const raw = await this.skillStore.readBotSkillSource(this.root,id,slug);
    this.guard();
    return raw;
  }
  async writeSkill(id: string, slug: string, text: string) {
    await this.checkedSkillPath(id,slug);
    await this.skillStore.saveBotSkillSource(this.root,id,slug,text);
    this.guard();
  }
  async skillEnabled(id: string, slug: string) {
    await this.checkedSkillPath(id,slug);
    return (await this.skillStore.readBotSkill(this.root,id,slug))?.enabled!==false;
  }
  async setSkillEnabled(id: string, slug: string, enabled: boolean) {
    await this.checkedSkillPath(id,slug);
    const source=await this.skillStore.readBotSkillSource(this.root,id,slug);
    if(source===null)throw new Error('SKILL_NOT_FOUND');
    await this.skillStore.saveBotSkillSource(this.root,id,slug,source,{enabled});
    this.guard();
  }
  async removeSkill(id: string, slug: string) {
    await this.checkedSkillPath(id,slug);
    await this.skillStore.deleteBotSkill(this.root,id,slug);
    this.guard();
  }
  private async checkedSkillPath(id:string,slug:string){
    await this.checkedPath(id,'_');await this.checkedSkillShelves(id,slug);
  }
  private async checkedSkillShelves(id:string,slug:string){
    idOf(slug);
    for(const shelf of ['skills','disabled-skills']){
      for(const location of [path.join(this.home(id),shelf),path.join(this.home(id),shelf,slug)]){
        try{if((await lstat(location)).isSymbolicLink())throw new Error('UNSAFE_PROFILE_DIRECTORY');}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      for(const name of ['SKILL.md','skill.md']){
        try{if((await lstat(path.join(this.home(id),shelf,slug,name))).isSymbolicLink())throw new Error('UNSAFE_PRIVATE_FILE');}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
    }
    this.guard();
  }
  async runtimeSkills(id:string){
    await this.checkedPath(id,'_');
    return cachedBotSkillRuntime(this.home(id),()=>projectBotSkillMounts(this.home(id),this.skillSource.iterateBotSkillRuntimeSummaries(this.root,id)));
  }
  async querySkills(id:string,input:{query?:string;offset?:number;limit?:number}){
    await this.checkedPath(id,'_');
    return queryBotSkillIndex(this.home(id),this.root,id,input,()=>this.skillSource.iterateBotSkillQuerySummaries(this.root,id));
  }
  async saveSkill(id:string,input:BotSkillWriteInput){
    const slug=input.slug ?? this.skillStore.normalizeBotSkillSlug(input.name);
    if(!slug)throw new Error('SKILL_SLUG_REQUIRED');
    await this.checkedSkillPath(id,slug);
    const result=await this.skillStore.saveBotSkill(this.root,id,input);
    this.guard();return result;
  }
  async remove(id:string){const profile=await this.get(id);if(!profile)return;await this.tasks.botLifecycle!.run({botId:id,action:'delete',confirmName:profile.name});}
  async close(){}
}
