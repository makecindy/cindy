/**
 * DiffPanelShell — 复用的右侧滑入面板外壳。
 *
 * 之前 SessionDiffPanel 直接在自己内部写了 backdrop + aside + 滑入 transform +
 * ESC 处理 + header 标题栏 + 关闭按钮。SkillhubDiffPanel 也需要同一套外壳,所以
 * 抽出本组件,两个面板都只关心自己的 body 内容。
 *
 * 用法:
 *   <DiffPanelShell open onClose ariaLabel="Session changes"
 *                   title="改动" rightHeader={<TotalsLine .../>}>
 *     <YourBody />
 *   </DiffPanelShell>
 */

import {
  createContext, useContext, useCallback, useEffect, useRef, useState,
  type HTMLAttributes, type ReactNode, type TransitionEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { cn } from '@/lib/utils';

const FloatingPanelContainer = createContext<HTMLDivElement | null>(null);

/** Keep previews in their owning pane's viewport, outside its scrolling messages. */
export function DiffPanelContainer({ children, ...props }: HTMLAttributes<HTMLDivElement>) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return (
    <div {...props} ref={setContainer}>
      <FloatingPanelContainer.Provider value={container}>
        {children}
      </FloatingPanelContainer.Provider>
    </div>
  );
}

interface DiffPanelShellProps {
  open: boolean;
  onClose: () => void;
  /** 默认 drawer 贴边；floating 用于卡片式右侧预览面板。 */
  variant?: 'drawer' | 'floating';
  /** 无障碍 label,会赋给 <aside aria-label> */
  ariaLabel: string;
  /** 标题栏左侧主文案 */
  title: ReactNode;
  /** 标题栏紧接 title 后渲染的元素(通常是统计线) */
  rightHeader?: ReactNode;
  /** 标题栏右侧、关闭按钮之前渲染的操作元素(如"新会话"按钮) */
  headerActions?: ReactNode;
  /** 默认宽度(px),用户拖拽后会覆盖此值并写入 localStorage */
  defaultWidth?: number;
  /** localStorage key for this concrete panel's persisted width. */
  storageKey?: string;
  children: ReactNode;
}

const MIN_WIDTH = 360;
const DEFAULT_STORAGE_KEY = 'diff-panel-shell:width';
// 旧版所有 panel 共用一个宽度 key。拆成 per-panel key 后,初始化时回退读
// 一次老 key,避免老用户升级后所有面板宽度被重置回默认值。一旦用户拖拽
// 落盘到新 key,后续就走新 key,不再读老的。
// 当前与 DEFAULT_STORAGE_KEY 恰好同值——DEFAULT 是 prop 缺省值语义，
// LEGACY 是"老用户迁移源"语义。如果将来改 DEFAULT，LEGACY 必须保持
// 旧值不动，否则迁移逻辑失效。
const LEGACY_STORAGE_KEY = 'diff-panel-shell:width';

export function DiffPanelShell({
  open,
  onClose,
  variant = 'drawer',
  ariaLabel,
  title,
  rightHeader,
  headerActions,
  defaultWidth = 480,
  storageKey = DEFAULT_STORAGE_KEY,
  children,
}: DiffPanelShellProps) {
  const { t } = useTranslation();
  const reducedMotion = useReducedMotion();
  const isFloating = variant === 'floating';
  const floatingContainer = useContext(FloatingPanelContainer);
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return defaultWidth;
    const readWidth = (key: string): number | null => {
      const saved = window.localStorage.getItem(key);
      if (!saved) return null;
      const parsed = Number.parseInt(saved, 10);
      return Number.isFinite(parsed) && parsed >= MIN_WIDTH ? parsed : null;
    };
    const fromNew = readWidth(storageKey);
    if (fromNew !== null) return fromNew;
    if (storageKey !== LEGACY_STORAGE_KEY) {
      const fromLegacy = readWidth(LEGACY_STORAGE_KEY);
      if (fromLegacy !== null) return fromLegacy;
    }
    return defaultWidth;
  });
  const [retainShadow, setRetainShadow] = useState(open);

  const draggingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setRetainShadow(true);
      return;
    }
    if (reducedMotion) setRetainShadow(false);
  }, [open, reducedMotion]);

  // ESC 关闭。只在 open 时绑定,避免与其他 ESC 监听器(FindInPageBar 等)抢
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const getMaxWidth = useCallback(() => {
    const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * 0.9));
    return max;
  }, []);

  const clampWidth = useCallback((next: number) => {
    return Math.min(getMaxWidth(), Math.max(MIN_WIDTH, next));
  }, [getMaxWidth]);

  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      // 拖拽期间禁用文本选择,鼠标统一显示 col-resize
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        // 面板贴右边,鼠标越往左拖,宽度越大
        const next = clampWidth(window.innerWidth - ev.clientX);
        setWidth(next);
      };
      const onUp = () => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        // 仅在松手时落盘,避免拖拽过程频繁写
        setWidth((current) => {
          window.localStorage.setItem(storageKey, String(current));
          return current;
        });
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [clampWidth, storageKey],
  );

  const onResizeDoubleClick = useCallback(() => {
    setWidth(defaultWidth);
    window.localStorage.setItem(storageKey, String(defaultWidth));
  }, [defaultWidth, storageKey]);

  const onResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const step = e.shiftKey ? 64 : 16;
      const getNextWidth = (current: number): number | null => {
        switch (e.key) {
          case 'ArrowLeft':
            return current + step;
          case 'ArrowRight':
            return current - step;
          case 'Home':
            return MIN_WIDTH;
          case 'End':
            return getMaxWidth();
          default:
            return null;
        }
      };
      const next = getNextWidth(width);
      if (next === null) return;
      e.preventDefault();
      const clamped = clampWidth(next);
      setWidth(clamped);
      window.localStorage.setItem(storageKey, String(clamped));
    },
    [clampWidth, getMaxWidth, storageKey, width],
  );

  const maxWidth = typeof window === 'undefined' ? Math.max(MIN_WIDTH, defaultWidth) : getMaxWidth();
  const panelWidth = isFloating ? defaultWidth : width;
  const showShadow = open || (!reducedMotion && retainShadow);

  const onShadowTransitionEnd = useCallback(
    (e: TransitionEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget || e.propertyName !== 'transform') return;
      if (!open) setRetainShadow(false);
    },
    [open],
  );

  const panel = (
    <>
      {/* 遮罩：floating 只覆盖宿主内容区，避免盖住 feature sidebar 和顶部工具条。 */}
      <div
        className={cn(
          isFloating
            ? 'absolute inset-0 z-30 bg-[var(--overlay-modal)] transition-opacity duration-200'
            : 'fixed inset-0 z-30 bg-black/10 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={onClose}
        aria-hidden
      />

      <aside
        className={cn(
          isFloating ? 'absolute z-40' : 'fixed z-40',
          isFloating
            ? 'right-3 top-3 bottom-3 overflow-hidden rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] text-[var(--msg-assistant-text)]'
            : 'right-0 top-[46px] bottom-0 border-l border-border bg-popover text-popover-foreground',
          showShadow && 'shadow-[shadow:var(--shadow-menu)]',
          'flex flex-col',
          'transition-transform duration-200 ease-out',
          open ? 'translate-x-0' : isFloating ? 'pointer-events-none translate-x-[calc(100%+16px)]' : 'translate-x-full',
        )}
        style={{ width: `${panelWidth}px`, maxWidth: isFloating ? 'calc(100% - 24px)' : '90vw' }}
        onTransitionEnd={onShadowTransitionEnd}
        aria-hidden={!open}
        role={isFloating ? undefined : 'complementary'}
        aria-label={ariaLabel}
      >
        {!isFloating && (
          <>
            {/* 宽度调整拖拽条 — 贴在 drawer 左边缘，保留旧面板的鼠标拖拽和键盘调宽能力。 */}
            <hr
              aria-orientation="vertical"
              aria-label={t('diffPanel.shell.resizeHandleAria')}
              aria-valuemin={MIN_WIDTH}
              aria-valuemax={maxWidth}
              aria-valuenow={width}
              tabIndex={0}
              onMouseDown={onResizeStart}
              onDoubleClick={onResizeDoubleClick}
              onKeyDown={onResizeKeyDown}
              className="absolute -left-px top-0 z-50 m-0 h-full w-[4px] cursor-col-resize border-0 bg-transparent transition-shadow hover:shadow-[inset_1px_0_0_var(--sidebar-action-icon)] focus-visible:outline-none focus-visible:shadow-[inset_1px_0_0_var(--focus-ring)]"
            />
          </>
        )}

        <header
          className={cn(
            'flex shrink-0 items-center justify-between gap-2 border-b',
            isFloating ? 'border-[var(--cmd-palette-border)] px-4 py-3' : 'border-border px-3 py-2',
          )}
        >
          <div className="flex items-baseline gap-2 min-w-0">
            <h2 className="min-w-0 truncate text-sm font-medium">{title}</h2>
            {rightHeader}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            {headerActions}
            <button
              type="button"
              onClick={onClose}
              aria-label={t('diffPanel.shell.closeAria')}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center focus-visible:outline-none',
                isFloating
                  ? 'rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]'
                  : 'rounded hover:bg-titlebar-button-hover',
              )}
            >
              <X size={16} />
            </button>
          </div>
        </header>

        <div className={cn('min-h-0 flex-1 overflow-y-auto', isFloating && 'bg-[hsl(var(--content-area))]')}>
          {children}
        </div>
      </aside>
    </>
  );
  return isFloating && floatingContainer ? createPortal(panel, floatingContainer) : panel;
}
