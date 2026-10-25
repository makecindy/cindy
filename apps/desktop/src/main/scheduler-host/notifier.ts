import type { BrowserWindow } from 'electron';
import { createScheduleNotifier, type DesktopNotifierDeps as SharedDeps } from '@cindy/app-runtime/scheduleNotifier';
import { showDesktopSessionEvent } from '../notificationService';
import { getMobileNotifyGeneration, sendMobileSessionNotify } from '../device-link';
export type DesktopNotifierDeps = SharedDeps<BrowserWindow>;
export const { DesktopNotifier } = createScheduleNotifier<BrowserWindow>({ showDesktopSessionEvent, getMobileNotifyGeneration, sendMobileSessionNotify });
export type DesktopNotifier = InstanceType<typeof DesktopNotifier>;
