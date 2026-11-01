import { createSessionNotificationCopy } from '@cindy/app-runtime/sessionNotificationCopy';
import { t } from './i18n.js';
export type { SessionEventKind } from '@cindy/app-runtime/sessionNotificationCopy';
export const { getSessionNotificationBody, getSessionNotificationUntitled, getSessionExternalNotificationText, getInputHandoffNotificationBody, getTeammateNotificationFallback, getBotGroupStepNotificationBody, getNotificationImageLabel } = createSessionNotificationCopy(t);
