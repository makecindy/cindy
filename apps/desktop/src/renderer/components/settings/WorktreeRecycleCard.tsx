import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import type { WorktreeRecycleStatus } from '../../../shared/worktreeRecycle';

export function WorktreeRecycleCard() {
  const { t } = useTranslation();
  const [rows, setRows] = useState<WorktreeRecycleStatus[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const loading = useRef(false);
  const refreshQueued = useRef(false);
  const controlBusy = useRef(false);
  const refresh = useCallback(async (): Promise<void> => {
    if (loading.current) { refreshQueued.current = true; return; }
    loading.current = true;
    try {
      setRows(await window.electronAPI.worktreeRecycle.list());
      setFailed(false);
    } catch { setFailed(true); }
    finally {
      loading.current = false;
      if (refreshQueued.current) { refreshQueued.current = false; void refresh(); }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);
  const control = async (row: WorktreeRecycleStatus, action: 'retry' | 'keep') => {
    if (controlBusy.current) return;
    controlBusy.current = true;
    setBusy(row.id);
    try {
      await window.electronAPI.worktreeRecycle.control({ id: row.id, generation: row.generation, action });
      await refresh();
    } catch { toast.error(t('settings.worktreeRecycle.actionFailed')); }
    finally { controlBusy.current = false; setBusy(null); }
  };
  return (
    <div className="mt-6 rounded-xl border border-[var(--border-default)] p-4">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">{t('settings.worktreeRecycle.title')}</h3>
        <Button variant="secondary" size="md" onClick={() => { void refresh(); }}>{t('settings.worktreeRecycle.refresh')}</Button>
      </div>
      {failed ? <p role="alert" className="mt-3 text-sm text-[var(--text-secondary)]">{t('settings.worktreeRecycle.loadFailed')}</p>
        : rows === null ? null : rows.length === 0 ? <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('settings.worktreeRecycle.empty')}</p>
          : <ul className="mt-3 divide-y divide-[var(--border-default)]">
            {rows.map((row) => <li key={`${row.id}:${row.generation}`} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-[var(--text-primary)]" title={row.path}>{row.name}</p>
                <p className="break-all text-xs text-[var(--text-secondary)]">{row.path}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {t(`settings.worktreeRecycle.state.${row.state}`)} · {t(`settings.worktreeRecycle.reason.${row.reason}`)}
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="secondary" size="md" disabled={busy !== null} onClick={() => { void control(row, 'retry'); }}>{t('settings.worktreeRecycle.retry')}</Button>
                <Button variant="secondary" size="md" disabled={busy !== null || row.state === 'kept'} onClick={() => { void control(row, 'keep'); }}>{t('settings.worktreeRecycle.keep')}</Button>
              </div>
            </li>)}
          </ul>}
    </div>
  );
}
