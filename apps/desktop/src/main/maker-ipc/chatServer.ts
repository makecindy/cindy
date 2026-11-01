import { app, net, nativeImage } from 'electron';
import { validateAvatarUpload } from '../profileEdit.js';
import { uploadPublicAsset } from '../ossPublicUpload.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { t } from '../i18n.js';
import { readFile as readMedia } from '../cindy-media/blobStore.js';
import { getAccessToken, refresh } from '../authManager.js';
import { createChatMedia } from './chatServerMedia.js';
import { prepareChatReplyImages } from './chatServerReplyImages.js';
import { chatServerWorkspaces } from './chatServerWorkspaces.js';
import { chatMigrationReceipts } from './chatMigrationReceipts.js';
import { prepareBotGroupTaskPost } from './botGroupTaskPostSnapshot.js';
import { registerGroupToolAuthority, GroupToolAuthorizationError } from './botGroupToolAuthorization.js';
import { getDbClient } from '../localDb/client/current.js';
import { readPersistedReplyText } from './botGroupChatService.js';
import { createChatServerRuntime } from '@cindy/app-runtime/chatServer';
export { ChatResponseError, REACTION_REVISION_MESSAGE_LIMIT, splitChatMessageText } from '@cindy/app-runtime/chatServer';
export const { withChatServer } = createChatServerRuntime({
 userDataPath:()=>app.getPath('userData'),isPackaged:()=>app.isPackaged,getClientEndpoint,t,
 fetch:(url,init)=>net.fetch(url instanceof URL ? url.toString() : url,init),getAccessToken,refresh,getDbClient,readMedia,
 createChatMedia,prepareChatReplyImages,chatServerWorkspaces,chatMigrationReceipts,prepareBotGroupTaskPost,
 readPersistedReplyText,registerGroupToolAuthority,GroupToolAuthorizationError,uploadPublicAsset,
 validateAvatar:avatar=>validateAvatarUpload(avatar,({buffer})=>{
  const image=nativeImage.createFromBuffer(Buffer.from(buffer));
  return image.isEmpty()?null:image.getSize();
 }),
});
