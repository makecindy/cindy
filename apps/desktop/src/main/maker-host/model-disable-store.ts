import {createModelDisableStore} from '@cindy/app-runtime/modelDisableStore';
import {desktopMakerLogger} from './logger-adapter.js';
import {ownerScopedUserDataPath} from '../appSessionState.js';
export const {readModelDisableOverrides, setModelsDisabled, migrateLegacyNamespacedModelDisableOverrides, __testing, setProviderDisabled, stageProviderDisableOverridesClear, clearProviderDisableOverrides} = createModelDisableStore(() => ownerScopedUserDataPath('model-disable-prefs.json'), desktopMakerLogger.child('model-disable-store'));
