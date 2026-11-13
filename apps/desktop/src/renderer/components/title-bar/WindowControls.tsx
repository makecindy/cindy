import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isResourceUsageWindow } from '@/lib/resourceUsageWindow';
import type {
  LinuxCloseBehavior,
  TitleBarQuitOutcome,
  WindowsCloseBehavior,
} from '../../../shared/windowBehavior';

type DesktopCloseBehavior = LinuxCloseBehavior | WindowsCloseBehavior;

interface WindowControlsProps {
  /**
   * Tailwind text color class for the icons. Defaults to the title-bar
   * warm-gray token so LoginPage / regular title bars stay unchanged.
   * Splash screens override this with `text-[hsl(var(--splash-text))]`
   * to match the Stone/Silver tones from docs/design-rules/cindy-design-system.md.
   */
  iconClassName?: string;
  /** Override the default minimize action for an auxiliary window. */
  onMinimize?: () => void | Promise<void>;
  /** Hide minimize when the current surface explicitly opts out of that action. */
  showMinimize?: boolean;
  /** Override the default close action for an auxiliary window. */
  onClose?: () => void | Promise<void>;
}

const DEFAULT_ICON_CLASS = 'text-titlebar-icon';

/**
 * True when this renderer is served by `cindy-host` into a browser tab.
 *
 * A tab already has the browser's own chrome, so drawing minimize/maximize/close
 * here would duplicate those buttons and target a window that does not exist.
 * The flag is set by the host shim before the app module runs.
 */
function isHostServedWebClient(): boolean {
  return Boolean((window as unknown as { __CINDY_HOST_WEB__?: boolean }).__CINDY_HOST_WEB__);
}

/** Tell main the title-bar quit confirmation it recorded for this window was dismissed. */
function cancelPendingQuitConfirmation(pending: { current: boolean }): void {
  if (!pending.current) return;
  pending.current = false;
  void window.electronAPI.windowBehavior.resolveQuitConfirmation(false).catch(() => {});
}

export function WindowControls({
  iconClassName = DEFAULT_ICON_CLASS,
  onMinimize,
  showMinimize = true,
  onClose,
}: WindowControlsProps = {}) {
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showCloseBehaviorDialog, setShowCloseBehaviorDialog] = useState(false);
  const [savingCloseBehavior, setSavingCloseBehavior] = useState(false);
  const savingCloseBehaviorRef = useRef(false);
  const closeBehaviorDialogVisibleRef = useRef(false);
  // main 答复已开始退出后 (无论走确认框还是直接关) 进入不可取消的 closing 态:
  //   - 有 in-flight turn 路径: ConfirmDialog 显示 loading spinner + 锁住关闭
  //   - 无 in-flight 路径:      全屏 ClosingOverlay 显示 spinner + "正在关闭…"
  // 期间 main 端走 disposer chain (~4-5s, 受 db.backup 体积影响), 完成后窗口/进程退出。
  // closingRef / resolvingQuitRef 与对应 state 同步设置,用来让 onOpenChange 在 Radix
  // Action 同步触发的 onOpenChange(false) 里也能立刻拦住 (state 还没 flush 到 props)。
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  // 确认框里点了「退出」、正在等 main 答复(main 可能还要弹自己的确认):按钮转圈、
  // 弹框不可关,答复不是 'quitting' 时再收起,不会卡在 closing 态。
  const [resolvingQuit, setResolvingQuit] = useState(false);
  const resolvingQuitRef = useRef(false);
  // main 为本窗记着一次待答的退出确认(requestQuit 答 'confirm' 后)。弹框以任何方式
  // 收起或组件卸载都要回报取消,main 才会让 Alt+F4 / 托盘退出恢复原生确认。
  const quitConfirmationPendingRef = useRef(false);
  const { t } = useTranslation();

  // requestQuit 的答复可能在本实例卸载后才到(如登录页 / 主界面切换)。
  const mountedRef = useRef(false);
  const cancelQuitConfirmation = (): void =>
    cancelPendingQuitConfirmation(quitConfirmationPendingRef);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingQuitConfirmation(quitConfirmationPendingRef);
    };
  }, []);

  useEffect(() => {
    if (
      onClose ||
      (window.electronAPI.platform !== 'win32' && window.electronAPI.platform !== 'linux') ||
      isSecondaryWindow() ||
      isSidebarWindow() ||
      isResourceUsageWindow()
    )
      return;
    const onCloseBehaviorRequested = (): void => {
      if (closeBehaviorDialogVisibleRef.current) {
        if (window.electronAPI.platform === 'win32') {
          window.electronAPI.windowBehavior.notifyWindowsCloseBehaviorPromptShown();
        } else {
          window.electronAPI.windowBehavior.notifyLinuxCloseBehaviorPromptShown();
        }
        return;
      }
      setShowCloseBehaviorDialog(true);
    };
    return window.electronAPI.platform === 'win32'
      ? window.electronAPI.windowBehavior.onWindowsCloseBehaviorRequested(onCloseBehaviorRequested)
      : window.electronAPI.windowBehavior.onLinuxCloseBehaviorRequested(onCloseBehaviorRequested);
  }, [onClose]);

  useEffect(() => {
    closeBehaviorDialogVisibleRef.current = showCloseBehaviorDialog;
    if (!showCloseBehaviorDialog) return;
    if (window.electronAPI.platform === 'win32') {
      window.electronAPI.windowBehavior.notifyWindowsCloseBehaviorPromptShown();
    } else if (window.electronAPI.platform === 'linux') {
      window.electronAPI.windowBehavior.notifyLinuxCloseBehaviorPromptShown();
    }
  }, [showCloseBehaviorDialog]);

  const controlBase = cn(
    'flex items-center justify-center',
    'h-7 w-7',
    iconClassName,
    'transition-colors',
  );

  const handleMinimizeClick = (): void => {
    if (onMinimize) {
      void onMinimize();
      return;
    }
    window.electronAPI.windowMinimize();
  };

  // main 已开始退出后才进入不可取消的 closing 态(无 in-flight 直走 / 确认后退出共用)。
  const enterClosing = (): void => {
    closingRef.current = true;
    setClosing(true);
  };

  // ConfirmDialog 的「退出」。main 只认它自己记下的那次确认;没有记录(已被重置)时
  // main 改走自己的确认,用户在那里取消就收起本弹框。
  const confirmQuit = async (): Promise<void> => {
    if (closingRef.current || resolvingQuitRef.current) return;
    resolvingQuitRef.current = true;
    setResolvingQuit(true);
    quitConfirmationPendingRef.current = false;
    let outcome: TitleBarQuitOutcome = 'none';
    try {
      outcome = await window.electronAPI.windowBehavior.resolveQuitConfirmation(true);
    } catch {
      // 答复没送达时 main 可能还记着这次确认,补一次取消,别让它挡住别的退出入口。
      void window.electronAPI.windowBehavior.resolveQuitConfirmation(false).catch(() => {});
    }
    resolvingQuitRef.current = false;
    setResolvingQuit(false);
    if (outcome === 'quitting') {
      enterClosing();
    } else {
      setShowCloseDialog(false);
    }
  };

  const continueCloseWithBehavior = async (behavior: DesktopCloseBehavior): Promise<void> => {
    if (behavior === 'tray') {
      window.electronAPI.windowClose();
      return;
    }
    if (behavior === 'minimize') {
      window.electronAPI.windowMinimize();
      return;
    }

    // main 自己判定有无 turn 并当场执行(与托盘退出 / Alt+F4 同一个守卫,判定失败按忙)。
    let outcome: TitleBarQuitOutcome;
    try {
      outcome = await window.electronAPI.windowBehavior.requestQuit();
    } catch {
      // 请求没送达:交给 window-close,由 main 按关闭行为处理并在需要时弹原生确认。
      // 不进 closing 态 —— 用户在原生确认里取消时窗口要照常可用。
      window.electronAPI.windowClose();
      return;
    }
    if (!mountedRef.current) {
      // 本实例已卸载,没人会画 main 刚记下的确认:立即取消,别让它挡住 Alt+F4 / 托盘退出。
      if (outcome === 'confirm') {
        void window.electronAPI.windowBehavior.resolveQuitConfirmation(false).catch(() => {});
      }
      return;
    }
    if (outcome === 'quitting') {
      enterClosing();
    } else if (outcome === 'confirm') {
      quitConfirmationPendingRef.current = true;
      setShowCloseDialog(true);
    }
  };

  const selectCloseBehavior = async (behavior: DesktopCloseBehavior): Promise<void> => {
    if (savingCloseBehaviorRef.current) return;
    savingCloseBehaviorRef.current = true;
    setSavingCloseBehavior(true);
    try {
      if (window.electronAPI.platform === 'linux') {
        await window.electronAPI.windowBehavior.setLinuxCloseBehavior(
          behavior === 'minimize' ? behavior : 'quit',
        );
      } else {
        await window.electronAPI.windowBehavior.setWindowsCloseBehavior(
          behavior === 'tray' ? behavior : 'quit',
        );
      }
      setShowCloseBehaviorDialog(false);
      await continueCloseWithBehavior(behavior);
    } catch {
      // 弹窗尚未关闭；持久化失败时保留它，不带着未知行为进入关闭流程。
    } finally {
      savingCloseBehaviorRef.current = false;
      setSavingCloseBehavior(false);
    }
  };

  // 点 X 的入口: Windows 首次关闭先在 renderer 内选择关闭行为,之后再请求 main 退出。
  // 系统 Alt+F4 / 任务栏关闭由 main 发同一个 request 事件,复用这里的自绘弹窗与后续
  // 关闭流程。main 判定:
  //   - 有 in-flight turn → 'confirm',走 ConfirmDialog 确认 (防止误关丢未完成的 turn)
  //   - 无 → main 当场退出,答 'quitting',全屏 overlay 反馈 (跳过一次点击)
  //
  // 请求走 main 的窗口 IPC(启动即注册), splash / login 阶段 Maker 未构造时
  // 直接按"无"退出, 不会弹多余的确认。
  const handleCloseClick = async (): Promise<void> => {
    if (onClose) {
      await onClose();
      return;
    }
    // 「在新窗口打开」的副窗口 / 右侧栏子窗口 / 插件面板子窗口:关闭只关本窗
    // (会话活在主进程,不受影响),不退出 app,也没有 disposer chain,所以跳过
    // in-flight 确认框 + 全屏 closing overlay,直接调 windowClose(main 端按
    // sender 解析为 win.close())。
    if (
      isSecondaryWindow() ||
      isSidebarWindow() ||
      isResourceUsageWindow()
    ) {
      window.electronAPI.windowClose();
      return;
    }
    if (window.electronAPI.platform === 'win32') {
      let closeBehavior: WindowsCloseBehavior | null = null;
      try {
        closeBehavior = await window.electronAPI.windowBehavior.getWindowsCloseBehavior();
      } catch {
        // Main close handler remains the final authority for the persisted behavior.
      }
      if (!closeBehavior) {
        setShowCloseBehaviorDialog(true);
        return;
      }
      await continueCloseWithBehavior(closeBehavior);
      return;
    }
    if (window.electronAPI.platform === 'linux') {
      let closeBehavior: LinuxCloseBehavior | null = null;
      try {
        closeBehavior = await window.electronAPI.windowBehavior.getLinuxCloseBehavior();
      } catch {
        // Main close handler remains the final authority for the persisted behavior.
      }
      if (!closeBehavior) {
        setShowCloseBehaviorDialog(true);
        return;
      }
      await continueCloseWithBehavior(closeBehavior);
      return;
    }
    await continueCloseWithBehavior('quit');
  };

  const keepRunningBehavior: Exclude<DesktopCloseBehavior, 'quit'> =
    window.electronAPI.platform === 'linux' ? 'minimize' : 'tray';

  // Browser tab: no desktop window chrome to control (see isHostServedWebClient).
  if (isHostServedWebClient()) return null;

  return (
    <>
      <div className="flex gap-0.5">
        {showMinimize && (
          <button
            className={cn(controlBase, 'hover:bg-titlebar-control-hover')}
            onClick={handleMinimizeClick}
            aria-label={t('titleBar.minimize')}
            data-tooltip-exempt="windows-system-control"
          >
            <Minus size={14} />
          </button>
        )}
        <button
          className={cn(controlBase, 'hover:bg-titlebar-control-hover')}
          onClick={() => window.electronAPI.windowMaximize()}
          aria-label={t('titleBar.maximizeOrRestore')}
          data-tooltip-exempt="windows-system-control"
        >
          <Square size={14} />
        </button>
        {closing ? (
          <span
            role="button"
            aria-disabled="true"
            aria-label={t('titleBar.closing.title')}
            tabIndex={0}
            data-tooltip-exempt="windows-system-control"
            className="inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          >
            <button
              className={cn(controlBase, 'hover:bg-[#E81123] hover:text-white')}
              aria-hidden="true"
              disabled
            >
              <X size={14} />
            </button>
          </span>
        ) : (
          <button
            className={cn(controlBase, 'hover:bg-[#E81123] hover:text-white')}
            onClick={() => void handleCloseClick()}
            aria-label={t('titleBar.close')}
            data-tooltip-exempt="windows-system-control"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <ConfirmDialog
        open={showCloseBehaviorDialog}
        onOpenChange={(next) => {
          // Dismissal cancels this close request without saving a choice or closing the window.
          if (savingCloseBehaviorRef.current && !next) return;
          setShowCloseBehaviorDialog(next);
        }}
        showCloseButton
        title={t('settings.windowBehavior.closePrompt.title')}
        description={t('settings.windowBehavior.closePrompt.message')}
        content={
          <p className="text-sm leading-6 text-[var(--confirm-desc)]">
            {t(
              window.electronAPI.platform === 'linux'
                ? 'settings.windowBehavior.closePrompt.linuxDetail'
                : 'settings.windowBehavior.closePrompt.detail',
            )}
          </p>
        }
        confirmText={t(`settings.windowBehavior.closeBehavior.${keepRunningBehavior}`)}
        cancelText={t('settings.windowBehavior.closeBehavior.quit')}
        autoFocusConfirm
        loading={savingCloseBehavior}
        onConfirm={() => void selectCloseBehavior(keepRunningBehavior)}
        onCancel={() => void selectCloseBehavior('quit')}
      />
      <ConfirmDialog
        open={showCloseDialog}
        onOpenChange={(next) => {
          // 「退出」之后(等 main 答复 / 已在退出)Radix Action 的同步 onOpenChange(false) /
          // Cancel / 外部状态变化都一律不放过 —— 退出时弹框必须留着直到进程死。
          if ((closingRef.current || resolvingQuitRef.current) && !next) return;
          // 取消 / Esc 等任何收起都回报 main,清掉它记着的这次确认。
          if (!next) cancelQuitConfirmation();
          setShowCloseDialog(next);
        }}
        title={t('titleBar.closeConfirm.title')}
        description={t('titleBar.closeConfirm.description')}
        confirmText={t('titleBar.closeConfirm.confirm')}
        cancelText={t('titleBar.closeConfirm.cancel')}
        loading={closing || resolvingQuit}
        onConfirm={() => void confirmQuit()}
      />
      <ClosingOverlay visible={closing && !showCloseDialog} />
    </>
  );
}

/**
 * 全屏 closing 反馈层 —— 无 in-flight 直接关闭路径专用 (有 in-flight 时由 ConfirmDialog
 * 自己显示 loading spinner, 不需要这层避免双层 spinner)。
 *
 * 视觉方案: 整窗轻 dim + 中央 capsule (浮卡 + spinner + 单行文字), 用户选定的方案 B
 * (vs 全屏强 dim 双行文字 vs 顶部进度条 vs 标题栏 inline)。内容可见但锁定操作。
 *
 * 走 Portal 渲染到 document.body, 与 title-bar 解耦, 保证整窗 (含其它 modal 之上) 覆盖。
 * 整窗 dim 用极轻的 rgba(0,0,0,0.2) (比 `--overlay-modal` 的 0.5 更克制),
 * capsule bg 用 `--surface-elevated` 主题 token (规则 18), light/dark 自动适配。
 * 不响应点击 / 键盘 / region drag, 锁住所有交互直到进程退出。
 */
function ClosingOverlay({ visible }: { visible: boolean }) {
  const { t } = useTranslation();
  if (!visible) return null;
  return createPortal(
    <div
      // z-[10000]: 高于 splash 的 z-[9999], 保证退出 overlay 永远在最顶层
      className="fixed inset-0 z-[10000] flex select-none items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.2)' }}
      role="alertdialog"
      aria-live="polite"
      aria-label={t('titleBar.closing.title')}
    >
      <div
        className="flex items-center gap-2 rounded-full border border-[var(--border-default)] px-4 py-2 shadow-[shadow:var(--shadow-menu)]"
        style={{ background: 'var(--surface-elevated)' }}
      >
        <Spinner size={16} className="text-[var(--text-primary)]" />
        <span className="text-sm text-[var(--text-primary)]">{t('titleBar.closing.title')}</span>
      </div>
    </div>,
    document.body,
  );
}
