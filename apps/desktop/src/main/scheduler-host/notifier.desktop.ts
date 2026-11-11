import type { BrowserWindow } from 'electron';
import { showDesktopSessionEvent } from '../notificationService';
import { isSessionNotificationsMutedSync } from '../localDb/sessionFlagRegistry';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from '../device-link';
import { ScheduleNotifier, type ScheduleNotifierDeps } from './notifier';

export interface DesktopNotifierDeps extends ScheduleNotifierDeps {
  getMainWindow: () => BrowserWindow | null;
}

export class DesktopNotifier extends ScheduleNotifier {
  constructor(deps: DesktopNotifierDeps) {
    super(deps, {
      getMobileNotifyGeneration: () => getMobileNotifyGeneration(),
      isSessionNotificationsMutedSync: id => isSessionNotificationsMutedSync(id),
      showSessionNotification: payload => showDesktopSessionEvent(deps.getMainWindow, payload),
      sendMobileSessionNotify: payload => sendMobileSessionNotify(payload),
    });
  }
}
