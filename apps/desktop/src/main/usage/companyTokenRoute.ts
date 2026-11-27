import type { RoutingDescriptor } from '@cindy/model-providers';

/** Use the actual runtime route, including the endpoint assigned to this organization. */
export function directCompanyTokenRoute(
  provider: string,
  route: RoutingDescriptor | undefined,
  gatewayUrl: string,
) {
  if (
    provider === 'xd' ||
    !route ||
    route.disabled ||
    route.authStrategy === 'gateway-key' ||
    route.authStrategy === 'none'
  )
    return false;
  try {
    const endpoint = new URL(route.upstream);
    return (
      endpoint.protocol === 'https:' &&
      !endpoint.hostname.endsWith('.invalid') &&
      (!gatewayUrl || endpoint.origin !== new URL(gatewayUrl).origin)
    );
  } catch {
    return false;
  }
}
