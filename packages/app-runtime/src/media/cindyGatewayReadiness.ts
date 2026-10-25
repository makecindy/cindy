export function createCindyGatewayReadiness(host:{getAppCapabilities():{canUseCindyGateway:boolean};effectiveXdGatewayBaseUrl():string}) {
const {getAppCapabilities,effectiveXdGatewayBaseUrl}=host;
function isXdGatewayProviderReady(providerId: string): boolean {
  if (providerId !== 'xd') return true;
  return getAppCapabilities().canUseCindyGateway && effectiveXdGatewayBaseUrl().trim() !== '';
}

return {isXdGatewayProviderReady};
}
