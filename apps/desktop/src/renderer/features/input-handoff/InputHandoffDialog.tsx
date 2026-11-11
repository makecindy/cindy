/**
 * The 代输入 dialog, opened from the strip above the composer. Same reading
 * order as on the phone: what the agent needs, where it goes (lock + site, or
 * the app), anything to check first, then only what the owner fills in. It
 * closes without ending the handoff; the strip stays until it is done.
 */

import type { ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, AppWindow, Globe, Lock, QrCode, SquareTerminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { InputHandoffSnapshot } from '@cindy/device-link';
import { inputHandoffPlace, inputHandoffPlaceKind } from './inputHandoffModel';

export interface InputHandoffDialogProps {
  open: boolean;
  snapshot: InputHandoffSnapshot;
  /** This device cannot send input to the computer running the task. */
  inputBlocked: boolean;
  error: string | null;
  /** The step itself: fields, the QR code, a sign-in code or the picture. */
  children: ReactNode;
  /** Primary and Cancel; absent on steps whose own content holds the actions. */
  footer?: ReactNode;
  /** Quiet links under the footer (see the window, live view). */
  links?: ReactNode;
  onClose: () => void;
}

export function InputHandoffDialog({
  open,
  snapshot,
  inputBlocked,
  error,
  children,
  footer,
  links,
  onClose,
}: InputHandoffDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(440px,calc(100vw-32px))] flex-col gap-4 overflow-y-auto p-6 outline-none"
          data-testid="input-handoff-dialog"
        >
          <InputHandoffDialogHeader snapshot={snapshot} inputBlocked={inputBlocked} />
          {children}
          {error && (
            <p role="alert" className="text-center text-12 text-[var(--error-fg)]">
              {error}
            </p>
          )}
          {footer}
          {links && <div className="-mt-1 flex flex-wrap justify-center gap-x-4">{links}</div>}
          {!footer && (
            <Dialog.Close className="mx-auto min-h-8 px-3 text-13 font-medium text-[var(--text-primary)] hover:text-[var(--text-secondary)]">
              {t('inputHandoff.action.close')}
            </Dialog.Close>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function InputHandoffDialogHeader({
  snapshot,
  inputBlocked,
}: {
  snapshot: InputHandoffSnapshot;
  inputBlocked: boolean;
}) {
  const { t } = useTranslation();
  const place = inputHandoffPlace(snapshot.source);
  const Icon = inputHandoffIcon(snapshot);
  const warnings = [
    snapshot.source.warning ? t(`inputHandoff.originWarning.${snapshot.source.warning}`) : null,
    snapshot.agentPicture
      ? t('inputHandoff.agentPicture')
      : snapshot.agentControlled ? t('inputHandoff.agentControlled') : null,
    inputBlocked ? t('inputHandoff.remoteUnavailable') : null,
    snapshot.failure && !snapshot.terminal ? t(`inputHandoff.failure.${snapshot.failure}`) : null,
  ].filter((warning): warning is string => Boolean(warning));
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span className="flex size-12 items-center justify-center rounded-[12px] border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]">
        <Icon size={22} aria-hidden />
      </span>
      <Dialog.Title className="mt-1 text-18 font-semibold leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]">
        {snapshot.purpose}
      </Dialog.Title>
      <InputHandoffPlace label={place.label} secure={place.secure} />
      {snapshot.note && (
        <p className="text-12 leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {t('inputHandoff.agentNote', { note: snapshot.note })}
        </p>
      )}
      {snapshot.command && (
        <p className="max-w-full font-mono text-12 text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {snapshot.command}
        </p>
      )}
      {warnings.map((warning) => (
        <p
          key={warning}
          className="flex w-full items-start gap-1.5 rounded-[8px] bg-[var(--warning-bg-soft)] px-2.5 py-1.5 text-left text-12 text-[var(--text-primary)]"
        >
          <AlertTriangle size={14} className="mt-px shrink-0 text-[var(--warning-fg)]" aria-hidden />
          <span>{warning}</span>
        </p>
      ))}
    </div>
  );
}

/** Lock + host for a secure site; otherwise the origin or the app, as the owner checks it. */
export function InputHandoffPlace({ label, secure }: { label: string; secure: boolean }) {
  return (
    <p className="flex min-w-0 items-center gap-1 text-12 text-[var(--text-secondary)]">
      {secure && <Lock size={12} className="shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </p>
  );
}

export function inputHandoffIcon(snapshot: InputHandoffSnapshot) {
  if (snapshot.qr) return QrCode;
  const kind = inputHandoffPlaceKind(snapshot);
  return kind === 'web' ? Globe : kind === 'terminal' ? SquareTerminal : AppWindow;
}
