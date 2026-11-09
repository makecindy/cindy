/**
 * A V2 teammate's project setup in the cloud (cloud-companions.md §2.1). The teammate is a project
 * on its main computer; of that project only its rules (`AGENTS.md`) and its automations
 * (`.cindy/automations/schedules.json`, with each one's paused state) travel. Its other files and
 * its Git history stay on each computer. Memories and skills travel under their existing keys.
 *
 * The file and scheduler side is injected (host.ts) so the rules here stay testable.
 */
import { errorCode, type CompanionLog } from './types.js';
import {
  COMPANION_AUTOMATION_PREFIX, COMPANION_PROJECT_CARRYOVER_KEY, COMPANION_PROJECT_RULES_KEY, canonicalJson, type CompanionPreferenceValue,
} from './uploader.js';

/** Rules larger than this are not read (and so not uploaded or tombstoned). */
export const PROJECT_RULES_MAX_BYTES = 256 * 1024;
/** Config ids the project automation loader accepts. */
const CONFIG_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/** One automation of the project as this computer has it. */
export interface ProjectAutomationEntry {
  config: { id: string } & Record<string, unknown>;
  paused: boolean;
}

/** Cloud value of one automation. */
export interface ProjectAutomationValue extends ProjectAutomationEntry {
  /** The computer that uploaded it: a check command it saved may not exist on another one. */
  originDeviceId?: string;
}

export interface CompanionProjectIo {
  /** The teammate's project folder when it is a V2 teammate here; null otherwise. */
  projectDir: (botId: string) => Promise<string | null>;
  /** Make the teammate a project here (the V2 upgrade, idempotent) and return its folder. */
  prepareProject: (botId: string, assertCurrent: () => void) => Promise<string>;
  /** The rules file; null when the project has none. Other read errors throw. */
  readRules: (workingDir: string) => Promise<string | null>;
  writeRules: (workingDir: string, content: string) => Promise<void>;
  /** The project's `CARRYOVER.md` (unfinished V1 work); null when it has none. */
  readCarryover: (workingDir: string) => Promise<string | null>;
  writeCarryover: (workingDir: string, content: string) => Promise<void>;
  /** Record a version of the project; a failure is logged, never fails the arrival. */
  snapshot: (workingDir: string, label: string) => Promise<void>;
  /** The project's automations; [] without an automations file; throws when it cannot be read. */
  automations: (workingDir: string) => Promise<ProjectAutomationEntry[]>;
  /** Save one automation definition (validated: a bad one throws with `code: 'INVALID_PARAMS'`). */
  upsertAutomation: (workingDir: string, config: Record<string, unknown>) => Promise<void>;
  removeAutomation: (workingDir: string, configId: string) => Promise<void>;
  setAutomationPaused: (workingDir: string, configId: string, paused: boolean) => Promise<void>;
}

/**
 * What the main computer uploads for a V2 teammate. Not a project here: nothing (earlier values
 * this computer uploaded are cleared like any removed value). A part that cannot be read is
 * `unread`: its cloud values stay, and a hand-over waits for the next try.
 */
export async function readProjectValues(botId: string, io: CompanionProjectIo, selfDeviceId: string | null): Promise<CompanionPreferenceValue[]> {
  const workingDir = await io.projectDir(botId);
  if (!workingDir) return [];
  const values: CompanionPreferenceValue[] = [];
  try {
    const rules = await io.readRules(workingDir);
    if (rules !== null && Buffer.byteLength(rules, 'utf8') > PROJECT_RULES_MAX_BYTES) {
      values.push({ key: COMPANION_PROJECT_RULES_KEY, value: null, unread: true });
    } else if (rules !== null) values.push({ key: COMPANION_PROJECT_RULES_KEY, value: { content: rules } });
  } catch { values.push({ key: COMPANION_PROJECT_RULES_KEY, value: null, unread: true }); }
  try {
    const carryover = await io.readCarryover(workingDir);
    if (carryover !== null && Buffer.byteLength(carryover, 'utf8') > PROJECT_RULES_MAX_BYTES) {
      values.push({ key: COMPANION_PROJECT_CARRYOVER_KEY, value: null, unread: true });
    } else if (carryover !== null) values.push({ key: COMPANION_PROJECT_CARRYOVER_KEY, value: { content: carryover } });
  } catch { values.push({ key: COMPANION_PROJECT_CARRYOVER_KEY, value: null, unread: true }); }
  try {
    for (const entry of await io.automations(workingDir)) {
      if (!CONFIG_ID.test(entry.config.id)) continue;
      const value: ProjectAutomationValue = { config: entry.config, paused: entry.paused, ...(selfDeviceId ? { originDeviceId: selfDeviceId } : {}) };
      values.push({ key: `${COMPANION_AUTOMATION_PREFIX}${entry.config.id}`, value });
    }
  } catch { values.push({ key: COMPANION_AUTOMATION_PREFIX, value: null, unread: true }); }
  return values;
}

/** The project's rules from the cloud: written and versioned only when they differ. */
export async function applyProjectRules(input: {
  botId: string; content: string; io: CompanionProjectIo; assertCurrent: () => void; log?: CompanionLog;
}): Promise<void> {
  const workingDir = await input.io.prepareProject(input.botId, input.assertCurrent);
  input.assertCurrent();
  if (await input.io.readRules(workingDir) === input.content) return;
  input.assertCurrent();
  await input.io.writeRules(workingDir, input.content);
  // Each computer keeps its own history: the arrival is one more version in it.
  await input.io.snapshot(workingDir, 'Rules from the teammate\'s main computer').catch(error => {
    input.log?.warn('Teammate rules arrived without a project version', { code: errorCode(error) });
  });
}

/** The project's unfinished V1 work from the cloud: written only when it differs. */
export async function applyProjectCarryover(input: {
  botId: string; content: string; io: CompanionProjectIo; assertCurrent: () => void;
}): Promise<void> {
  const workingDir = await input.io.prepareProject(input.botId, input.assertCurrent);
  input.assertCurrent();
  if (await input.io.readCarryover(workingDir) === input.content) return;
  input.assertCurrent();
  await input.io.writeCarryover(workingDir, input.content);
}

/** Merging another copy of the teammate: its rules are added to these, once, never replacing them. */
export async function mergeProjectRules(input: {
  botId: string; from: string; content: string; io: CompanionProjectIo; assertCurrent: () => void; log?: CompanionLog;
}): Promise<void> {
  const added = input.content.trim();
  if (!added) return;
  const workingDir = await input.io.prepareProject(input.botId, input.assertCurrent);
  input.assertCurrent();
  const current = await input.io.readRules(workingDir) ?? '';
  if (current.includes(added)) return;
  input.assertCurrent();
  await input.io.writeRules(workingDir, `${current.trimEnd()}\n\n## From ${input.from}\n\n${added}\n`);
  await input.io.snapshot(workingDir, `Rules merged from ${input.from}`).catch(error => {
    input.log?.warn('Merged teammate rules without a project version', { code: errorCode(error) });
  });
}

function readAutomation(id: string, value: unknown): ProjectAutomationValue | null {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const config = record?.config && typeof record.config === 'object' && !Array.isArray(record.config) ? record.config as Record<string, unknown> : null;
  if (!config || config.id !== id) return null;
  return { config: config as ProjectAutomationValue['config'], paused: record!.paused === true,
    ...(typeof record!.originDeviceId === 'string' ? { originDeviceId: record!.originDeviceId } : {}) };
}

/** Where it runs is relative to the computer the project is on: "that computer" may now be this one. */
function localRoute(config: ProjectAutomationValue['config'], selfDeviceId: string | null): ProjectAutomationValue['config'] {
  if (!selfDeviceId) return config;
  const next = { ...config };
  if (next.agentDeviceId === selfDeviceId) delete next.agentDeviceId;
  if (next.modelAgentDeviceId === selfDeviceId) next.modelAgentDeviceId = '';
  return next;
}

/**
 * The project's automations from the cloud, by config id: added or updated, paused or resumed to
 * match, removed for a tombstone. Automations only this computer has stay. Idempotent: what is
 * already the same is not written again (the teammate-memory-review the upgrade adds included).
 * One unreadable definition is skipped, never keeps the teammate from arriving.
 */
export async function applyProjectAutomations(input: {
  botId: string; rows: Array<{ id: string; value: unknown }>; io: CompanionProjectIo;
  selfDeviceId: string | null; assertCurrent: () => void; log?: CompanionLog;
}): Promise<void> {
  const { io } = input;
  const workingDir = await io.prepareProject(input.botId, input.assertCurrent);
  input.assertCurrent();
  const current = new Map((await io.automations(workingDir)).map(entry => [entry.config.id, entry]));
  for (const { id, value } of input.rows) {
    input.assertCurrent();
    if (!CONFIG_ID.test(id)) continue;
    const here = current.get(id);
    if (value === null) {
      if (here) await io.removeAutomation(workingDir, id);
      continue;
    }
    const arrived = readAutomation(id, value);
    if (!arrived) {
      input.log?.warn('Teammate automation skipped: unreadable definition');
      continue;
    }
    const config = localRoute(arrived.config, input.selfDeviceId);
    // A check command saved on another computer may not exist here: it arrives paused.
    const hook = config.preRunHook as { command?: unknown } | undefined;
    const foreignCheck = typeof hook?.command === 'string' && !!hook.command.trim() && arrived.originDeviceId !== input.selfDeviceId;
    const paused = arrived.paused || foreignCheck;
    if (!here || canonicalJson(here.config) !== canonicalJson(config)) {
      try { await io.upsertAutomation(workingDir, config); } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'INVALID_PARAMS') throw error;
        input.log?.warn('Teammate automation skipped: invalid definition');
        continue;
      }
    }
    if (here ? here.paused !== paused : paused) await io.setAutomationPaused(workingDir, id, paused);
  }
}
