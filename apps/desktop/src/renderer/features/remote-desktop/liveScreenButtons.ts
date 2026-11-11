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
} from 'lucide-react';
import type { LiveScreenButton, LiveScreenButtonIcon } from '@cindy/device-link';

/** Same glyphs as Mobile (apps/mobile/src/remote-desktop/liveScreen.ts). */
export const LIVE_SCREEN_ICONS: Record<LiveScreenButtonIcon, LucideIcon> = {
  home: House,
  back: Undo2,
  recents: Copy,
  lock: Lock,
  power: Power,
  'volume-up': Volume2,
  'volume-down': Volume1,
  'rotate-left': RotateCcw,
  'rotate-right': RotateCw,
  menu: Menu,
  'play-pause': Play,
  siri: Mic,
  shake: Vibrate,
  screenshot: Camera,
};

/**
 * The device buttons a viewer window's toolbar offers, in the plugin's order.
 * `orientation-*` set an absolute pose for a phone that turns the device with
 * itself; a window has no pose, and the rotate buttons already turn the device.
 */
export function liveScreenToolbarButtons(buttons: readonly LiveScreenButton[]): LiveScreenButton[] {
  const rotates =
    buttons.some((button) => button.id === 'rotate-left') &&
    buttons.some((button) => button.id === 'rotate-right');
  return buttons.filter(
    (button) =>
      button.icon in LIVE_SCREEN_ICONS && !(rotates && button.id.startsWith('orientation-')),
  );
}
