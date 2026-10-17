import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { useAuth } from '@/contexts/AuthContext';
import { useAppShellCover } from '@/contexts/AppShellCoverContext';
import { useEnvCheck } from '@/contexts/EnvCheckContext';
import { useLoginHandoff } from '@/contexts/LoginHandoffContext';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { OpenLogsRow, UploadLogsActionRow } from './LogSupportActions';
import { useManualLogUpload } from './useManualLogUpload';

/** Outside startup/auth/database gates so the failure being diagnosed cannot hide the entry. */
export function StartupLogSupport() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const upload = useManualLogUpload();
  const { canEnterApp, isInitializing } = useAuth();
  const { localDbGateStatus } = useAppShellCover();
  const { status } = useEnvCheck();
  const { brandStageMounted } = useLoginHandoff();
  const visible =
    isInitializing ||
    !canEnterApp ||
    status !== 'passed' ||
    localDbGateStatus !== 'ready' ||
    brandStageMounted;

  return (
    <>
      {visible && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-2 z-[9999] flex justify-center"
          style={WINDOW_NO_DRAG_STYLE}
        >
          {/* Login's bare-text action treatment; only the label's padded hit area is interactive. */}
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={open}
            className="pointer-events-auto flex h-8 items-center justify-center border-0 bg-transparent px-4 text-12 font-normal leading-4 text-[var(--login-secondary-text)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--login-link-text)]"
            onClick={() => setOpen(true)}
          >
            {t('logSupport.title')}
          </button>
        </div>
      )}
      {/* Only the entry follows startup readiness; an opened dialog stays until explicitly dismissed. */}
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={t('logSupport.title')}
        contentSelectable
        content={
          open ? (
            <div className="flex flex-col gap-5">
              <UploadLogsActionRow presentation="dialog" upload={upload} />
              <OpenLogsRow presentation="dialog" />
            </div>
          ) : undefined
        }
        confirmText={t('logSupport.close')}
        showCancel={false}
        onConfirm={() => setOpen(false)}
      />
    </>
  );
}
