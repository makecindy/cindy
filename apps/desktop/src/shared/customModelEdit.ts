import {
  providerBaseUrlForApi,
  providerWireProtocolForApi,
  type AgentKind,
  type CustomProviderConfig,
  type PiModelApi,
} from '@cindy/model-providers';

/** One per-model edit from the model panel of a custom provider. */
export type CustomModelEdit =
  | {
      kind: 'interface';
      /** `auto`, a catalog interface profile id, or an explicit API. */
      api: string;
      /** The value names a catalog interface profile (or `auto`) rather than an API. */
      profile: boolean;
    }
  | { kind: 'capability'; media: 'image' | 'video'; value: 'default' | 'generate' | 'edit' };

/**
 * Applies the edit to a saved custom provider config in place. Returns false when the
 * runtime or model is gone or the API is unknown, so the caller saves nothing.
 */
export function applyCustomModelEdit(
  config: CustomProviderConfig,
  agent: AgentKind,
  modelId: string,
  edit: CustomModelEdit,
): boolean {
  const runtime = config.runtimes[agent];
  const model = runtime?.models.find((item) => item.id === modelId);
  if (!runtime || !model) return false;
  if (edit.kind === 'capability') {
    if (edit.value === 'default') {
      delete model.mode;
      delete model.modalities;
    } else {
      model.mode = edit.media === 'image' ? 'image_generation' : 'video_generation';
      model.modalities = {
        input: edit.value === 'edit' ? ['text', 'image'] : ['text'],
        output: [edit.media],
      };
    }
    return true;
  }
  if (edit.api === 'auto' || edit.profile) {
    model.interfaceId = edit.api;
    delete model.api;
    delete model.piApi;
    delete model.route;
    return true;
  }
  const wire = providerWireProtocolForApi(edit.api);
  if (!wire) return false;
  delete model.interfaceId;
  model.api = edit.api as PiModelApi;
  if (agent === 'pi') model.piApi = edit.api as PiModelApi;
  // Pi gets the selected API from api/piApi. A same-endpoint generated route
  // would look explicit after refresh and block a later Messages /v1 fix.
  // Keep existing routes and endpoints that change for the selected API.
  const inheritPiEndpoint = agent === 'pi' && !model.route && !runtime.requestPath &&
    (runtime.wireProtocol === 'openai-chat' || runtime.wireProtocol === 'openai-responses' ||
      runtime.wireProtocol === 'anthropic-messages' || runtime.wireProtocol === 'google-generative-ai') &&
    (edit.api === 'anthropic-messages' ||
      ((edit.api === 'openai-completions' || edit.api === 'openai-responses' || edit.api === 'google-generative-ai') &&
        providerBaseUrlForApi(runtime.baseUrl, edit.api) === runtime.baseUrl));
  if (!inheritPiEndpoint) {
    model.route = {
      baseUrl: providerBaseUrlForApi(model.route?.baseUrl ?? runtime.baseUrl, edit.api),
      wireProtocol: wire,
    };
  }
  return true;
}
