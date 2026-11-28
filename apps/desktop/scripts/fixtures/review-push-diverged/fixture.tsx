import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../../src/renderer/components/ui/confirm-dialog';
import { mountPage, type UiPageContext } from '../../ui-page/harness';

function PushDialogSpecimen({ ctx }: { ctx: UiPageContext }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const [choice, setChoice] = useState<string>('');
  const isClean = ctx.case === 'default';

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('rightSidebar.review.push.divergedTitle')}
        description={
          isClean
            ? t('rightSidebar.review.push.syncCleanDesc', {
                count: 2,
                remoteRef: 'origin/main',
              })
            : t('rightSidebar.review.push.divergedConflictDesc', {
                count: 2,
                remoteRef: 'origin/main',
                files: 'src/auth.ts, src/sync.ts',
              })
        }
        confirmText={
          isClean
            ? t('rightSidebar.review.push.syncAndPushConfirm')
            : t('rightSidebar.review.push.askAgentSyncConfirm')
        }
        tertiaryText={t('rightSidebar.review.push.forceConfirm')}
        cancelText={t('rightSidebar.review.push.forceCancel')}
        maxWidth={440}
        autoFocusConfirm
        onConfirm={() => {
          setChoice('confirm');
          setOpen(false);
        }}
        onTertiary={() => {
          setChoice('tertiary');
          setOpen(false);
        }}
        onCancel={() => {
          setChoice('cancel');
          setOpen(false);
        }}
      />
      <div data-testid="push-choice" className="text-12 text-[var(--text-secondary)]">
        {choice}
      </div>
    </main>
  );
}

void mountPage({
  render: (ctx) => <PushDialogSpecimen ctx={ctx} />,
});
