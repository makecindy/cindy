import {RoutineFileStore} from '@cindy/maker-scheduler/routine-store';
import type {RoutineEngine} from '@cindy/maker-scheduler';
import {createRoutineService} from '@cindy/app-runtime/routineService';
import {registerRoutineRemoteResources} from '@cindy/companion-core/routineResources';
import type {RemoteResourceRegistry} from '@cindy/device-link';
import type {TaskInvocationContext} from '../../tasks/host.js';
import type {TerminalSchedulerHost} from '../../tasks/scheduler.js';
import type {TerminalCompanionHost} from './host.js';

/** Only host effects differ: original storage, admission, lifecycle, tools and
 * scheduler dispatch are shared with the GUI process. */
export class TerminalCompanionRoutines {
  readonly runtime:ReturnType<typeof createRoutineService<TaskInvocationContext>>;
  engine!:RoutineEngine;
  readonly service;
  readonly transfer;
  private closed=false;
  constructor(private readonly host:TerminalCompanionHost,private readonly scheduler:TerminalSchedulerHost,private readonly canActivate=()=>true) {
    const services=()=>{host.options.guard();if(this.closed)throw new Error('COMPANION_ROUTINES_CLOSED');return host.services;};
    this.runtime=createRoutineService<TaskInvocationContext>({
      activeOwnerScopeKey:()=>services().owner.activeOwnerScopeKey(),
      getActiveAppSession:()=>({dataOwnerId:services().database.getCurrentDbClientSnapshot()?.userId??null}),
      isAppSessionBoundaryPending:()=>this.closed||!this.canActivate()||!host.services?.current(),
      ownerScopedUserDataPath:(...parts)=>services().owner.ownerScopedUserDataPath(...parts),
      isPackaged:()=>true,log:host.options.logger,
      getCurrentDbClientSnapshot:()=>services().database.getCurrentDbClientSnapshot(),
      isCompanionShadowed:id=>host.isShadowed(id),
      currentFollowUpEvents:(...args)=>services().autonomy.currentFollowUpEvents(...args),
      createStore:directory=>new RoutineFileStore(directory),
      tapWindowBroadcast:(channel,payload)=>services().conversations.broadcastTap.tapWindowBroadcast(channel,payload),
      getSafeDataOwnerPushStamp:()=>services().conversations.broadcastTap.getSafeDataOwnerPushStamp(),
      broadcastLocal:channel=>{services().assertCurrent();host.options.emit(channel,[]);},
      ipcMain:{handle:(channel,handler)=>host.options.tasks.registerCompanionIpc(channel,handler)},
      assertTrustedAppRendererEvent:context=>services().assertTrustedAppRendererEvent(context),
    });
    this.runtime.configureRoutineHost({
      getBot:async id=>{services().assertCurrent();return host.options.tasks.bots!.profiles.getBotRemoteResourceSource(id);},
      getScheduler:()=>this.scheduler.engine??null,
      getScheduleStorage:()=>this.scheduler.storage,
    });
    this.runtime.registerRoutinesIpc();
    this.service=this.runtime.routineTools;
    this.transfer={listCompanionRoutines:this.runtime.listCompanionRoutines,importCompanionRoutines:this.runtime.importCompanionRoutines};
  }
  async open(){await this.host.ready;await this.scheduler.ready;if(this.closed)throw new Error('COMPANION_ROUTINES_CLOSED');this.engine=await this.runtime.getRoutineEngine();}
  registerResources(registry:RemoteResourceRegistry){registerRoutineRemoteResources({registry,tools:this.service,
    getEngine:()=>this.runtime.getRoutineEngine(),
    listBots:()=>this.host.options.tasks.bots!.profiles.listBotRemoteResourceSources(),
    scope:()=>this.host.services.owner.activeOwnerScopeKey(),boundaryPending:()=>this.closed||!this.canActivate()||!this.host.services.current(),
  });}
  list:typeof this.service.list=(...args)=>this.service.list(...args);
  save:typeof this.service.save=(...args)=>this.service.save(...args);
  createOnce:typeof this.service.createOnce=(...args)=>this.service.createOnce(...args);
  remove:typeof this.service.remove=(...args)=>this.service.remove(...args);
  runNow:typeof this.service.runNow=(...args)=>this.service.runNow(...args);
  lifecycle(...args:Parameters<typeof this.runtime.updateBotRoutineLifecycle>){return this.runtime.updateBotRoutineLifecycle(...args);}
  async close(){if(this.closed)return;this.closed=true;await this.runtime.stopRoutines();}
}
