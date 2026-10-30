/**
 * What of a companion's capability setup moves with it to another computer
 * (`companion.capabilities.v1`; cloud-companions.md §2, 2026-10-22 ruling). Only choices that mean
 * the same on any computer: references to skills, MCP servers and toolsets (ids, never their
 * configuration or credentials), the memory switch, hand-over and follow-up switches, and the
 * model *preference*. The permission level never travels; the new computer uses its default.
 */
import { BOT_MODEL_CHAIN_MAX, normalizeBotModelChain, readBotTaskModelOverride, type BotModelRoute } from '../../shared/botModelChain.js';

const MAX_REFS = 100;
const MAX_REF_LENGTH = 200;

type SelectionMode = 'inherit' | 'allowlist';

export interface CompanionCapabilitiesValue {
  skills?: string[];
  skillMode?: SelectionMode;
  skillsExcluded?: string[];
  toolsets?: string[];
  toolsetMode?: SelectionMode;
  mcpServers?: string[];
  mcpMode?: SelectionMode;
  /** Display names of the referenced MCP servers (their ids mean nothing to a person); never configuration. */
  mcpServerNames?: Record<string, string>;
  memory?: boolean;
  inputHandoff?: boolean;
  allowSchedulerFollow?: boolean;
  gender?: string;
  /** The routes the owner chose for this companion; absent when it follows the default model. */
  modelChain?: BotModelRoute[];
  taskModel?: BotModelRoute;
}

const refs = (value: unknown): string[] | undefined => Array.isArray(value)
  ? [...new Set(value.filter((id): id is string => typeof id === 'string' && !!id.trim() && id.length <= MAX_REF_LENGTH))].slice(0, MAX_REFS)
  : undefined;
const mode = (value: unknown): SelectionMode | undefined => (value === 'inherit' || value === 'allowlist' ? value : undefined);
const MAX_NAME_LENGTH = 80;
/** Names for the referenced ids only (the list may hold ids this computer does not know). */
function referencedNames(raw: unknown, ids: string[] | undefined): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !ids?.length) return undefined;
  const names: Record<string, string> = {};
  for (const id of ids) {
    const name = (raw as Record<string, unknown>)[id];
    if (typeof name === 'string' && name.trim()) names[id] = name.trim().slice(0, MAX_NAME_LENGTH);
  }
  return Object.keys(names).length ? names : undefined;
}
/** A route that names another computer to run on has no meaning on the new home. */
const portableRoute = (route: BotModelRoute) => !route.agentDeviceId;

/**
 * The portable part of a capabilities record. `explicitChain` is the companion's own chosen model
 * chain (null: it follows the default, which the new computer then also follows).
 */
export function portableCompanionCapabilities(config: Record<string, unknown>, explicitChain: BotModelRoute[] | null,
  localMcpNames: Record<string, string> = {}): CompanionCapabilitiesValue {
  const value: CompanionCapabilitiesValue = {};
  for (const [field, selection] of [['skills', 'skillMode'], ['toolsets', 'toolsetMode'], ['mcpServers', 'mcpMode']] as const) {
    const list = refs(config[field]);
    if (list) value[field] = list;
    const selected = mode(config[selection]);
    if (selected) value[selection] = selected;
  }
  // Names this computer knows win; the rest keep what an earlier computer sent along.
  const mcpNames = referencedNames({ ...(config.mcpServerNames as Record<string, unknown> | undefined), ...localMcpNames }, value.mcpServers);
  if (mcpNames) value.mcpServerNames = mcpNames;
  const excluded = refs(config.skillsExcluded);
  if (excluded) value.skillsExcluded = excluded;
  for (const field of ['memory', 'inputHandoff', 'allowSchedulerFollow'] as const) {
    if (typeof config[field] === 'boolean') value[field] = config[field];
  }
  if (typeof config.gender === 'string' && config.gender.length <= 16) value.gender = config.gender;
  const chain = (explicitChain ?? []).filter(portableRoute);
  if (chain.length) value.modelChain = chain;
  try {
    const task = readBotTaskModelOverride(config.taskModelOverride);
    if (task && portableRoute(task)) value.taskModel = task;
  } catch { /* an unreadable task model is not carried */ }
  return value;
}

/** A value from the cloud, read defensively (it is untrusted); null when it is not an object. */
export function parseCompanionCapabilities(raw: unknown): CompanionCapabilitiesValue | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const value: CompanionCapabilitiesValue = {};
  for (const [field, selection] of [['skills', 'skillMode'], ['toolsets', 'toolsetMode'], ['mcpServers', 'mcpMode']] as const) {
    const list = refs(input[field]);
    if (list) value[field] = list;
    const selected = mode(input[selection]);
    if (selected) value[selection] = selected;
  }
  const mcpNames = referencedNames(input.mcpServerNames, value.mcpServers);
  if (mcpNames) value.mcpServerNames = mcpNames;
  const excluded = refs(input.skillsExcluded);
  if (excluded) value.skillsExcluded = excluded;
  for (const field of ['memory', 'inputHandoff', 'allowSchedulerFollow'] as const) {
    if (typeof input[field] === 'boolean') value[field] = input[field];
  }
  if (typeof input.gender === 'string' && input.gender.length <= 16) value.gender = input.gender;
  const chain = normalizeBotModelChain(input.modelChain).filter(portableRoute).slice(0, BOT_MODEL_CHAIN_MAX);
  if (chain.length) value.modelChain = chain;
  try {
    const task = readBotTaskModelOverride(input.taskModel);
    if (task && portableRoute(task)) value.taskModel = task;
  } catch { /* ignored: follows the primary model */ }
  return value;
}

/** What the new home could not keep of the old setup; shown once as a line after the move. */
export type CompanionArrivalNotice = 'permissions' | 'model';

/**
 * The settings patch for `updateBotProfile` from a cloud value and the routes usable here. Only called
 * for a present `companion.capabilities.v1` value; without the key (an older main computer) nothing is touched.
 */
export function companionCapabilitiesPatch(value: CompanionCapabilitiesValue, models: {
  chain: BotModelRoute[]; task: BotModelRoute | null;
}): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const field of ['skills', 'skillMode', 'skillsExcluded', 'toolsets', 'toolsetMode', 'mcpServers', 'mcpMode', 'mcpServerNames', 'memory', 'inputHandoff', 'allowSchedulerFollow'] as const) {
    if (value[field] !== undefined) patch[field] = value[field];
  }
  // The value exists, so the main computer's setup is known: a model it does not name is one it
  // follows its default for, and a copy kept here from an earlier stay must not keep its old choice.
  const [primary] = models.chain;
  if (value.modelChain && primary) Object.assign(patch, primary, { modelChain: models.chain, modelChainOverride: models.chain });
  // No chain saved, or none of the saved routes exists here: follow this computer's default.
  else Object.assign(patch, { modelOverride: null, modelChainOverride: null });
  patch.taskModelOverride = value.taskModel ? models.task : null;
  return patch;
}
