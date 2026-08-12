/**
 * UpdateBanner — F4: Sidebar update notification banner.
 * ---------------------------------------------------------------------------
 * Shown when the auto-update system has downloaded and verified a new version
 * (status === 'ready'), or while it's busy preparing an even newer one on top
 * of the already-ready patch (status === 'superseding'). Sits between the upper
 * content slot and UserInfoSection in the Sidebar shell.
 *
 * 点「立即重启」不再无条件多要一次确认:先查「有没有任务在跑」(逻辑 turn + turn 已结束但
 * 仍在调模型的后台活动,两个来源都要看),**只有真的有任务时**才就地切换成确认态,确认没有
 * 就直接重启。原先那句「应用会自动重启」的中性二次确认纯属多一次点击、不带信息,已退役。
 *
 * 探针拿不到可信答案时 fail closed(当作有任务),因为重启会杀掉 in-flight turn:「无法确认」
 * 不能当成「确认没有」。这条口径跟的是 main 侧托盘退出路径,而不是 WindowControls 关窗那半。
 *
 * 因此 confirming 态的语义收窄为**「有任务在进行中,重启会打断它」的中断警告**:标题点明
 * 状态、副标题讲后果(警告色)、主按钮「仍要重启」占据入口按钮原位(鼠标零位移),「取消」
 * 置于其下(次级、需刻意移动)。
 *
 * 「查看更新公告」文字链:ready 态在副标题下给一条 ghost 文字链,点开 UpdateNoticeDialog
 * 预览**待安装版本**的公告,让用户在「现在重启 vs 稍后」之间有据可依(装完后的自动弹窗
 * 只解决装完之后的事)。跨版本时会把「已装版本 → 待装版本」之间跳过的每一版聚合进同一个
 * 弹窗(useUpdateNotice 的 onOpenVersion),普通单版本升级就只有一块。三条刻意的边界:
 *   - 只在 ready 态出现。superseding 态顶部刻意不显示版本号(新版还在下),没有可信的
 *     版本可查,confirming 态则要保持中断警告的干净,两者都不给入口。
 *   - CDN 上没有该版本公告(或内容不可渲染)时不显示入口 —— 用挂载时的 fetch 探测,
 *     宁可没有入口,也不给一个点了报错的链接。探测结果被 release-notes 双层缓存复用,
 *     真正点开时不会再打一次网。
 *   - 收起 / rail 态放不下文字链,因此**没有入口**;那两态里 UserInfoSection 的火焰按钮
 *     也只能看 <= 当前已装版本的历史,看不到待装版本。这是本方案已知的取舍。
 *
 *   - Expanded ready:        Flame 36px → "Updated to {v}" → "Relaunch to apply" → notes link → Relaunch pill
 *   - Expanded confirming:   Flame 36px → "A task is still running" → 警告色 hint → "Restart anyway" pill / Cancel (下方,ghost)
 *   - Expanded superseding:  Loader2 36px (spin) → "Newer version found" → "Updating…" → disabled pill with spinner
 *   - Collapsed ready:       Flame 20px, click → 有任务才展开 ✓ / ✕,否则直接重启
 *   - Collapsed confirming:  Check 20px (仍要重启,占原位) 叠 X 20px (取消)
 *   - Collapsed superseding: Loader2 20px (spin), click is a noop
 *
 * superseding 状态下 banner 顶部刻意不显示新版本号 —— 新版还在下,显示版本号等于撒谎;
 * 下载完成后主进程会把 status 切回 'ready' 且 version 升级到新版,banner 自动刷新。
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Flame, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { useUpdateStatus } from '@/hooks/useUpdateStatus';
import { useUpdateBannerDismiss } from '@/hooks/useUpdateBannerDismiss';
import { useLocale } from '@/hooks/useLocale';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tip } from '@/components/ui/tooltip';
import { fetchReleaseNotes } from '@/release-notes';

// 运行期端点清单(dev/packaged 都在启动阻断后有真值,烘焙兜底已退役)
const websiteUrl = () => window.electronAPI.clientEndpoints.websiteUrl;

interface UpdateBannerProps {
  isCollapsed: boolean;
  /**
   * 打开指定版本的更新公告(UpdateNoticeDialog)。由 MainLayout 的 useUpdateNotice
   * 提供;未传时文字链整体不渲染。
   */
  onOpenVersionNotice?: (version: string) => void;
}

export function UpdateBanner({ isCollapsed, onOpenVersionNotice }: UpdateBannerProps) {
  const { status, version, errorCode } = useUpdateStatus();
  const { effectiveLocale } = useLocale();
  // 用户主动关闭态(仅本次进程内存,由 UserInfoSection 的火焰按钮唤回)。
  // status/version 变化时下面 effect 会自动 restore,新一版更新到达时 banner
  // 重新出现,不会被上一版的 dismiss 状态吞掉。
  const { dismissed, dismiss, restore, isNewUpdateAfterDismiss } = useUpdateBannerDismiss();
  // 就地中断警告态:只在点击入口时探到「有任务在跑」才进入。
  const [confirming, setConfirming] = useState(false);
  // 入口点击的 busy 探针在飞标记 —— 防重入。探针是一次 IPC round trip(毫秒级),所以
  // 刻意不给 loading UI(几毫秒的 spinner 只会闪一下),只用 ref 挡住连点导致的
  // 重复探针 / 重复重启。与 WindowControls 的关窗入口保持同样的「无 loading 态」处理。
  const relaunchProbeRef = useRef(false);
  // 一次点击的有效性令牌。探针是异步的,点击那一刻成立的前提在 resolve 时可能已经不成立:
  // 用户点了右上角「稍后再说」、新版本把已就绪补丁顶成 superseding、组件被卸载,或用户
  // 又点了一次入口。任一情况都让 epoch 前进,在飞的 continuation 靠 epoch 不匹配自我作废。
  // 不作废会有三个真实后果:①点了「稍后」却突然重启;②superseding 期间重启并装回旧补丁;
  // ③dismiss 之后 setConfirming(true) 残留,下次被火焰按钮唤回时直接落在第二步(用户
  // 并没有再点入口)。
  const relaunchEpochRef = useRef(0);
  // continuation 里必须读「当前」status,不能读点击时闭包捕获的旧值。刻意在 render 期间
  // 同步镜像而不是用 effect —— effect 会晚一拍,「status 已 setState 但 effect 未执行」的
  // 区间里探针恰好 resolve 就会读到过期的 'ready'。这个 ref 只做最新值镜像,不参与渲染输出。
  const statusRef = useRef(status);
  statusRef.current = status;
  // 进入确认态后把焦点移到「取消」按钮 —— 键盘用户点入口键后原触发元素会卸载,
  // 若不主动聚焦,焦点会丢失、无法继续操作。刻意聚焦「取消」而非「仍要重启」:让默认落在
  // 安全动作上,避免再按一次 Enter/Space 就打断进行中的任务(即 Radix 对破坏性操作
  // 的默认焦点策略)。展开态与收起态共用同一个 ref(同一时刻只渲染其一)。
  const cancelBtnRef = useRef<HTMLButtonElement>(null);
  // 入口「立即重启」按钮的 ref:取消确认态后把焦点还给它,避免键盘用户退出两步流程时
  // 焦点掉到 body、丢失在侧栏里的位置(对齐原 AlertDialog 关闭时的 restore-focus)。
  const relaunchTriggerRef = useRef<HTMLButtonElement>(null);
  // 标记「这次 confirming 关闭是用户主动取消」——只有此时才需要把焦点还回入口按钮,
  // 区别于 status 变化等其它导致的复位。
  const restoreFocusRef = useRef(false);
  const [showTranslocatedDialog, setShowTranslocatedDialog] = useState(false);
  const { t } = useTranslation();

  const [showSpawnFailedDialog, setShowSpawnFailedDialog] = useState(false);
  // 待安装版本的公告在 CDN 上是否可用 —— 决定文字链是否渲染。
  const [hasNotes, setHasNotes] = useState(false);

  // Show the translocated fallback dialog when the main process reports
  // the app is running from a read-only App Translocation path.
  const isTranslocated = status === 'error' && errorCode === 'translocated';
  const isSpawnFailed = status === 'error' && errorCode === 'updater_spawn_failed';
  const isPreparing = status === 'superseding';

  useEffect(() => {
    if (isSpawnFailed) setShowSpawnFailedDialog(true);
  }, [isSpawnFailed]);

  useEffect(() => {
    if (isTranslocated) setShowTranslocatedDialog(true);
  }, [isTranslocated]);

  // 一旦不再是 ready(如被 superseding 顶掉 / 出错),复位确认态,避免残留一个
  // 指向旧补丁的「仍要重启」;同时作废在飞的探针 —— 它的结论建立在「当前补丁可装」之上。
  useEffect(() => {
    if (status !== 'ready') {
      relaunchEpochRef.current += 1;
      setConfirming(false);
    }
  }, [status]);

  // 卸载时同样作废在飞的探针。卸载后 setConfirming 只是一次无效更新,但 handleRelaunch
  // 会真的把 app 重启掉 —— 这条 cleanup 不是防 React 警告,是防意外重启。
  useEffect(() => () => { relaunchEpochRef.current += 1; }, []);

  // 新更新到达时自动 restore:isNewUpdateAfterDismiss 先检查当前 status 是否为
  // active update 态(ready / superseding),再对比 dismiss 时的快照——两个条件
  // 都满足才 restore(),从而避免 remount 时 useUpdateStatus() 经历 idle→ready
  // 的初始水合过程中误触 restore。
  useEffect(() => {
    if (isNewUpdateAfterDismiss(status, version ?? null)) {
      restore();
    }
  }, [status, version, restore, isNewUpdateAfterDismiss]);

  // 焦点管理:进入确认态 → 聚焦「取消」(安全默认 + 键盘可达);主动取消退出确认态 →
  // 把焦点还给入口「立即重启」按钮,避免焦点掉到 body。
  useEffect(() => {
    if (confirming) {
      cancelBtnRef.current?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      relaunchTriggerRef.current?.focus();
    }
  }, [confirming]);

  // 公告可用性探测。只对 ready 态的具体版本做 —— superseding 时的 version 指向的是
  // 上一个已就绪补丁,不是正在下载的新版,拿它探测会给出错版本的入口。
  // fetchReleaseNotes 在 renderer + main 两层都有缓存,所以这次探测同时也是预热:
  // 用户真点开时命中缓存,不会再打一次 CDN。
  //
  // 两条刻意的收窄:
  //   - 收起 / rail 态不渲染文字链,那就别探测;展开时 isCollapsed 变化会让 effect
  //     重跑,该探测的时候一定会探测到。
  //   - 依赖里用 canOpenNotice 这个布尔量而不是回调本身 —— 回调来自 useUpdateNotice
  //     的 useCallback([t, open]),弹窗每次开关都会换掉它的 identity,直接依赖函数会
  //     让探测跟着弹窗开关反复重跑。
  const canOpenNotice = Boolean(onOpenVersionNotice);
  useEffect(() => {
    if (status !== 'ready' || !version || !canOpenNotice || isCollapsed) {
      setHasNotes(false);
      return;
    }
    let cancelled = false;
    fetchReleaseNotes(version, effectiveLocale)
      .then((notes) => { if (!cancelled) setHasNotes(notes !== null); })
      .catch(() => { if (!cancelled) setHasNotes(false); });
    return () => { cancelled = true; };
  }, [status, version, canOpenNotice, isCollapsed, effectiveLocale]);

  // 取消:先打标记再复位,让上面的 effect 在入口按钮重新挂载后把焦点还回去。
  const handleCancelConfirm = () => {
    restoreFocusRef.current = true;
    setConfirming(false);
  };

  // 用户点 X:整块 banner 收起,同时把确认态一并复位,避免下次通过火焰按钮唤回时
  // 直接落在「确认重启」界面(那是两步流程的第二步,越过第一步显示不合适)。
  // 传入当前 status/version 让 store 记录快照,用于后续区分「同一更新 remount」
  // 与「真正新更新到达」,避免导航到 /settings 再回来时误 restore。
  // 同时作废在飞的探针:用户点「稍后再说」就是明确表达「现在不要重启」,几毫秒后 resolve
  // 的探针结论不能反过来推翻它(否则轻则 confirming 残留、重则直接重启)。
  const handleDismiss = () => {
    relaunchEpochRef.current += 1;
    setConfirming(false);
    dismiss(status, version ?? null);
  };

  // Banner is visible for ready (relaunch available), superseding (preparing
  // a newer version on top of an already-ready patch), or error fallback
  // dialogs. Everything else hides the banner.
  if (status !== 'ready' && !isPreparing && !isTranslocated && !isSpawnFailed) return null;

  // 用户主动 dismiss 后隐藏 banner —— 只作用于 ready/superseding,error 态
  // 只弹 modal 与 dismiss 无关。dismiss 逻辑在 handleDismiss 里把 confirming 一并
  // 复位,这里只负责渲染分支。
  if (dismissed && (status === 'ready' || isPreparing)) return null;

  const handleRelaunch = () => {
    const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
    window.electronAPI.relaunchToUpdate(theme);
  };

  // 入口「立即重启」/ 收起态火焰按钮的点击。展开态与收起态共用一份判定:
  //   - 有任务在跑 → 进 confirming 态,把「会打断进行中的任务」这件事说清楚,由用户拍板;
  //   - 没有        → 直接重启,不再多要一次无信息量的确认。
  //
  // 「有任务在跑」有三个互不相干的来源(逻辑 turn / Claude 后台活动 / Ghost card-action),
  // 判定收在 main 侧一处(relaunchBusyActivity.ts),这里只问一次结论。**刻意不在 renderer
  // 逐个枚举来源** —— 那样每加一个新来源就会漏一次(本 PR review 里连续被指出三轮),
  // 而漏掉的后果是静默打断用户任务。新增来源改 main 侧那一个函数即可,这里不用动。
  // 探针失败 = **无法确认**,不等于「没有任务」。重启会杀掉 in-flight turn,属于不可撤销的
  // 破坏性动作,所以 fail closed:退化成中断警告让用户自己拍板,而不是静默重启。main 侧对每个
  // 来源也各自 fail closed(见 relaunchBusyActivity.ts),这里再兜住整条 IPC 失败的情况。
  // 口径对齐 main 侧托盘退出路径(bootstrap-electron.ts 的 hasActiveTurn:「A failed busy
  // probe must not turn the tray into an unguarded exit path.」)。注意
  // WindowControls.handleCloseClick 的 catch 走的是 false,那条是既有行为,本 PR 不改它,
  // 但新入口不跟随更宽松的那一半。
  //
  // await 之后的两道复核是必需的,不是防御性冗余:探针在飞期间用户可能 dismiss、组件可能
  // 卸载、已就绪补丁可能被 superseding 顶掉。少了它们,「点了稍后却重启」「装回旧补丁」
  // 「confirming 残留到下次唤回」三种都会真实发生。
  const handleRelaunchClick = async (): Promise<void> => {
    if (relaunchProbeRef.current) return;
    relaunchProbeRef.current = true;
    const epoch = relaunchEpochRef.current;
    // 初值取 true:探针没给出可信答案的任何路径(reject、桥同步 throw)都落在保守的那一侧。
    let hasInFlight = true;
    try {
      hasInFlight = await window.electronAPI.anyActivityBlockingRelaunch();
    } catch {
      hasInFlight = true;
    } finally {
      relaunchProbeRef.current = false;
    }
    // 这次点击是否仍然有效(未被 dismiss / 卸载 / status 离开 ready 作废)。
    if (epoch !== relaunchEpochRef.current) return;
    // status 变化的作废由上面那个 effect 打点,但 effect 会晚一拍;这里直接读最新值,
    // 关掉「已 setState 未跑 effect」的那段窗口。两道判定针对同一不变量的不同触发路径。
    if (statusRef.current !== 'ready') return;
    if (hasInFlight) setConfirming(true);
    else handleRelaunch();
  };

  const handleMoveToApplications = () => {
    setShowTranslocatedDialog(false);
    window.electronAPI.moveToApplicationsFolder();
  };

  const handleManualDownload = () => {
    setShowTranslocatedDialog(false);
    window.open(websiteUrl(), '_blank');
  };

  const handleSpawnFailedDownload = () => {
    setShowSpawnFailedDialog(false);
    window.open(websiteUrl(), '_blank');
  };

  // 文字链要显示的版本 —— undefined 即不显示。ready 态之外(superseding / error)没有
  // 可信版本号,confirming 态则刻意让位给两步确认。hasNotes 已经蕴含「ready + 该版本
  // 公告可渲染」,这里再显式列出条件,读代码时不必回溯 effect。
  const notesVersion =
    status === 'ready' && !confirming && hasNotes && version ? version : undefined;

  const versionSuffix = version ? ` (v${version})` : '';
  const versionForAria = version ?? 'latest';

  // Error states (translocated / spawn_failed) suppress the banner body —
  // the only useful UI in those cases is the modal dialog, and the "Updated
  // to vX" body would be misleading (version may be missing, button does
  // nothing because the patch has already been cleared).
  const isErrorOnly = isTranslocated || isSpawnFailed;

  if (isErrorOnly) {
    // onOpenChange is a no-op so the user can't accidentally dismiss the
    // dialog via ESC / outside-click — banner body is hidden in this state
    // so there'd be no way to re-trigger it. Matches SplashScreen's error
    // dialogs. handleManualDownload / handleSpawnFailedDownload still set
    // the open state to false themselves after the user picks an action.
    return (
      <>
        <ConfirmDialog
          open={showTranslocatedDialog}
          onOpenChange={() => {}}
          title={t('update.translocated.title')}
          description={t('update.translocated.description')}
          confirmText={t('update.translocated.move')}
          tertiaryText={t('update.translocated.download')}
          showCancel={false}
          autoFocusConfirm
          onConfirm={handleMoveToApplications}
          onTertiary={handleManualDownload}
        />
        <ConfirmDialog
          open={showSpawnFailedDialog}
          onOpenChange={() => {}}
          title={t('splash.spawnFailed.title')}
          description={t('splash.spawnFailed.description')}
          confirmText={t('splash.spawnFailed.confirm')}
          showCancel={false}
          onConfirm={handleSpawnFailedDownload}
        />
      </>
    );
  }

  // ── Collapsed state: icon only ──
  if (isCollapsed) {
    // 确认态(仅在有任务在跑时出现):上方 ✓(仍要重启,占据原 Flame 图标位置,鼠标零位移),
    // 下方 ✕(取消)。收起态没有文案位置,「会打断进行中的任务」只能落在 ✓ 的 tooltip 上。
    if (confirming && !isPreparing) {
      return (
        <div className="flex flex-col items-center gap-0.5 border-t border-sidebar-border py-1.5">
          <Tip text={t('update.banner.confirmTooltip')} side="right">
            <button
              onClick={handleRelaunch}
              aria-label={t('update.banner.confirmAria')}
              className={cn(
                'flex w-full items-center justify-center py-2 transition-colors',
                // Bare ghost icon on the sidebar — use the readable foreground, not the
                // on-fill pill text color (which is dark-on-dark in E1D neutral themes).
                'text-foreground hover:bg-sidebar-item-hover',
              )}
            >
              <Check className="h-5 w-5" strokeWidth={2.25} />
            </button>
          </Tip>
          <Tip text={t('update.banner.cancelTooltip')} side="right">
            <button
              ref={cancelBtnRef}
              onClick={handleCancelConfirm}
              aria-label={t('update.banner.cancelAria')}
              className={cn(
                'flex w-full items-center justify-center py-2 transition-colors',
                'text-sidebar-muted hover:bg-sidebar-item-hover',
              )}
            >
              <X className="h-5 w-5" strokeWidth={2} />
            </button>
          </Tip>
        </div>
      );
    }

    return (
      <div className="flex flex-col items-center border-t border-sidebar-border">
        <Tip
          text={isPreparing
            ? t('update.banner.preparingTooltip')
            : t('update.banner.tooltipReady', { versionSuffix })}
          side="right"
        >
          <button
            ref={relaunchTriggerRef}
            onClick={() => { if (!isPreparing) void handleRelaunchClick(); }}
            disabled={isPreparing}
            aria-label={isPreparing
              ? t('update.banner.preparingAria')
              : t('update.banner.ariaCollapsed', { version: versionForAria })}
            className={cn(
              'flex w-full items-center justify-center py-2',
              'transition-colors',
              isPreparing
                ? 'cursor-default'
                : 'hover:bg-sidebar-item-hover',
            )}
          >
            <div className="flex items-center justify-center py-1">
              {isPreparing
                ? <Spinner size={20} className="text-sidebar-muted" />
                : <Flame className="h-5 w-5 text-sidebar-muted" />
              }
            </div>
          </button>
        </Tip>
      </div>
    );
  }

  // ── Expanded state: full banner ──
  return (
    <div className="flex select-none flex-col border-t border-sidebar-border">
      <div className="relative flex flex-col items-center gap-[10px] px-4 py-3">
        {/* X dismiss —— 右上角。error 态 body 本就隐藏,superseding 允许 dismiss。
            hover 前 muted、hover 后主色,不抢主视觉;绝对定位保证不影响居中主内容。 */}
        <Tip text={t('update.banner.dismiss')} side="left">
          <button
            onClick={handleDismiss}
            aria-label={t('update.banner.dismissAria')}
            className={cn(
              'absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full',
              'text-sidebar-muted transition-colors hover:bg-sidebar-item-hover hover:text-foreground',
            )}
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </Tip>

        {/* Lead icon — 36px centered. Flame for ready/confirming, spinner for superseding. */}
        {isPreparing
          ? <Spinner size={36} className="text-sidebar-muted" strokeWidth={1.5} />
          : <Flame className="h-9 w-9 text-sidebar-muted" strokeWidth={1.5} />
        }

        {/* Title */}
        <p className="text-sm font-semibold text-foreground">
          {isPreparing
            ? t('update.banner.preparingTitle')
            : confirming
              ? t('update.banner.confirmTitle')
              : t('update.banner.title', { version: version ?? '…' })}
        </p>

        {/* Subtitle + 「查看更新公告」文字链 —— 同一视觉组(gap-1),所以链接读作副标题的
            延伸而不是第三段独立文案;没有链接时这个 wrapper 只有一个子元素,布局与
            加链接前完全一致。 */}
        <div className="flex flex-col items-center gap-1">
          {/* confirming 态一律是「有任务在跑」才进来的,所以警告色与 busy 文案不再分支。 */}
          <p
            className={cn(
              'text-center text-xs',
              !isPreparing && confirming
                ? 'text-[var(--warning-fg)]'
                : 'text-sidebar-muted',
            )}
          >
            {isPreparing
              ? t('update.banner.preparingSubtitle')
              : confirming
                ? t('update.banner.confirmBusyHint')
                : t('update.banner.subtitle')}
          </p>
          {notesVersion && (
            <button
              onClick={() => onOpenVersionNotice?.(notesVersion)}
              aria-label={t('update.banner.viewNotesAria', { version: notesVersion })}
              className={cn(
                'rounded-full text-xs underline underline-offset-2',
                'text-sidebar-muted transition-colors hover:text-foreground',
              )}
            >
              {t('update.banner.viewNotes')}
            </button>
          )}
        </div>

        {/* Actions.
            - superseding: disabled pill + spinner.
            - confirming:  竖排 —— 主按钮「仍要重启」占入口按钮原位(鼠标零位移),
                           「取消」在其下,次级 ghost,需刻意移动 → 打断任务前的最后一道闸。
            - ready:       单个「立即重启」入口 pill,点击后按 busy 探针决定直接重启还是
                           先进中断警告态。 */}
        {isPreparing ? (
          <button
            disabled
            aria-label={t('update.banner.preparingAria')}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-full border py-2',
              'text-13 font-medium',
              'bg-[var(--update-btn-bg)] border-[var(--update-btn-border)] text-[var(--update-btn-text)]',
              'cursor-default opacity-70',
            )}
          >
            <Spinner size={14} />
            {t('update.banner.preparingButton')}
          </button>
        ) : confirming ? (
          <div className="flex w-full flex-col gap-2">
            <button
              onClick={handleRelaunch}
              aria-label={t('update.banner.confirmAria')}
              className={cn(
                'flex w-full items-center justify-center gap-2 rounded-full border py-2',
                'text-13 font-medium transition-colors',
                'bg-[var(--update-btn-bg)] border-[var(--update-btn-border)] text-[var(--update-btn-text)]',
                'hover:bg-[var(--update-btn-hover)]',
              )}
            >
              {t('update.banner.confirmButton')}
            </button>
            <button
              ref={cancelBtnRef}
              onClick={handleCancelConfirm}
              aria-label={t('update.banner.cancelAria')}
              className={cn(
                'flex w-full items-center justify-center rounded-full py-1.5',
                'text-13 font-medium text-sidebar-muted transition-colors',
                'hover:bg-sidebar-item-hover',
              )}
            >
              {t('update.banner.cancel')}
            </button>
          </div>
        ) : (
          <button
            ref={relaunchTriggerRef}
            onClick={() => { void handleRelaunchClick(); }}
            aria-label={t('update.banner.ariaExpanded', { version: version ?? '' })}
            className={cn(
              'flex w-full items-center justify-center gap-2 rounded-full border py-2',
              'text-13 font-medium transition-colors',
              'bg-[var(--update-btn-bg)] border-[var(--update-btn-border)] text-[var(--update-btn-text)]',
              'hover:bg-[var(--update-btn-hover)]',
            )}
          >
            {t('update.banner.button')}
          </button>
        )}
      </div>
    </div>
  );
}
