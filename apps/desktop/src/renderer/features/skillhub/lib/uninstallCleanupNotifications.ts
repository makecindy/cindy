import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';

const notices = new Map<string, { id: string; retrying: boolean }>();

export function showUninstallCleanup(token: string, name: string, refresh: () => Promise<unknown>): void {
  if (notices.has(token)) return;
  const notice = { id: '', retrying: false };
  notices.set(token, notice);
  notice.id = toast.warning(i18n.t('skillhub.management.cleanupIncomplete', { name }), {
    duration: 0,
    onClose: () => { if (notices.get(token) === notice) notices.delete(token); },
    action: { label: i18n.t('skillhub.management.retryCleanup'), onClick: () => {
      if (notices.get(token) !== notice || notice.retrying) return;
      notice.retrying = true;
      void window.electronAPI.skillhub.retryUninstallCleanup(token).then(({ complete }) => {
        if (notices.get(token) !== notice) return;
        if (complete) {
          notices.delete(token);
          toast.dismiss(notice.id);
          toast.success(i18n.t('skillhub.management.cleanupComplete'));
          void refresh();
        }
      }).catch((error: unknown) => {
        if (notices.get(token) !== notice) return;
        const code = extractIpcError(error)?.code;
        toast.error(i18n.t(code === 'PRECONDITION_FAILED' || code === 'PERMISSION_DENIED'
          ? 'skillhub.management.refreshRequired' : 'skillhub.management.uninstallFailed'));
      }).finally(() => { notice.retrying = false; });
    } },
  });
}

export function syncUninstallCleanupNotices(pending: Array<{ token: string; name: string }>, refresh: () => Promise<unknown>): void {
  const tokens = new Set(pending.map(({ token }) => token));
  for (const [token, notice] of notices) {
    if (tokens.has(token)) continue;
    notices.delete(token);
    toast.dismiss(notice.id);
  }
  for (const { token, name } of pending) showUninstallCleanup(token, name, refresh);
}

export function resetUninstallCleanupNotices(): void {
  const old = [...notices.values()];
  notices.clear();
  for (const { id } of old) toast.dismiss(id);
}
