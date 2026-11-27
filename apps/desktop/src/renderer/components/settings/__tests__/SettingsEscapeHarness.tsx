import { useRef, useState, type ReactNode } from 'react';
import { SettingsSubpageBackContext, useSettingsEscape } from '../useSettingsEscape';

/** Give a real settings section the window-level Escape handling it gets in SettingsView. */
export function SettingsEscapeHarness({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const [exited, setExited] = useState(false);
  const back = useSettingsEscape(root, !exited, () => setExited(true));
  if (exited) return <p>Left settings</p>;
  return (
    <SettingsSubpageBackContext.Provider value={back}>
      <div ref={root}>{children}</div>
    </SettingsSubpageBackContext.Provider>
  );
}
