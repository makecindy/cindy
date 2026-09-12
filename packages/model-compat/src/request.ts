import { mapReasoningEffort, REASONING_EFFORT_OMIT_SENTINEL } from './upstream/reasoning-effort';
import type { OcxProviderConfig } from './upstream/types/provider';
import { backfillWebSearchQueries, normalizeResponsesToolResultAdjacency, annotateEmptyResponsesToolOutputs } from './upstream/adapters/openai-responses';
import { stripBracketedModelSuffix, reasoningDetailSegmentForWire, thinkingBudgetForEffort, normalizeMoonshotToolParameters, isMoonshotSchemaTarget } from './upstream/adapters/openai-chat';
import { isPlainObject } from './object';
import { resolveProviderCompatibilityProfile, profileModelListed, profileModelValue, type CompatibilityRoute } from './profiles';
import { normalizeXaiResponsesWebSearch } from './upstream/adapters/xai-web-search';
import { isXaiSchemaTarget, normalizeXaiToolParameters } from './upstream/adapters/xai-tool-schema';
import { stripResponsesOnlyEncryptedMarker } from './upstream/adapters/responses-tool-schema';
import { normalizeOpenCodeGoAdditionalTools } from './upstream/adapters/opencode-go-additional-tools';

/** Provider parameter policy shared by all harnesses, after protocol translation.
 * A harness's private tool dialect is handled separately in the request-owned Responses adapter.
 */
export function normalizeProviderRequest(body: unknown, route: CompatibilityRoute, options: { reasoningEffortAlreadyMapped?: boolean } = {}): unknown {
  if (!isPlainObject(body)) return body;
  const profile = resolveProviderCompatibilityProfile(route);
  let next = body;
  const set = (key: string, value: unknown) => {
    if (next[key] === value) return;
    if (next === body) next = { ...body };
    if (value === undefined) delete next[key]; else next[key] = value;
  };
  if (route.protocol === 'openai-chat' && isMoonshotSchemaTarget({ baseUrl: route.upstreamBase } as OcxProviderConfig) && Array.isArray(next.tools)) {
    const tools = next.tools.map(tool => {
      if (!isPlainObject(tool) || tool.type !== 'function' || !isPlainObject(tool.function)) return tool;
      return { ...tool, function: { ...tool.function, parameters: normalizeMoonshotToolParameters(tool.function.parameters) } };
    });
    set('tools', tools);
  }
  if (profile) {
    if (profileModelListed(profile.noTemperatureModels, route.model)) set('temperature', undefined);
    if (profileModelListed(profile.noTopPModels, route.model)) set('top_p', undefined);
    if (profileModelListed(profile.noPenaltyModels, route.model)) {
      set('frequency_penalty', undefined); set('presence_penalty', undefined);
    }
    const noReasoning = profileModelListed(profile.noReasoningModels, route.model);
    if (route.protocol === 'openai-responses') {
      const history = backfillWebSearchQueries(next);
      if (isPlainObject(history)) next = history;
      if (profile.requiresAdjacentResponsesToolResults === true) {
        const adjacent = normalizeResponsesToolResultAdjacency(next);
        if (isPlainObject(adjacent)) next = adjacent;
      }
      if (profile.annotateEmptyToolOutputs === true) {
        const annotated = annotateEmptyResponsesToolOutputs(next, true);
        if (isPlainObject(annotated)) next = annotated;
      }

      if (noReasoning) set('reasoning', undefined);
      if (isPlainObject(next.reasoning)) {
        const reasoning = { ...next.reasoning };
        if (profileModelValue(profile.modelSupportsReasoningSummaries, route.model) === false) delete reasoning.summary;
        const wire = profileModelValue(profile.modelWireDefaults, route.model);
        if ((profile.adapter === 'openai-responses' || (isPlainObject(wire) && wire.wire === 'openai-responses')) && typeof reasoning.effort === 'string') {
          const mapped = mapReasoningEffort(profile as unknown as OcxProviderConfig, route.model, reasoning.effort);
          if (mapped !== undefined) reasoning.effort = mapped;
        }
        if (JSON.stringify(reasoning) !== JSON.stringify(next.reasoning)) set('reasoning', Object.keys(reasoning).length ? reasoning : undefined);
      }
      if (profile.statelessResponses === true) {
        set('store', false);
        // A continuation id without expanded history cannot be silently discarded.
        if (typeof next.previous_response_id === 'string') throw new Error('stateless provider requires expanded Responses continuation history');
      }
      const verbosity = profileModelValue(profile.modelSupportsVerbosity, route.model) ?? profile.supportsVerbosity;
      if (verbosity === false && isPlainObject(next.text) && Object.hasOwn(next.text, 'verbosity')) {
        const text = { ...next.text }; delete text.verbosity; set('text', Object.keys(text).length ? text : undefined);
      }
    } else if (route.protocol === 'openai-chat') {
      if (profile.modelSuffixBracketStrip === true && typeof next.model === 'string') set('model', stripBracketedModelSuffix(next.model));
      if (profileModelListed(profile.reasoningSplitModels, route.model)) set('reasoning_split', true);
      if (noReasoning) set('reasoning_effort', undefined);
      const originalEffort = typeof next.reasoning_effort === 'string' ? next.reasoning_effort : undefined;
      const omitWithTools = Array.isArray(next.tools) && next.tools.length > 0 && profileModelListed(profile.omitReasoningEffortWithToolsModels, route.model);
      const wireMap = profileModelValue(profile.modelReasoningEffortMap, route.model) ?? profile.reasoningEffortMap;
      const mapped = mapReasoningEffort(profile as unknown as OcxProviderConfig, route.model, originalEffort);
      const explicitOmission = originalEffort !== undefined && isPlainObject(wireMap)
        && wireMap[originalEffort === 'ultra' ? 'max' : originalEffort] === REASONING_EFFORT_OMIT_SENTINEL;
      const effort = omitWithTools ? undefined : options.reasoningEffortAlreadyMapped ? originalEffort
        : explicitOmission ? undefined : mapped ?? originalEffort;
      if (effort === undefined && originalEffort !== undefined) set('reasoning_effort', undefined);
      if (!noReasoning && !omitWithTools && originalEffort === 'none' && profile.reasoningWireFormat === 'gateway-object') {
        set('reasoning', { enabled: false });
      } else if (effort !== undefined) {
        if (profile.reasoningWireFormat === 'gateway-object') {
          set('reasoning', effort === 'none' ? { enabled: false } : { enabled: true, effort });
          set('reasoning_effort', undefined);
        } else if (profileModelListed(profile.thinkingBudgetModels, route.model)) {
          const budget = thinkingBudgetForEffort({ options: { reasoning: originalEffort } }, effort, typeof next.max_tokens === 'number' ? next.max_tokens : undefined);
          if (budget !== undefined) { set('thinking_budget', budget); set('reasoning_effort', undefined); }
        } else if (profileModelListed(profile.thinkingToggleModels, route.model)) {
          if (['enabled', 'disabled', 'adaptive'].includes(effort)) { set('thinking', { type: effort }); set('reasoning_effort', undefined); }
        } else set('reasoning_effort', effort);
      }
      if (profileModelListed(profile.reasoningDetailsModels, route.model) && Array.isArray(next.messages)) {
        const messages = next.messages.map(message => {
          if (!isPlainObject(message) || message.role !== 'assistant' || typeof message.reasoning_content !== 'string' || message.reasoning_details !== undefined) return message;
          const result: Record<string, unknown> = { ...message, reasoning_details: [reasoningDetailSegmentForWire(message.reasoning_content)] };
          delete result.reasoning_content;
          return result;
        });
        if (messages.some((message, index) => message !== (next.messages as unknown[])[index])) set('messages', messages);
      }
    }
  }
  if (route.protocol !== 'openai-responses') return next;
  const normalized = normalizeXaiResponsesWebSearch(next, { baseUrl: route.upstreamBase });
  if (isPlainObject(normalized)) next = normalized;
  const promoted = normalizeOpenCodeGoAdditionalTools(next, route.upstreamBase.replace(/\/+$/, '') + '/responses');
  if (isPlainObject(promoted)) next = promoted;
  if (isXaiSchemaTarget({ baseUrl: route.upstreamBase })) {
    const rewriteTools = (tools: unknown[]): unknown[] => tools.map(tool => {
      if (!isPlainObject(tool) || tool.type !== 'function' || !Object.hasOwn(tool, 'parameters')) return tool;
      const parameters = normalizeXaiToolParameters(stripResponsesOnlyEncryptedMarker(tool.parameters));
      if (parameters === undefined) throw new Error('xAI subscription cannot represent this function tool schema');
      return { ...tool, parameters };
    });
    if (Array.isArray(next.tools)) next = { ...next, tools: rewriteTools(next.tools) };
    if (Array.isArray(next.input)) next = { ...next, input: next.input.map(item =>
      isPlainObject(item) && item.type === 'additional_tools' && Array.isArray(item.tools)
        ? { ...item, tools: rewriteTools(item.tools) } : item) };
  }
  return next;
}
