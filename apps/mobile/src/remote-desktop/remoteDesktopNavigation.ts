import type {
  NavigationState,
  PartialState,
} from "expo-router/react-navigation";

export const REMOTE_DESKTOP_ROUTE = "devices/desktop/[deviceId]";
type State = NavigationState | PartialState<NavigationState>;

/** Expo Router owns an outer navigator; the actual page may be nested. */
export function activeDesktopRoute(
  state: State | undefined,
): State["routes"][number] | undefined {
  if (!state) return undefined;
  const route = state.routes[state.index ?? 0];
  return route?.state ? activeDesktopRoute(route.state) : route;
}

/** A retained PiP surface is not a page in the user's Back history. */
export function removeDesktopHistory<T extends State>(
  state: T,
  keepKey?: string,
): T | null {
  const routes = state.routes.flatMap((route) => {
    if (route.name === REMOTE_DESKTOP_ROUTE && route.key !== keepKey) return [];
    if (!route.state) return [route];
    const nested = removeDesktopHistory(route.state, keepKey);
    if (!nested) return [];
    return [nested === route.state ? route : { ...route, state: nested }];
  });
  if (
    routes.length === state.routes.length &&
    routes.every((route, i) => route === state.routes[i])
  )
    return state;
  if (!routes.length) return null;
  const activeKey = state.routes[state.index ?? 0]?.key;
  const activeIndex = routes.findIndex((route) => route.key === activeKey);
  // Preserve the current non-desktop page, or return to the last surviving
  // page before the removed desktop. Keep original route keys and params.
  const previousCount = state.routes
    .slice(0, state.index)
    .filter((route) => routes.some((kept) => kept.key === route.key)).length;
  return {
    ...state,
    routes,
    index: activeIndex >= 0 ? activeIndex : Math.max(0, previousCount - 1),
  };
}
