import { manageAppSettings } from '../app-settings/sections.js';
import { HostSettingsError } from './operations.js';
import { desktopPreferencePatch, isDesktopPreferenceDomain } from './desktopPreferenceDomains.js';

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

async function run(input: Parameters<typeof manageAppSettings>[0], assertCurrent: () => void): Promise<void> {
  let result: Awaited<ReturnType<typeof manageAppSettings>>;
  try {
    result = await manageAppSettings(input, async () => { assertCurrent(); });
  } catch (error) {
    if (error instanceof HostSettingsError) throw error;
    const code = /^\[([A-Z_]+)\]/.exec(error instanceof Error ? error.message : '')?.[1];
    throw new HostSettingsError(code === 'INVALID_PARAMS' ? 'INVALID_PARAMS' : 'SAVE_FAILED');
  }
  if ('errorCode' in result) {
    throw new HostSettingsError(result.errorCode === 'INVALID_ARGS' ? 'INVALID_PARAMS' : result.errorCode === 'UNKNOWN_SETTINGS_SECTION' ? 'NOT_READY' : 'SAVE_FAILED');
  }
}

/** The caller has already matched the expected revision; this only performs the write. */
export async function commitThroughSection(
  domain: SectionDomain,
  change: { set: Values; clear: string[] },
  before: { value: Values; defaults: Values; customizedKeys: string[]; choices?: Record<string, Array<{ value: unknown; label: string }>> },
  assertCurrent: () => void,
): Promise<void> {
  const section = SECTION_OF[domain];
  let values: Values;
  if (change.clear.some(key => RESET_ONLY[domain]?.includes(key))) {
    await run({ operation: 'reset', section }, assertCurrent);
    // Reset clears the whole section; write back what this change did not clear.
    values = { ...Object.fromEntries(before.customizedKeys.filter(key => !change.clear.includes(key)).map(key => [key, before.value[key]])), ...change.set };
  } else {
    // Stores drop a value equal to its default, which is how a single field follows the default again.
    values = { ...Object.fromEntries(change.clear.map(key => [key, before.defaults[key]])), ...change.set };
  }
  const patch = isDesktopPreferenceDomain(domain)
    ? desktopPreferencePatch(domain, values as never, before as never) : toSectionPatch(domain, values);
  if (Object.keys(patch).length) await run({ operation: 'update', section, patch }, assertCurrent);
}
