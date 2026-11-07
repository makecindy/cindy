import {
  Camera,
  Copy,
  House,
  Lock,
  Menu,
  Mic,
  Play,
  Power,
  RotateCcw,
  RotateCw,
  Undo2,
  Vibrate,
  Volume1,
  Volume2,
  type LucideIcon,
} from "lucide-react-native";
import {
  LIVE_SCREEN_ID,
  LIVE_SCREEN_PLUGIN_ID,
  type LiveScreenButtonIcon,
} from "@cindy/device-link";

/**
 * A plugin live screen in the `liveScreen` route param: `plugin|id` (neither may
 * contain `|`). Not `screen`: navigation treats that param as a nested page and drops it.
 */
export function liveScreenParam(screen: {
  plugin: string;
  id: string;
}): string {
  return `${screen.plugin}|${screen.id}`;
}

export function parseLiveScreenParam(
  value: unknown,
): { plugin: string; id: string } | undefined {
  if (typeof value !== "string") return undefined;
  const [plugin, id, ...rest] = value.split("|");
  return !rest.length &&
    plugin &&
    id &&
    LIVE_SCREEN_PLUGIN_ID.test(plugin) &&
    LIVE_SCREEN_ID.test(id)
    ? { plugin, id }
    : undefined;
}

/** Native glyphs for the button names a live screen descriptor uses. */
export const LIVE_SCREEN_ICONS: Record<LiveScreenButtonIcon, LucideIcon> = {
  home: House,
  back: Undo2,
  recents: Copy,
  lock: Lock,
  power: Power,
  "volume-up": Volume2,
  "volume-down": Volume1,
  "rotate-left": RotateCcw,
  "rotate-right": RotateCw,
  menu: Menu,
  "play-pause": Play,
  siri: Mic,
  shake: Vibrate,
  screenshot: Camera,
};

/** Buttons on the toolbar itself; the rest stay in the controls panel. */
export const LIVE_SCREEN_TOOLBAR_BUTTONS = 3;

/**
 * Device buttons the full-screen menu leaves out: turning follows the phone's
 * own orientation, and shaking belongs to the phone itself (not wired yet).
 */
export const LIVE_SCREEN_NOT_IN_MENU: ReadonlySet<string> = new Set([
  "rotate-left",
  "rotate-right",
  "orientation-portrait",
  "orientation-landscape",
  "shake",
]);

/** A foldable's hinge poses (closed, half open, flat): their own row, not the menu. */
export const LIVE_SCREEN_POSTURES: readonly string[] = [
  "posture-closed",
  "posture-open",
  "posture-flat",
];
