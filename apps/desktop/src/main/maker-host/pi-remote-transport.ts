import {piManagerEnsure,piManagerKill} from './pi-manager-client.js';
export {shellQuote,redactCredentialText} from '@cindy/app-runtime/sshShell';
import {createPiRemoteTransport} from '@cindy/app-runtime/pi-remote-transport';
export type * from '@cindy/app-runtime/pi-remote-transport';

export const {resolveRemotePiBinaryPath,createRemotePiFileOps,createSshPiTransport,invalidateRemotePiPathCaches,createSshPiDaemonTransport,killRemotePiManagerSession}=createPiRemoteTransport({piManagerEnsure,piManagerKill});
