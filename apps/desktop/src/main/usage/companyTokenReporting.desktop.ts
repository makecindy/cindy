import { app, net } from 'electron';
import { readCompanyTokenReportingPreference } from '../analytics-settings-store.js';
import * as auth from '../authManager.js';
import { getClientEndpointForRealm } from '../clientEndpointsService.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { installCompanyUsageCapture, installExecutionReporting } from './companyTokenFacts.js';
import { directCompanyTokenRoute } from './companyTokenRoute.js';
import { createCompanyTokenReportingCore, type ReportingIdentity, type ReportingRuntime } from './companyTokenReportingCore.js';

function identity(): ReportingIdentity | null {
  const state = auth.getAuthState();
  const user = state.user;
  const token = auth.getAccessToken();
  if (
    state.mode !== 'cloud' ||
    !state.isAuthenticated ||
    !state.canEnterApp ||
    !user?.orgId ||
    user.membershipKind !== 'org' ||
    !token
  )
    return null;
  const realm = auth.getActiveAuthRealm();
  return {
    owner: JSON.stringify([realm, user.orgId, user.id]),
    orgId: user.orgId,
    member: user.id,
    token,
    generation: state.ownerGeneration,
    base: getClientEndpointForRealm(realm, 'authApiBaseUrl'),
    device: state.deviceId,
  };
}
export function createCompanyTokenReporting(subscribeSettings: ReportingRuntime['subscribeSettings']) {
  const reporter = createCompanyTokenReportingCore({
    dir: app.getPath('userData'),
    identity,
    recovering: () => {
      const state = auth.getAuthState();
      return state.mode !== 'local' && state.user?.membershipKind !== 'personal' &&
        (auth.isSavedLoginRecoveryPending() || (!state.canEnterApp && state.isAuthenticated && state.user?.membershipKind === 'org'));
    },
    readCompanyTokenReportingPreference,
    subscribeAuth: auth.onAuthStateChange,
    subscribeSettings,
    fetch: (input, init) => net.fetch(input, init),
    direct(id, kind) {
      try {
        const route = getActiveCatalog().providers.find(entry => entry.id === id)?.routing[kind];
        return directCompanyTokenRoute(id, route, effectiveXdGatewayBaseUrl());
      } catch {
        return false;
      }
    },
  });
  installCompanyUsageCapture(reporter.capture);
  installExecutionReporting(reporter.execution);
  return reporter;
}
