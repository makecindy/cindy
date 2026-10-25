import {nativeImage} from 'electron';
import {resolveSafe,writeBlob} from '../cindy-media/blobStore.js';
import {recordBlob} from '../cindy-media/ledger.js';
import {createBotInvitationAvatar} from '@cindy/app-runtime/botInvitationAvatar';
export const {prepareBotInvitationAvatar,finishBotInvitationAvatar}=createBotInvitationAvatar({
  callCindyMedia:async request=>(await import('../cindy-media/invocationService.js')).callCindyMedia(request),resolveSafe,writeBlob,recordBlob,
  async cropPortrait(buffer) {
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) throw new Error('INVITATION_AVATAR_INVALID');
  const size = image.getSize();
  const side = Math.min(size.width, size.height);
  return image
    .crop({
      x: Math.floor((size.width - side) / 2),
      y: Math.floor((size.height - side) / 2),
      width: side,
      height: side,
    })
    .resize({ width: 256, height: 256, quality: 'best' })
    .toPNG();
  },
});
