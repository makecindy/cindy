import {
  appShortcutCombosEqual,
  type AppShortcutCombo,
  type AppShortcutId,
} from '../../shared/appShortcuts';
import type { VoiceInputShortcut } from './shortcut';
import { voiceInputShortcutToAppShortcutCombo } from '../../shared/voiceInputAppShortcut';

export { voiceInputShortcutToAppShortcutCombo };

/** App shortcut id plus its currently effective key combinations. */
export interface AppShortcutComboEntry {
  id: AppShortcutId;
  combos: ReadonlyArray<AppShortcutCombo>;
}

/** Find the first app shortcut that already owns the voice input key combo. */
export function findVoiceInputAppShortcutConflict(
  shortcut: VoiceInputShortcut,
  appShortcuts: ReadonlyArray<AppShortcutComboEntry>,
): AppShortcutId | null {
  const combo = voiceInputShortcutToAppShortcutCombo(shortcut);
  if (!combo) return null;
  for (const entry of appShortcuts) {
    if (entry.combos.some((appCombo) => appShortcutCombosEqual(appCombo, combo))) {
      return entry.id;
    }
  }
  return null;
}
