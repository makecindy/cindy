import { TerminalPluginSessions } from './sessions.js';
import { TerminalPluginTargets } from './targets.js';
import path from 'node:path';
import { isCindyAccountGhostId } from '@cindy/plugin-runtime/shared/ghost';
import type { GhostVisibilityDeps } from '@cindy/plugin-runtime/ghostVisibility';
import type { DirDepositVault,SaveDepositVault } from '@cindy/plugin-runtime/store/dirDeposit';
import type { TerminalTaskHost } from '../tasks/host.js';
import type { TerminalProtectedInput } from '../protected-input.js';
import type { TerminalPlugins } from './host.js';
import type { TerminalPluginAccount } from './account.js';
import { TerminalPluginPreferences } from './preferences.js';
import { TerminalPluginSetup } from './setup.js';
import { TerminalPluginPages } from './pages.js';
import { TerminalPluginPublisher } from './publisher.js';
import { createTerminalPluginTask, type TerminalPluginTask } from './mcp.js';
import type { PluginTaskContext } from './permissions.js';
import type { HostPermissionRequester } from '@cindy/plugin-runtime/ghostInstallConsentInteraction';
import { createTerminalPluginForge } from './forge.js';
import type { TerminalPluginMarket } from './market.js';
import translations from './translations.json';
import { pluginManagementDependencies } from './management.js';

/** Owner-scoped wiring; no process-global Desktop singleton is borrowed. */
export class TerminalPluginTasks {
  readonly sessions:TerminalPluginSessions;
  readonly targets:TerminalPluginTargets;
  readonly setup:TerminalPluginSetup;
  readonly pages:TerminalPluginPages;
  readonly preferences:TerminalPluginPreferences;
  readonly publisher:TerminalPluginPublisher;
  readonly ready:Promise<void>;
  private closed=false;
  private readonly createTask: (context: PluginTaskContext, requestPermission: HostPermissionRequester) => Promise<TerminalPluginTask>;
  constructor(private readonly options:{
    root:string;runtimeDirectory:string;host:TerminalPlugins;account:TerminalPluginAccount;market:TerminalPluginMarket;
    tasks:TerminalTaskHost;protectedInput:Pick<TerminalProtectedInput,'configurePlugins'>;deposits:DirDepositVault;saves:SaveDepositVault;
    owner():import('@cindy/plugin-runtime/owner').PluginOwner;
    signedIn():boolean;remoteAvailable(peer:string):boolean;locale():string;assertCurrent():void;
    emit(channel:string,payload:unknown):void;
    mediaTransfer?:Pick<import('../media-transfer.js').TerminalMediaTransfer,'resolve'>;
    projectDirectories?():Promise<string[]>;
    companions?():import('../remote/companions/host.js').TerminalCompanionHost|undefined;
  }){
    const guard=()=>{if(this.closed)throw new Error('PLUGIN_TASKS_CLOSED');options.assertCurrent();};
    const translate=(key:string)=>((translations as Record<string,Record<string,string>>)[options.locale()]??translations.en)[key]??(translations.en as Record<string,string>)[key]??key;
    this.sessions=new TerminalPluginSessions({root:options.root,host:options.host,tasks:options.tasks,guard,translate});
    options.host.configureTaskSessions(this.sessions);
    this.targets=new TerminalPluginTargets({host:options.host,sessions:this.sessions,tasks:options.tasks,companions:options.companions,projects:options.projectDirectories??(async()=>[]),owner:options.owner,guard});
    options.host.configureTargets(this.targets);
    this.preferences=new TerminalPluginPreferences(options.root,guard);
    const visibility:GhostVisibilityDeps={translate,listGhosts:()=>{guard();return options.host.native.list();},
      isAvailableForActiveSession:id=>{guard();const ghost=options.host.installed(id);return !!ghost&&(!isCindyAccountGhostId(ghost.manifest.id)||options.signedIn());},
      isDisabledForWorkdir:(id,dir)=>this.preferences.disabled(id,dir),
    };
    this.pages=new TerminalPluginPages(options.host,{assertCurrent:guard,translate:(key,locale)=>((translations as Record<string,Record<string,string>>)[locale??options.locale()]??translations.en)[key]??(translations.en as Record<string,string>)[key]??key,
      management:pluginManagementDependencies({host:options.host,market:options.market,preferences:this.preferences,projects:options.projectDirectories??(async()=>[]),media:options.mediaTransfer}),receiptAvailable:options.remoteAvailable,refreshPreferences:()=>this.preferences.refresh()});
    const pages=this.pages.pages;
    this.setup=new TerminalPluginSetup(options.host,{visibility,owner:()=>JSON.stringify(options.owner()),remoteAvailable:options.remoteAvailable,translate,assertCurrent:guard,emit:options.emit,
      settings:{bind:action=>pages.settingsBinding(action),bindAuthorization:action=>pages.settingsAuthorizationBinding(action),runAuthorization:action=>pages.runSettingsAuthorization(action),request:(peer,request)=>pages.settingsRequest(peer,request)},
      navigate:(sessionId,target,ghostId)=>options.emit('terminal:plugin-settings',{sessionId,target,ghostId}),
    });
    this.publisher=new TerminalPluginPublisher({stagingDirectory:path.join(options.root,'plugin-publish-staging'),host:options.host,account:options.account,owner:options.owner,assertCurrent:guard,
      onProgress:progress=>options.emit('ghosts:publish-progress',progress),
    });
    options.protectedInput.configurePlugins(this.setup.authorization);
    this.createTask=async(context,requestPermission)=>{
      guard();await this.ready;await this.preferences.refresh();guard();
      const scoped={...context,assertCurrent:()=>{guard();context.assertCurrent();}};
      return createTerminalPluginTask({host:options.host,setup:this.setup,preferences:this.preferences,visibility,context:scoped,media:options.tasks.media,deposits:options.deposits,saves:options.saves,
        market:options.market.task(scoped,requestPermission,translate),
        forge:createTerminalPluginForge({...options,context:scoped,media:options.tasks.media,publisher:this.publisher,requestPermission,translate}),
      });
    };
    options.tasks.configurePlugins(context=>this.createTask(context,options.tasks.requestHostPermission),this.setup);
    this.ready=Promise.all([this.preferences.refresh(),this.sessions.ready,this.targets.ready]).then(()=>undefined);
  }
  connectCompanions(){
    const host=this.options.companions?.();
    if(!host)throw new Error('COMPANION_HOST_UNAVAILABLE');
    this.targets.connectCompanions();
  }
  async close(){if(this.closed)return;this.closed=true;this.targets.close();this.pages.close();this.setup.close();this.publisher.close();await this.sessions.close();}
}
