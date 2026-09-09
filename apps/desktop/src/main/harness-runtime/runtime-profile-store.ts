/**
 * Per-owner local Tencent Harness runtime override store.
 *
 * Persisted values are only explicit overrides. Missing entries always mean
 * "follow Cindy-managed runtime", so future product defaults remain live.
 * Secrets are intentionally impossible to represent in this schema.
 */

import path from 'node:path';

import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { desktopMakerLogger } from '../maker-host/logger-adapter.js';
import {
  createOverrideSettingsFile,
  type OverrideSettingsState,
} from '../maker-host/override-settings-file.js';
import {
  inspectTencentHarnessLaunchPlan,
  validateTencentHarnessLaunchPlanShape,
} from './runtime-profile-probe.js';
import type {
  ApprovedExecutableIdentity,
  HarnessCapabilityProfile,
  HarnessLaunchPlan,
  HarnessRuntimeAgentKind,
  HarnessRuntimeProfile,
  HarnessRuntimeProfileSettings,
  LaunchPlanProbeDeps,
  TencentHarnessRuntimeOverride,
  TencentHarnessWrapperKind,
} from './types.js';

const log = desktopMakerLogger.child('harness-runtime-profile');
const MAX_PROFILE_FILE_BYTES = 64 * 1024;
const MAX_CAPABILITIES = 128;

function isAgentKind(value: unknown): value is HarnessRuntimeAgentKind {
  return value === 'claude-code' || value === 'codex';
}

function expectedWrapper(agentKind: HarnessRuntimeAgentKind): TencentHarnessWrapperKind {
  return agentKind === 'claude-code' ? 'tclaude' : 'tcodex';
}

function isAbsoluteNonEmptyPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeLaunchPlan(raw: unknown): HarnessLaunchPlan | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as { executable?: unknown; argsPrefix?: unknown };
  if (!isAbsoluteNonEmptyPath(value.executable)) return null;
  if (
    !Array.isArray(value.argsPrefix) ||
    value.argsPrefix.some((arg) => !isAbsoluteNonEmptyPath(arg))
  ) {
    return null;
  }
  return {
    executable: value.executable,
    argsPrefix: [...value.argsPrefix],
  };
}

function normalizeIdentity(
  agentKind: HarnessRuntimeAgentKind,
  raw: unknown,
): ApprovedExecutableIdentity | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as Partial<ApprovedExecutableIdentity>;
  const launcherRealpath = value.launcherRealpath;
  const launcherSize = value.launcherSize;
  const launcherMtimeMs = value.launcherMtimeMs;
  const realpath = value.realpath;
  const size = value.size;
  const mtimeMs = value.mtimeMs;
  const wrapperKind = value.wrapperKind;
  const wrapperVersion = value.wrapperVersion;
  const upstreamVersion = value.upstreamVersion;
  if (
    !isAbsoluteNonEmptyPath(launcherRealpath) ||
    !isNonNegativeSafeInteger(launcherSize) ||
    !isNonNegativeFiniteNumber(launcherMtimeMs) ||
    !isAbsoluteNonEmptyPath(realpath) ||
    !isNonNegativeSafeInteger(size) ||
    !isNonNegativeFiniteNumber(mtimeMs) ||
    wrapperKind !== expectedWrapper(agentKind) ||
    typeof wrapperVersion !== 'string' ||
    wrapperVersion.length === 0 ||
    wrapperVersion.length > 128 ||
    typeof upstreamVersion !== 'string' ||
    upstreamVersion.length === 0 ||
    upstreamVersion.length > 128
  ) {
    return null;
  }
  return {
    launcherRealpath,
    launcherSize,
    launcherMtimeMs,
    realpath,
    size,
    mtimeMs,
    wrapperKind,
    wrapperVersion,
    upstreamVersion,
  };
}

function normalizeCapabilities(raw: unknown): HarnessCapabilityProfile {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: HarnessCapabilityProfile = {};
  let kept = 0;
  for (const [name, enabled] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/i.test(name) || enabled !== true) continue;
    if (kept >= MAX_CAPABILITIES) {
      log.warn('harness runtime capability profile truncated at hard cap', {
        cap: MAX_CAPABILITIES,
      });
      break;
    }
    out[name] = true;
    kept += 1;
  }
  return out;
}

function normalizeOverride(
  agentKind: HarnessRuntimeAgentKind,
  raw: unknown,
): TencentHarnessRuntimeOverride | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = raw as {
    launchPlan?: unknown;
    identity?: unknown;
    capabilityProfile?: unknown;
  };
  const launchPlan = normalizeLaunchPlan(value.launchPlan);
  const identity = normalizeIdentity(agentKind, value.identity);
  if (!launchPlan || !identity) return null;
  try {
    validateTencentHarnessLaunchPlanShape(agentKind, launchPlan);
  } catch {
    return null;
  }
  const wrapperTarget =
    agentKind === 'claude-code' ? launchPlan.executable : launchPlan.argsPrefix[0];
  if (identity.launcherRealpath !== launchPlan.executable || identity.realpath !== wrapperTarget) {
    return null;
  }
  return {
    launchPlan,
    identity,
    capabilityProfile: normalizeCapabilities(value.capabilityProfile),
  };
}

function normalize(raw: unknown): HarnessRuntimeProfileSettings {
  const runtimes: HarnessRuntimeProfileSettings['runtimes'] = {};
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { runtimes?: unknown }).runtimes
      : undefined;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { runtimes };
  for (const [agentKind, rawOverride] of Object.entries(source)) {
    if (!isAgentKind(agentKind)) continue;
    const override = normalizeOverride(agentKind, rawOverride);
    if (override) runtimes[agentKind] = override;
  }
  return { runtimes };
}

function settingsFilePath(): string {
  return ownerScopedUserDataPath('harness-runtime-profiles.json');
}

const stores = new Map<
  string,
  ReturnType<typeof createOverrideSettingsFile<HarnessRuntimeProfileSettings>>
>();

function currentStore() {
  const scopeKey = activeOwnerScopeKey();
  let store = stores.get(scopeKey);
  if (!store) {
    store = createOverrideSettingsFile<HarnessRuntimeProfileSettings>({
      filePath: settingsFilePath,
      defaults: { runtimes: {} },
      normalize,
      mergeOverrides: ({ next }) =>
        Object.keys(next.runtimes).length === 0 ? {} : { runtimes: next.runtimes },
      log,
      label: 'harness runtime profile',
      scopeKey: activeOwnerScopeKey,
      maxBytes: MAX_PROFILE_FILE_BYTES,
      preserveUnreadableFile: true,
      logLoadedValue: false,
      logReadErrorDetails: false,
    });
    stores.set(scopeKey, store);
  }
  return store;
}

export function readHarnessRuntimeProfilesState(): OverrideSettingsState<HarnessRuntimeProfileSettings> {
  const store = currentStore();
  store.invalidateIfChanged();
  return store.readState();
}

export function getHarnessRuntimeProfile(
  agentKind: HarnessRuntimeAgentKind,
): HarnessRuntimeProfile {
  const store = currentStore();
  store.invalidateIfChanged();
  const override = store.read().runtimes[agentKind];
  if (!override) {
    return {
      agentKind,
      distribution: 'cindy-managed',
      authOwner: 'cindy',
      routeOwner: 'cindy',
      configHomePolicy: 'cindy-isolated',
    };
  }
  return {
    agentKind,
    distribution: 'tencent-local',
    authOwner: 'harness',
    routeOwner: 'harness',
    configHomePolicy: 'harness-default',
    launchPlan: {
      executable: override.launchPlan.executable,
      argsPrefix: [...override.launchPlan.argsPrefix],
    },
    identity: { ...override.identity },
    capabilityProfile: { ...(override.capabilityProfile ?? {}) },
  };
}

/** Persist a profile only after Main-owned validation has completed. */
function persistInspectedTencentHarnessRuntimeProfile(
  agentKind: HarnessRuntimeAgentKind,
  override: TencentHarnessRuntimeOverride,
): void {
  const normalized = normalizeOverride(agentKind, override);
  if (!normalized) throw new Error(`invalid Tencent runtime profile for ${agentKind}`);
  const store = currentStore();
  store.invalidateIfChanged();
  const runtimes = { ...store.read().runtimes, [agentKind]: normalized };
  store.writePatch({ runtimes });
  log.info('Tencent Harness runtime profile saved', {
    agentKind,
    wrapperKind: normalized.identity.wrapperKind,
    capabilityCount: Object.keys(normalized.capabilityProfile ?? {}).length,
  });
}

/**
 * Approve an explicit Tencent override from a Main-owned Settings action.
 *
 * Callers provide a structured launch plan, never shell command text. The
 * plan is inspected before it can enter durable owner-scoped settings.
 */
export async function approveTencentHarnessRuntimeProfile(
  agentKind: HarnessRuntimeAgentKind,
  launchPlan: HarnessLaunchPlan,
  deps?: LaunchPlanProbeDeps,
): Promise<{
  launchPlan: HarnessLaunchPlan;
  identity: ApprovedExecutableIdentity;
}> {
  const inspected = await inspectTencentHarnessLaunchPlan(agentKind, launchPlan, deps);
  persistInspectedTencentHarnessRuntimeProfile(agentKind, {
    launchPlan: inspected.launchPlan,
    identity: inspected.identity,
    capabilityProfile: {},
  });
  return inspected;
}

export function resetHarnessRuntimeProfile(
  agentKind: HarnessRuntimeAgentKind,
): HarnessRuntimeProfile {
  const store = currentStore();
  store.invalidateIfChanged();
  const runtimes = { ...store.read().runtimes };
  delete runtimes[agentKind];
  store.writePatch({ runtimes });
  log.info('Tencent Harness runtime profile reset', { agentKind });
  return getHarnessRuntimeProfile(agentKind);
}

export function clearHarnessRuntimeCapabilities(agentKind: HarnessRuntimeAgentKind): void {
  const current = getHarnessRuntimeProfile(agentKind);
  if (current.distribution !== 'tencent-local') return;
  persistInspectedTencentHarnessRuntimeProfile(agentKind, {
    launchPlan: current.launchPlan,
    identity: current.identity,
    capabilityProfile: {},
  });
}

function sameIdentity(
  left: ApprovedExecutableIdentity,
  right: ApprovedExecutableIdentity,
): boolean {
  return (
    left.launcherRealpath === right.launcherRealpath &&
    left.launcherSize === right.launcherSize &&
    left.launcherMtimeMs === right.launcherMtimeMs &&
    left.realpath === right.realpath &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.wrapperKind === right.wrapperKind &&
    left.wrapperVersion === right.wrapperVersion &&
    left.upstreamVersion === right.upstreamVersion
  );
}

/**
 * Reconcile fresh probe identity before a Tencent runtime is launched.
 *
 * Any identity drift invalidates affirmative capability facts. Callers must
 * run a fresh capability probe before enabling high-risk behavior again.
 */
export function reconcileHarnessRuntimeIdentity(
  agentKind: HarnessRuntimeAgentKind,
  observed: ApprovedExecutableIdentity,
): { identityChanged: boolean; capabilityProfile: HarnessCapabilityProfile } {
  const current = getHarnessRuntimeProfile(agentKind);
  if (current.distribution !== 'tencent-local') {
    throw new Error(`cannot reconcile a Cindy-managed runtime: ${agentKind}`);
  }
  if (sameIdentity(current.identity, observed)) {
    return {
      identityChanged: false,
      capabilityProfile: { ...current.capabilityProfile },
    };
  }
  persistInspectedTencentHarnessRuntimeProfile(agentKind, {
    launchPlan: current.launchPlan,
    identity: observed,
    capabilityProfile: {},
  });
  log.warn('Tencent Harness executable identity changed; capabilities invalidated', {
    agentKind,
    wrapperKind: observed.wrapperKind,
  });
  return { identityChanged: true, capabilityProfile: {} };
}

export const __testing = {
  normalize,
  normalizeLaunchPlan,
  normalizeIdentity,
  persistInspectedTencentHarnessRuntimeProfile,
  resetStores(): void {
    stores.clear();
  },
};
