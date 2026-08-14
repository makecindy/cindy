/**
 * Central capability boundary for services owned by the Cindy account plane.
 *
 * Public CDN/endpoint manifests, updates and anonymous TapDB deliberately do
 * not use this gate. Account services must check it at their main-process
 * boundary even when the renderer also hides their entry point.
 */
import {
  getActiveAppSession,
  isAppSessionBoundaryPending,
  type AppSessionMode,
} from './appSessionState.js';
import { throwIpcError } from './utils/ipcValidate.js';

export interface AppCapabilities {
  canUseCindyAccountServices: boolean;
  canUseCindyGateway: boolean;
  canUseDeviceLink: boolean;
  canUseSkillHubCloud: boolean;
  canUseCindyOAuthBroker: boolean;
  canUseCindyHeartbeat: boolean;
}

export function deriveAppCapabilities(
  mode: AppSessionMode,
  boundaryPending = false,
): AppCapabilities {
  const cloud = mode === 'cloud' && !boundaryPending;
  return {
    canUseCindyAccountServices: cloud,
    canUseCindyGateway: cloud,
    canUseDeviceLink: cloud,
    canUseSkillHubCloud: cloud,
    canUseCindyOAuthBroker: cloud,
    canUseCindyHeartbeat: cloud,
  };
}

export function getAppCapabilities(): AppCapabilities {
  const session = getActiveAppSession();
  return deriveAppCapabilities(session.mode, isAppSessionBoundaryPending());
}

export function requireAppCapability(
  capability: keyof AppCapabilities,
  message = 'This feature requires a Cindy account.',
): void {
  const session = getActiveAppSession();
  const boundaryPending = isAppSessionBoundaryPending();
  if (deriveAppCapabilities(session.mode, boundaryPending)[capability]) return;
  if (boundaryPending) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'App session is switching; retry after the owner boundary settles.',
    );
  }
  throwIpcError('PERMISSION_DENIED', message);
}
