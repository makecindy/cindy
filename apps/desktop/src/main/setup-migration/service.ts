/**
 * New-computer setup service (docs/product-rules/new-device-setup-migration.md).
 *
 * Target side: list same-account computers, read one computer's snapshot, plan, apply the
 * Main-owned part and remember the one-time checklist. Source side: answer another
 * computer's read-only snapshot request. All dependencies are injected so the flow is
 * tested without Electron; `register.ts` wires the real installers and stores.
 */
import { randomUUID } from 'node:crypto';

import {
  SETUP_SNAPSHOT_VERSION,
  parseSetupSnapshot,
  parseSetupSnapshotRequest,
  setupSnapshotCapsVersion,
  type SetupSnapshot,
  type SetupSnapshotCaps,
  type SetupSnapshotPlugin,
  type SetupSnapshotRequest,
} from '@cindy/device-link';

import type {
  SetupMigrationApplyRequest,
  SetupMigrationApplyResponse,
  SetupMigrationChecklistItem,
  SetupMigrationDismissRequest,
  SetupMigrationPlan,
  SetupMigrationProgress,
  SetupMigrationSource,
  SetupMigrationState,
} from '../../shared/setupMigration.js';
import type { GhostInstallConsentPrompt } from '../cindy-brain/ghostInstallConsent.js';
import { createIpcError } from '../../shared/ipc-errors.js';
import { applySetupPlan, isRendererOwnedKey, type SetupApplyDeps } from './apply.js';
import {
  buildSetupPlan,
  type TargetCatalogFact,
  type TargetGhostFact,
} from './plan.js';
import type { SetupSettingsGroup } from './settingsGroups.js';
import { collectSetupSnapshot, type SetupSnapshotSourceDeps } from './snapshot.js';
import type { SetupTransferApplyDeps } from './transferApply.js';

const PLAN_TTL_MS = 30 * 60_000;
const MAX_PLANS = 4;

export interface SetupDeviceFact {
  deviceId: string;
  name: string;
  platform: string;
  online: boolean;
  remoteControlEnabled: boolean;
  controlEnabled: boolean;
  isSelf: boolean;
  lastSeenAt: string | null;
}

export interface PersistedSetupMigrationState {
  lastRun: { sourceName: string; finishedAt: number; checklist: SetupMigrationChecklistItem[] } | null;
  suggestionDismissed: boolean;
}

export interface SetupMigrationServiceDeps {
  platform: string;
  now(): number;
  /** Current account scope; null while signed out or switching. */
  ownerKey(): string | null;
  listDevices(): Promise<SetupDeviceFact[]>;
  /** Raw reply of the other computer, or throws an Error with `code`. */
  invokeRemote(deviceId: string, request: SetupSnapshotRequest): Promise<unknown>;
  targetGhosts(): TargetGhostFact[];
  /** Market facts for the source plugins this computer could install. */
  catalog(plugins: SetupSnapshotPlugin[]): Promise<Map<string, TargetCatalogFact>>;
  marketNames(): Promise<Set<string>>;
  localSkills(): Promise<Map<string, { enabled: boolean }>>;
  mcpIds(): Promise<Set<string>>;
  providerIds(): Promise<Set<string>>;
  builtinTools(): Promise<Map<string, { enabled: boolean; userSet: boolean }>>;
  access(): { remoteControlEnabled: boolean; keepAwake: boolean };
  /** Built-in keys saved here (ids only). */
  builtinKeys(): ReadonlySet<string>;
  sshHostIds(): Promise<Set<string>>;
  settingsGroups: readonly SetupSettingsGroup[];
  apply: Omit<SetupApplyDeps, 'windowPrompt' | 'assertCurrent' | 'settingsGroup' | 'transfer'>;
  /** Keys and SSH step bound to the computer the plan was read from. */
  transfer(deviceId: string): SetupTransferApplyDeps;
  readState(): PersistedSetupMigrationState;
  writeState(next: PersistedSetupMigrationState): Promise<void>;
  /** Live completion of a checklist item; null when only the user can tell. */
  checklistItemDone(item: SetupMigrationChecklistItem): boolean | null;
  /** True when this computer has none of the user's plugins, providers or MCP yet. */
  looksNew(): Promise<boolean>;
  source: SetupSnapshotSourceDeps;
}

interface StoredPlan {
  plan: SetupMigrationPlan;
  snapshot: SetupSnapshot;
  owner: string;
  senderId: number;
  expiresAt: number;
  applying: boolean;
}

export function isSetupMigrationSourceCandidate(device: SetupDeviceFact): boolean {
  return !device.isSelf && !isMobilePlatform(device.platform);
}

function isMobilePlatform(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}

function toSource(device: SetupDeviceFact): SetupMigrationSource {
  const unavailable = !device.online
    ? 'offline'
    : !device.remoteControlEnabled
      ? 'remote-control-off'
      : !device.controlEnabled
        ? 'control-disabled'
        : undefined;
  return {
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    online: device.online,
    lastSeenAt: device.lastSeenAt,
    ...(unavailable ? { unavailable } : {}),
  };
}

function setupError(code: Parameters<typeof createIpcError>[0], message: string): never {
  throw createIpcError(code, message);
}

export function createSetupMigrationService(deps: SetupMigrationServiceDeps) {
  const plans = new Map<string, StoredPlan>();

  const requireOwner = (): string => {
    const owner = deps.ownerKey();
    if (!owner) setupError('PRECONDITION_FAILED', 'Sign in before setting up this computer');
    return owner;
  };

  const prune = () => {
    const now = deps.now();
    for (const [id, stored] of plans) {
      if (stored.expiresAt <= now && !stored.applying) plans.delete(id);
    }
    while (plans.size > MAX_PLANS) {
      const oldest = [...plans.entries()].find(([, stored]) => !stored.applying);
      if (!oldest) break;
      plans.delete(oldest[0]);
    }
  };

  async function readSnapshot(deviceId: string): Promise<SetupSnapshot> {
    let caps: unknown;
    try {
      caps = await deps.invokeRemote(deviceId, { action: 'caps' });
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === 'CHANNEL_NOT_ALLOWED' || code === 'UNSUPPORTED_CAPABILITY') {
        setupError('SETUP_SOURCE_OUTDATED', 'Update Cindy on the other computer');
      }
      setupError('SETUP_SOURCE_UNAVAILABLE', 'The other computer did not answer');
    }
    if (setupSnapshotCapsVersion(caps) < SETUP_SNAPSHOT_VERSION) {
      setupError('SETUP_SOURCE_OUTDATED', 'Update Cindy on the other computer');
    }
    let raw: unknown;
    try {
      raw = await deps.invokeRemote(deviceId, { action: 'snapshot' });
    } catch {
      setupError('SETUP_SOURCE_UNAVAILABLE', 'The other computer did not answer');
    }
    try {
      return parseSetupSnapshot(raw);
    } catch {
      setupError('SETUP_SNAPSHOT_INVALID', 'The other computer sent an unreadable snapshot');
    }
  }

  async function sources(): Promise<SetupMigrationSource[]> {
    requireOwner();
    const devices = await deps.listDevices();
    return devices
      .filter(isSetupMigrationSourceCandidate)
      .map(toSource)
      .sort((a, b) => {
        if (!a.unavailable !== !b.unavailable) return a.unavailable ? 1 : -1;
        return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '');
      });
  }

  async function preview(deviceId: string, senderId: number): Promise<SetupMigrationPlan> {
    const owner = requireOwner();
    const device = (await deps.listDevices()).find(
      (candidate) => candidate.deviceId === deviceId && isSetupMigrationSourceCandidate(candidate),
    );
    if (!device) setupError('NOT_FOUND', 'This computer is no longer on your account');
    const snapshot = await readSnapshot(deviceId);
    const installable = snapshot.plugins.filter((plugin) => plugin.pluginId !== null);
    const [catalog, marketNames, localSkills, mcpIds, providerIds, builtinTools, sshHostIds] = await Promise.all([
      deps.catalog(installable).catch(() => new Map<string, TargetCatalogFact>()),
      deps.marketNames().catch(() => new Set<string>()),
      deps.localSkills().catch(() => new Map<string, { enabled: boolean }>()),
      deps.mcpIds().catch(() => new Set<string>()),
      deps.providerIds().catch(() => new Set<string>()),
      deps.builtinTools().catch(() => new Map<string, { enabled: boolean; userSet: boolean }>()),
      // Unknown here means "already present": never add a second block for an alias.
      snapshot.sshHosts.length > 0
        ? deps.sshHostIds().catch(() => new Set(snapshot.sshHosts.map((host) => host.id)))
        : Promise.resolve(new Set<string>()),
    ]);
    let builtinKeys: ReadonlySet<string>;
    try {
      builtinKeys = deps.builtinKeys();
    } catch {
      builtinKeys = new Set(snapshot.hints.builtinKeys);
    }
    if (deps.ownerKey() !== owner) setupError('SETUP_PLAN_EXPIRED', 'The signed-in account changed');
    const settings = deps.settingsGroups.map((group) => {
      let customized: Record<string, unknown> = {};
      try {
        customized = group.settings.readCustomized();
      } catch {
        customized = {};
      }
      return { id: group.id, platforms: group.platforms, customized };
    });
    const planId = randomUUID();
    const plan = buildSetupPlan({
      planId,
      now: deps.now(),
      platform: deps.platform,
      source: { deviceId, name: device.name },
      snapshot,
      ghosts: deps.targetGhosts(),
      catalog,
      marketNames,
      localSkills,
      settings,
      mcpIds,
      providerIds,
      builtinTools,
      access: deps.access(),
      builtinKeys,
      sshHostIds,
    });
    prune();
    plans.set(planId, {
      plan,
      snapshot,
      owner,
      senderId,
      expiresAt: deps.now() + PLAN_TTL_MS,
      applying: false,
    });
    prune();
    return plan;
  }

  async function apply(
    request: SetupMigrationApplyRequest,
    senderId: number,
    windowPrompt: GhostInstallConsentPrompt,
    emit: (progress: SetupMigrationProgress) => void,
  ): Promise<SetupMigrationApplyResponse> {
    const owner = requireOwner();
    const stored = plans.get(request.planId);
    if (
      !stored ||
      stored.owner !== owner ||
      stored.senderId !== senderId ||
      stored.expiresAt <= deps.now()
    ) {
      setupError('SETUP_PLAN_EXPIRED', 'Read the other computer again before applying');
    }
    if (stored.applying) setupError('PRECONDITION_FAILED', 'This setup is already being applied');
    const known = new Set(planKeys(stored.plan));
    const keys = new Set(request.keys.filter((key) => known.has(key)));
    const consentKeys = new Set(
      stored.plan.plugins.filter((item) => item.consent && keys.has(item.key)).map((item) => item.key),
    );
    const approvedPluginKeys = new Set(request.approvedPluginKeys.filter((key) => consentKeys.has(key)));
    stored.applying = true;
    try {
      const result = await applySetupPlan(
        { plan: stored.plan, snapshot: stored.snapshot, keys, approvedPluginKeys, emit },
        {
          ...deps.apply,
          transfer: deps.transfer(stored.plan.source.deviceId),
          windowPrompt,
          settingsGroup: (id) => deps.settingsGroups.find((group) => group.id === id)?.settings ?? null,
          assertCurrent: () => {
            if (deps.ownerKey() !== owner) setupError('SETUP_PLAN_EXPIRED', 'The signed-in account changed');
          },
        },
      );
      // Items finished by this run (keys copied, servers added) are shown done right away.
      const checklist = result.checklist.map((item) => (isChecklistItemDone(item) ? { ...item, done: true } : item));
      if (deps.ownerKey() === owner) {
        const current = deps.readState();
        await deps.writeState({
          ...current,
          lastRun: {
            sourceName: stored.plan.source.name,
            finishedAt: deps.now(),
            checklist,
          },
        });
      }
      return { ...result, checklist };
    } finally {
      stored.applying = false;
      plans.delete(request.planId);
    }
  }

  function isChecklistItemDone(item: SetupMigrationChecklistItem): boolean {
    if (item.done) return true;
    try {
      return deps.checklistItemDone(item) === true;
    } catch {
      return false;
    }
  }

  async function state(): Promise<SetupMigrationState> {
    if (!deps.ownerKey()) return { lastRun: null, suggestion: null };
    const persisted = deps.readState();
    const lastRun = persisted.lastRun
      ? {
          ...persisted.lastRun,
          checklist: persisted.lastRun.checklist.map((item) =>
            isChecklistItemDone(item) ? { ...item, done: true } : item,
          ),
        }
      : null;
    let suggestion: SetupMigrationState['suggestion'] = null;
    if (!persisted.lastRun && !persisted.suggestionDismissed) {
      try {
        if (await deps.looksNew()) {
          const candidate = (await sources()).find((source) => !source.unavailable);
          if (candidate) suggestion = { deviceId: candidate.deviceId, name: candidate.name };
        }
      } catch {
        suggestion = null;
      }
    }
    return { lastRun, suggestion };
  }

  async function dismiss(request: SetupMigrationDismissRequest): Promise<SetupMigrationState> {
    requireOwner();
    const current = deps.readState();
    if (request.kind === 'suggestion') {
      await deps.writeState({ ...current, suggestionDismissed: true });
    } else if (request.kind === 'checklist') {
      await deps.writeState({ ...current, lastRun: null, suggestionDismissed: true });
    } else if (current.lastRun) {
      await deps.writeState({
        ...current,
        lastRun: {
          ...current.lastRun,
          checklist: current.lastRun.checklist.map((item) =>
            item.id === request.id ? { ...item, done: true } : item,
          ),
        },
      });
    }
    return state();
  }

  /** Source side: answer another computer of the same account. Read-only. */
  async function handleRemote(raw: unknown): Promise<SetupSnapshotCaps | SetupSnapshot> {
    const request = parseSetupSnapshotRequest(raw);
    if (request.action === 'caps') return { setupSnapshot: SETUP_SNAPSHOT_VERSION };
    requireOwner();
    return collectSetupSnapshot(deps.source);
  }

  return { sources, preview, apply, state, dismiss, handleRemote, isRendererOwnedKey };
}

export type SetupMigrationService = ReturnType<typeof createSetupMigrationService>;

export function planKeys(plan: SetupMigrationPlan): string[] {
  return [
    ...plan.plugins.map((item) => item.key),
    ...plan.skills.map((item) => item.key),
    ...plan.settings.map((item) => item.key),
    ...(plan.rendererPrefs ? [plan.rendererPrefs.key] : []),
    ...plan.providers.map((item) => item.key),
    ...plan.mcpServers.map((item) => item.key),
    ...plan.builtinTools.map((item) => item.key),
    ...plan.access.map((item) => item.key),
    ...(plan.secrets ? [plan.secrets.key] : []),
    ...plan.sshHosts.map((item) => item.key),
  ];
}
