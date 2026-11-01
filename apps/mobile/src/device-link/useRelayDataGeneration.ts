import { useRef, useSyncExternalStore } from 'react';
import { getSelfHostedRelayRouteGeneration, subscribeSelfHostedRelayRoute } from './selfHostedRelayRouting';

/** Local data lifecycle only: never substitute this for the auth owner's generation. */
export function useRelayDataGeneration(accountGeneration: number): number {
  const route = useSyncExternalStore(subscribeSelfHostedRelayRoute,
    getSelfHostedRelayRouteGeneration, getSelfHostedRelayRouteGeneration);
  const scope = useRef({ accountGeneration, route, generation: accountGeneration });
  if (scope.current.accountGeneration !== accountGeneration || scope.current.route !== route) {
    scope.current = { accountGeneration, route, generation: scope.current.generation + 1 };
  }
  return scope.current.generation;
}
