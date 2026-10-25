import { createSessionNotificationPreview } from '@cindy/app-runtime/sessionNotificationPreview';
import { getDbClient } from './client/current.js';
import { notificationAvatar } from '../notificationAvatar.js';
export type { SessionNotificationPreview } from '@cindy/app-runtime/sessionNotificationPreview';
export const { readSessionNotificationPreview } = createSessionNotificationPreview({ getDbClient, notificationAvatar });
