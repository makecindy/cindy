import type {
  NavigationState,
  PartialState,
} from "expo-router/react-navigation";
import { mobileDebugEnabled, mobileDebugLog } from "@/debug/mobileDebugLog";

type State = NavigationState | PartialState<NavigationState>;
const pages: Record<string, string> = {
  __root: "root",
  index: "home",
  "devices/index": "devices",
  "devices/[deviceId]": "device",
  "devices/desktop/[deviceId]": "desktop",
  "sessions/[sessionId]": "task",
  "devices/manage/[deviceId]": "manage-device",
  settings: "settings",
};

/** Fixed page categories and indices only: never route keys, paths or params. */
export function desktopNavigationSummary(state: State | undefined): string {
  let remaining = 60;
  const visit = (value: State | undefined, depth: number): string => {
    if (!value) return "absent";
    if (depth > 5 || remaining <= 0) return "truncated";
    return `${value.index ?? 0}:[${value.routes
      .slice(0, 30)
      .map((route) => {
        if (--remaining < 0) return "truncated";
        const page = Object.hasOwn(pages, route.name)
          ? pages[route.name]
          : "other";
        return route.state ? `${page}(${visit(route.state, depth + 1)})` : page;
      })
      .join(",")}]`;
  };
  return visit(state, 0);
}

export function logDesktopNavigation(
  event: string,
  state: State | undefined,
  flags: Record<string, boolean | number | string> = {},
) {
  if (!mobileDebugEnabled()) return;
  mobileDebugLog("info", "lifecycle", `remote desktop navigation ${event}`, {
    stack: desktopNavigationSummary(state),
    ...flags,
  });
}
