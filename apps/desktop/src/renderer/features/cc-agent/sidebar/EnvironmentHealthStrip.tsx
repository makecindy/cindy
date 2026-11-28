import { useId, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, CircleAlert, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EnvironmentHealthAction, EnvironmentHealthAlert } from './environmentHealth';

export interface EnvironmentHealthStripProps {
  alerts: readonly EnvironmentHealthAlert[];
  onAction: (action: EnvironmentHealthAction, alert: EnvironmentHealthAlert) => void;
  onDismiss: (fingerprint: string) => void;
  /** Optional initial expanded state when multiple alerts exist (primarily for UI fixtures/tests). */
  defaultExpanded?: boolean;
}

function SeverityIcon({ severity }: { severity: EnvironmentHealthAlert['severity'] }) {
  const Icon = severity === 'error' ? CircleAlert : AlertTriangle;
  return (
    <Icon
      size={14}
      aria-hidden
      className={cn(
        'mt-0.5 shrink-0',
        severity === 'error' ? 'text-[var(--error-fg)]' : 'text-[var(--warning-fg)]',
      )}
    />
  );
}

/**
 * Compact, zero-footprint-when-healthy environment health strip for the Desktop Inbox.
 * Renders nothing when healthy; surfaces 1 actionable row directly or aggregates 2+
 * alerts into a single collapsible card without stacking banners.
 */
export function EnvironmentHealthStrip({
  alerts,
  onAction,
  onDismiss,
  defaultExpanded = false,
}: EnvironmentHealthStripProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();

  if (alerts.length === 0) return null;

  if (alerts.length === 1) {
    const alert = alerts[0];
    return (
      <div
        role="region"
        data-testid="inbox-environment-health"
        aria-label={t('ccAgent.sidebar.inbox.health.regionLabel')}
        className="mr-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-2 text-[var(--text-primary)]"
      >
        <div className="flex items-start gap-2">
          <SeverityIcon severity={alert.severity} />
          <div className="min-w-0 flex-1">
            <p className="text-12 font-medium leading-[1.35] break-words">
              {t(alert.titleKey, alert.titleParams)}
            </p>
            <p className="mt-0.5 text-11 leading-[1.4] text-[var(--text-secondary)] break-words">
              {t(alert.descriptionKey, alert.descriptionParams)}
            </p>
            <div className="mt-1.5">
              <Button
                type="button"
                variant="secondary"
                compact
                size="sm"
                onClick={() => onAction(alert.action, alert)}
              >
                {t(alert.actionLabelKey)}
              </Button>
            </div>
          </div>
          <button
            type="button"
            aria-label={t('ccAgent.sidebar.inbox.health.dismiss')}
            onClick={() => onDismiss(alert.fingerprint)}
            className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <X size={13} aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  const highestSeverity: EnvironmentHealthAlert['severity'] = alerts.some(
    (a) => a.severity === 'error',
  )
    ? 'error'
    : 'warning';

  return (
    <div
      role="region"
      data-testid="inbox-environment-health"
      aria-label={t('ccAgent.sidebar.inbox.health.regionLabel')}
      className="mr-2 overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((prev) => !prev)}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-sidebar-item-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
      >
        <SeverityIcon severity={highestSeverity} />
        <span className="min-w-0 flex-1 truncate text-12 font-medium leading-[1.35]">
          {t('ccAgent.sidebar.inbox.health.summaryTitle', { count: alerts.length })}
        </span>
        {expanded ? (
          <ChevronDown size={13} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        ) : (
          <ChevronRight size={13} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        )}
      </button>
      {expanded && (
        <div
          id={listId}
          className="divide-y divide-[var(--border-default)] border-t border-[var(--border-default)]"
        >
          {alerts.map((alert) => (
            <div key={alert.id} className="flex items-start gap-2 px-2.5 py-2">
              <SeverityIcon severity={alert.severity} />
              <div className="min-w-0 flex-1">
                <p className="text-12 font-medium leading-[1.35] break-words">
                  {t(alert.titleKey, alert.titleParams)}
                </p>
                <p className="mt-0.5 text-11 leading-[1.4] text-[var(--text-secondary)] break-words">
                  {t(alert.descriptionKey, alert.descriptionParams)}
                </p>
                <div className="mt-1.5">
                  <Button
                    type="button"
                    variant="secondary"
                    compact
                    size="sm"
                    onClick={() => onAction(alert.action, alert)}
                  >
                    {t(alert.actionLabelKey)}
                  </Button>
                </div>
              </div>
              <button
                type="button"
                aria-label={t('ccAgent.sidebar.inbox.health.dismiss')}
                onClick={() => onDismiss(alert.fingerprint)}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-sidebar-item-hover hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <X size={13} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
