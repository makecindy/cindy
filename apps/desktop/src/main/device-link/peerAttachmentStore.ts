import { createPeerAttachmentStore } from '@cindy/remote-agent/peerAttachmentStore';
import { ownerScopedUserDataPath } from '../appSessionState';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { getDeviceLinkInvokeContext } from './invoke-context';

const store = createPeerAttachmentStore({
  root: () => ownerScopedUserDataPath('peer-attachment-inbox'),
  captureScope: captureDataOwnerBroadcastScope,
  isCurrent: isDataOwnerBroadcastScopeCurrent,
  controllerDeviceId: () => getDeviceLinkInvokeContext()?.controllerDeviceId,
});
export const { handlePeerAttachment, copyPeerAttachment, takePeerAttachment, discardPeerAttachment } = store;
