/**
 * ControlledBanner —— 被控端可见性指示。
 *
 * 当本机正在被同账号的其它设备远程控制时,在聊天输入框上方或全局兜底位置显示一条 chip:
 * 「动态状态点 + 正在被 <设备名> 控制 + 撤销访问权限」。主聊天页展开时与计划胶囊
 * 组成一组共同居中;点胶囊内的叉后,只把呼吸灯放到 RunningStatusBar 右侧 token 统计
 * 之前。其它页面全局挂载(MainLayout),与 FeishuConflictDialogHost 同级。状态订阅来自
 * device-link:controlled-state push,初值经 getState().controlledBy。
 *
 * 单设备时按钮调 revoke(deviceId)(逐设备黑名单,持久化);多设备时跳转到设置页,
 * 让用户逐台查看 / 撤销。撤销后控制端连不回来,需被控端到设置「控制本机的设备」里手动恢复。
 *
 * chip 文字不可选中(select-none) —— 它是状态指示而非可复制内容;hover 弹 Tip,展示
 * 完整设备名 + 远程控制逻辑说明。
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Eye, MonitorOff, X } from 'lucide-react';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const log = createLogger('ControlledBanner');

interface Controller {
  deviceId: string;
  name: string;
}

/**
 * 共享的「谁在控制本机」状态 —— 提到组件之上、模块级单例缓存 + 单一订阅。
 *
 * 为什么:ControlledBanner 会在 composer / floating placement 间切换挂载。若每个实例各自
 * 持 useState([]) + 异步 getState() 回填,新挂载的实例首帧 controllers 必为空 → 返回 null →
 * 被控 chip 闪空 1 帧。把状态缓存到模块级,任何实例挂载时同步读到上次最新值,首帧即有内容。
 */
let cachedControllers: Controller[] = [];
let pushSubscribed = false;
const controllerListeners = new Set<(c: Controller[]) => void>();

// composer 被控提示的折叠状态只在当前 renderer 生命周期内保存,并严格按 sessionId
// 分桶。它不是全局偏好,不写 localStorage / DB / 服务端;切换任务时直接读取对应桶,
// 因此不会把 A 任务的折叠态闪到 B 任务首帧。
const collapsedComposerSessionIds = new Set<string>();
const collapsedComposerListeners = new Set<() => void>();

function subscribeCollapsedComposer(listener: () => void) {
  collapsedComposerListeners.add(listener);
  return () => collapsedComposerListeners.delete(listener);
}

function setComposerCollapsed(sessionId: string, collapsed: boolean) {
  if (collapsedComposerSessionIds.has(sessionId) === collapsed) return;
  if (collapsed) collapsedComposerSessionIds.add(sessionId);
  else collapsedComposerSessionIds.delete(sessionId);
  for (const listener of collapsedComposerListeners) listener();
}

export function useComposerCollapsed(sessionId: string | null): boolean {
  const getSnapshot = useCallback(
    () => sessionId !== null && collapsedComposerSessionIds.has(sessionId),
    [sessionId],
  );
  return useSyncExternalStore(subscribeCollapsedComposer, getSnapshot, getSnapshot);
}

export function __resetControlledBannerForTests(): void {
  cachedControllers = [];
  pushSubscribed = false;
  controllerListeners.clear();
  collapsedComposerSessionIds.clear();
  collapsedComposerListeners.clear();
}

function emitControllers(next: Controller[]) {
  cachedControllers = next;
  for (const listener of controllerListeners) listener(next);
}

// 首个 ControlledBanner 实例挂载时建立一次性订阅(初值 getState + 后续 push),之后常驻 app
// 生命周期:这是单条轻量 IPC 监听,换来跨 remount 的状态连续性,故不在每个实例卸载时反复拆装。
function ensureControllerSubscription() {
  if (pushSubscribed) return;
  if (typeof window === 'undefined' || !window.electronAPI?.deviceLink) return;
  pushSubscribed = true;
  void window.electronAPI.deviceLink
    .getState()
    .then((s) => emitControllers(s.controlledBy ?? []))
    .catch(() => {});
  window.electronAPI.deviceLink.onControlledState((p) => emitControllers(p.controllers ?? []));
}

// 读共享的被控状态:首帧同步返回模块级缓存(remount 不再闪空),后续随 push 更新。
/**
 * 读取当前被控端控制者列表,供聊天布局在挂载 composer 被控行前判断是否需要占位。
 * 状态仍由本模块的单例订阅维护,调用方不会建立额外 IPC 监听。
 */
export function useControlledBy(): Controller[] {
  const [controllers, setControllers] = useState<Controller[]>(cachedControllers);
  useEffect(() => {
    ensureControllerSubscription();
    // 挂载瞬间把本地 state 对齐到最新缓存(可能在本实例上次卸载后又被 push 更新过)。
    setControllers(cachedControllers);
    controllerListeners.add(setControllers);
    return () => {
      controllerListeners.delete(setControllers);
    };
  }, []);
  return controllers;
}

/**
 * 控制被控提示的呈现方式:
 *   - 'floating'  : 全局悬浮兜底(右下角,带 shadow),非主聊天路由用。
 *   - 'inline'    : 独占一行、水平居中(带 w-full 包裹),plan-review 等场景用。
 *   - 'composer'  : 主聊天输入区的完整 chip / 折叠呼吸灯,具体挂载位置由会话布局决定。
 */
interface ControlledBannerProps {
  placement?: 'floating' | 'inline' | 'composer';
  maxWidth?: number;
  /** composer placement 的任务 ID,用于隔离完整 / 呼吸灯折叠态。 */
  sessionId?: string | null;
}

export function ControlledBanner({
  placement = 'floating',
  maxWidth,
  sessionId = null,
}: ControlledBannerProps = {}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const controllers = useControlledBy();
  const composerSessionId = placement === 'composer' ? sessionId : null;
  const composerCollapsed = useComposerCollapsed(composerSessionId);

  if (controllers.length === 0) return null;

  const label =
    controllers.length === 1
      ? t('remoteDevice.controlledBy', { name: controllers[0].name })
      : t('remoteDevice.controlledByMultiple', { count: controllers.length });
  const hasMultipleControllers = controllers.length > 1;

  // 撤销当前控制本机的单台控制端访问权限(逐设备黑名单,持久化)。
  // 此函数仅在 !hasMultipleControllers(即 controllers.length === 1)时被调用。
  // 成功后被控端会踢断链路 + 拒绝后续连接,controlled-state push 清空 → banner 自然消失。
  // 撤销是持久化操作(对方将连不回来、需到设置恢复)→ 先确认,避免误点;单数文案即对应这一台。
  const onRevoke = async () => {
    // 快照点击那一刻展示的那台控制端(单数文案描述的就是它),确认后只撤它——**不**重读整列表:
    // 否则弹窗 await 期间若第二台接入,会把用户从没在单数文案里见过的新控制端也一起永久拉黑,
    // 且绕过多控制端本应走的「跳设置页」路径(reviewer)。
    const target = controllers[0];
    if (!target) return;
    const ok = await confirm({
      title: t('settings.remoteControl.revokeConfirm.title'),
      description: t('settings.remoteControl.revokeConfirm.description'),
      confirmText: t('settings.remoteControl.revokeConfirm.confirm'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.deviceLink.revoke(target.deviceId);
      toast.success(t('settings.remoteControl.toast.revoked'));
    } catch (err) {
      log.warn('revoke failed', err);
      toast.error(t('settings.remoteControl.toast.revokeFailed'));
    }
  };
  const onViewControllers = () => {
    navigate('/settings?tab=remote-control');
  };

  // hover Tip:第一行完整 label(设备名不截断,窄宽时 chip 里那行会 truncate),
  // 第二行解释远程控制逻辑(可撤销 / 撤销后果 / 在哪恢复)。
  const tooltipContent = (
    <div className="space-y-1">
      <div className="font-medium">{label}</div>
      <div className="opacity-80">{t('remoteDevice.controlledTooltip')}</div>
    </div>
  );

  const collapsedIndicator = composerSessionId ? (
    <Tip text={tooltipContent}>
      <button
        type="button"
        data-controlled-banner="collapsed"
        aria-label={t('remoteDevice.expandControlledNotice', { label })}
        onClick={() => setComposerCollapsed(composerSessionId, false)}
        className={cn(
          // 20px 布局盒与右侧元信息行同高,避免把整行从 32px 撑到 40px；
          // ::before 把鼠标热区无布局地扩回 28px。
          "pointer-events-auto relative flex h-5 w-5 shrink-0 items-center justify-center rounded-full before:absolute before:-inset-1 before:content-['']",
          'text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)]',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        )}
      >
        <span
          // 圆点的几何中心与文字盒中心相同，但字形/箭头的可见像素重心更低；
          // 单独下移 1px 做光学对齐，不改变按钮盒、状态行或计划位置。
          className="session-status-breathing h-2 w-2 translate-y-[2px] rounded-full"
          style={{ backgroundColor: 'var(--status-bar-accent)' }}
          aria-hidden
        />
      </button>
    </Tip>
  ) : null;

  const chip = (
    <Tip text={tooltipContent}>
      <div
        data-controlled-banner-chip="true"
        className={cn(
          // select-none:被控提示是状态指示,不应像正文一样可被鼠标框选复制。
          // h-7 与计划胶囊同为 28px；显式去掉纵向 padding，避免撤销按钮把主体撑到 32px。
          'pointer-events-auto flex h-7 min-w-0 max-w-full select-none items-center gap-2 overflow-hidden rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-0',
          placement === 'floating' && 'shadow-[var(--shadow-menu)]',
        )}
      >
        <span
          className="session-status-breathing h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: 'var(--status-bar-accent)' }}
          aria-hidden
        />
        <span className="min-w-0 truncate text-12 text-[var(--text-primary)]">{label}</span>
        <button
          type="button"
          onClick={hasMultipleControllers ? onViewControllers : () => void onRevoke()}
          className="flex min-w-0 max-w-[45%] shrink items-center gap-1 rounded-full px-2 py-0.5 text-12 text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        >
          {hasMultipleControllers ? (
            <Eye size={13} className="shrink-0" />
          ) : (
            <MonitorOff size={13} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">
            {hasMultipleControllers
              ? t('remoteDevice.viewControllers')
              : t('remoteDevice.revokeAccess')}
          </span>
        </button>
        {composerSessionId && (
          <button
            type="button"
            data-controlled-banner-collapse="true"
            aria-label={t('remoteDevice.collapseControlledNotice')}
            onClick={() => setComposerCollapsed(composerSessionId, true)}
            className={cn(
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
              'text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
            )}
          >
            <X size={13} aria-hidden />
          </button>
        )}
      </div>
    </Tip>
  );

  if (placement === 'inline') {
    return (
      <div className="flex w-full justify-center px-2">
        <div
          className="flex min-w-0 max-w-full justify-center"
          style={maxWidth == null ? undefined : { maxWidth }}
        >
          {chip}
        </div>
      </div>
    );
  }

  if (placement === 'composer') {
    return (
      <div className="pointer-events-auto flex min-w-0 max-w-full shrink justify-end">
        <div
          className="flex min-w-0 max-w-full justify-end"
          style={maxWidth == null ? undefined : { maxWidth }}
        >
          {composerCollapsed && collapsedIndicator ? collapsedIndicator : chip}
        </div>
      </div>
    );
  }

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)]">
      {chip}
    </div>
  );
}
