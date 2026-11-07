import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionLinkTarget } from './SessionLinkChip';
import { toast } from '@/lib/toast';

export function GhostCardSessionLink({ element }: { element: HTMLElement }) {
  const { openTarget, navigationMode } = useSessionLinkTarget(element.dataset.ghostLink ?? '');
  const { t } = useTranslation();
  useEffect(() => {
    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const mouse = event as MouseEvent;
      void openTarget(navigationMode === 'sidebar-embedded' || mouse.metaKey || mouse.ctrlKey || mouse.shiftKey)
        .catch(() => toast.error(t('chat.ghostCall.linkOpenFailed')));
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    };
    element.addEventListener('click', open);
    element.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('click', open);
      element.removeEventListener('keydown', key);
    };
  }, [element, openTarget, navigationMode, t]);
  return null;
}
