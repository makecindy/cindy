import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Minus, Square, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { isSecondaryWindow } from '@/lib/secondaryWindow';
import { isSidebarWindow } from '@/lib/sidebarWindow';
import { isGhostPanelWindow } from '@/lib/ghostPanelWindow';
import type { WindowsCloseBehavior } from '../../../shared/windowBehavior';

interface WindowControlsProps {
  /**
   * Tailwind text color class for the icons. Defaults to the title-bar
   * warm-gray token so LoginPage / regular title bars stay unchanged.
   * Splash screens override this with `text-[hsl(var(--splash-text))]`
   * to match the Stone/Silver tones from docs/design-rules/cindy-design-system.md.
   */
  iconClassName?: string;
}

const DEFAULT_ICON_CLASS = 'text-titlebar-icon';

export function WindowControls({
  iconClassName = DEFAULT_ICON_CLASS,
}: WindowControlsProps = {}) {
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [showWindowsCloseBehaviorDialog, setShowWindowsCloseBehaviorDialog] = useState(false);
  const [savingWindowsCloseBehavior, setSavingWindowsCloseBehavior] = useState(false);
  const savingWindowsCloseBehaviorRef = useRef(false);
  const windowsCloseBehaviorDialogVisibleRef = useRef(false);
  // 点 X 后 (无论走确认框还是直接关) 进入不可取消的 closing 态:
  //   - 有 in-flight turn 路径: ConfirmDialog 显示 loading spinner + 锁住关闭
  //   - 无 in-flight 路径:      全屏 ClosingOverlay 显示 spinner + "正在关闭…"
  // 期间 main 端走 disposer chain (~4-5s, 受 db.backup 体积影响), 完成后窗口/进程退出。
  // closingRef 与 setClosing 同步设置,用来让 onOpenChange 在 Radix Action
  // 同步触发的 onOpenChange(false) 里也能立刻拦住 (state 还没 flush 到 props)。
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const { t } = useTranslation();

  useEffect(() => {
    if (
      window.electronAPI.platform !== 'win32' ||
      isSecondaryWindow() ||
      isSidebarWindow() ||
      isGhostPanelWindow()
    )
      return;
    return window.electronAPI.windowBehavior.onWindowsCloseBehaviorRequested(() => {
      if (windowsCloseBehaviorDialogVisibleRef.current) {
        window.electronAPI.windowBehavior.notifyWindowsCloseBehaviorPromptShown();
        return;
      }
      setShowWindowsCloseBehaviorDialog(true);
    });
  }, []);

  useEffect(() => {
    windowsCloseBehaviorDialogVisibleRef.current = showWindowsCloseBehaviorDialog;
    if (showWindowsCloseBehaviorDialog && window.electronAPI.platform === 'win32') {
      window.electronAPI.windowBehavior.notifyWindowsCloseBehaviorPromptShown();
    }
  }, [showWindowsCloseBehaviorDialog]);

  const controlBase = cn(
    'flex items-center justify-center',
    'h-9 w-[46px]',
    iconClassName,
    'transition-colors',
  );

  // 进入 closing 态 + 调 main 端关闭。同时被"点 X 无 in-flight 直走"和 ConfirmDialog
  // 的 onConfirm 调用,共用一份语义。幂等: closingRef 守住重复调用。
  const beginClose = (): void => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    window.electronAPI.windowClose();
  };

  const continueCloseWithBehavior = async (behavior: WindowsCloseBehavior): Promise<void> => {
    if (behavior === 'tray') {
      window.electronAPI.windowClose();
      return;
    }

    let hasInFlight = false;
    try {
      hasInFlight = await window.electronAPI.anySessionInTurn();
    } catch {
      hasInFlight = false;
    }
    if (hasInFlight) {
      setShowCloseDialog(true);
    } else {
      beginClose();
    }
  };

  const selectWindowsCloseBehavior = async (
    behavior: WindowsCloseBehavior,
  ): Promise<void> => {
    if (savingWindowsCloseBehaviorRef.current) return;
    savingWindowsCloseBehaviorRef.current = true;
    setSavingWindowsCloseBehavior(true);
    try {
      await window.electronAPI.windowBehavior.setWindowsCloseBehavior(behavior);
      setShowWindowsCloseBehaviorDialog(false);
      await continueCloseWithBehavior(behavior);
    } catch {
      // 弹窗尚未关闭；持久化失败时保留它，不带着未知行为进入关闭流程。
    } finally {
      savingWindowsCloseBehaviorRef.current = false;
      setSavingWindowsCloseBehavior(false);
    }
  };

  // 点 X 的入口: Windows 首次关闭先在 renderer 内选择关闭行为,之后再查是否
  // 有 in-flight turn。系统 Alt+F4 / 任务栏关闭由 main 发同一个 request 事件,
  // 复用这里的自绘弹窗与后续关闭流程。
  //   - 有 → 走 ConfirmDialog 确认 (防止误关丢未完成的 turn)
  //   - 无 → 直接 beginClose, 全屏 overlay 反馈 (跳过一次点击)
  //
  // splash / login 阶段 maker-ipc handler 还没注册, invoke 会 reject ——
  // catch 后当作 false 处理 (那个阶段本来就不可能有 in-flight)。
  const handleCloseClick = async (): Promise<void> => {
    // 「在新窗口打开」的副窗口 / 右侧栏子窗口 / 插件面板子窗口:关闭只关本窗
    // (会话活在主进程,不受影响),不退出 app,也没有 disposer chain,所以跳过
    // in-flight 确认框 + 全屏 closing overlay,直接调 windowClose(main 端按
    // sender 解析为 win.close())。
    if (isSecondaryWindow() || isSidebarWindow() || isGhostPanelWindow()) {
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
        setShowWindowsCloseBehaviorDialog(true);
        return;
      }
      await continueCloseWithBehavior(closeBehavior);
      return;
    }
    await continueCloseWithBehavior('quit');
  };

  return (
    <>
      <div className="flex">
        <button
          className={cn(controlBase, 'hover:bg-titlebar-control-hover')}
          onClick={() => window.electronAPI.windowMinimize()}
          aria-label={t('titleBar.minimize')}
        >
          <Minus size={16} />
        </button>
        <button
          className={cn(controlBase, 'hover:bg-titlebar-control-hover')}
          onClick={() => window.electronAPI.windowMaximize()}
          aria-label={t('titleBar.maximize')}
        >
          <Square size={14} />
        </button>
        <button
          className={cn(controlBase, 'hover:bg-[#E81123] hover:text-white')}
          onClick={() => void handleCloseClick()}
          aria-label={t('titleBar.close')}
          disabled={closing}
        >
          <X size={16} />
        </button>
      </div>
      <ConfirmDialog
        open={showWindowsCloseBehaviorDialog}
        onOpenChange={(next) => {
          // 首次关闭必须明确选择；ESC / 点击遮罩不应静默写入默认值或关窗。
          if (next) setShowWindowsCloseBehaviorDialog(true);
        }}
        title={t('settings.windowBehavior.closePrompt.title')}
        description={t('settings.windowBehavior.closePrompt.message')}
        content={
          <p className="text-sm leading-6 text-[var(--confirm-desc)]">
            {t('settings.windowBehavior.closePrompt.detail')}
          </p>
        }
        confirmText={t('settings.windowBehavior.closeBehavior.tray')}
        cancelText={t('settings.windowBehavior.closeBehavior.quit')}
        autoFocusConfirm
        loading={savingWindowsCloseBehavior}
        onConfirm={() => void selectWindowsCloseBehavior('tray')}
        onCancel={() => void selectWindowsCloseBehavior('quit')}
      />
      <ConfirmDialog
        open={showCloseDialog}
        onOpenChange={(next) => {
          // loading 期间 Radix Action 的同步 onOpenChange(false) / Cancel /
          // 外部状态变化都一律不放过 —— 弹框必须留着直到进程死。
          if (closingRef.current && !next) return;
          setShowCloseDialog(next);
        }}
        title={t('titleBar.closeConfirm.title')}
        description={t('titleBar.closeConfirm.description')}
        confirmText={t('titleBar.closeConfirm.confirm')}
        cancelText={t('titleBar.closeConfirm.cancel')}
        loading={closing}
        onConfirm={beginClose}
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
        className="flex items-center gap-2 rounded-full border border-[var(--border-default)] px-4 py-2 shadow-sm"
        style={{ background: 'var(--surface-elevated)' }}
      >
        <Spinner size={16} className="text-[var(--text-primary)]" />
        <span className="text-sm text-[var(--text-primary)]">
          {t('titleBar.closing.title')}
        </span>
      </div>
    </div>,
    document.body,
  );
}
