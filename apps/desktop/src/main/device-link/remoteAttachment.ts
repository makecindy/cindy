import { createRemoteAttachmentMaterializer } from '@cindy/app-runtime/remoteAttachment';
import { downloadToFile } from './mediaTransfer';
import { copyPeerAttachment } from './peerAttachmentStore';
export { isRemoteAttachmentRef, parseRemoteAttachmentRef, type RemoteAttachment } from '@cindy/app-runtime/remoteAttachment';
export const materializeRemoteAttachment = createRemoteAttachmentMaterializer({
 downloadToFile: (...args) => downloadToFile(...args), copyPeerAttachment: (...args) => copyPeerAttachment(...args),
});
