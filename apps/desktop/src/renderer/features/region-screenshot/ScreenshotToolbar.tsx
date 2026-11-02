import { forwardRef, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Check,
  Circle,
  Download,
  Droplets,
  Grid3x3,
  GripVertical,
  Highlighter,
  Languages,
  Lightbulb,
  ListOrdered,
  MessageCircleQuestion,
  Minus,
  MoveUpRight,
  Pencil,
  Pin,
  Redo2,
  ScanText,
  Sparkles,
  Square,
  Type,
  Undo2,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import '@/components/ui/button.css';
import type { RegionScreenshotAiAction } from '../../../shared/regionScreenshot';
import type { RegionCaptureMode } from '../../../shared/regionCapture';
import {
  ANNOTATION_COLORS,
  ANNOTATION_TOOLS,
  type AnnotationSize,
  type AnnotationTool,
} from './annotations';
import { SCREENSHOT_INK, type ScreenshotInk } from './screenshotColors';

export const TOOL_SHORTCUTS: Record<AnnotationTool, string> = {
  rect: 'R',
  ellipse: 'E',
  line: 'L',
  arrow: 'A',
  pen: 'P',
  marker: 'M',
  text: 'T',
  mosaic: 'X',
  blur: 'B',
  step: 'N',
};

const TOOL_ICONS: Record<AnnotationTool, typeof Square> = {
  rect: Square,
  ellipse: Circle,
  line: Minus,
  arrow: MoveUpRight,
  pen: Pencil,
  marker: Highlighter,
  text: Type,
  mosaic: Grid3x3,
  blur: Droplets,
  step: ListOrdered,
};

const AI_ICONS: Record<RegionScreenshotAiAction, typeof Square> = {
  ask: MessageCircleQuestion,
  translate: Languages,
  explain: Lightbulb,
  extract: ScanText,
};

function IconButton({
  label,
  active = false,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tip text={label} side="top" delay={300}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={active || undefined}
        aria-disabled={disabled || undefined}
        // 鼠标点按钮不把焦点留在按钮上, 快捷键与文字输入照常交给浮层。
        onMouseDown={(event) => event.preventDefault()}
        onClick={disabled ? undefined : onClick}
        className={cn(
          'cindy-button-frame inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          active
            ? '[--button-face-bg:var(--surface-chip)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)]',
          disabled
            ? 'cursor-default opacity-60'
            : 'hover:text-[var(--text-primary)] hover:[--button-face-bg:var(--surface-hover)]',
        )}
      >
        {children}
      </button>
    </Tip>
  );
}

const Divider = () => <span className="mx-1 h-4 w-px shrink-0 bg-[var(--border-default)]" />;

export interface ScreenshotToolbarProps {
  tool: AnnotationTool | null;
  canUndo: boolean;
  canRedo: boolean;
  shortcutMod: string;
  onTool: (tool: AnnotationTool) => void;
  onUndo: () => void;
  onRedo: () => void;
  onAction: (action: 'copy' | 'save' | 'pin' | RegionScreenshotAiAction) => void;
  onCancel: () => void;
}

/** 选区下方的工具条: 标注工具 | 撤销重做 | 贴图 保存 | 退出 复制。 */
export const ScreenshotToolbar = forwardRef<HTMLDivElement, ScreenshotToolbarProps>(
  function ScreenshotToolbar(props, ref) {
    const { t } = useTranslation();
    const mod = props.shortcutMod;
    return (
      <div
        ref={ref}
        className="pointer-events-auto relative flex items-center gap-0.5 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
        onPointerDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {ANNOTATION_TOOLS.map((tool) => {
          const Icon = TOOL_ICONS[tool];
          return (
            <IconButton
              key={tool}
              label={`${t(`regionScreenshot.tools.${tool}`)} (${TOOL_SHORTCUTS[tool]})`}
              active={props.tool === tool}
              onClick={() => props.onTool(tool)}
            >
              <Icon size={15} strokeWidth={tool === 'step' ? 2 : 1.75} />
            </IconButton>
          );
        })}
        <Divider />
        <IconButton label={`${t('regionScreenshot.undo')} (${mod}Z)`} disabled={!props.canUndo} onClick={props.onUndo}>
          <Undo2 size={15} />
        </IconButton>
        <IconButton label={`${t('regionScreenshot.redo')} (${mod}⇧Z)`} disabled={!props.canRedo} onClick={props.onRedo}>
          <Redo2 size={15} />
        </IconButton>
        <Divider />
        <IconButton label={`${t('regionScreenshot.pinToScreen')} (${mod}T)`} onClick={() => props.onAction('pin')}>
          <Pin size={15} />
        </IconButton>
        <IconButton label={`${t('regionScreenshot.save')} (${mod}S)`} onClick={() => props.onAction('save')}>
          <Download size={15} />
        </IconButton>
        <Divider />
        <IconButton label={`${t('regionScreenshot.cancel')} (Esc)`} onClick={props.onCancel}>
          <X size={15} />
        </IconButton>
        <Tip text={t('regionScreenshot.live.finish')} side="top" delay={300}>
          <Button
            variant="cta"
            size="xs"
            className="ml-1 w-7 shrink-0 px-0"
            aria-label={t('regionScreenshot.live.finish')}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => props.onAction('copy')}
          >
            <Check size={16} aria-hidden="true" />
          </Button>
        </Tip>
      </div>
    );
  },
);

export type ScreenshotMode = 'image' | Exclude<RegionCaptureMode, 'gif'>;

/** Screen-top mode switcher stays available before and after selecting a region. */
export function ScreenshotModeBar(props: {
  mode: ScreenshotMode;
  onMode: (mode: ScreenshotMode) => void;
  finished: boolean;
  canAsk: boolean;
  aiMenuOpen: boolean;
  onToggleAiMenu: () => void;
  onAction: (action: RegionScreenshotAiAction) => void;
  /** 可拖动的横向范围 (本显示器 DIP 的安全区), 不拖进刘海或屏幕外。 */
  area: { x: number; width: number };
  onPositionChange: (center: number) => void;
}) {
  const { t } = useTranslation();
  const drag = useRef<{ pointerId: number; x: number; left: number; width: number } | null>(null);
  const moveTo = (left: number, width: number) => {
    const bounded = Math.max(props.area.x + 8, Math.min(props.area.x + props.area.width - width - 8, left));
    props.onPositionChange(bounded + width / 2);
  };
  return <div className="pointer-events-auto relative flex flex-wrap items-center justify-center gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
    onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}>
    <button type="button" aria-label={t('regionScreenshot.moveToolbar')} title={t('regionScreenshot.moveToolbar')}
      className="inline-flex h-7 w-6 shrink-0 touch-none cursor-grab items-center justify-center rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      onPointerDown={(event) => {
        event.stopPropagation();
        if (event.button !== 0) return;
        event.preventDefault();
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
        drag.current = { pointerId: event.pointerId, x: event.clientX, left: bounds.left, width: bounds.width };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        event.stopPropagation();
        const current = drag.current;
        if (current?.pointerId === event.pointerId) moveTo(current.left + event.clientX - current.x, current.width);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault(); event.stopPropagation();
        const bounds = event.currentTarget.parentElement!.getBoundingClientRect();
        moveTo(bounds.left + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 40 : 10), bounds.width);
      }}><GripVertical size={14} /></button>
    {(['image', 'scroll', 'video'] as const).filter((mode) => !props.finished || mode === 'image').map((mode) => <Button key={mode} size="xs" variant="secondary" tone={props.mode === mode ? 'default' : 'quiet'} aria-pressed={props.mode === mode}
      onMouseDown={(event) => event.preventDefault()} onClick={() => props.onMode(mode)}>{t(mode === 'image' ? 'regionScreenshot.live.image' : 'regionScreenshot.live.' + mode)}</Button>)}
    <Divider />
    <div className="relative">
      <Button size="xs" variant="secondary" tone={props.aiMenuOpen ? 'default' : 'quiet'} disabled={!props.canAsk} aria-label={t('regionScreenshot.cindy')} aria-expanded={props.aiMenuOpen}
        onMouseDown={(event) => event.preventDefault()} onClick={props.onToggleAiMenu}><Sparkles size={14} className="text-[var(--warning-fg)]" />Cindy</Button>
      {props.aiMenuOpen && <div role="menu" className="absolute right-0 top-full z-10 mt-2 flex min-w-[168px] flex-col rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1">
        {(['ask', 'translate', 'explain', 'extract'] as const).map((action) => {
          const Icon = AI_ICONS[action];
          return <button key={action} type="button" role="menuitem" onMouseDown={(event) => event.preventDefault()} onClick={() => props.onAction(action)}
            className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-left text-13 text-[var(--text-primary)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
            <Icon size={15} className="shrink-0 text-[var(--text-secondary)]" /><span className="flex-1">{t('regionScreenshot.ai.' + action)}</span>
          </button>;
        })}
      </div>}
    </div>
  </div>;
}

/** 当前工具 (或选中标注) 的颜色与粗细; 马赛克 / 模糊只有强度。 */
export function ScreenshotStyleBar({
  tool,
  color,
  size,
  onColor,
  onSize,
}: {
  tool: AnnotationTool;
  color: ScreenshotInk;
  size: AnnotationSize;
  onColor: (color: ScreenshotInk) => void;
  onSize: (size: AnnotationSize) => void;
}) {
  const { t } = useTranslation();
  const showColors = tool !== 'mosaic' && tool !== 'blur';
  const sizeKey = tool === 'text' ? 'text' : tool === 'mosaic' || tool === 'blur' ? 'strength' : 'stroke';
  return (
    <div
      className="pointer-events-auto flex items-center gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-1"
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.stopPropagation()}
    >
      {([0, 1, 2] as const).map((value) => (
        <IconButton
          key={value}
          label={t(`regionScreenshot.size.${sizeKey}.${value}`)}
          active={size === value}
          onClick={() => onSize(value)}
        >
          <span
            className="rounded-full bg-current"
            style={{ width: 4 + value * 3, height: 4 + value * 3 }}
          />
        </IconButton>
      ))}
      {showColors && <Divider />}
      {showColors &&
        ANNOTATION_COLORS.map((value) => (
          <Tip key={value} text={t(`regionScreenshot.colors.${value}`)} side="top" delay={300}>
            <button
              type="button"
              aria-label={t(`regionScreenshot.colors.${value}`)}
              aria-pressed={color === value || undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onColor(value)}
              className={cn(
                'inline-flex h-7 w-7 items-center justify-center rounded-full',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                color === value ? 'bg-[var(--surface-chip)]' : 'hover:bg-[var(--surface-hover)]',
              )}
            >
              {/* 色块是墨水本身 (用户内容色); 细边框让白 / 黑色块在两种模式下都看得清。 */}
              <span
                className="h-4 w-4 rounded-full border border-[var(--border-default)]"
                style={{ background: SCREENSHOT_INK[value] }}
              />
            </button>
          </Tip>
        ))}
    </div>
  );
}
