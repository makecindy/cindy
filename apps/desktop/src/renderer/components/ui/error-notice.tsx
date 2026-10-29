import {
  forwardRef,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react';
import { AlertCircle, ChevronDown, ChevronRight, Stethoscope, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { redactSensitiveText } from '@cindy/maker-shared/error-redaction';
import { cn } from '@/lib/utils';
import { Button } from './button';
import { Tip } from './tooltip';

interface ErrorNoticeProps extends Omit<ComponentPropsWithoutRef<'div'>, 'children'> {
  message: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  details?: string;
  /** Offered only after the user expands details; the caller decides where diagnosis happens. */
  onDiagnose?: () => void;
  icon?: ReactNode;
  onDismiss?: () => void;
  dismissLabel?: string;
  children?: ReactNode;
}

/** Shared error presentation; callers retain all recovery and dismissal decisions. */
export const ErrorNotice = forwardRef<HTMLDivElement, ErrorNoticeProps>(function ErrorNotice(
  {
    message,
    description,
    actions,
    details,
    onDiagnose,
    icon,
    onDismiss,
    dismissLabel,
    children,
    className,
    ...props
  },
  ref,
) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setExpanded(false);
  }, [details]);
  const closeLabel = dismissLabel ?? t('chat.errorBanner.cancelTitle');
  return (
    <div
      ref={ref}
      className={cn(
        'flex items-start gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-3',
        className,
      )}
      {...props}
    >
      <span className="mt-0.5 inline-flex shrink-0 text-[var(--error-fg)]" aria-hidden="true">
        {icon ?? <AlertCircle size={16} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="break-words text-13 leading-5 text-[var(--text-primary)]">{message}</div>
        {description && (
          <div className="mt-1 text-12 leading-5 text-[var(--text-secondary)]">{description}</div>
        )}
        {children}
        <div className="mt-2 flex flex-wrap items-center gap-2 empty:hidden">
          {actions}
          {details && (
            <Button
              size="sm"
              compact
              tone="quiet"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t(expanded ? 'chat.errorBanner.networkHideRaw' : 'chat.errorBanner.networkShowRaw')}
            </Button>
          )}
          {details && expanded && onDiagnose && (
            <Button
              size="sm"
              compact
              type="button"
              data-split-pane-route-action=""
              onClick={onDiagnose}
              title={t('chat.errorBanner.diagnoseTitle')}
            >
              <Stethoscope size={12} />
              {t('chat.errorBanner.diagnose')}
            </Button>
          )}
        </div>
        {details && expanded && (
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-[hsl(var(--surface-hsl))] p-2 text-12 leading-5 text-[var(--text-secondary)]">
            {redactSensitiveText(details)}
          </pre>
        )}
      </div>
      {onDismiss && (
        <Tip text={closeLabel}>
          <button
            type="button"
            onClick={onDismiss}
            aria-label={closeLabel}
            className="-mt-1 -mr-1 flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] transition-colors"
          >
            <X size={14} />
          </button>
        </Tip>
      )}
    </div>
  );
});
