/**
 * A one-page introduction shown the first time someone opens a feature (DESIGN.md "Feature
 * introduction"). It reuses the get-started guide's cover: a mark, a headline, one sentence,
 * three cards whose scenes play once, and one action that closes it.
 */
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { GuideCover } from './GuideCover';

type CoverProps = ComponentProps<typeof GuideCover>;

export function FeatureIntroDialog({ open, onClose, actionLabel, ...cover }: Omit<CoverProps, 'action' | 'close'> & {
  open: boolean;
  onClose: () => void;
  actionLabel: string;
}) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000]" style={WINDOW_DRAG_STYLE} />
        <Dialog.Content
          aria-describedby={undefined}
          data-feature-intro=""
          // Shown once; a stray click beside it should not dismiss it unseen.
          onPointerDownOutside={(event) => event.preventDefault()}
          style={WINDOW_NO_DRAG_STYLE}
          className="modal-panel fixed inset-0 z-[10000] m-auto flex h-fit max-h-[88vh] w-[min(640px,calc(100vw-32px))] flex-col overflow-hidden outline-none"
        >
          <GuideCover
            {...cover}
            action={(
              <Dialog.Close asChild>
                <Button variant="cta" size="lg" type="button" className="min-w-[168px]">{actionLabel}</Button>
              </Dialog.Close>
            )}
            close={(
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={t('featureIntro.close')}
                  title={t('featureIntro.close')}
                  className="flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </Dialog.Close>
            )}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
