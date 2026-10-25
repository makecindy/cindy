import { buildGhostRosterPrompt, createCindyGhostsMcpServer,type CindyGhostInfo,type CindyGhostsMcpDeps } from 'cindy-tools';
import { TERMINAL_PLUGIN_MCP_NAME } from '../tasks/mcp-names.js';
import { classifyGhostVisibility,classifyInstalledGhostVisibility,type GhostVisibilityDeps } from '@cindy/plugin-runtime/ghostVisibility';
import { readInstalledGhostManual } from '@cindy/plugin-runtime/ghostManual';
import { deriveGhostSessionContext,ghostInstallApprovalToken,type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import { installedGhostStoragePart,deliveryNamespaceFields } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { workdirWriteVerdict } from '@cindy/plugin-runtime/fsSlot';
import type { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginSetup } from './setup.js';
import type { TerminalPluginPreferences } from './preferences.js';
import type { TerminalTaskMedia } from '../tasks/media.js';
import type { PluginTaskContext } from './permissions.js';
import { grantPluginCall } from './grants.js';

/** Do not expose arbitrary exception text: worker/network errors may contain
 * private paths or request data. Only known host codes select recovery advice. */
function pluginCallFailure(error: unknown, signal: AbortSignal) {
  if(signal.aborted)return {ok:false as const,errorCode:'CANCELLED',message:'The plugin call was cancelled.'};
  const code=error instanceof Error?error.message:'';
  if(['PLUGIN_FILE_HANDOFF_DENIED','PLAN_MODE_READ_ONLY','TASK_PERMISSION_CHANGED','PLUGIN_PATH_CHANGED'].includes(code))return {ok:false as const,errorCode:'PERMISSION_DENIED',message:'The current task or file permission does not allow this plugin call.'};
  if(code==='PLUGIN_CHANGED')return {ok:false as const,errorCode:code,message:'The plugin changed before the call completed. Check its current configuration and retry.'};
  if(['ABSOLUTE_PATH_REQUIRED','DIRECTORY_REQUIRED','DIRECTORY_DEPOSIT_INVALID','ATTACHMENT_INVALID','UNRECOGNIZED_MEDIA_TYPE','TOO_MANY_ATTACHMENTS','ATTACHMENTS_TOO_LARGE'].includes(code))return {ok:false as const,errorCode:code,message:'Check the supplied files or directories before retrying.'};
  const fsCode=error&&typeof error==='object'&&'code' in error?error.code:null;
  if(fsCode==='ENOENT'||fsCode==='ENOTDIR')return {ok:false as const,errorCode:'FILE_NOT_FOUND',message:'A supplied file or directory is no longer available. Select it again before retrying.'};
  if(fsCode==='EACCES'||fsCode==='EPERM')return {ok:false as const,errorCode:'FILE_ACCESS_DENIED',message:'The operating system denied file access. Check access to the supplied files before retrying.'};
  return {ok:false as const,errorCode:'PLUGIN_CALL_FAILED',message:'The plugin call failed. Retry the operation or inspect the plugin diagnostics.'};
}

export interface TerminalPluginTaskOptions {
  host:TerminalPlugins;setup:TerminalPluginSetup;preferences:TerminalPluginPreferences;
  visibility:GhostVisibilityDeps;context:PluginTaskContext;media:TerminalTaskMedia;
  deposits:DirDepositVault;saves:SaveDepositVault;
  forge:Pick<CindyGhostsMcpDeps,'forgeGuide'|'forgeScaffold'|'forgePack'|'forgeInstall'|'forgePublish'|'forgePublishStatus'>;
  connectHost?:CindyGhostsMcpDeps['connectAccount'];
  market?:Pick<CindyGhostsMcpDeps,'searchMarket'|'installMarket'>;
  mediaTools?:CindyGhostsMcpDeps['callMedia'];
}
/** Every invocation resolves the live instance and owner again. The prompt is a
 * discovery hint; it is never an authority to dispatch or hand over files. */
export function createTerminalPluginTask(options:TerminalPluginTaskOptions){
  const {host,context,visibility}=options;
  const abort=new AbortController();
  const guard=()=>{abort.signal.throwIfAborted();context.assertCurrent();context.instanceId();};
  const refresh=async()=>{guard();await Promise.all([host.list(),options.preferences.refresh()]);guard();};
  const visible=()=>host.native.list().filter(ghost=>(ghost.manifest.tools?.length||ghost.manifest.manual?.items.length)&&classifyInstalledGhostVisibility(ghost,context.workingDir,visibility).ok);
  const info=(ghost:InstalledGhost):CindyGhostInfo=>({id:ghost.manifest.id,...(ghost.namespaceState==='pending'?{}:deliveryNamespaceFields(ghost)),name:ghost.manifest.name,
    ...(ghost.manifest.command?{command:ghost.manifest.command}:{}),recall:ghost.manifest.whenToUse??ghost.manifest.description,
    ...(ghost.manifest.manual?{manual:ghost.manifest.manual.items.map(({name,description})=>({name,description}))}:{}),
    setup:host.assessment(installedGhostStoragePart(ghost)),tools:(ghost.manifest.tools??[]).map(({name,description,parameters})=>({name,description,...(parameters?{parameters}:{})})),
  });
  const roster=()=>visible().map(ghost=>{const {id,namespace,name,command,recall}=info(ghost);return {id,...(namespace!==undefined?{namespace}:{}),name,command,recall};});
  const combined=(signal?:AbortSignal)=>AbortSignal.any([abort.signal,...(signal?[signal]:[])]);
  const deps:CindyGhostsMcpDeps={...options.forge,...options.market,...(options.mediaTools?{callMedia:options.mediaTools}:{}),
    getRosterItems:roster,
    listAwakeGhosts:async()=>{await refresh();return visible().map(info);},
    getAwakeGhost:async(id,namespace)=>{await refresh();const found=classifyGhostVisibility(id,context.workingDir,visibility,namespace);if(!found.ok)return found;if(!visible().some(ghost=>installedGhostStoragePart(ghost)===installedGhostStoragePart(found.ghost)))return {ok:false,errorCode:'GHOST_NOT_FOUND',message:'This plugin has no tools or manual.'};return {ok:true,ghost:info(found.ghost)};},
    readGhostManual:async request=>{await refresh();const found=classifyGhostVisibility(request.ghostId,context.workingDir,visibility,request.namespace);if(!found.ok)return {...found,manual:[],content:''};const result=await readInstalledGhostManual(found.ghost,request.path);guard();return result;},
    connectAccount:async(target,signal)=>{
      await refresh();if(target.kind==='host')return options.connectHost?options.connectHost(target,combined(signal)):{ok:false,errorCode:'HOST_NOT_READY'};
      const found=classifyGhostVisibility(target.id,context.workingDir,visibility,target.namespace);if(!found.ok)return found;
      const instance=installedGhostStoragePart(found.ghost),assessment=host.assessment(instance);
      if(assessment.state==='ready'&&assessment.groups.length===0)return {ok:false,errorCode:'PLUGIN_CONNECTION_METHOD_REQUIRED',ghostId:target.id,settingsAvailable:Boolean(found.ghost.manifest.settingsHtml),message:'Use this plugin’s documented connection tool or settings. Do not send credentials in chat.'};
      const result=await options.setup.coordinator.ensureReady({sessionId:options.setup.surface.ghostSetupInteractionSessionId({sessionId:context.sessionId,vendorOptions:{source:context.source}}),ghostId:instance,workingDir:context.workingDir,reauthorize:target.reauthorize,signal:combined(signal)});guard();
      if(!result.ok)return result;
      const current=classifyInstalledGhostVisibility(found.ghost,context.workingDir,visibility);if(!current.ok)return current;
      if(host.assessment(instance).state!=='ready')return {ok:false,errorCode:'SETUP_REQUIRED'};
      return {ok:true,status:'ready',ghostId:target.id,message:'Host setup is ready. Platform access is verified by the requested operation.'};
    },
    callGhostTool:async request=>{
      await refresh();const found=classifyGhostVisibility(request.ghostId,context.workingDir,visibility,request.namespace);if(!found.ok)return found;
      const target=found.ghost,instance=installedGhostStoragePart(target),approval=ghostInstallApprovalToken(target.approval);
      if(!request.grantOnly&&!target.manifest.tools?.some(tool=>tool.name===request.tool))return {ok:false,errorCode:'TOOL_NOT_FOUND',message:'The plugin does not declare this tool.'};
      if(request.grantOnly&&!request.attachments?.length)return {ok:false,errorCode:'ATTACHMENT_INVALID',message:'grant_only requires attachments.'};
      const signal=combined(request.signal);
      const check=()=>{guard();signal.throwIfAborted();const current=classifyInstalledGhostVisibility(target,context.workingDir,visibility);if(!current.ok||ghostInstallApprovalToken(current.ghost.approval)!==approval)throw new Error('PLUGIN_CHANGED');};
      const ready=await options.setup.coordinator.ensureReady({sessionId:options.setup.surface.ghostSetupInteractionSessionId({sessionId:context.sessionId,vendorOptions:{source:context.source}}),ghostId:instance,workingDir:context.workingDir,...(!request.grantOnly?{tool:request.tool}:{}),plan:request.setupPlan,signal});if(!ready.ok)return ready;
      check();if(host.assessment(instance).state!=='ready')return {ok:false,errorCode:'SETUP_REQUIRED',message:'Plugin setup changed. Retry with the current configuration.'};
      try{
        const granted=await grantPluginCall({...request,signal},{instance,name:target.manifest.name,context,media:options.media,deposits:options.deposits,saves:options.saves,assertCurrent:check});
        granted.assertCurrent();
        if(request.grantOnly)return {ok:true,result:{granted:granted.args.attachments}};
        const live=await context.snapshot();granted.assertCurrent();
        if(target.manifest.sessionContext===true)granted.args.session_context=deriveGhostSessionContext(context.sessionId,context.workingDir,live?{workingDir:live.workingDir,remoteHostId:live.remoteHostId,workdirIsReadOnly:workdirWriteVerdict(live.permissionMode,live.planModeEnabled)==='deny'}:null);
        if(host.assessment(instance).state!=='ready')return {ok:false,errorCode:'SETUP_REQUIRED',message:'Plugin setup changed before dispatch.'};
        granted.assertCurrent();return await host.callTool(instance,{tool:request.tool,args:granted.args,signal,agentToolUseId:request.agentToolUseId},{sessionId:context.sessionId,sessionInstanceId:context.instanceId(),remoteHostId:live?.remoteHostId??null,assertCurrent:granted.assertCurrent});
      }catch(error){return pluginCallFailure(error,signal);}
    },
  };
  return {deps,factories:{[TERMINAL_PLUGIN_MCP_NAME]:()=>createCindyGhostsMcpServer(deps)},getGhostRosterPrompt:()=>buildGhostRosterPrompt(roster()),close:()=>{abort.abort();options.setup.bridge.cleanupForSession(context.sessionId,'session_closed');}};
}
export type TerminalPluginTask=ReturnType<typeof createTerminalPluginTask>;
