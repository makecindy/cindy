import { createNotificationAvatar } from '@cindy/app-runtime/notificationAvatar';
import { resolveSafe } from './cindy-media/blobStore';
export { encodeNotificationAvatar } from '@cindy/app-runtime/notificationAvatar';
export const { notificationAvatar } = createNotificationAvatar(resolveSafe);
