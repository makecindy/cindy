/**
 * HostDaemonsView —— 「本机常驻」清单：由 Cindy 任务创建、但脱离会话生命周期的
 * 系统常驻项（Windows 计划任务 / macOS LaunchAgent / Linux systemd 单元、crontab）。
 *
 * 数据全部来自 main（扫描 + 归属判定 + 台账），这里只负责呈现与二次确认。
 * 列表里不会出现与本机任务无关的常驻项（例如用户自己装的 v2rayN）：main 只返回
 * 有 Cindy 归属证据的条目，其余只回一个数量。
 *
 * 清单只有一个来源 —— 一轮更新：面板可见时订阅，main 按自己的节奏一轮轮做（归属
 * 还在核对历史记录的条目由它接着推进），每轮把清单推来；打开面板、点刷新、操作
 * 之后用 refresh 请求一轮。这里不轮询，也不在收到通知后回读。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ListTodo, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import type { HostDaemonEntry, HostDaemonsSnapshot, HostDaemonsUpdate } from '../../../../../shared/hostDaemons';

type PendingAction = { entry: HostDaemonEntry; action: 'stop' | 'delete' };

export function HostDaemonsView({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<HostDaemonsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  /** 面板是否还「在场」：组件已挂载且可见。卸载后不再发起新的读取请求。 */
  const liveRef = useRef(false);

  /** 清单的唯一入口：订阅的首轮回执、main 推来的每一轮、手动刷新的回执，走的都是它。 */
  const apply = useCallback((update: HostDaemonsUpdate) => {
    if (update.ok) {
      setSnapshot(update.snapshot);
      setFailed(false);
    } else {
      setFailed(true);
    }
  }, []);

  // 可见期间订阅；首轮回执到了才算首屏加载完。重新可见时旧清单先留着，新一轮到了原地替换。
  useEffect(() => {
    liveRef.current = visible;
    if (!visible) {
      // 面板不可见时，待确认动作失去上下文（用户看不到提示、条目也可能已变），不再留着。
      setPending(null);
      return;
    }
    const api = window.electronAPI.hostDaemons;
    setLoading(true);
    let cancelled = false;
    const off = api.onChanged((update) => {
      if (!cancelled) apply(update);
    });
    void api.subscribe().then(
      (update) => {
        if (!cancelled) {
          apply(update);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
      liveRef.current = false;
      off();
      void api.unsubscribe();
    };
  }, [visible, apply]);

  /** 请求一轮更新；清单保留到新结果到达，按钮转圈期间不可重复请求。 */
  const refresh = async () => {
    // 面板已经离开：不发起新的读取请求（工程规范 §8.2 / §8.3）。
    if (!liveRef.current) return;
    setBusy(true);
    try {
      apply(await window.electronAPI.hostDaemons.refresh());
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

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
      // 操作已成功；新一轮更新失败只影响清单的新旧（页脚提示），不改写上面的结果。
      // 面板已经离开就不再请求新一轮：已接受的写入可以完成，但不再发起新读取。
      if (liveRef.current) {
        await window.electronAPI.hostDaemons
          .refresh()
          .then(apply, () => setFailed(true));
      }
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
      // 同上：面板已经离开就不再请求新一轮。
      if (liveRef.current) {
        await window.electronAPI.hostDaemons
          .refresh()
          .then(apply, () => setFailed(true));
      }
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
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
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
  const refreshing = loading || busy;

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
          {/* 一轮更新失败时保留旧清单，但说清楚它可能不是最新的（停止/删除后的状态同理）；
              有来源没读全时清单同样可能缺项，如实说明。 */}
          {failed
            ? t('rightSidebar.hostDaemons.refreshFailed')
            : snapshot?.incomplete
              ? t('rightSidebar.hostDaemons.incomplete')
              : (snapshot?.pendingCount ?? 0) > 0
                ? t('rightSidebar.hostDaemons.checking', { count: snapshot?.pendingCount ?? 0 })
                : entries.length > 0 && (snapshot?.unrelatedCount ?? 0) > 0
                  ? t('rightSidebar.hostDaemons.unrelated', {
                      count: snapshot?.unrelatedCount ?? 0,
                    })
                  : ''}
        </div>
        <Button variant="secondary" size="xs" disabled={refreshing} onClick={() => void refresh()}>
          <RefreshCw aria-hidden size={12} strokeWidth={1.8} />
          {refreshing
            ? t('rightSidebar.hostDaemons.scanning')
            : t('rightSidebar.hostDaemons.refresh')}
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
