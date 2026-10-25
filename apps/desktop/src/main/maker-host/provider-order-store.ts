import {ownerScopedUserDataPath} from '../appSessionState.js';
import {desktopMakerLogger} from './logger-adapter.js';
import {createProviderOrderStore} from '@cindy/app-runtime/providerOrderStore';
export const {readProviderOrder,setProviderOrder,__testing}=createProviderOrderStore(()=>ownerScopedUserDataPath('provider-order-prefs.json'),desktopMakerLogger.child('provider-order-store'));
