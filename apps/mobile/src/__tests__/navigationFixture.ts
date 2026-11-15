import { isActionHandled } from 'expo-router/build/react-navigation/routers/utils';
import { StackRouter, type StackNavigationState } from 'expo-router/build/react-navigation/routers/StackRouter';
import type { NavigationAction, RouterConfigOptions, ParamListBase } from 'expo-router/build/react-navigation/routers/types';
type NavigationState = StackNavigationState<ParamListBase>;

/** SDK 58 reducers consume complete states and return { state, affectedRouteKey }. */
export function stackState(config: RouterConfigOptions & { routeParamList?: Record<string, object | undefined> }, initialName = config.routeNames[0]): NavigationState {
  return { key: 'test-stack', routeKeySeq: 1, type: 'stack', stale: false, index: 0,
    routeNames: config.routeNames,
    routes: [{ key: `${initialName}:0`, name: initialName, params: config.routeParamList?.[initialName] }] };
}
export function reduceStack(stack: ReturnType<typeof StackRouter>, state: NavigationState,
  action: NavigationAction, config: RouterConfigOptions): NavigationState {
  const result = stack.getStateForAction(state, action as never, config);
  if (!isActionHandled(result)) throw new Error(`Unhandled test navigation: ${action.type}`);
  return result.state;
}
