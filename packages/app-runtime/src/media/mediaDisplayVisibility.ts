import {isModelVisible,type Catalog,type AgentKind} from '@cindy/model-providers';
export function createMediaDisplayVisibility(host:{getActiveCatalog():Pick<Catalog,'providers'>;getModelVisibilityOverride(agent:AgentKind,providerId:string,modelId:string):Parameters<typeof isModelVisible>[0]}) {
const {getActiveCatalog,getModelVisibilityOverride}=host;
/** Settings display switch for image/video. Mirror-not-ready fails closed. */
function isCatalogMediaModelVisible(
  providerId: string,
  modelId: string,
  defaultEnabled?: boolean,
): boolean {
  try {
    const provider = getActiveCatalog().providers.find((item) => item.id === providerId);
    const agent = provider?.agents[0] ?? 'claude-code';
    return isModelVisible(
      getModelVisibilityOverride(agent, providerId, modelId),
      defaultEnabled,
    );
  } catch {
    return false;
  }
}

return {isCatalogMediaModelVisible};
}
