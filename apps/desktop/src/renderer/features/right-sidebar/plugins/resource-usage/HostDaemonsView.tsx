/**
 * HostDaemonsView —— 「本机常驻」清单：由 Cindy 任务创建、但脱离会话生命周期的
 * 系统常驻项（Windows 计划任务 / macOS LaunchAgent / Linux systemd 单元、crontab）。
 *
 * 数据全部来自 main（扫描 + 归属判定 + 台账），这里只负责呈现与二次确认。
 * 列表里不会出现与本机任务无关的常驻项（例如用户自己装的 v2rayN）：main 只返回
 * 有 Cindy 归属证据的条目，其余只回一个数量。归属还在核对历史记录的条目同样先不列，
 * 由界面按 main 给的间隔静默重拉，直到核对完。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTodo, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type { HostDaemonEntry, HostDaemonsSnapshot } from '../../../../../shared/hostDaemons';

type PendingAction = { entry: HostDaemonEntry; action: 'stop' | 'delete' };

export function HostDaemonsView({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<HostDaemonsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  // 请求序号：慢扫描返回时丢弃过期结果，避免旧响应覆盖新状态。
  const loadSeq = useRef(0);

  // quiet：核对历史期间的自动重拉，不进加载态（列表和刷新按钮保持可用）。
  const load = useCallback(async (quiet = false) => {
    const seq = ++loadSeq.current;
    if (!quiet) setLoading(true);
    try {
      const next = await window.electronAPI.hostDaemons.list();
      if (seq !== loadSeq.current) return;
      setSnapshot(next);
      setFailed(false);
    } catch {
      if (seq !== loadSeq.current) return;
      setFailed(true);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, []);

  // 只在看得见时工作：收起时停下，重新展开时补拉一次。
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);

  // 归属还在核对历史的条目：按 main 给的间隔静默重拉。pollTick 让失败的一次也会排下一次，
  // 否则一次瞬时的读取失败会让核对停在那里。
  const [pollTick, setPollTick] = useState(0);
  const pendingCount = snapshot?.pendingCount ?? 0;
  const retryAfterMs = snapshot?.retryAfterMs ?? 0;
  useEffect(() => {
    if (!visible || pendingCount === 0) return;
    const timer = setTimeout(async () => {
      await load(true);
      setPollTick((n) => n + 1);
    }, retryAfterMs);
    return () => clearTimeout(timer);
  }, [visible, pendingCount, retryAfterMs, pollTick, load]);

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
                {/* 启动/停止合一个按钮：同一条任务只有「当前在跑」与「没在跑」两种意图。 */}
                <Button
                  variant="secondary"
                  size="xs"
                  disabled={busy || entry.state === 'disabled'}
                  onClick={() =>
                    entry.state === 'running'
                      ? setPending({ entry, action: 'stop' })
                      : void runNow(entry)
                  }
                >
                  {t(
                    entry.state === 'running'
                      ? 'rightSidebar.hostDaemons.stop'
                      : 'rightSidebar.hostDaemons.run',
                  )}
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
          {/* 保留旧列表时也要说清楚它可能不是最新的（停止/删除后的状态同理）。 */}
          {failed
            ? t('rightSidebar.hostDaemons.refreshFailed')
            : pendingCount > 0
              ? t('rightSidebar.hostDaemons.checking', { count: pendingCount })
              : entries.length > 0 && (snapshot?.unrelatedCount ?? 0) > 0
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
