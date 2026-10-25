import {createCcManagerClient} from '@cindy/app-runtime/ccManagerClient';
import {createLogger} from '../logger.js';
import {drainPersistQueue} from '../messagePersistBroadcaster.js';
export const {ensureDaemonRunning,openCcManagerSession}=createCcManagerClient({logger:createLogger("cc-manager-client"),drainPersistQueue});
