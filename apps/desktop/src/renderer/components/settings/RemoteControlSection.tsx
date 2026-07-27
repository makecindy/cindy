/**
 * RemoteControlSection —— 统一的「远程控制」设置页。
 *
 * 合并原「设备互联」(device-link)与「远端机器」(SSH)两个入口,两块功能在同一页内上下排列:
 *   1. 我的设备:同账号设备一处管理 —— 本机承载被控总开关 + relay 状态,其余设备逐台管
 *      「我控制它 / 允许它控制本机」+ 重命名 / 删除(MyDevicesPanel)
 *   2. SSH:原 RemoteSection 原样嵌入(showTitle=false,标题由本页统一给)
 * (Slack 连接子块已迁至「IM 机器人」页 Cindy 栏, 见 ImBotSection.tsx + HookConnectionsSection.tsx)
 *
 * 两个子块都是无上限列表,页面默认全部收起;收起态 header 右侧带状态摘要,
 * 各子块独立展开,状态不持久化(刷新回默认,与 PinnedSection 先例一致)。
 * 「我的设备」的本机卡(被控总开关 + relay 状态)是全页最常用控件,以 pinned
 * 形式常驻折叠区外,折叠只收其它设备列表。收起只做 CSS 隐藏、内容保持挂载:
 * 子组件的数据订阅与内联编辑状态不因折叠丢失,展开瞬间无重新加载跳变(规则 7)。
 *
 * device-link 数据(开关 / 设备列表 / controlledBy)由 useDeviceLinkSettings 取一份;
 * SSH 主机摘要由本组件自取轻量快照(list + onStatusChanged),不侵入 RemoteSection。
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useDeviceLinkSettings, type DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { MyDevicesPanel } from './MyDevicesPanel';
import { RemoteSection } from './RemoteSection';
import { useAuth } from '@/contexts/AuthContext';

/** SSH 状态 → 摘要状态点的优先级:有已连接给绿,其次进行中给橙,再次失败给红,否则灰。 */
const SSH_PROGRESS_STATUSES: ReadonlySet<RemoteHostSnapshot['status']> = new Set([
  'connecting',
  'authenticating',
  'reconnecting',
]);

function CollapsibleSubSection({
  title,
  summary,
  dotColor,
  open,
  onToggle,
  pinned,
  children,
}: {
  title: string;
  /** 收起态 header 右侧的状态摘要;null = 数据未就绪,整块不显示(避免闪一帧错误状态)。 */
  summary: string | null;
  dotColor: string | null;
  open: boolean;
  onToggle: () => void;
  /** 不随折叠隐藏的常驻内容(如「我的设备」的本机卡),渲染在 header 与折叠区之间。 */
  pinned?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="group flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="shrink-0 text-14 font-medium text-[var(--text-primary)]">{title}</span>
        <div className="flex min-w-0 items-center gap-2">
          {!open && summary ? (
            <>
              {dotColor ? (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: dotColor }}
                  aria-hidden
                />
              ) : null}
              <span className="truncate text-12 text-[var(--text-tertiary)]">{summary}</span>
            </>
          ) : null}
          <span
            className="shrink-0 text-[var(--text-tertiary)] transition-colors group-hover:text-[var(--text-primary)]"
            aria-hidden
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        </div>
      </button>
      {pinned}
      <div hidden={!open}>{children}</div>
    </section>
  );
}

/**
 * 「我的设备」收起态摘要:其它设备数量。本机卡常驻外层,relay 状态与被控开关
 * 在卡上直接可见,摘要不再重复;状态点也免了(本机卡自带)。
 */
function deviceSummary(
  s: DeviceLinkSettings,
  t: (k: string, o?: Record<string, unknown>) => string,
): string | null {
  if (s.devices === null) return null;
  const others = s.devices.filter((d) => !d.isSelf).length;
  return others === 0
    ? t('settings.remoteControl.summary.noOtherDevices')
    : t('settings.remoteControl.summary.otherDevices', { count: others });
}

/** 「SSH」收起态摘要:主机数 + 已连接数。 */
function sshSummary(
  hosts: RemoteHostSnapshot[] | null,
  t: (k: string, o?: Record<string, unknown>) => string,
): { text: string; dot: string } | null {
  if (hosts === null) return null;
  if (hosts.length === 0) {
    return {
      text: t('settings.remoteControl.summary.noHosts'),
      dot: 'var(--remote-status-disconnected)',
    };
  }
  const connected = hosts.filter((h) => h.status === 'ready').length;
  const inProgress = hosts.some((h) => SSH_PROGRESS_STATUSES.has(h.status));
  const failed = hosts.some((h) => h.status === 'failed');
  const parts = [t('settings.remoteControl.summary.hostCount', { count: hosts.length })];
  if (connected > 0) {
    parts.push(t('settings.remoteControl.summary.hostsConnected', { count: connected }));
  }
  const dot =
    connected > 0
      ? 'var(--remote-status-ready)'
      : inProgress
        ? 'var(--remote-status-progress)'
        : failed
          ? 'var(--remote-status-failed)'
          : 'var(--remote-status-disconnected)';
  return { text: parts.join(' · '), dot };
}

export function RemoteControlSection() {
  const { t } = useTranslation();
  const { mode } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const deviceLinkAvailable = mode === 'cloud';
  const s = useDeviceLinkSettings(deviceLinkAvailable);

  // 深链 ?section=devices 必须在首帧就是展开态:放到 effect 里会先画一帧收起,
  // 再把下方内容顶开一格。
  const [devicesOpen, setDevicesOpen] = useState(
    () => new URLSearchParams(location.search).get('section') === 'devices',
  );
  const [sshOpen, setSshOpen] = useState(false);

  // SSH 主机轻量快照 —— 只为收起态摘要服务。RemoteSection 内部自管自己的一份;
  // 这里不外提它的状态是有意的(979 行组件不为一行摘要重构)。
  const [hosts, setHosts] = useState<RemoteHostSnapshot[] | null>(null);

  useEffect(() => {
    if (new URLSearchParams(location.search).get('section') === 'devices') {
      setDevicesOpen(true);
    }
  }, [location.search]);

  const collapseRequestedRef = useRef(false);
  const toggleDevices = useCallback(() => {
    setDevicesOpen((previous) => {
      // 只有用户主动收起才需要清 URL;更新函数里只记录这次意图,幂等、可重入。
      collapseRequestedRef.current = previous;
      return !previous;
    });
  }, []);

  // 收起后把 ?section=devices 摘掉,否则刷新/返回还会再展开一次。挂 effect 是为了
  // 让 toggle 保持函数式更新;必须再看 collapseRequestedRef,否则「页面已挂载时才
  // 导航进深链」那一帧会读到还没提交的 devicesOpen=false,把刚进来的深链清掉。
  useEffect(() => {
    if (devicesOpen || !collapseRequestedRef.current) return;
    collapseRequestedRef.current = false;

    const next = new URLSearchParams(location.search);
    if (next.get('section') !== 'devices') return;
    next.delete('section');
    const search = next.toString();
    navigate(
      {
        pathname: location.pathname,
        search: search ? `?${search}` : '',
      },
      { replace: true },
    );
  }, [devicesOpen, location.pathname, location.search, navigate]);

  const refreshHosts = useCallback(async () => {
    try {
      const res = await window.electronAPI.remoteSsh.list();
      setHosts(res.hosts);
    } catch {
      // 摘要是 best-effort:失败保持 null 不显示;真实错误由展开后的 RemoteSection 呈现
    }
  }, []);

  useEffect(() => {
    void refreshHosts();
    const off = window.electronAPI.remoteSsh.onStatusChanged((snap) => {
      setHosts((prev) => {
        if (!prev) return prev;
        const idx = prev.findIndex((h) => h.config.id === snap.config.id);
        if (idx < 0) return [...prev, snap];
        const copy = prev.slice();
        copy[idx] = snap;
        return copy;
      });
    });
    return () => {
      off();
    };
  }, [refreshHosts]);

  // 每次开合都重拉一次快照:RemoteSection 里的添加 / 删除不广播列表变更,
  // 收起瞬间重新同步,避免摘要计数漂移。
  const toggleSsh = useCallback(() => {
    setSshOpen((v) => !v);
    void refreshHosts();
  }, [refreshHosts]);

  const devSumText = deviceSummary(s, t);
  const sshSum = sshSummary(hosts, t);

  return (
    <div className="flex flex-col gap-2 px-1">
      <div className="flex flex-col gap-1">
        <h2 className="text-15 font-medium text-[var(--text-primary)]">
          {t('settings.remoteControl.title')}
        </h2>
        <p className="text-12 text-[var(--text-tertiary)]">
          {t('settings.remoteControl.description')}
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-6">
        {deviceLinkAvailable ? (
          <>
            <CollapsibleSubSection
              title={t('settings.remoteControl.sections.myDevices')}
              summary={devSumText}
              dotColor={null}
              open={devicesOpen}
              onToggle={toggleDevices}
              pinned={<MyDevicesPanel s={s} variant="self" />}
            >
              <MyDevicesPanel s={s} variant="others" />
            </CollapsibleSubSection>
            <div className="h-px w-full bg-[var(--border-default)]" />
          </>
        ) : null}

        <CollapsibleSubSection
          title={t('settings.remoteControl.sections.ssh')}
          summary={sshSum?.text ?? null}
          dotColor={sshSum?.dot ?? null}
          open={sshOpen}
          onToggle={toggleSsh}
        >
          <RemoteSection showTitle={false} />
        </CollapsibleSubSection>
      </div>
    </div>
  );
}
