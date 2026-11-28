/**
 * Managed cloud instances only: the settings half of an instance handover.
 *
 * CIS copies an allowlist of work files from one member's instance to another's
 * and never reads or writes settings itself. This module is how the settings
 * travel: the source instance keeps a small snapshot of its owner's portable
 * preferences on disk (the same stores new-computer setup copies, which hold no
 * credentials and nothing tied to one machine or account), and the receiving
 * instance applies a snapshot it finds in its inbox the next time it starts.
 * Values the receiver already chose are never overwritten.
 */
import fs from 'node:fs';
import path from 'node:path';

import { splitSettingsValues } from '../setup-migration/plan.js';
import { SETUP_SETTINGS_GROUPS, type SetupSettingsGroup } from '../setup-migration/settingsGroups.js';

/** File name CIS looks for under `owners/<key>/handover/` and writes into `handover-inbox/<id>/`. */
export const HANDOVER_SETTINGS_FILE = 'portable-settings.v1.json';
export const HANDOVER_SETTINGS_DIRECTORY = 'handover';
export const HANDOVER_INBOX_DIRECTORY = 'handover-inbox';
const MAX_BYTES = 256 * 1024;
/** How this installation updates itself is the managed runtime's business, not its owner's preference. */
const NOT_FOR_HANDOVER: ReadonlySet<string> = new Set(['autoUpdate', 'updateChannel']);

export interface HandoverSettingsSnapshot {
  version: 1;
  groups: Record<string, Record<string, unknown>>;
}

const portableGroups = (groups: readonly SetupSettingsGroup[], platform: NodeJS.Platform) =>
  groups.filter((group) => !NOT_FOR_HANDOVER.has(group.id) && (!group.platforms || group.platforms.includes(platform)));

/** What the owner changed from the defaults, group by group. A store that cannot be read is left out. */
export function collectHandoverSettings(
  groups: readonly SetupSettingsGroup[] = SETUP_SETTINGS_GROUPS,
  platform: NodeJS.Platform = process.platform,
): HandoverSettingsSnapshot {
  const out: HandoverSettingsSnapshot['groups'] = {};
  for (const group of portableGroups(groups, platform)) {
    let values: Record<string, unknown>;
    try {
      values = group.settings.readCustomized();
    } catch {
      continue;
    }
    if (Object.keys(values).length > 0) out[group.id] = values;
  }
  return { version: 1, groups: out };
}

/**
 * Keeps `<ownerDirectory>/handover/portable-settings.v1.json` equal to the current snapshot.
 * Synchronous on purpose: it also runs while the app is quitting. Returns whether it wrote.
 */
export function writeHandoverSettings(
  ownerDirectory: string,
  groups: readonly SetupSettingsGroup[] = SETUP_SETTINGS_GROUPS,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const body = JSON.stringify(collectHandoverSettings(groups, platform));
  if (Buffer.byteLength(body) > MAX_BYTES) return false;
  const directory = path.join(ownerDirectory, HANDOVER_SETTINGS_DIRECTORY);
  const file = path.join(directory, HANDOVER_SETTINGS_FILE);
  try {
    if (fs.readFileSync(file, 'utf8') === body) return false;
  } catch {
    // Not there yet, or unreadable: write it afresh.
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, body, { mode: 0o600 });
  fs.renameSync(temporary, file);
  return true;
}

function parseSnapshot(raw: string): HandoverSettingsSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const snapshot = value as Partial<HandoverSettingsSnapshot> | null;
  if (!snapshot || snapshot.version !== 1 || !snapshot.groups || typeof snapshot.groups !== 'object' || Array.isArray(snapshot.groups)) return null;
  for (const values of Object.values(snapshot.groups)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) return null;
  }
  return snapshot as HandoverSettingsSnapshot;
}

/**
 * Applies every snapshot waiting in `<userDataDirectory>/handover-inbox/<id>/` and removes it,
 * whether or not it could be used: an inbox entry is offered once. Each store validates the
 * values itself and drops what it does not know. Returns the groups that received a value.
 */
export async function applyHandoverInbox(
  userDataDirectory: string,
  groups: readonly SetupSettingsGroup[] = SETUP_SETTINGS_GROUPS,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const inbox = path.join(userDataDirectory, HANDOVER_INBOX_DIRECTORY);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(inbox, { withFileTypes: true });
  } catch {
    return [];
  }
  const known = new Map(portableGroups(groups, platform).map((group) => [group.id, group]));
  const applied = new Set<string>();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(inbox, entry.name);
    try {
      if (!entry.isDirectory()) continue;
      const file = path.join(directory, HANDOVER_SETTINGS_FILE);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) continue;
      const snapshot = parseSnapshot(fs.readFileSync(file, 'utf8'));
      if (!snapshot) continue;
      for (const [id, values] of Object.entries(snapshot.groups)) {
        const group = known.get(id);
        if (!group) continue;
        try {
          // Only keys the receiver left at their defaults; their own choices stay.
          if (await group.settings.applyPatch((customizedHere) => splitSettingsValues(values, customizedHere).apply)) applied.add(id);
        } catch {
          // One store refusing its values does not stop the others.
        }
      }
    } catch {
      // Missing or unreadable: nothing to apply from this entry.
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
  return [...applied];
}

/**
 * Applies the inbox once the instance's own member is the active owner, then keeps the snapshot
 * current: on a slow timer and once more while quitting, so a handover finds the latest values
 * even when the instance has been asleep since.
 */
export function startCloudHandoverSettings(deps: {
  membershipId: string;
  activeOwnerId: () => string | null;
  ownerDirectory: () => string;
  userDataDirectory: () => string;
  warn: (message: string) => void;
  intervalMs?: number;
}): () => void {
  let applied = false;
  let running = false;
  const pass = async (): Promise<void> => {
    if (running || deps.activeOwnerId() !== deps.membershipId) return;
    running = true;
    try {
      if (!applied) {
        await applyHandoverInbox(deps.userDataDirectory());
        applied = true;
      }
      writeHandoverSettings(deps.ownerDirectory());
    } catch {
      deps.warn('handover settings unavailable');
    } finally {
      running = false;
    }
  };
  // The owner is committed some time after start; the first passes simply find nobody yet.
  const early = setInterval(() => {
    if (applied) clearInterval(early);
    else void pass();
  }, 5_000);
  const steady = setInterval(() => void pass(), deps.intervalMs ?? 10 * 60_000);
  early.unref?.();
  steady.unref?.();
  void pass();
  return () => {
    clearInterval(early);
    clearInterval(steady);
    // Last word before the volume is left alone; never before the inbox was applied.
    if (applied && deps.activeOwnerId() === deps.membershipId) {
      try {
        writeHandoverSettings(deps.ownerDirectory());
      } catch {
        deps.warn('handover settings unavailable');
      }
    }
  };
}
