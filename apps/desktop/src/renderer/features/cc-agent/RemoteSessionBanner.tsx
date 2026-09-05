/**
 * RemoteSessionBanner —— 控制端打开的远程会话状态提示条。
 *
 * 让"连接 / 同步有问题"可见而非静默卡住,在会话视图顶部显示一条 strip。
 * 连接类状态(reconnecting / host-offline / degraded)的恢复全自动(重连 / presence /
 * 熔断探测 + 恢复后自动 resync),不提供手动按钮(2026-08 弱网实测反馈:重连必须全自动);
 * 只有 suspect-stall 保留「重新同步」「结束本轮」——那是自动机制无法核实的卡死回合,
 * 需要用户裁决。四种 status:
 *   - reconnecting  : 本机断链重连中。
 *   - host-offline  : 被控设备离线。
 *   - degraded      : 两端 presence 均在线但被控端连续超时被熔断判定无响应(弱网 / 对端
 *                     卡死),正在自动探测恢复 —— 区别于 host-offline,设备并没有离线。
 *   - suspect-stall : 链路在线但本轮久未更新、且无法向被控端核实其真实运行态(不可达 / 旧端 /
 *                     超时)→ 可能已断流。额外给「结束本轮」让用户手动收尾卡死的 Generating。
 * 连接 / 同步恢复后由上层据状态自动隐藏。
 *
 * 颜色复用 remote 区语义 token(host-offline=disconnected,其余=progress),走主题不硬编码。
 */

import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { RotateCw, Square } from 'lucide-react';

interface Props {
  status: 'reconnecting' | 'host-offline' | 'degraded' | 'suspect-stall' | 'syncing' | 'recovered';
  /**
   * 本机到 relay 的连接问题(鉴权失效/被顶号/超限/版本不符)。仅 reconnecting 态消费:
   * 有明确原因时把笼统的「重连中」替换成具体原因文案,避免无限重连横幅无法行动。
   */
  issue?: DeviceLinkConnectionIssuePayload | null;
  onResync: () => void;
  /** 仅 suspect-stall:用户手动收尾卡死的远程 turn。 */
  onFinalize?: () => void;
}

export function RemoteSessionBanner({ status, issue, onResync, onFinalize }: Props) {
  const { t } = useTranslation();
  const [hideRecovered, setHideRecovered] = useState(false);
  useEffect(() => {
    setHideRecovered(false);
    if (status !== 'recovered') return;
    const timer = setTimeout(() => setHideRecovered(true), 2_000);
    return () => clearTimeout(timer);
  }, [status]);
  const activeIssue = status === 'reconnecting' ? (issue ?? null) : null;
  const dotColor =
    status === 'host-offline' || activeIssue
      ? 'var(--remote-status-disconnected)'
      : 'var(--remote-status-progress)';
  const label = activeIssue
    ? t(`ccAgent.remoteSession.issue.${activeIssue.kind}`)
    : status === 'reconnecting'
      ? t('ccAgent.remoteSession.reconnecting')
      : status === 'host-offline'
        ? t('ccAgent.remoteSession.hostOffline')
        : status === 'degraded'
          ? t('ccAgent.remoteSession.degraded')
          : status === 'syncing'
            ? t('ccAgent.remoteSession.syncing')
            : status === 'recovered'
              ? t('ccAgent.remoteSession.recovered')
              : t('ccAgent.remoteSession.suspectStall');
  const pulse =
    !activeIssue &&
    (status === 'reconnecting' || status === 'degraded' || status === 'suspect-stall' || status === 'syncing');

  if (status === 'recovered' && hideRecovered) return null;

  return (
    <div className="flex select-none items-center gap-2 border-b border-[var(--border-default)] bg-[var(--surface-chip)] px-4 py-1.5">
      <span
        className={
          pulse
            ? 'h-1.5 w-1.5 shrink-0 animate-pulse rounded-full'
            : 'h-1.5 w-1.5 shrink-0 rounded-full'
        }
        style={{ backgroundColor: dotColor }}
        aria-hidden
      />
      <span className="flex-1 truncate text-12 text-[var(--text-secondary)]">{label}</span>
      {status === 'suspect-stall' && onFinalize && (
        <button
          type="button"
          onClick={onFinalize}
          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <Square size={12} />
          {t('ccAgent.remoteSession.finalizeStuck')}
        </button>
      )}
      {status === 'suspect-stall' && (
        <button
          type="button"
          onClick={onResync}
          className="flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          <RotateCw size={12} />
          {t('ccAgent.remoteSession.resync')}
        </button>
      )}
    </div>
  );
}
