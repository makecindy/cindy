/**
 * Picks the one question card that answers the voice shortcut.
 *
 * Several cards can be on screen at once (split panes, Orca columns, group
 * chats where more than one teammate asks). Every card hears each press, so
 * each asks here before acting and exactly one card claims it:
 *
 * 1. a card that is already dictating — the press stops it;
 * 2. the card holding keyboard focus. Focus on any control outside every card
 *    (a text field, button, link, menu or dialog) means the press belongs there
 *    (the composer or the global overlay), so no card claims it;
 * 3. otherwise an Orca lead's card, then the card that appeared most recently.
 *
 * A minimized or hidden card never starts dictation.
 */
import { isForeignKeyboardControl } from '@/lib/editableKeyboardTarget';

export type AskUserVoiceShortcutCard = {
  /** Orca lead card: wins step 3 over worker cards, even newer ones. */
  preferred: boolean;
  getElement: () => Element | null;
  isBusy: () => boolean;
  canStart: () => boolean;
};

type Entry = AskUserVoiceShortcutCard & { order: number };

const cards = new Set<Entry>();
let lastOrder = 0;

/** Appearance order for a newly mounted card; later cards win step 3. */
export function nextAskUserVoiceShortcutOrder(): number {
  lastOrder += 1;
  return lastOrder;
}

function isShown(element: Element | null): boolean {
  if (!element?.isConnected) return false;
  // Electron's Chromium has checkVisibility; jsdom does not and renders nothing hidden.
  return typeof element.checkVisibility === 'function' ? element.checkVisibility() : true;
}

function resolveOwner(focus: EventTarget | null): Entry | null {
  const entries = [...cards];
  const busy = entries.find((entry) => entry.isBusy());
  if (busy) return busy;

  const focused = focus instanceof Element && focus !== document.body ? focus : null;
  if (focused) {
    const holder = entries.find((entry) => entry.getElement()?.contains(focused));
    if (holder) return holder.canStart() ? holder : null;
    if (isForeignKeyboardControl(focused)) return null;
  }

  let pick: Entry | null = null;
  for (const entry of entries) {
    if (!entry.canStart() || !isShown(entry.getElement())) continue;
    if (
      !pick
      || (entry.preferred && !pick.preferred)
      || (entry.preferred === pick.preferred && entry.order > pick.order)
    ) pick = entry;
  }
  return pick;
}

export function registerAskUserVoiceShortcutCard(
  order: number,
  card: AskUserVoiceShortcutCard,
): { owns: (focus: EventTarget | null) => boolean; dispose: () => void } {
  const entry: Entry = { ...card, order };
  cards.add(entry);
  return {
    owns: (focus) => resolveOwner(focus) === entry,
    dispose: () => {
      cards.delete(entry);
    },
  };
}
