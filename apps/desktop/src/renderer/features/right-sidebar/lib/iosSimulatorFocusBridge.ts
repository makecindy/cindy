import type { IOSSimulatorFocusRequest } from '../../../../shared/iosSimulatorIpc';

import { createLogger } from '@/lib/logger';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { addTab, ensureHydrated, getBucket, patchTabState, setActiveTab } from '../store';
import { requestRightSidebarVisibility } from './sidebarCommands';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import { isIOSSimulatorPluginAvailable } from '../iosSimulatorPluginAvailability';

const log = createLogger('rightSidebar.iosSimulatorFocus');

let initialized = false;
let teardown: (() => void) | null = null;
let operationTail: Promise<void> = Promise.resolve();

/**
 * Open the Host-owned simulator viewer for an exact task.
 *
 * The Agent bridge and direct plugin entry share this path so both obey the
 * same enabled-plugin gate and singleton-tab behavior.
 */
export async function focusIOSSimulatorPanel(request: IOSSimulatorFocusRequest): Promise<void> {
  if (!isIOSSimulatorPluginAvailable(readInstalledGhostsSnapshot())) return;
  const sessionId = request.sessionId.trim();
  const instanceId = request.instanceId?.trim() ?? '';
  if (!sessionId) return;

  await ensureHydrated(sessionId);
  const bucket = getBucket(sessionId);
  const exact = instanceId
    ? bucket.tabs.find(
        (tab) =>
          tab.kind === 'ios-simulator' &&
          (tab.state as { instanceId?: unknown } | null)?.instanceId === instanceId,
      )
    : undefined;
  const existing = exact ?? bucket.tabs.find((tab) => tab.kind === 'ios-simulator');
  if (existing) {
    if (instanceId && !exact) {
      await patchTabState(sessionId, existing.id, () => ({ instanceId }));
    }
    await setActiveTab(sessionId, existing.id);
  } else {
    await addTab(sessionId, 'ios-simulator', instanceId ? { instanceId } : {});
  }
  requestRightSidebarVisibility('open', {
    sessionId,
    userInitiated: request.userInitiated ?? true,
  });
}

/** Main-to-renderer bridge that reveals an exact simulator after it becomes viewable. */
export function initIOSSimulatorFocusBridge(): () => void {
  if (initialized) return teardown ?? (() => undefined);
  initialized = true;
  if (isSecondaryWindow() || !window.electronAPI?.maker?.iosSimulator?.onFocusRequest) {
    teardown = () => undefined;
    return teardown;
  }
  teardown = window.electronAPI.maker.iosSimulator.onFocusRequest((request) => {
    operationTail = operationTail
      .catch(() => undefined)
      .then(() => focusIOSSimulatorPanel(request))
      .catch((error) => {
        log.warn('Unable to focus the iOS Simulator pane', error);
      });
  });
  return teardown;
}

export function _resetIOSSimulatorFocusBridgeForTests(): void {
  teardown?.();
  initialized = false;
  teardown = null;
  operationTail = Promise.resolve();
}
