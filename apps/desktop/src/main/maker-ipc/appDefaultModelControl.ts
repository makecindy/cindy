import {activeOwnerScopeKey,getActiveDataOwnerPushStamp,isAppSessionBoundaryPending} from '../appSessionState.js';
import {getDesktopProviderService} from '../maker-host/createDesktopProviderService.js';
import {getMakerIfReady} from '../maker-host/index.js';
import {getModelVisibilityOverride,waitForModelVisibilityMirror} from '../maker-host/model-visibility-mirror.js';
import {getNewMakerModelTuning,getSelectedNewMakerRoute,subscribeNewMakerDefaults} from '../maker-host/newMakerDefaultsCache.js';
import {createAppDefaultModelControl} from '@cindy/app-runtime/appDefaultModelControl';
export {availableAppDefaultModels} from '@cindy/app-runtime/appDefaultModelControl';
export type {TaskModelSelection} from '@cindy/app-runtime/appDefaultModelControl';
export const {configureAppDefaultModelSelection, inspectAppDefaultModel, resolveTaskModelSelection, resolveAvailableTaskModels, validateTaskModel, changeAppDefaultModel} = createAppDefaultModelControl({activeOwnerScopeKey,getActiveDataOwnerPushStamp,isAppSessionBoundaryPending,getDesktopProviderService,getMakerIfReady,getModelVisibilityOverride,waitForModelVisibilityMirror,getNewMakerModelTuning,getSelectedNewMakerRoute,subscribeNewMakerDefaults,readRemoteProviderRoute:async route=>(await import('../remote-agent/controller/deviceCatalog.js')).readRemoteProviderRoute(route)});
