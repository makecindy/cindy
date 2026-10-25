import { AsyncLocalStorage } from 'node:async_hooks';
import { MobilePluginPages } from '@cindy/plugin-runtime/mobilePageService';
import { listMobilePageFiles, readMobilePageChunk } from '@cindy/plugin-runtime/mobilePageAssets';
import { mobilePageRelayScript, type MobileRelayOperation } from '@cindy/plugin-runtime/mobilePageRelay';
import { readMobilePreview } from '@cindy/plugin-runtime/mobilePreview';
import { installedGhostStoragePart } from '@cindy/plugin-runtime/shared/pluginIdentity';
import { ghostInstallApprovalToken, type InstalledGhost } from '@cindy/plugin-runtime/shared/ghost';
import type { RemoteResourceHostContext, RemoteResourceProvider, PluginPageFetchResult } from '@cindy/device-link';
import type { TerminalPlugins } from './host.js';
import { RemotePluginManagement, type RemotePluginManagementDeps } from '@cindy/plugin-runtime/remotePluginManagement';

/** Reuses the desktop page leases and encrypted settings protocol. No window
 * or browser is needed to open a form or save a credential. */
export class TerminalPluginPages {
  readonly pages: MobilePluginPages;
  readonly provider: RemoteResourceProvider;
  private closed = false;
  private readonly management?:RemotePluginManagement;
  private readonly context = new AsyncLocalStorage<RemoteResourceHostContext>();
  constructor(host: TerminalPlugins, options: {assertCurrent():void; translate(key:string,locale?:string):string;management?:Omit<RemotePluginManagementDeps,'capture'|'captureReceipt'>;receiptAvailable?(peer:string):boolean;refreshPreferences?():Promise<void>}) {
    const current = () => { try { options.assertCurrent(); return !this.closed; } catch { return false; } };
    const capture=(controller:string)=>{
      const context=this.context.getStore();
      return ()=>{try{if(!context||context.controllerDeviceId!==controller)return false;context.assertCurrent?.();return current();}catch{return false;}};
    };
    if(options.management)this.management=new RemotePluginManagement({...options.management,capture,captureReceipt:peer=>()=>current()&&(peer==='local'||options.receiptAvailable?.(peer)===true)});
    const relay = async (ghost: InstalledGhost, operation: MobileRelayOperation) => {
      if (!current()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
      const id = installedGhostStoragePart(ghost);
      if (operation.op !== 'disconnect') {
        const runtime = host.native.runtime;
        if (!runtime || !(await runtime.spawn(ghost)).ok || !await runtime.waitUntilRunning(id)) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
      }
      const result = await host.native.web?.evaluate(id, mobilePageRelayScript(operation));
      if (!current()) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
      return result;
    };
    const request = async (ghost:InstalledGhost,pathname:string,method:string,body:string|undefined,active:()=>boolean,confirm?:(label:string,host:string)=>Promise<boolean>):Promise<PluginPageFetchResult> => {
      const response = await host.settingsRequest(installedGhostStoragePart(ghost),new Request(`https://plugin.invalid${pathname}`,{method,...(body===undefined?{}:{body})}),()=>current()&&active(),confirm);
      return response ? {status:response.status,mime:response.headers.get('content-type')??'application/octet-stream',base64:Buffer.from(await response.arrayBuffer()).toString('base64')} : {status:404,mime:'application/json',base64:''};
    };
    this.pages = new MobilePluginPages({
      translate:options.translate,formSettings:true,list:()=>host.native.list(),management:this.management,
      revision:ghost=>JSON.stringify([ghost.dir,ghostInstallApprovalToken(ghost.approval)]),
      captureOwner:()=>current,captureController:controller=>{
        const context=this.context.getStore();
        return ()=>{try {if(!context||context.controllerDeviceId!==controller)return false;context.assertCurrent?.();return current();}catch{return false;}};
      },
      setupAssessment:id=>host.assessment(id),runtimeState:id=>host.native.runtime?.stateOf(id)??'stopped',
      unread:()=>null,clearUnread:()=>{},setEnabled:(id,enabled)=>host.setEnabled(id,enabled),
      bundle:listMobilePageFiles,asset:readMobilePageChunk,
      connect:async(ghost,pageId,channels)=>{await relay(ghost,{op:'connect',pageId,channels});},
      post:async(ghost,pageId,channel,data,sourceId)=>{await relay(ghost,{op:'post',pageId,channel,data,sourceId});},
      poll:async(ghost,pageId,after)=>await relay(ghost,{op:'poll',pageId,after}) as import('@cindy/device-link').PluginPageEvent[],
      disconnect:async(id,pageId)=>{const ghost=host.installed(id);if(ghost)await relay(ghost,{op:'disconnect',pageId});},
      fetch:(ghost,pathname,method,body)=>request(ghost,pathname,method,body,current),
      fetchPreview:readMobilePreview,settingsFetch:request,
      taskSettings:{
        read:(id,revision)=>host.taskSettings(id,revision),
        update:(id,revision,input,current)=>host.taskSettings(id,revision,input,current),
      },
    });
    const provider=this.pages.provider();
    this.provider={...provider,invoke:async(context,request)=>{if(request.actionId.startsWith('management:'))await options.refreshPreferences?.();context.assertCurrent?.();return this.context.run(context,()=>provider.invoke!(context,request));}};
  }
  close(){this.closed=true;this.management?.invalidate();this.pages.invalidate();}
}
