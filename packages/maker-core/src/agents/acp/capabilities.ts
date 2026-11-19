/**
 * Builds Cindy `Capabilities` for an ACP agent from what it actually negotiated.
 *
 * Nothing is assumed from the agent's name: model switching, reasoning effort,
 * image input and resume are declared only when `initialize` / `session/new`
 * advertised them, so the UI hides what the agent cannot do instead of failing
 * later.
 */

import type { Capabilities, CapabilityStatus, EffortDescriptor, ModelDescriptor, PermissionModeDescriptor } from '../../types/capabilities.js';
import type { Effort, PermissionMode } from '../../types/common.js';
import type { AcpConfigOption, AcpInitializeResult } from './protocol.js';

const NOT_IMPLEMENTED: CapabilityStatus = { supported: false, reason: 'not-implemented' };
const SDK_MISSING: CapabilityStatus = { supported: false, reason: 'sdk-missing', upstreamRef: 'Agent Client Protocol v1' };
const SUPPORTED: CapabilityStatus = { supported: true };

/** Cindy efforts an ACP option value can map to, compared case-insensitively by value id. */
const MAPPABLE_EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Permission policy Cindy applies to `session/request_permission`. The agent
 * decides which actions ask at all; Cindy cannot gate an action it is not asked about.
 */
export const ACP_PERMISSION_MODES: readonly PermissionModeDescriptor[] = [
  {
    id: 'ask',
    displayName: 'Ask each time',
    description: 'Every permission request from the agent is shown to you for a decision.',
  },
  {
    id: 'bypassPermissions',
    displayName: 'Full access',
    description: 'Permission requests from the agent are approved automatically. Use only for trusted tasks.',
  },
];

export const ACP_SUPPORTED_PERMISSION_MODES: ReadonlySet<PermissionMode> = new Set(ACP_PERMISSION_MODES.map((mode) => mode.id));

/**
 * Cindy permission modes an agent's own `mode` option can stand for. A value maps when it names
 * the same mode ignoring case, '-', '_' and spaces (`accept-edits` → acceptEdits); other values
 * stay agent-only, like reasoning levels Cindy cannot name.
 */
const MAPPABLE_MODES: readonly PermissionMode[] = ['ask', 'default', 'acceptEdits', 'auto', 'plan'];

function modeKey(value: string): string {
  return value.toLowerCase().replace(/[-_\s]/g, '');
}

export function findModeOption(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.type === 'select' && option.category === 'mode')
    ?? options.find((option) => option.type === 'select' && option.id === 'mode');
}

export interface MappedAcpMode {
  mode: PermissionMode;
  value: string;
  name: string;
}

/** The agent's modes Cindy can name, in the agent's order. */
export function mapModeValues(option: AcpConfigOption | undefined): MappedAcpMode[] {
  if (!option) return [];
  const out: MappedAcpMode[] = [];
  for (const entry of option.options) {
    const mode = MAPPABLE_MODES.find((candidate) => modeKey(candidate) === modeKey(entry.value));
    if (mode && !out.some((mapped) => mapped.mode === mode)) out.push({ mode, value: entry.value, name: entry.name });
  }
  return out;
}

/**
 * Permission modes offered for an ACP task. An agent that publishes modes Cindy can name offers
 * those (the agent switches its own mode; Cindy still asks you about every permission request),
 * followed by Full access; any other agent offers Ask each time / Full access.
 */
export function acpPermissionModes(options: readonly AcpConfigOption[]): PermissionModeDescriptor[] {
  const agentModes = mapModeValues(findModeOption(options));
  if (agentModes.length === 0) return [...ACP_PERMISSION_MODES];
  const fullAccess = ACP_PERMISSION_MODES.find((mode) => mode.id === 'bypassPermissions')!;
  return [...agentModes.map((mapped) => ({ id: mapped.mode, displayName: mapped.name })), fullAccess];
}

export function findModelOption(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.type === 'select' && option.category === 'model')
    ?? options.find((option) => option.type === 'select' && option.id === 'model');
}

export function findEffortOption(options: readonly AcpConfigOption[]): AcpConfigOption | undefined {
  return options.find((option) => option.type === 'select' && option.category === 'thought_level')
    ?? options.find((option) => option.type === 'select' && (option.id === 'reasoning_effort' || option.id === 'thought_level'));
}

export interface AcpEffortMapping {
  effort: Effort;
  value: string;
  name: string;
}

/** Only option values whose id equals a Cindy effort are mapped; others stay agent-only. */
export function mapEffortValues(option: AcpConfigOption | undefined): AcpEffortMapping[] {
  if (!option) return [];
  const out: AcpEffortMapping[] = [];
  for (const entry of option.options) {
    const effort = MAPPABLE_EFFORTS.find((candidate) => candidate === entry.value.toLowerCase());
    if (effort && !out.some((mapped) => mapped.effort === effort)) out.push({ effort, value: entry.value, name: entry.name });
  }
  return out;
}

export function currentEffort(option: AcpConfigOption | undefined): Effort | null {
  if (!option || typeof option.currentValue !== 'string') return null;
  const value = option.currentValue;
  return mapEffortValues(option).find((mapped) => mapped.value === value)?.effort ?? null;
}

/**
 * Models come from the agent's own `model` config option. Effort levels are only
 * known for the currently selected model (agents republish the thought option
 * per model), so other models are marked `effortsUnknown`.
 */
export function describeAcpModels(options: readonly AcpConfigOption[]): ModelDescriptor[] {
  const modelOption = findModelOption(options);
  if (!modelOption) return [];
  const effortMappings = mapEffortValues(findEffortOption(options));
  const selected = typeof modelOption.currentValue === 'string' ? modelOption.currentValue : undefined;
  return modelOption.options.map((entry) => {
    const isSelected = entry.value === selected;
    const efforts = isSelected ? effortMappings.map((mapped) => mapped.effort) : [];
    return {
      id: entry.value,
      displayName: entry.name,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.group ? { group: entry.group } : {}),
      // ACP does not publish context windows; 0 means unknown everywhere in Cindy.
      contextWindow: 0,
      efforts,
      defaultEffort: isSelected ? currentEffort(findEffortOption(options)) : null,
      ...(isSelected ? {} : { effortsUnknown: true }),
      supportsFastMode: false,
    };
  });
}

export function buildAcpCapabilities(init: AcpInitializeResult, options: readonly AcpConfigOption[]): Capabilities {
  const modelOption = findModelOption(options);
  const effortLevels: EffortDescriptor[] = mapEffortValues(findEffortOption(options))
    .map((mapped) => ({ id: mapped.effort, displayName: mapped.name }));
  const { promptCapabilities } = init.agentCapabilities;
  return {
    switchModel: modelOption && modelOption.options.length > 0 ? SUPPORTED : SDK_MISSING,
    availableModels: describeAcpModels(options),
    hasFastMode: false,
    effort: effortLevels.length > 0 ? SUPPORTED : SDK_MISSING,
    effortLevels,
    reasoningDisplay: ['full'],
    permissionModes: acpPermissionModes(options),
    setPermissionModeMidSession: SUPPORTED,
    planMode: SDK_MISSING,
    multimodal: {
      text: SUPPORTED,
      // Without image support the attachment is still passed as a resource link.
      image: promptCapabilities.image ? SUPPORTED : SDK_MISSING,
      // `resource_link` is mandatory in ACP v1, so files can always be referenced.
      file: SUPPORTED,
    },
    fork: SDK_MISSING,
    rewind: SDK_MISSING,
    sessionTree: SDK_MISSING,
    abort: SUPPORTED,
    // One prompt per session at a time; follow-ups wait for the next turn.
    sameTurnSteer: SDK_MISSING,
    memory: { supported: SDK_MISSING },
    extraDirs: NOT_IMPLEMENTED,
    writableDirs: NOT_IMPLEMENTED,
    sessionHtmlExport: SDK_MISSING,
    manualCompact: SDK_MISSING,
  };
}
