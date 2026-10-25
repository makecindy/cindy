import {app} from 'electron';
import {createLogger} from '../logger.js';
import {createSshHostPrefs} from '@cindy/app-runtime/ssh-host-prefs-store';
export type * from '@cindy/app-runtime/ssh-host-prefs-store';
export {LEGACY_AGENT_PROXY_REMOTE_PORT,normalizeAgentProxyUrl} from '@cindy/app-runtime/ssh-host-prefs-store';
export const {isAllowedAgentProxyRemotePort,getSshHostDisplayName,setSshHostDisplayName,readSshHostPrefs,getSshHostAutoConnect,getSshHostAgentProxy,setSshHostAgentProxy,patchSshHostPref,setSshHostAutoConnect,hasAnyAutoConnectHost,removeSshHostPref}=createSshHostPrefs({userDataDirectory:()=>app.getPath('userData'),logger:createLogger('ssh-host-prefs-store')});
