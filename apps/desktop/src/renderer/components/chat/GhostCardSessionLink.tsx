import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSessionLinkTarget } from './SessionLinkChip';
import { isSeparateLinkActivation } from './linkInteraction';
import { toast } from '@/lib/toast';

export function GhostCardSessionLink({ element }: { element: HTMLElement }) {
  const { openTarget, navigationMode } = useSessionLinkTarget(element.dataset.ghostSessionLink ?? element.dataset.ghostLink ?? '');
  const { t } = useTranslation();
  useEffect(() => {
    const open = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      if ((element as HTMLButtonElement).disabled || element.getAttribute('aria-disabled') === 'true') return;
      const mouse = event as MouseEvent;
      void openTarget(navigationMode === 'sidebar-embedded' || isSeparateLinkActivation(mouse))
        .catch(() => toast.error(t('chat.ghostCall.linkOpenFailed')));
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Enter' || event.key === ' ') open(event);
    };
    // The sanitized anchor has no href, so a middle click has no browser default to fall back on.
    const aux = (event: MouseEvent) => {
      if (event.button === 1) open(event);
    };
    element.addEventListener('click', open);
    element.addEventListener('auxclick', aux);
    element.addEventListener('keydown', key);
    return () => {
      element.removeEventListener('click', open);
      element.removeEventListener('auxclick', aux);
      element.removeEventListener('keydown', key);
    };
  }, [element, openTarget, navigationMode, t]);
  return null;
}
