import { existsSync, mkdirSync, readFileSync, watch } from 'node:fs';
import path from 'node:path';
import { createCompanyTokenReportingCore, discardCompanyMemberOutboxes, type ReportingIdentity } from '../../desktop/src/main/usage/companyTokenReportingCore.js';
import { installCompanyUsageCapture, installExecutionReporting } from '../../desktop/src/main/usage/companyTokenFacts.js';
import { directCompanyTokenRoute } from '../../desktop/src/main/usage/companyTokenRoute.js';
import { getActiveCatalog } from '../../desktop/src/main/maker-host/active-catalog.js';
import { profileSettingPaths } from './profile-settings.mjs';

interface HostReportingOptions {
  directory: string;
  /** A fresh, confirmed cloud owner (and its Host session), never a directory or a peer-supplied identity. */
  identity(): ReportingIdentity | null;
  gatewayEndpoint(): string | null;
  reportBuild: boolean;
  canWrite(): boolean;
  definitivelyInactive(): boolean;
  fetch: typeof globalThis.fetch;
}

/** The settings projection does not own these files. Read only the already accepted consent and explicit switch. */
function readDecision(file: string) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof value?.privacyConsentAccepted !== 'boolean' ||
        (value.analyticsEnabled !== undefined && typeof value.analyticsEnabled !== 'boolean')) return null;
    const enabled = value.analyticsEnabled !== false;
    return { enabled, allowed: value.privacyConsentAccepted && enabled };
  } catch {
    return null;
  }
}

export function bindHostCompanyReporting(options: HostReportingOptions) {
  const dir = path.join(options.directory, 'company-token-host');
  const decisionFile = profileSettingPaths(options.directory, null).analytics;
  let phase: 'suspended' | 'active' | 'signed-out' = 'suspended';
  let disposed = false;
  let decision: ReturnType<typeof readDecision> = null;
  let core: ReturnType<typeof createCompanyTokenReportingCore> | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  let onAuth: (() => void) | undefined;
  let onSetting: ((allowed: boolean, explicitEnabled?: boolean) => void) | undefined;
  function readSetting() {
    const previous = decision;
    decision = readDecision(decisionFile);
    try {
      if (!decision || !previous) {
        // An unreadable preference file suspends the outbox until the decision is known again.
        if (previous !== decision) onAuth?.();
      } else if (decision.allowed !== previous.allowed || decision.enabled !== previous.enabled) {
        onSetting?.(decision.allowed, previous.enabled === decision.enabled ? undefined : decision.enabled);
      }
    } catch {
      // A failed preference write must not escape the watcher into the Host process.
      decision = null;
      onAuth?.();
    }
  }
  function start() {
    if (core) return;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    decision = readDecision(decisionFile);
    core = createCompanyTokenReportingCore({
      dir,
      identity: () => phase === 'active' && decision ? options.identity() : null,
      recovering: () => phase === 'suspended' || (phase === 'active' && (!decision || !options.canWrite())),
      isAnalyticsAllowed: () => decision?.allowed === true && options.canWrite(),
      subscribeAuth(listener) { onAuth = listener; return () => { onAuth = undefined; }; },
      subscribeSettings(listener) { onSetting = listener; return () => { onSetting = undefined; }; },
      direct(provider, kind) {
        try {
          const endpoint = options.gatewayEndpoint();
          if (endpoint === null) return false;
          const route = getActiveCatalog().providers.find(p => p.id === provider)?.routing[kind];
          return directCompanyTokenRoute(provider, route, endpoint);
        } catch { return false; }
      },
      fetch: options.fetch,
    });
    installCompanyUsageCapture(core.capture);
    installExecutionReporting(core.execution);
  }
  function update(next: 'suspended' | 'active' | 'signed-out') {
    if (disposed || !options.reportBuild) return;
    if (next !== phase && watcher) {
      watcher.close();
      watcher = undefined;
    }
    phase = next;
    try {
      // The transport and disk readiness originate in the verified Host session.
      if (!core && (next === 'active' || (next === 'signed-out' && existsSync(dir)))) start();
      if (next === 'active' && !watcher && core) {
        const currentWatcher = watch(path.dirname(decisionFile), { persistent: false }, (_event, filename) => {
          if (watcher === currentWatcher && (!filename || String(filename) === path.basename(decisionFile))) readSetting();
        });
        watcher = currentWatcher;
        currentWatcher.on('error', () => {
          if (watcher !== currentWatcher) return;
          currentWatcher.close();
          watcher = undefined;
          decision = null;
          onAuth?.();
        });
        readSetting();
      }
      onAuth?.();
    } catch {
      watcher?.close();
      watcher = undefined;
      phase = 'suspended';
      onAuth?.();
    }
  }
  return {
    resume: () => {
      if (disposed || !options.reportBuild) return;
      try {
        if (!options.canWrite()) return update('suspended');
        if (options.identity()) return update('active');
        update(options.definitivelyInactive() ? 'signed-out' : 'suspended');
      } catch { update('suspended'); }
    },
    suspend: () => update('suspended'),
    signOut: () => update('signed-out'),
    discardMember(member: string) {
      if (disposed || !options.reportBuild) return;
      update('suspended');
      try { discardCompanyMemberOutboxes(dir, member); }
      catch { /* Unavailable storage must not change the verified Host login result. */ }
    },
    dispose() {
      disposed = true;
      watcher?.close();
      watcher = undefined;
      phase = 'suspended';
      core?.dispose();
      core = undefined;
    },
  };
}
