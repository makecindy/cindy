import { useId, type ReactNode, type Ref } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import type { ThreadPanelResize } from './useThreadPanelResize';
import './ThreadPanel.css';

/** Shared chrome for group and private topics. Each keeps its existing reply runtime. */
export function ThreadPanel({ children, actions, onClose, panelRef, resize, rootClientId }: {
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  panelRef?: Ref<HTMLElement>;
  resize?: ThreadPanelResize;
  rootClientId?: string;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  return <aside ref={panelRef} aria-labelledby={titleId} data-dm-thread-panel={rootClientId}
    style={resize?.width === undefined ? undefined : { width: resize.width, maxWidth: 'none' }}
    className="thread-panel app-wallpaper-surface relative flex h-full min-w-0 w-1/2 max-w-[min(50%,28rem)] shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--surface)]">
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
      <h2 id={titleId} className="text-15 font-medium text-[var(--text-primary)]">{t('bots.groupChat.server.topic')}</h2>
      <div className="flex items-center gap-1">
        {actions}
        <Tip text={t('bots.close')}>
          <Button variant="secondary" tone="quiet" size="md"
            className="w-8 rounded-none px-0 [&::before]:rounded-full"
            aria-label={t('bots.close')} onClick={onClose}><X size={17} aria-hidden /></Button>
        </Tip>
      </div>
    </header>
    {children}
    {/* Keep the Shift+Tab route from Close back into the parent chat. */}
    {resize && <div role="separator" aria-orientation="vertical" aria-label={t('diffPanel.shell.resizeHandleAria')}
      tabIndex={0} {...resize.handleProps}
      className="absolute inset-y-0 left-0 z-10 w-2 touch-none cursor-col-resize hover:border-l hover:border-[var(--text-tertiary)] focus-visible:border-l focus-visible:border-[var(--focus-ring)] focus-visible:outline-none" />}
  </aside>;
}

/** Lives inside the reply scroller: the root never gets a separate height cap or scrollbar. */
export function ThreadPanelRoot({ children, replyCount, testId }: {
  children: ReactNode;
  replyCount?: number;
  testId?: string;
}) {
  const { t } = useTranslation();
  return <>
    {children}
    <div data-testid={testId} data-thread-replies="" className="mt-3 flex select-none items-center gap-3 text-12 text-[var(--text-tertiary)]">
      <span className="shrink-0">{replyCount ? t('bots.groupChat.server.replyCount', { count: replyCount }) : t('bots.groupChat.server.replies')}</span>
      <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
    </div>
  </>;
}
