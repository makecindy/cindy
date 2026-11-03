import { useContext, type CSSProperties, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Download, MoreHorizontal, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Tip } from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { cn } from '@/lib/utils';
import { ActivePreviewCollection } from './AttachmentCollectionContext';

/** Scope teardown runs after closing/switching; don't restore into a removed viewer. */
export function usePreviewFocusReturn() {
  return useContext(ActivePreviewCollection)?.restoreFocus;
}

/**
 * 预览窗几何:浮在对话之上,四周留 40px 露出原界面。顶部 40px 同时是窗口
 * 标题栏(mac 红绿灯、拖动窗口),预览窗从它下面开始,不会被红绿灯压住。
 * 超宽窗口里限宽居中,内容不会被拉到整屏宽。
 */
export const PREVIEW_PANEL_MARGIN = 40;
export const PREVIEW_PANEL_MAX_WIDTH = 1440;

const PANEL_SIDE = `max(${PREVIEW_PANEL_MARGIN}px, calc((100vw - ${PREVIEW_PANEL_MAX_WIDTH}px) / 2))`;

/** 预览窗在给定窗口尺寸里的实际大小,供按像素适配内容的查看器使用。 */
export function previewPanelSize(viewport: { width: number; height: number }) {
  return {
    width: Math.max(
      0,
      Math.min(viewport.width - PREVIEW_PANEL_MARGIN * 2, PREVIEW_PANEL_MAX_WIDTH),
    ),
    height: Math.max(0, viewport.height - PREVIEW_PANEL_MARGIN * 2),
  };
}

/**
 * 与 `PREVIEW_PANEL_CLASS` 一起加在各查看器根节点上,把它从整窗铺满变成浮动预览窗。
 * 只管几何:圆角、底色、描边、阴影与入场动画由共享的 `.modal-panel` 提供
 * (DESIGN.md §4 Dialog & Modal),调用处不再自写。根节点内部的绝对定位
 * (顶栏、内容区、底部工具栏)都以预览窗为参照,不需要逐个改写;
 * `--preview-width` / `--preview-height` 供按预览窗尺寸算大小的内容使用。
 */
export const PREVIEW_PANEL_CLASS = 'modal-panel';
export const PREVIEW_PANEL_STYLE = {
  position: 'fixed',
  top: PREVIEW_PANEL_MARGIN,
  bottom: PREVIEW_PANEL_MARGIN,
  left: PANEL_SIDE,
  right: PANEL_SIDE,
  overflow: 'hidden',
  '--preview-width': `min(calc(100vw - ${PREVIEW_PANEL_MARGIN * 2}px), ${PREVIEW_PANEL_MAX_WIDTH}px)`,
  '--preview-height': `calc(100vh - ${PREVIEW_PANEL_MARGIN * 2}px)`,
} as CSSProperties;

/**
 * 打不开的文件(压缩包等)只有文件信息和打开方式,不需要大窗:同一套外观的
 * 小窗,居中显示。居中用 inset 0 + margin auto,不用 transform,Electron
 * 拖拽区按布局矩形计算,transform 会让命中区与视觉错位。
 * `extraHeight` 留给集合导航等底部工具栏。
 */
export function previewCompactPanelStyle(extraHeight = 0): CSSProperties {
  return {
    ...PREVIEW_PANEL_STYLE,
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    margin: 'auto',
    width: `min(480px, calc(100vw - ${PREVIEW_PANEL_MARGIN * 2}px))`,
    height: 360 + extraHeight,
    maxHeight: `calc(100vh - ${PREVIEW_PANEL_MARGIN * 2}px)`,
  };
}

/**
 * 预览窗后面的遮罩:与弹窗同一套 `.modal-scrim`,点空白处关闭(媒体查看器
 * 保留点外关闭,见 DESIGN.md Dialog & Modal)。
 *
 * Electron 的窗口拖拽区只按几何位置判定、不看层级,主界面顶栏的拖拽区会穿过
 * 预览吞掉点击。遮罩 portal 在主界面之后,整层 no-drag 把它们盖掉;顶部一条
 * 再声明为拖拽区(作为后代可靠生效),预览期间仍能拖动窗口。预览窗从这条
 * 下面开始,不与它重叠。
 */
export function PreviewScrim({ onClose, zIndex = 9999 }: { onClose: () => void; zIndex?: number }) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: 键盘关闭由查看器的 Escape 处理,遮罩只承接点外关闭。
    <div
      aria-hidden
      data-preview-scrim
      className="modal-scrim fixed inset-0"
      style={{ ...WINDOW_NO_DRAG_STYLE, zIndex }}
      onClick={onClose}
    >
      <div
        className="absolute inset-x-0 top-0"
        style={{ height: PREVIEW_PANEL_MARGIN, ...WINDOW_DRAG_STYLE }}
      />
    </div>
  );
}

/** Shared preview chrome. Content renderers retain their own lifecycle and permissions. */
export function PreviewHeader({
  name,
  detail,
  onClose,
  onSave,
  actions,
  menu,
  onMenuClose,
}: {
  name: string;
  detail?: ReactNode;
  onClose: () => void;
  onSave?: () => void;
  actions?: ReactNode;
  menu?: ReactNode;
  onMenuClose?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <header
      className="absolute inset-x-0 top-0 z-10 flex h-16 min-w-0 items-center gap-3 border-b border-[var(--border-default)] bg-[var(--surface-elevated)] px-6 text-[var(--text-primary)]"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={name}>
          {name}
        </div>
        {detail ? (
          <div className="truncate text-xs text-[var(--text-secondary)]">{detail}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {actions}
        {onSave ? (
          <PreviewButton label={t('chat.media.saveAs')} onClick={onSave}>
            <Download className="h-4 w-4" />
          </PreviewButton>
        ) : null}
        {menu ? (
          <DropdownMenu
            onOpenChange={(open) => {
              if (!open) onMenuClose?.();
            }}
          >
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={PREVIEW_BUTTON_CLASS}
                aria-label={t('attachmentPreview.more')}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              onEscapeKeyDown={(event) => event.stopPropagation()}
              className="z-[10002]"
              align="end"
            >
              {menu}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <PreviewButton label={t('chat.lightbox.close')} onClick={onClose}>
          <X className="h-4 w-4" />
        </PreviewButton>
      </div>
    </header>
  );
}

const PREVIEW_BUTTON_CLASS =
  'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--text-primary)] disabled:opacity-40 disabled:pointer-events-none';

export function PreviewButton({
  label,
  onClick,
  disabled,
  children,
  keepPointerFocus,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
  keepPointerFocus?: boolean;
}) {
  return (
    <Tip text={label} contentClassName="z-[10003]">
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={onClick}
        onMouseDown={keepPointerFocus ? (event) => event.preventDefault() : undefined}
        className={PREVIEW_BUTTON_CLASS}
      >
        {children}
      </button>
    </Tip>
  );
}

export function PreviewFooter({
  children,
  className,
  collectionOnly = false,
}: {
  children?: ReactNode;
  className?: string;
  collectionOnly?: boolean;
}) {
  const collection = useContext(ActivePreviewCollection);
  const { t } = useTranslation();
  if (collectionOnly && !collection) return null;
  return (
    <footer
      className={cn(
        'absolute inset-x-0 bottom-0 z-10 flex min-h-16 flex-wrap items-center justify-center gap-1 border-t border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3 text-[var(--text-primary)]',
        className,
      )}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      {collection ? (
        <div
          className={cn(
            'flex items-center gap-1',
            children && 'ml-4 border-l border-[var(--border-default)] pl-4',
          )}
        >
          <PreviewButton
            label={t('attachmentPreview.previous')}
            disabled={collection.index === 0}
            onClick={() => collection.select(collection.index - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </PreviewButton>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="h-8 min-w-16 rounded-full px-3 text-xs tabular-nums hover:bg-[var(--surface-hover)]"
              >
                {collection.index + 1} / {collection.items.length}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="z-[10002] max-h-72 overflow-auto"
              onEscapeKeyDown={(event) => event.stopPropagation()}
            >
              {collection.items.map((item, index) => (
                <DropdownMenuItem key={item.id} onSelect={() => collection.select(index)}>
                  {index + 1}. {item.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <PreviewButton
            label={t('attachmentPreview.next')}
            disabled={collection.index === collection.items.length - 1}
            onClick={() => collection.select(collection.index + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </PreviewButton>
        </div>
      ) : null}
    </footer>
  );
}
