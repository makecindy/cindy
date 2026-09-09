import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '@/contexts/AuthContext';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { toast } from '@/lib/toast';
import { mapIpcErrorToI18nKey } from '@/utils/ipcError';

export function useLogout(): { handleLogout: () => Promise<void> } {
  const { logout } = useAuth();
  const { confirm } = useConfirmDialog();
  const { t } = useTranslation();

  const handleLogout = useCallback(async () => {
    const confirmed = await confirm({
      title: t('logic.confirm.logoutTitle'),
      description: t('logic.confirm.logoutDescription'),
      confirmText: t('logic.confirm.logoutConfirm'),
      cancelText: t('logic.confirm.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;

    try {
      await logout();
    } catch (error) {
      toast.error(
        t(mapIpcErrorToI18nKey(error, { fallback: 'ipcError.INTERNAL' }), {
          defaultValue: t('ipcError.INTERNAL'),
        }),
      );
    }
  }, [logout, confirm, t]);

  return { handleLogout };
}
