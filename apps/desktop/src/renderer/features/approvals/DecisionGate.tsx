import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import './approvals.css';

/** How long the decision controls stay inert after a request is selected. */
export const ARM_MS = 600;

/**
 * Wraps the real PermissionPrompt. For ARM_MS after mount the wrapper is `inert` (no focus, no
 * click, hidden from assistive tech), so a click aimed at a queue row that lands on the freshly
 * shown Allow button does nothing. Mount it with a key that changes on every new selection.
 * The band above keeps its height after arming, so Allow never moves under the pointer; a polite
 * live region announces locking and ready, because inert also hides the controls from screen readers.
 */
export function DecisionGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [arming, setArming] = useState(true);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    setAnnouncement(t('approvalsInbox.gate.locking'));
    const timer = setTimeout(() => {
      setArming(false);
      setAnnouncement(t('approvalsInbox.gate.ready'));
    }, ARM_MS);
    return () => clearTimeout(timer);
  }, [t]);

  return (
    <div>
      <div
        data-testid="arming-band"
        data-visible={arming ? 'true' : 'false'}
        aria-hidden="true"
        className="approval-arming-band flex h-5 items-center gap-3 text-12 text-[var(--text-secondary)]"
      >
        <span className="relative h-0.5 flex-1 overflow-hidden rounded-full bg-[var(--border-default)]">
          <span className="approval-arm-fill absolute inset-0 bg-[var(--text-primary)]" />
        </span>
        <span className="shrink-0">{t('approvalsInbox.gate.locking')}</span>
      </div>
      <p data-testid="gate-status" role="status" aria-live="polite" className="sr-only">{announcement}</p>
      <div data-testid="decision-gate" data-arming={arming ? 'true' : 'false'} inert={arming} className="approval-gate">
        {children}
      </div>
    </div>
  );
}
