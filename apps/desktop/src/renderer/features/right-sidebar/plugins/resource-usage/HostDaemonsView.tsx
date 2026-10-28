/**
 * HostDaemonsView —— 「本机常驻」清单：由 Cindy 任务创建、但脱离会话生命周期的
 * Windows 计划任务。
 *
 * 数据全部来自 main（扫描 + 归属判定 + 台账），这里只负责呈现与二次确认。
 * 列表里不会出现与本机任务无关的常驻项（例如用户自己装的 v2rayN）：main 只返回
 * 有 Cindy 归属证据的条目，其余只回一个数量。
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTodo, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type { HostDaemonEntry, HostDaemonsSnapshot } from '../../../../../shared/hostDaemons';

type PendingAction = { entry: HostDaemonEntry; action: 'stop' | 'delete' };

export function HostDaemonsView() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<HostDaemonsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await window.electronAPI.hostDaemons.list();
      setSnapshot(next);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAction = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const request = { id: pending.entry.id };
      if (pending.action === 'stop') await window.electronAPI.hostDaemons.stop(request);
      else await window.electronAPI.hostDaemons.remove(request);
      toast.success(
        t(
          pending.action === 'stop'
            ? 'rightSidebar.hostDaemons.stopped'
            : 'rightSidebar.hostDaemons.deleted',
          { name: pending.entry.name },
        ),
      );
      setPending(null);
      await load();
    } catch {
      toast.error(t('rightSidebar.hostDaemons.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  /** 立即跑一次。停止是可逆的一半：没有这一步任务只能等下一个触发时机。 */
  const runNow = async (entry: HostDaemonEntry) => {
    if (busy) return;
    setBusy(true);
    try {
      await window.electronAPI.hostDaemons.run({ id: entry.id });
      toast.success(t('rightSidebar.hostDaemons.started', { name: entry.name }));
      await load();
    } catch {
      toast.error(t('rightSidebar.hostDaemons.actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  if (loading && snapshot === null) {
    return (
      <div className="resource-usage-loading host-daemons-loading">
        <Spinner size={13} />
        <span>{t('rightSidebar.hostDaemons.scanning')}</span>
      </div>
    );
  }

  if (failed && snapshot === null) {
    return (
      <div className="host-daemons-empty">
        <div>{t('rightSidebar.hostDaemons.loadFailed')}</div>
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t('rightSidebar.hostDaemons.refresh')}
        </Button>
      </div>
    );
  }

  if (snapshot && !snapshot.supported) {
    return (
      <div className="host-daemons-empty">{t('rightSidebar.hostDaemons.unsupported')}</div>
    );
  }

  const entries = snapshot?.entries ?? [];

  return (
    <div className="host-daemons">
      <div className="host-daemons-list" role="list">
        {entries.length === 0 ? (
          <div className="host-daemons-empty">
            <ListTodo aria-hidden size={18} strokeWidth={1.6} />
            <div>{t('rightSidebar.hostDaemons.empty')}</div>
          </div>
        ) : (
          entries.map((entry) => (
            <div className="host-daemons-row" role="listitem" key={entry.id}>
              <div className="host-daemons-main">
                <div className="host-daemons-title">
                  <span className="host-daemons-name" title={entry.id}>
                    {entry.name}
                  </span>
                  <span className={`host-daemons-state host-daemons-state--${entry.state}`}>
                    {t(`rightSidebar.hostDaemons.state.${entry.state}`)}
                  </span>
                </div>
                <div className="host-daemons-owner">
                  {t('rightSidebar.hostDaemons.owner', {
                    title: entry.ownerTitle || t('rightSidebar.hostDaemons.ownerUnknown'),
                  })}
                  <span className="host-daemons-sep"> · </span>
                  {t(`rightSidebar.hostDaemons.trigger.${entry.trigger}`)}
                </div>
                <div className="host-daemons-command" title={entry.command}>
                  {entry.command}
                </div>
              </div>
              <div className="host-daemons-actions">
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy || entry.state === 'running' || entry.state === 'disabled'}
                  onClick={() => void runNow(entry)}
                >
                  {t('rightSidebar.hostDaemons.run')}
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy}
                  onClick={() => setPending({ entry, action: 'stop' })}
                >
                  {t('rightSidebar.hostDaemons.stop')}
                </Button>
                <Button
                  variant="secondary"
                  size="xs"
                  tone="danger"
                  disabled={busy}
                  onClick={() => setPending({ entry, action: 'delete' })}
                >
                  {t('rightSidebar.hostDaemons.delete')}
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="host-daemons-footer">
        <div className="host-daemons-note">
          {entries.length > 0 && (snapshot?.unrelatedCount ?? 0) > 0
            ? t('rightSidebar.hostDaemons.unrelated', { count: snapshot?.unrelatedCount ?? 0 })
            : ''}
        </div>
        <Button variant="secondary" size="xs" disabled={loading} onClick={() => void load()}>
          <RefreshCw aria-hidden size={12} strokeWidth={1.8} />
          {loading ? t('rightSidebar.hostDaemons.scanning') : t('rightSidebar.hostDaemons.refresh')}
        </Button>
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null);
        }}
        title={t(
          pending?.action === 'delete'
            ? 'rightSidebar.hostDaemons.deleteTitle'
            : 'rightSidebar.hostDaemons.stopTitle',
          { name: pending?.entry.name ?? '' },
        )}
        description={t(
          pending?.action === 'delete'
            ? 'rightSidebar.hostDaemons.deleteBody'
            : 'rightSidebar.hostDaemons.stopBody',
        )}
        confirmText={t(
          pending?.action === 'delete'
            ? 'rightSidebar.hostDaemons.delete'
            : 'rightSidebar.hostDaemons.stop',
        )}
        confirmVariant={pending?.action === 'delete' ? 'destructive' : 'default'}
        loading={busy}
        onConfirm={() => void runAction()}
      />
    </div>
  );
}
