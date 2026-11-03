import { useState, type ReactNode } from 'react';

/** Closed sheets need neither their hooks nor eagerly constructed JSX on entry.
 * Once opened, retain them so draft state and the existing dismissal lifecycle
 * continue to belong to the sheet (including rapid close/reopen). */
export function MountOnFirstOpen({ open, children }: { open: boolean; children: () => ReactNode }) {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return open || opened ? children() : null;
}
