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
import { isGhostSkillProjectionBoundaryStableForOwner } from './authBoundaryQuarantine.js';
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
  ownerStable = true,
): AppCapabilities {
  const cloud = mode === 'cloud' && !boundaryPending && ownerStable;
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
  return deriveAppCapabilities(
    session.mode,
    isAppSessionBoundaryPending(),
    isGhostSkillProjectionBoundaryStableForOwner(session.dataOwnerId),
  );
}

export function requireAppCapability(
  capability: keyof AppCapabilities,
  message = 'This feature requires a Cindy account.',
): void {
  const session = getActiveAppSession();
  const boundaryPending = isAppSessionBoundaryPending();
  const ownerStable = isGhostSkillProjectionBoundaryStableForOwner(session.dataOwnerId);
  if (deriveAppCapabilities(session.mode, boundaryPending, ownerStable)[capability]) return;
  if (boundaryPending || (session.mode === 'cloud' && !ownerStable)) {
    throwIpcError(
      'PRECONDITION_FAILED',
      'App session is switching; retry after the owner boundary settles.',
    );
  }
  throwIpcError('PERMISSION_DENIED', message);
}
