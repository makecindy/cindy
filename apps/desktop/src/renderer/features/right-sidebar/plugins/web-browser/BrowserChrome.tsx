/**
 * BrowserChrome —— web-browser tab 的 40px 顶部工具栏。
 *
 * 视觉结构:
 *   ┌────────────────────────────────────────────────────────────────┐
 *   │ ← → ↻   [🔒  https://github.com           ⭐]   ⋯              │  40px
 *   └────────────────────────────────────────────────────────────────┘
 *
 *   - 左:24×24 前进 / 后退 / 刷新(disabled 半透明)
 *   - 中:28px 高 URL pill,`--surface-elevated` + 1px border + 圆角(rounded-full),
 *         lock icon 居左、URL/title 居中、star 居右
 *   - 右:24×24 download / ellipsis(Phase 5 范围内只渲染占位,实际无 action)
 *
 * 不提供 newtab quick-link 卡片,所以 URL bar 常驻、URL 输入
 * 框跟显示框是同一个(点 / focus 就能编辑)。
 *
 * URL bar 自身要支持:
 *   - 点 → 进入编辑态(text input)
 *   - Enter → parseOmnibox + navigate
 *   - Esc → 退出编辑回到 url 显示态
 *   - blur → 同 Esc
 *
 * Cmd/Ctrl+L 焦点快捷键由 BrowserTabBody 顶层 keydown 处理,这里只暴露 imperative
 * focus 入口。
 */

import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Ellipsis,
  ExternalLink,
  Link as LinkIcon,
  Lock,
  MessageSquarePlus,
  RotateCw,
  Unlock,
  X as XIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import { parseOmnibox } from './lib/parseOmnibox';

export interface BrowserChromeProps {
  url: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onNavigate: (url: string) => void;
  onReload: () => void;
  onStop: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  /** 截图按钮:capturePage → 剪贴板(main 端执行);反馈由 TabBody 做(成功/失败 toast)。 */
  onCaptureScreenshot: () => void;
  /** 页面评论按钮 active 态(评论模式进行中,点按可退出)。 */
  commentActive: boolean;
  /** 页面评论按钮:进入 / 退出评论模式,流程由 TabBody 的 useBrowserComment 驱动。 */
  onToggleComment: () => void;
  /**
   * 是否支持页面评论(default true)。评论的落点是 composer 的「N 条注释」胶囊,
   * 而 detached 独立子窗口(SidebarWindowLayout)根本不挂 ChatInput / composer,
   * 评论写进去无处可发(且会误弹成功 toast)——故子窗口传 false 隐藏该按钮。
   */
  commentSupported?: boolean;
  /** 当前页是否能交给系统默认浏览器打开。 */
  canOpenInSystemBrowser: boolean;
  /** 「更多」菜单项:用系统默认浏览器打开当前页(main 端 shell.openExternal)。 */
  onOpenInSystemBrowser: () => void;
  /** 「更多」菜单项:复制当前页链接到剪贴板(反馈 toast 由 TabBody 做)。 */
  onCopyLink: () => void;
  /** 原生 popup view 必须在 renderer portal 打开时暂时让出层叠空间。 */
  onOverlayOpenChange?: (open: boolean) => void;
}

/** Imperative ref —— 父组件(BrowserTabBody)用 keydown 监听 Cmd/Ctrl+L,调
 *  `focusUrlBar()` 把焦点跳到地址栏并全选 URL,跟 Chrome 行为对齐。 */
export interface BrowserChromeHandle {
  focusUrlBar: () => void;
}

export const BrowserChrome = forwardRef<BrowserChromeHandle, BrowserChromeProps>(
  function BrowserChrome(
    {
      url,
      isLoading,
      canGoBack,
      canGoForward,
      onNavigate,
      onReload,
      onStop,
      onGoBack,
      onGoForward,
      onCaptureScreenshot,
      commentActive,
      onToggleComment,
      commentSupported = true,
      canOpenInSystemBrowser,
      onOpenInSystemBrowser,
      onCopyLink,
      onOverlayOpenChange,
    },
    ref,
  ) {
    const { t } = useTranslation();

    // URL pill 编辑态 —— 点 / focus 进入,Enter / Esc / blur 退出。
    // editingValue 是编辑态的临时 buffer,提交才 onNavigate 出去。
    const [editing, setEditing] = useState(false);
    const [editingValue, setEditingValue] = useState('');
    const inputRef = useRef<HTMLInputElement | null>(null);
    const suppressNextBlurSubmitRef = useRef(false);

    // 进入编辑态时只负责 focus/select。editingValue 在 beginEdit 同步写入,避免
    // input 首帧先显示空值 / 旧值、下一帧再跳成 URL 的视觉闪动。
    useLayoutEffect(() => {
      if (editing) {
        requestAnimationFrame(() => {
          inputRef.current?.focus();
          inputRef.current?.select();
        });
      }
    }, [editing]);

    const beginEdit = useCallback(() => {
      suppressNextBlurSubmitRef.current = false;
      setEditingValue(url);
      setEditing(true);
    }, [url]);
    const exitEdit = useCallback(() => setEditing(false), []);

    // 暴露 imperative API:Cmd/Ctrl+L 由 BrowserTabBody 监听 keydown 调到这里。
    // 行为:进编辑态 + 下一帧 select all(focus+select 的副作用在 editing effect 里)。
    useImperativeHandle(
      ref,
      () => ({
        focusUrlBar: beginEdit,
      }),
      [beginEdit],
    );

    const submitValue = useCallback(
      (value: string, options?: { ctrlEnter?: boolean }) => {
        const next = parseOmnibox(value, options);
        onNavigate(next);
        setEditing(false);
      },
      [onNavigate],
    );

    const ignoreNextBlurSubmit = useCallback(() => {
      suppressNextBlurSubmitRef.current = true;
    }, []);

    const handleBlur = useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        if (suppressNextBlurSubmitRef.current) {
          suppressNextBlurSubmitRef.current = false;
          return;
        }
        submitValue(e.currentTarget.value);
      },
      [submitValue],
    );

    const handleKey = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          ignoreNextBlurSubmit();
          const value = e.currentTarget.value;
          if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
            submitValue(value, { ctrlEnter: true });
          } else {
            submitValue(value);
          }
        } else if (e.key === 'Escape') {
          e.preventDefault();
          ignoreNextBlurSubmit();
          exitEdit();
        }
      },
      [ignoreNextBlurSubmit, submitValue, exitEdit],
    );

    // URL pill 显示态展示:about:blank / 空 → 显示"新标签"占位文案,否则显示 URL。
    // 长 URL 截断走 CSS truncate。
    const displayValue = url && url !== 'about:blank' ? url : t('rightSidebar.browser.newTab');

    // 是否 https:左侧 lock icon 决定。about:blank 等非 web 协议显示 unlock 占位。
    const isSecure = url.startsWith('https://');

    // 「更多」菜单里复制链接只要求有有效页面 URL;系统浏览器打开还要由宿主确认
    // 当前协议/页面类型有对应的安全 IPC 能力。比如本地 HTML 走 openFileInBrowser,
    // 其它 file/data/custom scheme 不应显示一个点击必失败的可用菜单项。
    const hasValidLink = Boolean(url) && url !== 'about:blank';

    return (
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--border-default)] bg-content-area px-2">
        {/* 左:导航按钮 */}
        <ChromeIconButton
          icon={ArrowLeft}
          disabled={!canGoBack}
          onClick={onGoBack}
          tooltip={t('rightSidebar.browser.goBack')}
          disabledTooltip={t('rightSidebar.browser.goBackUnavailable')}
        />
        <ChromeIconButton
          icon={ArrowRight}
          disabled={!canGoForward}
          onClick={onGoForward}
          tooltip={t('rightSidebar.browser.goForward')}
          disabledTooltip={t('rightSidebar.browser.goForwardUnavailable')}
        />
        <ChromeIconButton
          icon={RotateCw}
          reducedMotionIcon={isLoading ? XIcon : undefined}
          spinning={isLoading}
          onClick={isLoading ? onStop : onReload}
          tooltip={isLoading ? t('rightSidebar.browser.stop') : t('rightSidebar.browser.reload')}
        />

        {/* 中:URL pill */}
        <div
          className={cn(
            'mx-1 flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-full border',
            'bg-[var(--surface-elevated)] px-2.5',
            editing
              ? 'border-[var(--focus-ring)] ring-1 ring-[var(--focus-ring-soft)]'
              : 'border-[var(--border-default)]',
          )}
        >
          {isSecure ? (
            <Lock size={11} strokeWidth={2} className="shrink-0 text-[var(--text-tertiary)]" />
          ) : (
            <Unlock size={11} strokeWidth={2} className="shrink-0 text-[var(--text-tertiary)]" />
          )}
          {editing ? (
            <input
              ref={inputRef}
              type="text"
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              onKeyDown={handleKey}
              onBlur={handleBlur}
              placeholder={t('rightSidebar.browser.urlPlaceholder')}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-12 leading-none text-[var(--text-primary)]',
                'placeholder:text-[var(--text-tertiary)] outline-none',
              )}
            />
          ) : (
            <button
              type="button"
              onClick={beginEdit}
              // 整个 pill 中部区域都可点 → 进编辑态。truncate 让长 URL 单行省略。
              className="min-w-0 flex-1 truncate text-left text-12 leading-none text-[var(--text-primary)]"
              title={url}
              data-native-title="truncated-text"
            >
              {displayValue}
            </button>
          )}
        </div>
        {/* 右侧工具区交互约定:
          camera = 截图(capturePage → 剪贴板,已实现);
          message-square-plus = 页面评论(评论模式点选元素 → 评论进 composer,
          已实现,active 态高亮);ellipsis = 更多菜单(系统浏览器打开 / 复制链接)。 */}
        <ChromeIconButton
          icon={Camera}
          onClick={onCaptureScreenshot}
          tooltip={t('rightSidebar.browser.screenshot')}
        />
        {/* detached 子窗口无 composer,评论无处落点 —— 直接不渲染该按钮。 */}
        {commentSupported && (
          <ChromeIconButton
            icon={MessageSquarePlus}
            active={commentActive}
            onClick={onToggleComment}
            tooltip={
              commentActive
                ? t('rightSidebar.browser.exitCommentMode')
                : t('rightSidebar.browser.comment')
            }
          />
        )}
        {/* 更多菜单:trigger 复用 chrome 图标按钮视觉(默认态 + 菜单打开时 active 高亮,
          走 data-[state=open])。菜单项在无有效链接(新标签空白态)时置灰。 */}
        <DropdownMenu onOpenChange={onOverlayOpenChange}>
          <DropdownMenuTrigger asChild>
            <Tip text={t('rightSidebar.browser.moreTools')} side="bottom">
              <button
                type="button"
                aria-label={t('rightSidebar.browser.moreTools')}
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-md transition-colors',
                  'text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
                  'data-[state=open]:bg-sidebar-item-active data-[state=open]:text-sidebar-item-active-foreground',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                )}
              >
                <Ellipsis size={14} strokeWidth={2} />
              </button>
            </Tip>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[9rem]">
            <DropdownMenuItem
              disabled={!hasValidLink || !canOpenInSystemBrowser}
              onSelect={onOpenInSystemBrowser}
            >
              <ExternalLink size={14} strokeWidth={2} className="mr-2 shrink-0" />
              {t('rightSidebar.browser.openInSystemBrowser')}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!hasValidLink} onSelect={onCopyLink}>
              <LinkIcon size={14} strokeWidth={2} className="mr-2 shrink-0" />
              {t('rightSidebar.browser.copyLink')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  },
);

/**
 * Chrome 内一类小图标按钮:24×24(默认)/ inlinePill 用 18×18(URL pill 内嵌的
 * star 用)。disabled 时半透明 + 不可点。
 */
function ChromeIconButton({
  icon: Icon,
  reducedMotionIcon: ReducedMotionIcon,
  size = 14,
  inlinePill = false,
  disabled = false,
  active = false,
  spinning = false,
  onClick,
  tooltip,
  disabledTooltip,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  /** reduced-motion 下用静态动作图标表达 loading 状态，避免刷新/空闲态无法区分。 */
  reducedMotionIcon?: React.ComponentType<{
    size?: number;
    strokeWidth?: number;
    className?: string;
  }>;
  size?: number;
  inlinePill?: boolean;
  disabled?: boolean;
  /** 常亮 active 态(如评论模式进行中):反色底,提示当前处于该工具的模式里。 */
  active?: boolean;
  /** 加载态旋转放在 HTML wrapper 上,避免 SVG 常驻动画触发主线程重绘。 */
  spinning?: boolean;
  onClick: () => void;
  tooltip: string;
  /** 禁用态必须解释不可用原因，不能只重复可用态动作名。 */
  disabledTooltip?: string;
}) {
  const accessibleLabel = disabled ? (disabledTooltip ?? tooltip) : tooltip;
  const button = (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={accessibleLabel}
      aria-hidden={disabled ? true : undefined}
      aria-busy={spinning || undefined}
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        inlinePill ? 'size-[18px]' : 'size-6',
        disabled
          ? 'text-[var(--text-tertiary)] opacity-40'
          : active
            ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
            : 'text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
      )}
    >
      {spinning && ReducedMotionIcon ? (
        <>
          <span className="inline-flex animate-spinner motion-reduce:hidden">
            <Icon size={size} strokeWidth={2} />
          </span>
          <span className="hidden motion-reduce:inline-flex">
            <ReducedMotionIcon size={size} strokeWidth={2} />
          </span>
        </>
      ) : (
        <span
          className={cn('inline-flex', spinning && 'animate-spinner motion-reduce:animate-none')}
        >
          <Icon size={size} strokeWidth={2} />
        </span>
      )}
    </button>
  );

  return (
    <Tip text={accessibleLabel} side="bottom">
      {disabled ? (
        <span
          role="button"
          aria-disabled="true"
          aria-label={accessibleLabel}
          tabIndex={0}
          className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
          {button}
        </span>
      ) : (
        button
      )}
    </Tip>
  );
}
