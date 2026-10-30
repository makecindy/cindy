/** Cindy provider policies, consolidated from codex-proxy-host. Route selection stays in the host. */
import { isPlainObject } from "../object";
import { stripEmptyResponseMessage } from "./seed";

export const STRICT_GATEWAY_TOOL_HISTORY_MODELS = new Set([
  'moonshot/kimi-k3',
  'moonshotai/kimi-k3',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);

export const RESPONSE_TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);

export const RESPONSE_TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

export function responseToolCallId(item: unknown, output: boolean): string | null {
  if (!isPlainObject(item)) return null;
  const supportedTypes = output ? RESPONSE_TOOL_OUTPUT_TYPES : RESPONSE_TOOL_CALL_TYPES;
  if (!supportedTypes.has(typeof item.type === 'string' ? item.type : '')) return null;
  return typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : null;
}

export function normalizeStrictGatewayHistory(
  body: Record<string, unknown>,
  routingModel = typeof body.model === 'string' ? body.model : '',
): Record<string, unknown> | null {
  if (
    !STRICT_GATEWAY_TOOL_HISTORY_MODELS.has(routingModel) ||
    !Array.isArray(body.input)
  ) {
    return null;
  }

  const originalInput = body.input;
  const normalizedInput: unknown[] = [];
  for (const item of originalInput) {
    const normalized = stripEmptyResponseMessage(item);
    if (normalized) normalizedInput.push(normalized.item);
  }

  const matchedOutputs = new Map<number, number>();
  const usedOutputIndexes = new Set<number>();
  const outputIndexesByCallId = new Map<string, number[]>();
  const outputCursorByCallId = new Map<string, number>();
  for (let index = 0; index < normalizedInput.length; index += 1) {
    const outputCallId = responseToolCallId(normalizedInput[index], true);
    if (!outputCallId) continue;
    const indexes = outputIndexesByCallId.get(outputCallId) ?? [];
    indexes.push(index);
    outputIndexesByCallId.set(outputCallId, indexes);
  }

  for (let callIndex = 0; callIndex < normalizedInput.length; callIndex += 1) {
    const callId = responseToolCallId(normalizedInput[callIndex], false);
    if (!callId) continue;

    const outputIndexes = outputIndexesByCallId.get(callId);
    if (!outputIndexes) continue;
    let cursor = outputCursorByCallId.get(callId) ?? 0;
    while (cursor < outputIndexes.length && outputIndexes[cursor] <= callIndex) cursor += 1;
    if (cursor >= outputIndexes.length) continue;

    const outputIndex = outputIndexes[cursor];
    outputCursorByCallId.set(callId, cursor + 1);
    matchedOutputs.set(callIndex, outputIndex);
    usedOutputIndexes.add(outputIndex);
  }

  const outputIndexesByGroupEnd = new Map<number, number[]>();
  for (let groupStart = 0; groupStart < normalizedInput.length;) {
    if (!responseToolCallId(normalizedInput[groupStart], false)) {
      groupStart += 1;
      continue;
    }
    let groupEnd = groupStart;
    while (
      groupEnd + 1 < normalizedInput.length &&
      responseToolCallId(normalizedInput[groupEnd + 1], false)
    ) {
      groupEnd += 1;
    }
    const outputIndexes: number[] = [];
    for (let callIndex = groupStart; callIndex <= groupEnd; callIndex += 1) {
      const outputIndex = matchedOutputs.get(callIndex);
      if (outputIndex !== undefined) outputIndexes.push(outputIndex);
    }
    if (outputIndexes.length > 0) {
      outputIndexesByGroupEnd.set(groupEnd, outputIndexes.sort((a, b) => a - b));
    }
    groupStart = groupEnd + 1;
  }

  const input: unknown[] = [];
  for (let index = 0; index < normalizedInput.length; index += 1) {
    if (usedOutputIndexes.has(index)) continue;
    input.push(normalizedInput[index]);
    const outputIndexes = outputIndexesByGroupEnd.get(index);
    if (outputIndexes) {
      for (const outputIndex of outputIndexes) input.push(normalizedInput[outputIndex]);
    }
  }
  const changed =
    input.length !== originalInput.length ||
    input.some((item, index) => item !== originalInput[index]);
  return changed ? { ...body, input } : null;
}
