import {app} from 'electron';
import path from 'node:path';
import {writeBlob} from '../../cindy-media/blobStore.js';
import {recordBlob} from '../../cindy-media/ledger.js';
import {createBotAvatarSelection} from '@cindy/app-runtime/botAvatarSelection';
export {BOT_AVATAR_MAX_BYTES,validateBotAvatarBuffer,decodeBotAvatarImage} from '@cindy/app-runtime/botAvatarSelection';
export const {storeTeammateAvatarImage,readDefaultTeammatePortrait}=createBotAvatarSelection({
  resourceRoot:()=>app.isPackaged?process.resourcesPath:path.join(app.getAppPath(),'resources'),writeBlob,recordBlob,
});
