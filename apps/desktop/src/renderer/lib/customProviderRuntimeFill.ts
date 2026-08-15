import type {
  AgentKind,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';
import { savedCustomProviderModelShape } from '@/../shared/piRuntimeInitialization';

export type RuntimeFillAgent = Extract<AgentKind, 'claude-code' | 'codex' | 'pi'>;
export interface RuntimeFillHeaderRow {
  name: string;
  value: string;
}
export interface RuntimeFillDraft {
  baseUrl: string;
  requestPath: string;
  apiKey: string;
  wireProtocol: ProviderWireProtocol;
  models: ProviderRuntimeModelConfig[];
  headers: RuntimeFillHeaderRow[];
  modelsUrl: string;
  /** Non-secret metadata for headers held in main-only storage. */
  headersState?: 'configured' | 'unknown';
}
export type RuntimeFillField =
  'baseUrl' | 'requestPath' | 'wireProtocol' | 'apiKey' | 'models' | 'headers' | 'modelsUrl';
export type RuntimeFillTargetState = 'empty' | 'same' | 'conflict' | 'incompatible';
export type RuntimeFillIncompatibilityReason = 'protocol' | 'endpoint' | 'headers';
export interface RuntimeFillFieldDiff {
  field: RuntimeFillField;
  targetState: RuntimeFillTargetState;
  incompatibilityReason?: RuntimeFillIncompatibilityReason;
  /** This field must be cleared together with the endpoint bundle. */
  implicitClear?: boolean;
}

export const RUNTIME_FILL_ENDPOINT_FIELDS = [
  'baseUrl',
  'requestPath',
  'wireProtocol',
] as const satisfies readonly RuntimeFillField[];

export const RUNTIME_FILL_FIELD_ORDER: readonly RuntimeFillField[] = [
  ...RUNTIME_FILL_ENDPOINT_FIELDS,
  'apiKey',
  'models',
  'headers',
  'modelsUrl',
];

const PROTOCOL_BOUND_FIELDS = new Set<RuntimeFillField>([
  ...RUNTIME_FILL_ENDPOINT_FIELDS,
  'headers',
  'modelsUrl',
]);

const HEADER_DEPENDENT_FIELDS = new Set<RuntimeFillField>([
  ...RUNTIME_FILL_ENDPOINT_FIELDS,
  'headers',
  'modelsUrl',
]);

const RUNTIME_FILL_AGENTS: readonly RuntimeFillAgent[] = ['claude-code', 'codex', 'pi'];

export function runtimeFillTargetAgents(
  source: RuntimeFillAgent,
  options: { includePi: boolean },
): RuntimeFillAgent[] {
  return RUNTIME_FILL_AGENTS.filter(
    (agent) => agent !== source && (options.includePi || agent !== 'pi'),
  );
}

function defaultWire(agent: RuntimeFillAgent): ProviderWireProtocol {
  return agent === 'claude-code'
    ? 'anthropic-messages'
    : agent === 'codex'
      ? 'openai-responses'
      : 'openai-chat';
}

function effectiveWire(agent: RuntimeFillAgent, value: ProviderWireProtocol | undefined) {
  return value ?? defaultWire(agent);
}

function protocolSupported(agent: RuntimeFillAgent, wire: ProviderWireProtocol) {
  return agent !== 'claude-code' || wire === 'anthropic-messages';
}

/** Pi's native provider config does not consume the shared route-only request path. */
function fieldSupported(
  agent: RuntimeFillAgent,
  field: RuntimeFillField,
  wire: ProviderWireProtocol,
) {
  if (agent === 'pi' && field === 'requestPath') return false;
  return !PROTOCOL_BOUND_FIELDS.has(field) || protocolSupported(agent, wire);
}

function transferFieldSupported(
  source: RuntimeFillDraft,
  sourceAgent: RuntimeFillAgent,
  targetAgent: RuntimeFillAgent,
  field: RuntimeFillField,
  wire: ProviderWireProtocol,
): boolean {
  // A path-free Pi source can intentionally clear a legacy/custom path on a route-aware target
  // while moving the rest of the inference endpoint. Pi itself still cannot receive a path.
  if (field === 'requestPath') {
    return targetAgent !== 'pi' &&
      (sourceAgent !== 'pi' || source.requestPath.trim().length === 0) &&
      protocolSupported(sourceAgent, wire) &&
      protocolSupported(targetAgent, wire);
  }
  return fieldSupported(sourceAgent, field, wire) && fieldSupported(targetAgent, field, wire);
}

/** Pi cannot express a custom inference request path, so this endpoint cannot be copied partly. */
function endpointBundleSupported(
  source: RuntimeFillDraft,
  sourceAgent: RuntimeFillAgent,
  targetAgent: RuntimeFillAgent,
): boolean {
  return source.requestPath.trim().length === 0 || (sourceAgent !== 'pi' && targetAgent !== 'pi');
}

function validModels(models: ProviderRuntimeModelConfig[]) {
  return models
    .filter((model) => model.id.trim() && model.name.trim())
    .map((model) => savedCustomProviderModelShape(model, true));
}

function canonicalHeaders(headers: RuntimeFillHeaderRow[]) {
  const byName = new Map<string, string>();
  for (const header of headers) {
    const name = header.name.trim();
    if (!name) continue;
    // Save semantics are object assignment: the last value for a duplicate name wins.
    if (byName.has(name)) byName.delete(name);
    byName.set(name, header.value.trim());
  }
  return [...byName].map(([name, value]) => ({ name, value }));
}

/**
 * Project source models into the exact shape that the target runtime will save.
 * Pi-only capability metadata belongs to the Pi runtime, so portable fills preserve
 * it for matching target model ids instead of silently deleting it.
 */
function modelsForTarget(
  sourceModels: ProviderRuntimeModelConfig[],
  targetModels: ProviderRuntimeModelConfig[],
  sourceAgent: RuntimeFillAgent,
  targetAgent: RuntimeFillAgent,
) {
  const targetById = new Map(validModels(targetModels).map((model) => [model.id, model]));
  return validModels(sourceModels).map((sourceModel) => {
    if (targetAgent !== 'pi') return savedCustomProviderModelShape(sourceModel, false);
    if (sourceAgent === 'pi') return savedCustomProviderModelShape(sourceModel, true);

    const portable = savedCustomProviderModelShape(sourceModel, false);
    const existing = targetById.get(portable.id);
    return {
      ...portable,
      ...(existing?.supportsImageInput === true ? { supportsImageInput: true } : {}),
      ...(existing?.reasoning === true && existing.reasoningEfforts?.length
        ? { reasoning: true, reasoningEfforts: [...existing.reasoningEfforts] }
        : {}),
    };
  });
}

function comparableValue(
  field: RuntimeFillField,
  draft: RuntimeFillDraft,
  agent: RuntimeFillAgent,
): unknown {
  switch (field) {
    case 'baseUrl':
      return draft.baseUrl.trim();
    case 'requestPath':
      return draft.requestPath.trim();
    case 'wireProtocol':
      return effectiveWire(agent, draft.wireProtocol);
    case 'apiKey':
      return draft.apiKey.trim();
    case 'models':
      return validModels(draft.models);
    case 'headers':
      return canonicalHeaders(draft.headers).sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.value.localeCompare(right.value),
      );
    case 'modelsUrl':
      return draft.modelsUrl.trim();
  }
}

function sourceFieldHasValue(
  field: RuntimeFillField,
  draft: RuntimeFillDraft,
  agent: RuntimeFillAgent,
) {
  if (field === 'wireProtocol') return draft.baseUrl.trim().length > 0;
  if (field === 'requestPath') return draft.baseUrl.trim().length > 0;
  const value = comparableValue(field, draft, agent);
  return Array.isArray(value) ? value.length > 0 : value !== '';
}

function targetFieldHasValue(
  field: RuntimeFillField,
  draft: RuntimeFillDraft,
  agent: RuntimeFillAgent,
) {
  return field === 'headers'
    ? sourceFieldHasValue(field, draft, agent) || runtimeHeaderState(draft) != null
    : sourceFieldHasValue(field, draft, agent);
}

function runtimeHeaderState(draft: RuntimeFillDraft): 'configured' | 'unknown' | undefined {
  return draft.headersState;
}

function endpointUrlChanged(source: RuntimeFillDraft, target: RuntimeFillDraft): boolean {
  const sourceBaseUrl = source.baseUrl.trim();
  const sourceModelsUrl = source.modelsUrl.trim();
  const targetModelsUrl = target.modelsUrl.trim();
  return (
    (sourceBaseUrl.length > 0 && sourceBaseUrl !== target.baseUrl.trim()) ||
    (sourceModelsUrl !== targetModelsUrl &&
      (sourceModelsUrl.length > 0 || (sourceBaseUrl.length > 0 && targetModelsUrl.length > 0)))
  );
}

export function runtimeFillFieldHasValue(
  field: RuntimeFillField,
  draft: RuntimeFillDraft,
  agent: RuntimeFillAgent = 'claude-code',
): boolean {
  return sourceFieldHasValue(field, draft, agent);
}

export function runtimeFillModelCount(draft: RuntimeFillDraft): number {
  return validModels(draft.models).length;
}

export function runtimeFillHeaderCount(draft: RuntimeFillDraft): number {
  return canonicalHeaders(draft.headers).length;
}

export function runtimeFillEndpointUrlsChanged(
  previous: RuntimeFillDraft,
  next: RuntimeFillDraft,
): boolean {
  return (
    previous.baseUrl.trim() !== next.baseUrl.trim() ||
    previous.modelsUrl.trim() !== next.modelsUrl.trim()
  );
}

export function cloneRuntimeFillDraft(draft: RuntimeFillDraft): RuntimeFillDraft {
  return {
    ...draft,
    models: draft.models.map((model) => ({
      ...model,
      ...(model.reasoningEfforts ? { reasoningEfforts: [...model.reasoningEfforts] } : {}),
    })),
    headers: draft.headers.map((header) => ({ ...header })),
  };
}

export function mergeHydratedRuntimeKeys<T extends RuntimeFillDraft>(
  drafts: Record<RuntimeFillAgent, T>,
  fetched: Partial<Record<RuntimeFillAgent, string>>,
  savedTargets: Partial<
    Record<RuntimeFillAgent, Pick<RuntimeFillDraft, 'baseUrl' | 'modelsUrl'>>
  >,
  revisionAtStart: Record<RuntimeFillAgent, number>,
  currentRevision: Record<RuntimeFillAgent, number>,
): Record<RuntimeFillAgent, T> {
  const next = { ...drafts };
  for (const agent of RUNTIME_FILL_AGENTS) {
    const apiKey = fetched[agent];
    const savedTarget = savedTargets[agent];
    if (
      apiKey == null ||
      !savedTarget ||
      currentRevision[agent] !== revisionAtStart[agent] ||
      drafts[agent].baseUrl.trim() !== savedTarget.baseUrl.trim() ||
      drafts[agent].modelsUrl.trim() !== savedTarget.modelsUrl.trim()
    ) {
      continue;
    }
    next[agent] = { ...drafts[agent], apiKey };
  }
  return next;
}

export function buildRuntimeFillDiffs(
  source: RuntimeFillDraft,
  target: RuntimeFillDraft,
  options: { includeApiKey: boolean; sourceAgent: RuntimeFillAgent; targetAgent: RuntimeFillAgent },
): RuntimeFillFieldDiff[] {
  const wire = effectiveWire(options.sourceAgent, source.wireProtocol);
  const endpointSupported = endpointBundleSupported(
    source,
    options.sourceAgent,
    options.targetAgent,
  );
  const sourceHasHiddenHeaders =
    runtimeHeaderState(source) != null &&
    !sourceFieldHasValue('headers', source, options.sourceAgent);
  const targetHeadersUnknown = runtimeHeaderState(target) === 'unknown';
  const targetHasHeaders = targetFieldHasValue('headers', target, options.targetAgent);
  const endpointChangesUrl = endpointUrlChanged(source, target);
  const implicitHeaderClear = endpointChangesUrl && targetHasHeaders;
  const implicitModelsUrlClear =
    source.baseUrl.trim().length > 0 &&
    source.modelsUrl.trim().length === 0 &&
    target.modelsUrl.trim().length > 0;
  // A modelsUrl replacement is an endpoint move too. Keep it in the same
  // inseparable selection as the inference endpoint whenever applying it can
  // make Main discard endpoint-bound credentials/headers.
  const modelsUrlEndpointChange =
    source.modelsUrl.trim() !== target.modelsUrl.trim() && endpointChangesUrl;
  const implicitApiKeyClear =
    endpointChangesUrl &&
    target.apiKey.trim().length > 0 &&
    true;

  return RUNTIME_FILL_FIELD_ORDER.filter((field) => {
    if (!options.includeApiKey && field === 'apiKey' && !implicitApiKeyClear) return false;
    if (field === 'headers') {
      return sourceFieldHasValue(field, source, options.sourceAgent) ||
        sourceHasHiddenHeaders ||
        implicitHeaderClear;
    }
    if (field === 'modelsUrl') {
      return sourceFieldHasValue(field, source, options.sourceAgent) || implicitModelsUrlClear;
    }
    if (field === 'apiKey') {
      return sourceFieldHasValue(field, source, options.sourceAgent) || implicitApiKeyClear;
    }
    return sourceFieldHasValue(field, source, options.sourceAgent);
  }).map((field) => {
    if (sourceHasHiddenHeaders && HEADER_DEPENDENT_FIELDS.has(field)) {
      return {
        field,
        targetState: 'incompatible',
        incompatibilityReason: 'headers',
      };
    }
    if (
      targetHeadersUnknown &&
      endpointChangesUrl &&
      (HEADER_DEPENDENT_FIELDS.has(field) || field === 'apiKey')
    ) {
      return {
        field,
        targetState: 'incompatible',
        incompatibilityReason: 'headers',
      };
    }
    if (
      (RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).includes(field) &&
      !endpointSupported
    ) {
      return { field, targetState: 'incompatible', incompatibilityReason: 'endpoint' };
    }
    // An API key is endpoint-bound. If the source endpoint cannot be transferred
    // (for example, because its main-only headers are unavailable to renderer or
    // because a Pi-incompatible request path makes the bundle unsafe), never let
    // the key fall through as an independently copyable field to another host.
    if (field === 'apiKey' && endpointChangesUrl &&
      (sourceHasHiddenHeaders || !endpointSupported)
    ) {
      return {
        field,
        targetState: 'incompatible',
        incompatibilityReason: sourceHasHiddenHeaders ? 'headers' : 'endpoint',
      };
    }
    if (!transferFieldSupported(source, options.sourceAgent, options.targetAgent, field, wire)) {
      return {
        field,
        targetState: 'incompatible',
        incompatibilityReason:
          field === 'requestPath' &&
          (options.sourceAgent === 'pi' || options.targetAgent === 'pi')
            ? 'endpoint'
            : 'protocol',
      };
    }

    const sourceValue =
      field === 'models'
        ? modelsForTarget(source.models, target.models, options.sourceAgent, options.targetAgent)
        : comparableValue(field, source, options.sourceAgent);
    const targetValue =
      field === 'models'
        ? modelsForTarget(target.models, target.models, options.targetAgent, options.targetAgent)
        : comparableValue(field, target, options.targetAgent);
    const same = JSON.stringify(sourceValue) === JSON.stringify(targetValue);
    const hiddenTargetHeadersOnly =
      field === 'headers' &&
      runtimeHeaderState(target) != null &&
      !sourceFieldHasValue('headers', source, options.sourceAgent);
    const shouldConfirmImplicitClear =
      (field === 'headers' && implicitHeaderClear) ||
      (field === 'modelsUrl' && (implicitModelsUrlClear || modelsUrlEndpointChange)) ||
      (field === 'apiKey' && implicitApiKeyClear);
    return {
      field,
      targetState: same && !hiddenTargetHeadersOnly
        ? 'same'
        : targetFieldHasValue(field, target, options.targetAgent)
          ? 'conflict'
          : 'empty',
      ...(shouldConfirmImplicitClear ? { implicitClear: true } : {}),
    };
  });
}

export function runtimeFillFieldsForToggle(
  field: RuntimeFillField,
  diffs: readonly RuntimeFillFieldDiff[],
): RuntimeFillField[] {
  const fieldDiff = diffs.find((diff) => diff.field === field);
  const compatibleEndpointFields = RUNTIME_FILL_ENDPOINT_FIELDS.filter((candidate) =>
    diffs.some(
      (diff) => diff.field === candidate && diff.targetState !== 'incompatible',
    ),
  );
  const compatibleImplicitFields = RUNTIME_FILL_FIELD_ORDER.filter((candidate) =>
    diffs.some(
      (diff) =>
        diff.field === candidate &&
        diff.targetState !== 'incompatible' &&
        diff.implicitClear === true,
    ),
  );
  const isEndpointField = (RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).includes(
    field,
  );
  if (isEndpointField && fieldDiff?.targetState === 'incompatible') return [];
  if (fieldDiff?.implicitClear === true && compatibleEndpointFields.length === 0) return [];
  if (isEndpointField || fieldDiff?.implicitClear === true) {
    return RUNTIME_FILL_FIELD_ORDER.filter(
      (candidate) =>
        compatibleEndpointFields.includes(candidate as (typeof RUNTIME_FILL_ENDPOINT_FIELDS)[number]) ||
        compatibleImplicitFields.includes(candidate),
    );
  }
  return [field];
}

export function normalizeRuntimeFillSelection(
  fields: readonly RuntimeFillField[],
  diffs: readonly RuntimeFillFieldDiff[],
): RuntimeFillField[] {
  const selected = new Set(fields);
  const selectedImplicitClear = diffs.find(
    (diff) => diff.implicitClear === true && selected.has(diff.field),
  );
  if (
    selectedImplicitClear ||
    (RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).some((field) =>
      selected.has(field),
    )
  ) {
    const bundle = runtimeFillFieldsForToggle(selectedImplicitClear?.field ?? 'baseUrl', diffs);
    if (selectedImplicitClear && bundle.length === 0) {
      selected.delete(selectedImplicitClear.field);
    }
    for (const field of bundle) {
      selected.add(field);
    }
  }
  return RUNTIME_FILL_FIELD_ORDER.filter(
    (field) =>
      selected.has(field) &&
      diffs.some(
        (diff) => diff.field === field && diff.targetState !== 'incompatible',
      ),
  );
}

export function runtimeFillHasUnreviewedConflict(
  previousDiffs: readonly RuntimeFillFieldDiff[],
  freshDiffs: readonly RuntimeFillFieldDiff[],
  selectedFields: readonly RuntimeFillField[],
): boolean {
  const selected = new Set(selectedFields);
  const previousState = new Map(previousDiffs.map((diff) => [diff.field, diff.targetState]));
  return freshDiffs.some(
    (diff) =>
      selected.has(diff.field) &&
      diff.targetState === 'conflict' &&
      previousState.get(diff.field) !== 'conflict',
  );
}

export function runtimeFillSelectedTargetChanged(
  previousTarget: RuntimeFillDraft,
  freshTarget: RuntimeFillDraft,
  selectedFields: readonly RuntimeFillField[],
  targetAgent: RuntimeFillAgent,
): boolean {
  return selectedFields.some(
    (field) =>
      JSON.stringify(comparableValue(field, previousTarget, targetAgent)) !==
      JSON.stringify(comparableValue(field, freshTarget, targetAgent)),
  );
}

export function applyRuntimeFillFields(
  target: RuntimeFillDraft,
  source: RuntimeFillDraft,
  fields: readonly RuntimeFillField[],
  options: { sourceAgent: RuntimeFillAgent; targetAgent: RuntimeFillAgent },
): RuntimeFillDraft {
  const selected = new Set(fields);
  const sourceWire = effectiveWire(options.sourceAgent, source.wireProtocol);
  const sourceHasHiddenHeaders =
    runtimeHeaderState(source) != null &&
    !sourceFieldHasValue('headers', source, options.sourceAgent);
  // Keep direct callers safe as well as the overlay: changing modelsUrl moves
  // the credential endpoint, so it must carry the endpoint bundle and any
  // target headers that Main would clear with that move.
  if (
    selected.has('modelsUrl') &&
    source.modelsUrl.trim() !== target.modelsUrl.trim() &&
    endpointUrlChanged(source, target)
  ) {
    for (const field of RUNTIME_FILL_ENDPOINT_FIELDS) selected.add(field);
    if (!sourceHasHiddenHeaders && targetFieldHasValue('headers', target, options.targetAgent)) {
      selected.add('headers');
    }
  }
  const endpointSelected = (RUNTIME_FILL_ENDPOINT_FIELDS as readonly RuntimeFillField[]).some(
    (field) => selected.has(field),
  );
  const endpointCompatible =
    protocolSupported(options.targetAgent, sourceWire) &&
    endpointBundleSupported(source, options.sourceAgent, options.targetAgent) &&
    !sourceHasHiddenHeaders &&
    !(runtimeHeaderState(target) === 'unknown' && endpointUrlChanged(source, target));
  const copyableEndpointFields = RUNTIME_FILL_ENDPOINT_FIELDS.filter(
    (field) =>
      transferFieldSupported(
        source,
        options.sourceAgent,
        options.targetAgent,
        field,
        sourceWire,
      ),
  );
  const copyEndpoint =
    endpointSelected &&
    endpointCompatible &&
    copyableEndpointFields.some((field) => selected.has(field));
  const copyBaseUrl = copyEndpoint && copyableEndpointFields.includes('baseUrl');
  const copyRequestPath = copyEndpoint && copyableEndpointFields.includes('requestPath');
  const copyWireProtocol = copyEndpoint && copyableEndpointFields.includes('wireProtocol');
  const copyApiKey = selected.has('apiKey') &&
    (!endpointUrlChanged(source, target) || endpointCompatible) &&
    (!endpointSelected || copyEndpoint);
  const clearTargetApiKeyWithEndpoint =
    copyEndpoint &&
    target.apiKey.trim().length > 0 &&
    !selected.has('apiKey');
  const models = selected.has('models')
    ? modelsForTarget(source.models, target.models, options.sourceAgent, options.targetAgent)
    : target.models;
  const copyHeaders =
    selected.has('headers') &&
    !sourceHasHiddenHeaders &&
    !(runtimeHeaderState(target) === 'unknown' && endpointUrlChanged(source, target)) &&
    fieldSupported(options.sourceAgent, 'headers', sourceWire) &&
    fieldSupported(options.targetAgent, 'headers', sourceWire);

  return {
    baseUrl: copyBaseUrl ? source.baseUrl : target.baseUrl,
    requestPath:
      options.targetAgent === 'pi'
        ? sourceHasHiddenHeaders
          ? target.requestPath
          : ''
        : copyRequestPath
          ? source.requestPath
          : target.requestPath,
    apiKey: copyApiKey
      ? source.apiKey
      : clearTargetApiKeyWithEndpoint
        ? ''
        : target.apiKey,
    wireProtocol: copyWireProtocol ? source.wireProtocol : target.wireProtocol,
    models,
    headers: copyHeaders ? canonicalHeaders(source.headers) : target.headers,
    headersState: copyHeaders ? undefined : target.headersState,
    modelsUrl:
      selected.has('modelsUrl') &&
      !sourceHasHiddenHeaders &&
      !(runtimeHeaderState(target) === 'unknown' && endpointUrlChanged(source, target)) &&
      fieldSupported(options.sourceAgent, 'modelsUrl', sourceWire) &&
      fieldSupported(options.targetAgent, 'modelsUrl', sourceWire)
        ? source.modelsUrl
        : target.modelsUrl,
  };
}
