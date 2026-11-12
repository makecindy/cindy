/** Cindy provider policies, consolidated from codex-proxy-host. Route selection stays in the host. */
import { isPlainObject } from "../object";
import { stripEmptyResponseMessage } from "./seed";
import { resolveProviderCompatibilityProfile, type CompatibilityRoute } from '../profiles';

export const STRICT_GATEWAY_TOOL_HISTORY_MODELS = new Set([
  'moonshot/kimi-k3',
  'moonshotai/kimi-k3',
  'deepseek/deepseek-v4-pro',
  'deepseek/deepseek-v4-flash',
]);

export const RESPONSE_TOOL_CALL_TYPES = new Set(['function_call', 'custom_tool_call']);

export const RESPONSE_TOOL_OUTPUT_TYPES = new Set(['function_call_output', 'custom_tool_call_output']);

export type DeepSeekToolHistoryResult =
  | { kind: 'unchanged' }
  | { kind: 'invalid' }
  | { kind: 'normalized'; body: Record<string, unknown> };

/**
 * Complete an interleaved tool batch before developer messages for the verified
 * DeepSeek V4.1 Responses route. The host owns route selection and error delivery.
 * No item, field, reasoning content or media is altered; conversation boundaries
 * and incomplete or ambiguous batches are never crossed or guessed.
 */
export function normalizeDeepSeekV41ToolHistory(
  body: Record<string, unknown>,
): DeepSeekToolHistoryResult {
  return normalizeInterleavedToolHistory(body, 'developer');
}

/** Kimi's bare model IDs are eligible only on its actual Chat endpoint. */
export function normalizeKimiToolHistory(
  body: Record<string, unknown>,
  route: CompatibilityRoute,
): Record<string, unknown> | null {
  if (route.harness !== 'codex' || route.protocol !== 'openai-chat'
    || (route.model !== 'k3' && route.model !== 'k3[1m]')) return null;
  const profile = resolveProviderCompatibilityProfile(route);
  if (profile?.id !== 'kimi' && profile?.id !== 'kimi-code') return null;
  const result = normalizeInterleavedToolHistory(body, 'assistant');
  // Incomplete/ambiguous histories remain intact for the upstream to validate.
  // Never synthesize a result or borrow one across a user/reasoning boundary.
  return result.kind === 'normalized' ? result.body : null;
}

function normalizeInterleavedToolHistory(
  body: Record<string, unknown>,
  displacedRole: 'developer' | 'assistant',
): DeepSeekToolHistoryResult {
  if (!Array.isArray(body.input)) return { kind: 'unchanged' };
  const input: unknown[] = body.input;
  const outputTypes = new Map<string, string>([
    ['function_call', 'function_call_output'],
    ['custom_tool_call', 'custom_tool_call_output'],
  ]);
  const counts = new Map<unknown, { calls: number; outputs: number }>();
  for (const item of input) {
    if (!isPlainObject(item) || typeof item.type !== 'string') continue;
    const isCall = outputTypes.has(item.type);
    const isOutput = RESPONSE_TOOL_OUTPUT_TYPES.has(item.type);
    if (!isCall && !isOutput) continue;
    const count = counts.get(item.call_id) ?? { calls: 0, outputs: 0 };
    if (isCall) count.calls += 1;
    else count.outputs += 1;
    counts.set(item.call_id, count);
  }

  const normalized: unknown[] = [];
  let changed = false;
  for (let index = 0; index < input.length;) {
    const first = input[index];
    if (!isPlainObject(first) || typeof first.type !== 'string' || !outputTypes.has(first.type)) {
      normalized.push(first);
      index += 1;
      continue;
    }
    const start = index;
    const calls = new Map<unknown, Record<string, unknown>>();
    while (index < input.length) {
      const item = input[index];
      if (!isPlainObject(item) || typeof item.type !== 'string' || !outputTypes.has(item.type)) break;
      calls.set(item.call_id, item);
      index += 1;
    }
    const endCalls = index;
    const pending = new Set(calls.keys());
    const outputs: Record<string, unknown>[] = [];
    const messages: Record<string, unknown>[] = [];
    let cursor = endCalls;
    while (cursor < input.length && pending.size > 0) {
      const item = input[cursor];
      if (!isPlainObject(item)) break;
      if (item.role === displacedRole && (item.type === 'message' || item.type === undefined)) {
        messages.push(item);
      } else {
        const call = calls.get(item.call_id);
        if (
          !call || !pending.has(item.call_id) || typeof call.type !== 'string' ||
          outputTypes.get(call.type) !== item.type
        ) break;
        outputs.push(item);
        pending.delete(item.call_id);
      }
      cursor += 1;
    }
    if (messages.length === 0) {
      normalized.push(...input.slice(start, endCalls));
      continue;
    }
    if (pending.size > 0) return { kind: 'invalid' };
    for (const callId of calls.keys()) {
      const count = counts.get(callId);
      if (typeof callId !== 'string' || callId.length === 0 || count?.calls !== 1 || count.outputs !== 1) {
        return { kind: 'invalid' };
      }
    }
    for (const output of outputs) {
      const call = calls.get(output.call_id)!;
      if (
        !Object.hasOwn(output, 'output') ||
        (Object.hasOwn(output, 'name') && output.name !== call.name) ||
        (Object.hasOwn(output, 'namespace') && output.namespace !== call.namespace)
      ) return { kind: 'invalid' };
    }
    normalized.push(...input.slice(start, endCalls), ...outputs, ...messages);
    index = cursor;
    changed = true;
  }
  return changed ? { kind: 'normalized', body: { ...body, input: normalized } } : { kind: 'unchanged' };
}

export function responseToolCallId(item: unknown, output: boolean): string | null {
  if (!isPlainObject(item)) return null;
  const supportedTypes = output ? RESPONSE_TOOL_OUTPUT_TYPES : RESPONSE_TOOL_CALL_TYPES;
  if (!supportedTypes.has(typeof item.type === 'string' ? item.type : '')) return null;
  return typeof item.call_id === 'string' && item.call_id.length > 0 ? item.call_id : null;
}

/**
 * Repair repeated Responses call IDs without changing valid histories. Calls and outputs are
 * paired by their order in `input`. When one call has several outputs (e.g. exec notify),
 * combine their contents in wire order rather than guessing which one is the final result.
 * Reused call IDs keep their ordered pairing. This is activated after a provider rejects the
 * history, then reused for subsequent requests in that thread.
 */
export function normalizeRepeatedResponseToolCallIds(
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  const input = body.input;
  const callsById = new Map<string, number[]>();
  const outputsById = new Map<string, number[]>();
  for (let index = 0; index < input.length; index += 1) {
    const callId = responseToolCallId(input[index], false);
    if (callId) callsById.set(callId, [...(callsById.get(callId) ?? []), index]);
    const outputId = responseToolCallId(input[index], true);
    if (outputId) outputsById.set(outputId, [...(outputsById.get(outputId) ?? []), index]);
  }

  const occupiedIds = new Set([...callsById.keys(), ...outputsById.keys()]);
  const callIdByIndex = new Map<number, string>();
  const outputIdByIndex = new Map<number, string>();
  const removedOutputs = new Set<number>();
  const mergedOutputByIndex = new Map<number, string | unknown[]>();

  for (const [callId, callIndexes] of callsById) {
    const outputIndexes = outputsById.get(callId) ?? [];
    if (callIndexes.length < 2 && outputIndexes.length < 2) continue;

    if (callIndexes.length === 1 && outputIndexes.length > 1) {
      const callIndex = callIndexes[0]!;
      const call = input[callIndex] as Record<string, unknown>;
      const expectedType = call.type === 'function_call' ? 'function_call_output' : 'custom_tool_call_output';
      const outputs = outputIndexes.map(index => input[index] as Record<string, unknown>);
      // Only merge a proven single exchange. Malformed or pre-call results must
      // not be silently discarded or attached to another invocation.
      if (outputIndexes.some(index => index <= callIndex) || outputs.some(item =>
        item.type !== expectedType || (typeof item.output !== 'string' && !Array.isArray(item.output)),
      )) return null;
      const contents = outputs.map(item => item.output as string | unknown[]);
      mergedOutputByIndex.set(outputIndexes[0]!, contents.every(output => typeof output === 'string')
        ? contents.join('\n\n')
        : contents.flatMap(output => typeof output === 'string' ? [{ type: 'input_text', text: output }] : output));
    }

    const uniqueIds = callIndexes.map((_, occurrence) => {
      if (occurrence === 0) return callId;
      let suffix = occurrence + 1;
      let candidate = `${callId}__cindy_dup_${suffix}`;
      while (occupiedIds.has(candidate)) {
        suffix += 1;
        candidate = `${callId}__cindy_dup_${suffix}`;
      }
      occupiedIds.add(candidate);
      return candidate;
    });

    let outputCursor = 0;
    for (let occurrence = 0; occurrence < callIndexes.length; occurrence += 1) {
      const callIndex = callIndexes[occurrence]!;
      while (outputCursor < outputIndexes.length && outputIndexes[outputCursor]! <= callIndex) {
        outputCursor += 1;
      }
      const outputIndex = outputIndexes[outputCursor];
      callIdByIndex.set(callIndex, uniqueIds[occurrence]!);
      if (outputIndex !== undefined) {
        outputIdByIndex.set(outputIndex, uniqueIds[occurrence]!);
        outputCursor += 1;
      }
    }

    for (const outputIndex of outputIndexes) {
      if (!outputIdByIndex.has(outputIndex)) removedOutputs.add(outputIndex);
    }
  }

  if (callIdByIndex.size === 0 && removedOutputs.size === 0) return null;
  const nextInput = input.flatMap((item, index) => {
    if (removedOutputs.has(index)) return [];
    const callId = callIdByIndex.get(index);
    if (callId !== undefined) return [{ ...(item as Record<string, unknown>), call_id: callId }];
    const outputId = outputIdByIndex.get(index);
    if (outputId !== undefined) return [{
      ...(item as Record<string, unknown>), call_id: outputId,
      ...(mergedOutputByIndex.has(index) ? { output: mergedOutputByIndex.get(index) } : {}),
    }];
    return [item];
  });
  return { ...body, input: nextInput };
}

export function normalizeRepeatedResponseToolCallIdsFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const normalized = normalizeRepeatedResponseToolCallIds(parsed);
  return normalized ? Buffer.from(JSON.stringify(normalized), 'utf8') : null;
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
