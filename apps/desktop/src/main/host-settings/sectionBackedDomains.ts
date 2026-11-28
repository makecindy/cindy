import { manageAppSettings } from '../app-settings/sections.js';
import type { AppSettingsWriteGuard } from '../app-settings/service.js';
import { inspectAppearanceSettings } from '../appearance-settings-store.js';
import { HostSettingsError } from './operations.js';
import { inspectAdditionalSettings } from './additional.js';
import { getSubagentModelSettingsStore } from '../maker-host/subagent-model-settings-store.js';
import { getAuxiliaryModelSettingsStore } from '../utility-model/auxiliary-model-settings-store.js';
import { desktopPreferenceExpected, desktopPreferencePatch, isDesktopPreferenceDomain } from './desktopPreferenceDomains.js';

/**
 * Host domains that the app already owns as settings sections. The remote settings page keeps
 * its wire shape (revision, single-field clear), but saving and applying go through the same
 * section the local settings page and Agents use, so there is one write path.
 */
const SECTION_OF = {
  appearance: 'appearance', gitSafety: 'git-safety', agentResource: 'agent-resources', memory: 'memory',
  subagentModel: 'subagent-models', auxiliaryModel: 'auxiliary-models',
  desktopGeneral: 'preferences', desktopChat: 'preferences', desktopNotifications: 'preferences',
} as const;
export type SectionDomain = keyof typeof SECTION_OF;
export const isSectionDomain = (domain: string): domain is SectionDomain => Object.hasOwn(SECTION_OF, domain);

// Defaults these sections cannot restore by writing a value; only a section reset does.
const RESET_ONLY: Partial<Record<SectionDomain, readonly string[]>> = {
  gitSafety: ['autoSnapshotEnabled'], auxiliaryModel: ['models'],
};

type Values = Record<string, unknown>;
function toSectionPatch(domain: SectionDomain, values: Values): Values {
  if (domain === 'gitSafety') return Object.hasOwn(values, 'autoSnapshotEnabled') ? { mode: values.autoSnapshotEnabled ? 'all-projects' : 'off' } : {};
  if (domain !== 'subagentModel' || !Object.hasOwn(values, 'claudeCode')) return values;
  const route = values.claudeCode as { providerId: string | null; modelId: string } | null;
  return { ...values, claudeCode: route?.modelId ?? null, claudeCodeProviderId: route?.providerId ?? null };
}

/** The domain's revision now, read without waiting so a section can compare it right at its write. */
function currentRevision(domain: Exclude<SectionDomain, 'desktopGeneral' | 'desktopChat' | 'desktopNotifications'>): string | null {
  if (domain === 'appearance') return inspectAppearanceSettings().revision;
  try {
    // The model groups' revision is their store's.
    if (domain === 'subagentModel') return getSubagentModelSettingsStore().inspect().revision;
    if (domain === 'auxiliaryModel') return getAuxiliaryModelSettingsStore().inspect().revision;
  } catch { return null; }
  return inspectAdditionalSettings(domain).revision;
}

/**
 * The read this save is based on, checked by the section where it persists: a change the app's own
 * window saved in the meantime is kept and this save is rejected. The app window compares its
 * preference groups itself.
 */
function writeGuard(domain: SectionDomain, expectedRevision: string, before: { value: Values }) {
  let conflicted = false;
  const guard: AppSettingsWriteGuard = isDesktopPreferenceDomain(domain)
    ? { assertUnchanged() {}, expected: desktopPreferenceExpected(domain, before.value as never) }
    : { assertUnchanged() {
      if (currentRevision(domain) === expectedRevision) return;
      conflicted = true;
      throw new HostSettingsError('CONFLICT');
    } };
  return { guard, conflicted: () => conflicted };
}

async function run(input: Parameters<typeof manageAppSettings>[0], assertCurrent: () => void, check: ReturnType<typeof writeGuard>): Promise<void> {
  let result: Awaited<ReturnType<typeof manageAppSettings>>;
  let persisted = false;
  try {
    result = await manageAppSettings(input, async () => { assertCurrent(); }, { guard: check.guard, onPersisted: () => { persisted = true; } });
  } catch (error) {
    // A section may wrap the error; the guard remembers the conflict it raised.
    if (check.conflicted()) throw new HostSettingsError('CONFLICT');
    // The value is saved; only a later check or the read after it failed.
    if (persisted) return;
    if (error instanceof HostSettingsError) throw error;
    const code = /^\[([A-Z_]+)\]/.exec(error instanceof Error ? error.message : '')?.[1];
    throw new HostSettingsError(code === 'INVALID_PARAMS' || code === 'CONFLICT' ? code : 'SAVE_FAILED');
  }
  if ('errorCode' in result) {
    throw new HostSettingsError(result.errorCode === 'INVALID_ARGS' ? 'INVALID_PARAMS' : result.errorCode === 'UNKNOWN_SETTINGS_SECTION' ? 'NOT_READY' : 'SAVE_FAILED');
  }
}

/**
 * Saves a change made from the read `before` at `expectedRevision`. Resolves once the change is
 * persisted, even if reading it back fails; rejects with CONFLICT if the setting changed since.
 */
export async function commitThroughSection(
  domain: SectionDomain,
  change: { set: Values; clear: string[] },
  before: { value: Values; defaults: Values; customizedKeys: string[]; choices?: Record<string, Array<{ value: unknown; label: string }>> },
  assertCurrent: () => void,
  expectedRevision: string,
): Promise<void> {
  const section = SECTION_OF[domain];
  let values: Values;
  let check = writeGuard(domain, expectedRevision, before);
  if (change.clear.some(key => RESET_ONLY[domain]?.includes(key))) {
    await run({ operation: 'reset', section }, assertCurrent, check);
    // Reset clears the whole section; write back what this change did not clear.
    values = { ...Object.fromEntries(before.customizedKeys.filter(key => !change.clear.includes(key)).map(key => [key, before.value[key]])), ...change.set };
    // The write-back follows the reset this save just made.
    if (!isDesktopPreferenceDomain(domain)) check = writeGuard(domain, currentRevision(domain) ?? '', before);
  } else {
    // Stores drop a value equal to its default, which is how a single field follows the default again.
    values = { ...Object.fromEntries(change.clear.map(key => [key, before.defaults[key]])), ...change.set };
  }
  const patch = isDesktopPreferenceDomain(domain)
    ? desktopPreferencePatch(domain, values as never, before as never) : toSectionPatch(domain, values);
  if (Object.keys(patch).length) await run({ operation: 'update', section, patch }, assertCurrent, check);
}
