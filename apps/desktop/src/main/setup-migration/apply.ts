/**
 * Applies the Main-owned part of a new-computer setup plan: custom marketplaces, plugins,
 * skills and settings files (docs/product-rules/new-device-setup-migration.md).
 *
 * Every write goes through this computer's existing installer or store, so their locks,
 * verification, permission confirmation and normalization still apply. One failing item
 * never stops the others; each returns its own outcome.
 *
 * Plugin permissions: the plan shows Main-computed install facts for each market plugin, and
 * the user confirms them once in the setup window. The install prompt answers `true` only
 * when the real package yields exactly those facts; anything else (a release changed, a
 * custom market read during apply) falls back to the ordinary per-plugin confirmation.
 */
import type { SetupSnapshot, SetupSnapshotMarketSource } from '@cindy/device-link';

import type { GhostManifest } from '../../shared/ghost.js';
import {
  ghostInstallConsentKey,
  type GhostInstallConsentFacts,
} from '../../shared/ghostInstallConsent.js';
import type {
  SetupMigrationChecklistItem,
  SetupMigrationPlan,
  SetupMigrationProgress,
  SetupMigrationResult,
} from '../../shared/setupMigration.js';
import type { GhostInstallConsentPrompt } from '../cindy-brain/ghostInstallConsent.js';
import type { PortableOverrideSettings } from '../maker-host/override-settings-file.js';
import { splitSettingsValues } from './plan.js';
import { applySetupTransferStep, setupTransferKeys, type SetupTransferApplyDeps } from './transferApply.js';

export interface InstalledGhostRef {
  instanceKey: string;
  enabled: boolean;
  /** Receipt-derived approval token for enable/disable concurrency checks. */
  approval: string;
}

export interface SetupApplyDeps {
  marketNames(): Promise<Set<string>>;
  addMarketSource(source: SetupSnapshotMarketSource): Promise<void>;
  pluginDetail(pluginId: string): Promise<{ releaseId: string; manifest: GhostManifest }>;
  installPlugin(
    pluginId: string,
    options: { expectedReleaseId: string; expectedManifest?: GhostManifest },
    prompt: GhostInstallConsentPrompt,
  ): Promise<InstalledGhostRef>;
  findGhost(ghostId: string, namespace: string | null): InstalledGhostRef | null;
  setPluginEnabled(ghost: InstalledGhostRef, enabled: boolean): Promise<void>;
  /** The ordinary per-plugin confirmation in the window that started setup. */
  windowPrompt: GhostInstallConsentPrompt;
  /** Installs into the default global skill folder; returns where it landed. */
  installSkill(name: string, catalogScope: 'market' | 'team' | null): Promise<{ absolutePath: string }>;
  setSkillEnabled(absolutePath: string, enabled: boolean): Promise<void>;
  /** The global skill already installed here under this name, if any. */
  findSkill(name: string): Promise<{ absolutePath: string; enabled: boolean } | null>;
  settingsGroup(id: string): PortableOverrideSettings | null;
  /** Missing account/key labels for an installed plugin; null when ready or unknown. */
  pluginSetupMissing(instanceKey: string): string[] | null;
  /** Owner/account still the one that previewed this plan. */
  assertCurrent(): void;
  /** Keys and SSH step; absent when this run cannot reach the other computer. */
  transfer?: SetupTransferApplyDeps;
}

export interface SetupApplyInput {
  plan: SetupMigrationPlan;
  snapshot: SetupSnapshot;
  keys: ReadonlySet<string>;
  approvedPluginKeys: ReadonlySet<string>;
  emit(progress: SetupMigrationProgress): void;
}

/** Plan keys applied by the renderer through existing settings APIs. */
export function isRendererOwnedKey(key: string): boolean {
  return (
    key === 'renderer-prefs' ||
    key.startsWith('provider:') ||
    key.startsWith('mcp:') ||
    key.startsWith('builtin-tool:') ||
    key.startsWith('access:')
  );
}

/** Same facts → same fingerprint; package bytes and receiver are bound later by the installer. */
export function consentFingerprint(facts: GhostInstallConsentFacts): string {
  return ghostInstallConsentKey(facts, '', null);
}

export function errorCode(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^\[([A-Z][A-Z0-9_]{1,63})\]/.exec(message)?.[1] ?? 'FAILED';
}

export async function applySetupPlan(
  input: SetupApplyInput,
  deps: SetupApplyDeps,
): Promise<{ results: SetupMigrationResult[]; checklist: SetupMigrationChecklistItem[]; handledKeys: string[] }> {
  const { plan, snapshot, keys } = input;
  const plugins = plan.plugins.filter((item) => keys.has(item.key) && item.state === 'ready');
  const skills = plan.skills.filter((item) => keys.has(item.key) && item.state === 'ready');
  const settings = plan.settings.filter((item) => keys.has(item.key) && item.state === 'ready');
  const total =
    plugins.length + skills.length + settings.length + (deps.transfer ? setupTransferKeys(plan, keys).length : 0);
  const results: SetupMigrationResult[] = [];
  let completed = 0;
  const run = async (key: string, task: () => Promise<'done' | 'skipped'>) => {
    input.emit({ planId: plan.planId, key, phase: 'running', completed, total });
    let result: SetupMigrationResult;
    try {
      deps.assertCurrent();
      result = { key, outcome: await task() };
    } catch (error) {
      result = { key, outcome: 'failed', code: errorCode(error) };
    }
    completed += 1;
    results.push(result);
    input.emit({ planId: plan.planId, key, phase: result.outcome, completed, total });
    return result;
  };

  // Custom marketplaces first: their plugins can only be read after the source is added.
  const neededMarkets = new Set(
    plugins.filter((item) => item.source === 'custom-market' && item.marketName).map((item) => item.marketName!),
  );
  const marketErrors = new Map<string, string>();
  if (neededMarkets.size > 0) {
    const existing = await deps.marketNames().catch(() => new Set<string>());
    for (const name of neededMarkets) {
      if (existing.has(name)) continue;
      const source = snapshot.marketSources.find((candidate) => candidate.name === name);
      if (!source) {
        marketErrors.set(name, 'SOURCE_NOT_ADDED');
        continue;
      }
      try {
        deps.assertCurrent();
        await deps.addMarketSource(source);
      } catch (error) {
        marketErrors.set(name, errorCode(error));
      }
    }
  }

  const approved = new Map<string, string>();
  for (const item of plugins) {
    if (item.consent && input.approvedPluginKeys.has(item.key)) {
      approved.set(item.key, consentFingerprint(item.consent));
    }
  }

  for (const item of plugins) {
    await run(item.key, async () => {
      const existing = deps.findGhost(item.ghostId, item.namespace);
      if (existing) {
        if (existing.enabled === item.enabledOnSource) return 'skipped';
        await deps.setPluginEnabled(existing, item.enabledOnSource);
        return 'done';
      }
      if (!item.pluginId) return 'skipped';
      const marketError = item.marketName ? marketErrors.get(item.marketName) : undefined;
      if (marketError) throw Object.assign(new Error(marketError), { code: marketError });
      const detail = await deps.pluginDetail(item.pluginId);
      const expected = approved.get(item.key);
      const prompt: GhostInstallConsentPrompt = async (request) => {
        if (expected && request.purpose === undefined && consentFingerprint(request.facts) === expected) {
          return true;
        }
        return deps.windowPrompt(request);
      };
      const installed = await deps.installPlugin(
        item.pluginId,
        {
          expectedReleaseId: detail.releaseId,
          ...(item.source === 'custom-market' ? { expectedManifest: detail.manifest } : {}),
        },
        prompt,
      );
      if (!item.enabledOnSource && installed.enabled) {
        await deps.setPluginEnabled(installed, false);
      }
      return 'done';
    });
  }

  for (const item of skills) {
    await run(item.key, async () => {
      const local = await deps.findSkill(item.name);
      if (local) {
        // Already here: copy only the on/off choice.
        if (local.enabled === item.enabledOnSource) return 'skipped';
        await deps.setSkillEnabled(local.absolutePath, item.enabledOnSource);
        return 'done';
      }
      const installed = await deps.installSkill(item.name, item.catalogScope);
      if (!item.enabledOnSource) await deps.setSkillEnabled(installed.absolutePath, false);
      return 'done';
    });
  }

  for (const item of settings) {
    await run(item.key, async () => {
      const group = deps.settingsGroup(item.id);
      const values = snapshot.settings.find((candidate) => candidate.id === item.id)?.values;
      if (!group || !values) return 'skipped';
      // Decided inside the store's write lock: a value changed here since the preview, by the
      // user or another process, is still kept.
      const written = await group.applyPatch((customizedHere) => splitSettingsValues(values, customizedHere).apply);
      return written ? 'done' : 'skipped';
    });
  }

  // After plugins: their keys can only be written once they are installed here.
  const transfer = deps.transfer
    ? await applySetupTransferStep(
        {
          plan,
          snapshot,
          keys,
          onCode: (key, confirmCode) =>
            input.emit({ planId: plan.planId, key, phase: 'running', completed, total, confirmCode }),
        },
        deps.transfer,
        (key, task) => run(key, task),
      )
    : { handledKeys: [], checklist: [] };

  return {
    results,
    checklist: [...buildApplyChecklist(input, deps), ...transfer.checklist],
    handledKeys: transfer.handledKeys,
  };
}

/**
 * The plan's checklist, minus items for providers/MCP the user did not select, plus one
 * entry per plugin that had accounts or keys set up on the other computer and still needs
 * them here.
 */
export function buildApplyChecklist(
  input: Pick<SetupApplyInput, 'plan' | 'snapshot' | 'keys'>,
  deps: Pick<SetupApplyDeps, 'findGhost' | 'pluginSetupMissing'>,
): SetupMigrationChecklistItem[] {
  const { plan, snapshot, keys } = input;
  const checklist = plan.checklist.filter((item) => {
    if (item.kind === 'provider-key' || item.kind === 'provider-connection' || item.kind === 'provider-sign-in') {
      return keys.has(`provider:${item.ref}`);
    }
    if (item.kind === 'mcp-token') return keys.has(`mcp:${item.ref}`);
    return true;
  });
  for (const source of snapshot.plugins) {
    if (source.setupReady !== true) continue;
    const ghost = deps.findGhost(source.ghostId, source.namespace);
    if (!ghost) continue;
    let missing: string[] | null = null;
    try {
      missing = deps.pluginSetupMissing(ghost.instanceKey);
    } catch {
      missing = null;
    }
    if (!missing) continue;
    checklist.unshift({
      id: `plugin-setup:${ghost.instanceKey}`,
      kind: 'plugin-setup',
      label: source.name,
      ref: ghost.instanceKey,
      details: missing.slice(0, 8),
    });
  }
  return checklist;
}
