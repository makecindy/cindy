import {app} from 'electron';
import path from 'node:path';
import {createLogger} from '../../logger.js';
import {storeTeammateAvatarImage} from './botAvatarSelection.js';
import {createLegacyTeammateAvatar} from '@cindy/app-runtime/legacyTeammateAvatar';
export const {migrateLegacyTeammateAvatar}=createLegacyTeammateAvatar({resourceRoot:()=>app.isPackaged?process.resourcesPath:path.join(app.getAppPath(),'resources'),logger:createLogger('legacy-teammate-avatar'),storeTeammateAvatarImage});
