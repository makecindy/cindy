import type { PiModelApi } from '@cindy/model-providers';
import type { PiNativeModelSpec } from '@cindy/maker-core';
import { resolveProbedPiGatewayModel, isPiGatewayModelApi } from './piNativeProviders.js';
import { resolveBundledPiGatewayModelProfile, pruneAnthropicCompatForGateway } from '@cindy/model-providers/model-plane/pi-gateway-model-catalog';

export function createPiGatewayModelResolver(host: {
  resolveXdPiGatewayHintApi(modelId: string): PiModelApi | null | undefined;
  resolveXdPiGatewayServerApi(modelId: string): PiModelApi | null | undefined;
}) {
  const {resolveXdPiGatewayHintApi, resolveXdPiGatewayServerApi} = host;
function resolvePiCindyGatewayModelApi(
  _selectedProviderId: string | null | undefined,
  modelId: string,
  context?: { remote: boolean; runtimeBinaryPath?: string },
): PiModelApi | null | undefined {
  // Gateway membership remains the account-availability gate, but its protocol is the last hint.
  const gatewayApi = resolveXdPiGatewayHintApi(modelId);
  if (gatewayApi === undefined) return undefined;
  const serverApi = resolveXdPiGatewayServerApi(modelId);
  if (serverApi !== undefined) return serverApi;
  // The Desktop binary is not evidence about a different Pi executable on an SSH host. Remote
  // sessions skip that probe but still use this client version's explicit static configuration
  // before the last-priority Gateway hint.
  if (context?.remote) return resolveBundledPiGatewayModelProfile(modelId)?.api ?? gatewayApi;
  const probed = resolveProbedPiGatewayModel(modelId, context?.runtimeBinaryPath);
  if (probed) return isPiGatewayModelApi(probed.api) ? probed.api : null;
  return resolveBundledPiGatewayModelProfile(modelId)?.api ?? gatewayApi;
}

function resolvePiCindyGatewayModelSpec(
  _selectedProviderId: string | null | undefined,
  modelId: string,
  context?: { remote: boolean; runtimeBinaryPath?: string },
): Pick<
  PiNativeModelSpec,
  'api' | 'compat' | 'samplingParams' | 'thinkingLevelMap'
> | null | undefined {
  const api = resolvePiCindyGatewayModelApi(_selectedProviderId, modelId, context);
  if (api === undefined || api === null) return api;
  const bundled = resolveBundledPiGatewayModelProfile(modelId);
  const probed = context?.remote
    ? undefined
    : resolveProbedPiGatewayModel(modelId, context?.runtimeBinaryPath);
  const compatibleBundled = bundled?.api === api ? bundled : undefined;
  const compatibleProbed = probed?.api === api ? probed : undefined;
  let compat = compatibleProbed?.compat ?? compatibleBundled?.compat;
  if (api === 'anthropic-messages') compat = pruneAnthropicCompatForGateway(compat);
  // Gateway routing needs Pi's native session identity on every Chat/Messages request.
  // This is a Gateway transport policy, not a change to direct BYOM/subscription providers.
  if (api === 'openai-completions' || api === 'anthropic-messages') {
    compat = { ...compat, sendSessionAffinityHeaders: true };
  }
  // Remote execution never receives metadata from the Desktop binary probe. The version-matched
  // static client profile remains the second authority and is injected only when its API matches.
  if (context?.remote) {
    return {
      api,
      ...(compat ? { compat: structuredClone(compat) } : {}),
      ...(bundled?.api === api && bundled.samplingParams
        ? { samplingParams: structuredClone(bundled.samplingParams) }
        : {}),
      ...(bundled?.api === api && bundled.thinkingLevelMap
        ? { thinkingLevelMap: { ...bundled.thinkingLevelMap } }
        : {}),
    };
  }
  // Provider quirks are API-specific. Local metadata may fill omissions only when it agrees with
  // the final API; never apply stale compat across a protocol change. The exact current binary
  // probe takes precedence over the checked-in snapshot when both match that API.
  return {
    api,
    ...(compat ? { compat: structuredClone(compat) } : {}),
    ...(compatibleProbed?.samplingParams ?? compatibleBundled?.samplingParams
      ? {
          samplingParams: structuredClone(
            compatibleProbed?.samplingParams ?? compatibleBundled?.samplingParams,
          ),
        }
      : {}),
    ...(compatibleProbed?.thinkingLevelMap ?? compatibleBundled?.thinkingLevelMap
      ? {
          thinkingLevelMap: {
            ...(compatibleProbed?.thinkingLevelMap ?? compatibleBundled?.thinkingLevelMap),
          },
        }
      : {}),
  };
}


return {resolvePiCindyGatewayModelApi, resolvePiCindyGatewayModelSpec};
}
