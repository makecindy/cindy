import { terminalNodeExecutable } from '../version.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { packGhostDir,scaffoldGhostDir } from '@cindy/plugin-runtime/forge';
import { createNativeScaffoldWriter } from '@cindy/plugin-runtime/nativeScaffold';
import { GhostInstallTargetRequiredError } from '@cindy/plugin-runtime/ghostInstallTarget';
import { buildGhostInstallConsentInteraction,type HostPermissionRequester } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import type { CindyGhostsMcpDeps } from 'cindy-tools';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginPublisher } from './publisher.js';
import type { TerminalPluginAccount } from './account.js';
import type { TerminalTaskMedia } from '../tasks/media.js';
import { VERSION } from '../platform.js';
import { authorizePluginPaths,type PluginTaskContext } from './permissions.js';

type ForgeMethods=Pick<CindyGhostsMcpDeps,'forgeGuide'|'forgeScaffold'|'forgePack'|'forgeInstall'|'forgePublish'|'forgePublishStatus'>;
export function createTerminalPluginForge(options:{
  root:string;runtimeDirectory:string;host:TerminalPlugins;publisher:TerminalPluginPublisher;account:TerminalPluginAccount;
  context:PluginTaskContext;media:TerminalTaskMedia;requestPermission:HostPermissionRequester;translate(key:string):string;
}):ForgeMethods{
  const {context}=options;
  const access=async(dir:string,tool:string,allowMissing=false)=>{
    context.assertCurrent();const live=await context.snapshot();context.assertCurrent();
    if(!live||live.remoteHostId)throw new Error('WORKDIR_NOT_LOCAL');
    return authorizePluginPaths(context,{ghostId:'cindy-forge',ghostName:'Cindy',sourceTool:tool,lane:'forge_source',operation:'write',items:[{name:path.basename(dir),absPath:dir,size:0,isDirectory:true}]},{write:true,allowMissing});
  };
  const pack=async(dir:string,iconSource:string|undefined,tool:string)=>{
    const grant=await access(dir,tool);
    let iconPng:Buffer|undefined,iconNote='';
    if(iconSource){
      try{
        const source=await options.media.resolveManaged(iconSource,context.sessionId);grant.assertCurrent();
        const bytes=await readFile(source.path);if(bytes.length>25*1024*1024)throw new Error('ICON_TOO_LARGE');
        const sharp=(await import('sharp')).default;iconPng=await sharp(bytes,{limitInputPixels:25_000_000}).rotate().resize(512,512,{fit:'inside',withoutEnlargement:true}).png().toBuffer();grant.assertCurrent();
      }catch{iconNote='The supplied icon could not be embedded; the source icon was retained. ';}
    }
    const result=await packGhostDir(dir,{sessionWorkdir:context.workingDir,forbiddenRootDirs:['plugins','plugin-approvals','plugin-publish-staging'].map(dir=>path.join(options.root,dir)),iconPng,allowOutsideWorkdir:!grant.inside,authorizedDir:grant.paths[0],isCurrent:grant.isCurrent});grant.assertCurrent();
    return {result,grant,iconNote};
  };
  const permissionError=(error:unknown)=>({ok:false as const,errorCode:'PERMISSION_DENIED' as const,message:error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'The current task could not authorize this operation.'});
  return {
    forgeGuide:async()=>{context.assertCurrent();return readFile(path.join(options.runtimeDirectory,'plugin-forge-guide.md'),'utf8');},
    forgeScaffold:async request=>{
      try{
        const minCindyVersion=request.minCindyVersion?.trim()??VERSION;
        if(minCindyVersion==='0.0.0'||!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(minCindyVersion))return {ok:false,errorCode:'INVALID_INPUT',message:'Specify the first stable Cindy version required by this plugin.'};
        const grant=await access(request.dir,'ghost_forge_scaffold',true);
        return scaffoldGhostDir({...request,minCindyVersion},{sessionWorkdir:context.workingDir,forbiddenRootDirs:['plugins','plugin-approvals','plugin-publish-staging'].map(dir=>path.join(options.root,dir)),allowOutsideWorkdir:!grant.inside,authorizedDir:grant.paths[0],isCurrent:grant.isCurrent,writeScaffold:createNativeScaffoldWriter({nodePath:terminalNodeExecutable(),workerPath:path.join(options.runtimeDirectory,'plugin-scaffold-worker.cjs')})});
      }catch(error){return permissionError(error);}
    },
    forgePack:async request=>{
      try{
        const {result,iconNote}=await pack(request.dir,request.iconSource,'ghost_forge_pack');if(!result.ok)return result;
        const publishToken=request.intent==='publish'?options.publisher.stage(result.buf,result.manifest.id,options.host.native.list()):undefined;
        return {ok:true,cindyPath:publishToken?path.basename(result.cindyPath):result.cindyPath,id:result.manifest.id,name:result.manifest.name,version:result.manifest.version,...(publishToken?{publishToken}:{}),note:iconNote+'Package created.'};
      }catch(error){return permissionError(error);}
    },
    forgeInstall:async request=>{
      let pending:string|undefined;const controller=`task:${context.sessionId}:${context.instanceId()}`;
      try{
        const {result,grant,iconNote}=await pack(request.dir,request.iconSource,'ghost_forge_install');if(!result.ok)return result;
        const identity=await options.account.publisherIdentity();grant.assertCurrent();
        const prepared=await options.host.prepareInstall(result.cindyPath,controller,{...request,installOrigin:'agent-forge'},identity?.orgSlug??null);pending=prepared.id;grant.assertCurrent();
        if(prepared.packageSha256!==(await import('node:crypto')).createHash('sha256').update(result.buf).digest('hex'))throw new Error('PLUGIN_PACKAGE_CHANGED');
        const decision=await options.requestPermission(context.sessionId,context.instanceId(),buildGhostInstallConsentInteraction(randomUUID(),{facts:prepared.facts,initiator:'agent',origin:'forge',target:prepared.target},options.translate),new AbortController().signal);grant.assertCurrent();
        if(decision?.kind!=='permission'||decision.behavior!=='allow')return {ok:false,errorCode:'MUTATION_CANCELLED',message:'Plugin installation was cancelled.'};
        const ghost=await options.host.confirmInstall(prepared.id,controller,grant.assertCurrent);pending=undefined;
        return {ok:true,action:prepared.facts.kind==='install'?'installed':'updated',id:ghost.manifest.id,name:ghost.manifest.name,version:ghost.manifest.version,enabled:ghost.enabled,instanceId:installedGhostStoragePart(ghost),namespace:ghost.namespace??null,note:iconNote+'Plugin installed.'};
      }catch(error){if(error instanceof GhostInstallTargetRequiredError)return {ok:false,errorCode:'INSTALL_TARGET_REQUIRED',message:error.message,targets:error.targets,copyNamespace:error.copyNamespace};return permissionError(error);}
      finally{if(pending)try{options.host.cancelInstall(pending,controller);}catch{/* Consumed or owner closed. */}}
    },
    forgePublish:async({token})=>{context.assertCurrent();return options.publisher.publish(token,async(facts,signal)=>{
      const decision=await options.requestPermission(context.sessionId,context.instanceId(),{kind:'permission',requestId:randomUUID(),toolName:'ghost_forge_publish',input:facts as unknown as Record<string,unknown>,metadata:{hostOwnedConfirmation:'plugin_publish'}},signal);context.assertCurrent();return decision?.kind==='permission'&&decision.behavior==='allow';
    });},
    forgePublishStatus:async({transferId})=>{context.assertCurrent();return options.publisher.status(transferId);},
  };
}
