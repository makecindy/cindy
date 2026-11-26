import {
  CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1,
  CONTROLLER_CAPABILITY_TOOL_USE_EVENT_INPUT_OPTIONAL_V1,
} from '@cindy/device-link';

/**
 * Per-controller wire projection of tool bodies (see packages/device-link toolBodyStub.ts).
 * Pure: never changes the Host row, the local renderer broadcast or the agent transcript.
 * Each rule applies only when the controller declared its capability.
 */
export interface ToolBodyRules {
  resultText: boolean;
  useInput: boolean;
}

export function toolBodyRulesFor(supports: (capability: string) => boolean): ToolBodyRules | null {
  const rules = {
    resultText: supports(CONTROLLER_CAPABILITY_TOOL_RESULT_EVENT_TEXT_OPTIONAL_V1),
    useInput: supports(CONTROLLER_CAPABILITY_TOOL_USE_EVENT_INPUT_OPTIONAL_V1),
  };
  return rules.resultText || rules.useInput ? rules : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function projectToolEvent(push: Record<string, unknown>, rules: ToolBodyRules): unknown {
  const event = record(push.event)!;
  const data = record(event.data);
  if (!data) return push;
  if (event.type === 'tool_use') {
    if (!rules.useInput || data.input === null || data.input === undefined || data.toolName === 'update_plan') return push;
    return { ...push, event: { ...event, data: { ...data, input: null } } };
  }
  if (!rules.resultText || (!('fullText' in data) && !('summary' in data))) return push;
  const next = { ...data };
  delete next.fullText;
  delete next.summary;
  return { ...push, event: { ...event, data: next } };
}

/**
 * One push fans out to several controllers. Project each distinct rule set once, like the
 * Mobile projection, instead of once per controller. Only tool events can change; text
 * deltas and every other push skip all rule lookups.
 */
export function createToolBodyPushProjector(channel: string, payload: unknown) {
  const push = record(payload);
  const type = channel === 'maker:event' ? record(push?.event)?.type : undefined;
  if (type !== 'tool_use' && type !== 'tool_result' && type !== 'tool_result_full') {
    return (_supports: (capability: string) => boolean): unknown => payload;
  }
  const byRules = new Map<string, unknown>();
  return (supports: (capability: string) => boolean): unknown => {
    const rules = toolBodyRulesFor(supports);
    if (!rules) return payload;
    const key = `${+rules.resultText}${+rules.useInput}`;
    if (!byRules.has(key)) byRules.set(key, projectToolEvent(push!, rules));
    return byRules.get(key);
  };
}
