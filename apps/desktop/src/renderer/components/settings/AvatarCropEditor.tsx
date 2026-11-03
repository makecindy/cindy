import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ZoomIn, ZoomOut } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Tip } from '@/components/ui/tooltip';
import {
  createWheelSourceTracker,
  normalizeWheelDelta,
  wheelZoomFactor,
} from '@/components/chat/lightboxGestures';

import {
  AVATAR_CROP_MAX_ZOOM,
  AVATAR_CROP_ZOOM_STEP,
  AVATAR_ZOOM_SLIDER_MAX,
  avatarCropZoom,
  avatarSliderToZoom,
  avatarStageTransform,
  avatarZoomToSlider,
  panAvatarCrop,
  zoomAvatarCrop,
  type AvatarCrop,
  type AvatarViewPoint,
} from './avatarCropGeometry';
import type { AvatarSource } from './avatarCropImage';

/**
 * AvatarCropEditor — 头像「移动和缩放」编辑台(受控:取景状态由调用方持有)。
 *
 * 画面:整张图画在 stage 画布上,正中一个固定直径的取景圆,圆外用模态遮罩色压暗——
 * 圆内就是最终头像,圆外保留上下文方便判断构图。
 *
 * 输入(全部只作用于 stage 自身,不劫持弹窗或页面滚动):
 *   - 指针拖动平移;两指(触屏)捏合缩放并跟随中点;
 *   - 触控板捏合 / ⌘·Ctrl+滚轮 / 鼠标滚轮以光标为焦点缩放,触控板双指滑动平移
 *     (设备推断与 wheel 数学复用图片 lightbox 的 lightboxGestures);
 *   - 聚焦 stage 后方向键平移(Shift 大步),+ / - 缩放;滑杆与两侧按钮以圆心缩放。
 * 直接操纵不加缓动(DESIGN §14.4:跟手即反馈),所以没有需要 reduced-motion 关闭的动效。
 */

/** 取景圆在屏幕上的直径(CSS px)。 */
const VIEW_SIDE = 240;
/** 取景圆与 stage 边缘至少留出的距离,stage 被压窄时取景圆随之缩小。 */
const VIEW_MIN_GUTTER = 24;
const KEY_PAN_STEP = 8;
const KEY_PAN_STEP_LARGE = 40;
// 到达缩放边界时用 aria-disabled 而不是 disabled:真 disabled 会把正在连点的按钮
// 焦点甩到 body;边界处点击本就是 no-op(zoomAvatarCrop 会夹住倍率)。
const ZOOM_BUTTON_CLASS = 'w-8 shrink-0 px-0 aria-disabled:cursor-default aria-disabled:opacity-60';

interface AvatarCropEditorProps {
  source: AvatarSource;
  crop: AvatarCrop;
  onCropChange: (crop: AvatarCrop) => void;
  /** 弹窗内 Tooltip 需要盖过宿主弹窗的层级(DESIGN §4 Dialog & Modal)。 */
  tipClassName?: string;
}

interface StageSize {
  width: number;
  height: number;
}

function viewSideFor(stage: StageSize) {
  return Math.max(
    0,
    Math.min(VIEW_SIDE, stage.width - VIEW_MIN_GUTTER * 2, stage.height - VIEW_MIN_GUTTER * 2),
  );
}

export const AvatarCropEditor = forwardRef<HTMLDivElement, AvatarCropEditorProps>(
  function AvatarCropEditor({ source, crop, onCropChange, tipClassName }, forwardedRef) {
    const { t } = useTranslation();
    const stageRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [stage, setStage] = useState<StageSize>({ width: 0, height: 0 });
    const [dragging, setDragging] = useState(false);
    // 原生 wheel listener 与 pointer handler 读最新值,不受闭包过期影响。
    const cropRef = useRef(crop);
    cropRef.current = crop;
    const onCropChangeRef = useRef(onCropChange);
    onCropChangeRef.current = onCropChange;
    const viewSide = viewSideFor(stage);
    const viewSideRef = useRef(viewSide);
    viewSideRef.current = viewSide;
    const pointersRef = useRef(new Map<number, { x: number; y: number }>());

    const setStageNode = useCallback(
      (node: HTMLDivElement | null) => {
        stageRef.current = node;
        if (typeof forwardedRef === 'function') forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      },
      [forwardedRef],
    );

    // stage 尺寸:首帧同步量一次(避免空白帧),之后跟随 ResizeObserver。
    useLayoutEffect(() => {
      const node = stageRef.current;
      if (!node) return;
      const measure = () => {
        const rect = node.getBoundingClientRect();
        setStage((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height },
        );
      };
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(node);
      return () => observer.disconnect();
    }, []);

    // 每次取景 / 尺寸变化同步重画(layout effect:与本帧 DOM 一起提交,拖动不拖影)。
    useLayoutEffect(() => {
      const canvas = canvasRef.current;
      if (!canvas || stage.width === 0 || viewSide === 0) return;
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(stage.width * dpr);
      const height = Math.round(stage.height * dpr);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      const ctx = canvas.getContext('2d', { colorSpace: 'srgb' });
      if (!ctx) return;
      const { scale, x, y } = avatarStageTransform(crop, viewSide, stage.width, stage.height);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.setTransform(scale * dpr, 0, 0, scale * dpr, x * dpr, y * dpr);
      ctx.drawImage(source.bitmap, 0, 0);
    }, [crop, source, stage, viewSide]);

    const emit = useCallback((next: AvatarCrop) => {
      const current = cropRef.current;
      if (next.cx === current.cx && next.cy === current.cy && next.side === current.side) return;
      cropRef.current = next;
      onCropChangeRef.current(next);
    }, []);

    const zoomTo = useCallback(
      (zoom: number, focal?: AvatarViewPoint) => {
        emit(zoomAvatarCrop(cropRef.current, source.size, zoom, viewSideRef.current, focal));
      },
      [emit, source.size],
    );

    const panBy = useCallback(
      (dx: number, dy: number) => {
        emit(panAvatarCrop(cropRef.current, source.size, dx, dy, viewSideRef.current));
      },
      [emit, source.size],
    );

    /** 屏幕坐标 → 相对取景圆心(= stage 中心)的视图坐标。 */
    const toViewPoint = useCallback((clientX: number, clientY: number): AvatarViewPoint => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
    }, []);

    // 滚轮 / 触控板:native listener + passive:false 才能 preventDefault,事件只在
    // stage 上被消费,指针在 stage 外时弹窗照常滚动。
    useEffect(() => {
      const node = stageRef.current;
      if (!node) return;
      const trackWheelSource = createWheelSourceTracker();
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const modifierZoom = e.ctrlKey || e.metaKey;
        const device = modifierZoom
          ? 'mouse'
          : trackWheelSource(
              {
                deltaMode: e.deltaMode,
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                shiftKey: e.shiftKey,
                wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
              },
              e.timeStamp,
            );
        if (modifierZoom || device === 'mouse') {
          if (e.deltaY === 0) return;
          const zoom = avatarCropZoom(cropRef.current, source.size);
          zoomTo(zoom * wheelZoomFactor(e.deltaY, e.deltaMode), toViewPoint(e.clientX, e.clientY));
          return;
        }
        // 触控板双指滑动:内容跟手走(与 lightbox 放大后的平移方向一致)。
        panBy(
          -normalizeWheelDelta(e.deltaX, e.deltaMode),
          -normalizeWheelDelta(e.deltaY, e.deltaMode),
        );
      };
      node.addEventListener('wheel', onWheel, { passive: false });
      return () => node.removeEventListener('wheel', onWheel);
    }, [panBy, source.size, toViewPoint, zoomTo]);

    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // 抑制文字选区与原生拖拽;焦点仍交给 stage,方便随后用键盘微调。
      e.preventDefault();
      e.currentTarget.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      setDragging(true);
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const next = { x: e.clientX, y: e.clientY };
      if (pointers.size === 1) {
        pointers.set(e.pointerId, next);
        panBy(next.x - prev.x, next.y - prev.y);
        return;
      }
      // 两指:中点位移 → 平移,指间距比例 → 以新中点为焦点缩放。
      const others = [...pointers.entries()].filter(([id]) => id !== e.pointerId);
      const other = others[0]?.[1];
      pointers.set(e.pointerId, next);
      if (!other) return;
      const prevMid = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const nextMid = { x: (next.x + other.x) / 2, y: (next.y + other.y) / 2 };
      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      const nextDist = Math.hypot(next.x - other.x, next.y - other.y);
      const panned = panAvatarCrop(
        cropRef.current,
        source.size,
        nextMid.x - prevMid.x,
        nextMid.y - prevMid.y,
        viewSideRef.current,
      );
      const ratio = prevDist > 0 ? nextDist / prevDist : 1;
      emit(
        zoomAvatarCrop(
          panned,
          source.size,
          avatarCropZoom(panned, source.size) * ratio,
          viewSideRef.current,
          toViewPoint(nextMid.x, nextMid.y),
        ),
      );
    };

    const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
      const pointers = pointersRef.current;
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size === 0) setDragging(false);
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = e.shiftKey ? KEY_PAN_STEP_LARGE : KEY_PAN_STEP;
      const zoom = avatarCropZoom(cropRef.current, source.size);
      switch (e.key) {
        case 'ArrowLeft':
          panBy(-step, 0);
          break;
        case 'ArrowRight':
          panBy(step, 0);
          break;
        case 'ArrowUp':
          panBy(0, -step);
          break;
        case 'ArrowDown':
          panBy(0, step);
          break;
        case '+':
        case '=':
          zoomTo(zoom * AVATAR_CROP_ZOOM_STEP);
          break;
        case '-':
        case '_':
          zoomTo(zoom / AVATAR_CROP_ZOOM_STEP);
          break;
        default:
          return;
      }
      e.preventDefault();
    };

    const zoom = avatarCropZoom(crop, source.size);
    // 浮点误差容差:避免 1.0000001 让「缩小」按钮停在可点状态。
    const atMinZoom = zoom <= 1 + 1e-6;
    const atMaxZoom = zoom >= AVATAR_CROP_MAX_ZOOM - 1e-6;
    const zoomPercent = Math.round(zoom * 100);

    return (
      <div className="flex flex-col gap-3">
        <div
          ref={setStageNode}
          role="group"
          tabIndex={0}
          aria-label={t('settings.userProfile.edit.crop.stageLabel')}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown + -"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
          onKeyDown={handleKeyDown}
          className={cn(
            'group relative h-[288px] w-full shrink-0 touch-none select-none overflow-hidden rounded-xl',
            'bg-[var(--surface-chip)] outline-none',
            dragging ? 'cursor-grabbing' : 'cursor-grab',
          )}
        >
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" />
          {/* 取景圆:圆外由超大 spread 的阴影压暗,圆内即最终头像;内侧一圈半透白细线
              让圆边在花哨照片上也清晰(恒定浅色,同 lightbox 浮在暗底上的 chrome)。
              压暗是「看图」语义,取跨主题恒定的 lightbox 暗底并减淡到约 60%,保留圆外
              构图上下文;--overlay-modal 专属模态遮罩,这里不能用(modalSurfaceContract)。 */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: viewSide,
              height: viewSide,
              marginLeft: -viewSide / 2,
              marginTop: -viewSide / 2,
              boxShadow:
                '0 0 0 9999px color-mix(in srgb, var(--overlay-lightbox) 70%, transparent), inset 0 0 0 1px color-mix(in srgb, var(--lightbox-toolbar-fg-hover) 55%, transparent)',
            }}
          />
          {/* 焦点环单独一层:画在画布之上,且不会被弹窗滚动区裁掉。 */}
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute inset-0 rounded-xl',
              'group-focus-visible:ring-2 group-focus-visible:ring-inset group-focus-visible:ring-[var(--focus-ring-soft)]',
            )}
          />
        </div>

        <div className="flex items-center gap-1">
          <Tip text={t('settings.userProfile.edit.crop.zoomOut')} contentClassName={tipClassName}>
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="md"
              className={ZOOM_BUTTON_CLASS}
              aria-label={t('settings.userProfile.edit.crop.zoomOut')}
              aria-disabled={atMinZoom}
              onClick={() => zoomTo(zoom / AVATAR_CROP_ZOOM_STEP)}
            >
              <ZoomOut size={16} aria-hidden />
            </Button>
          </Tip>
          <Slider
            className="mx-1 flex-1"
            min={0}
            max={AVATAR_ZOOM_SLIDER_MAX}
            step={1}
            value={[avatarZoomToSlider(zoom)]}
            onValueChange={([value]) => {
              if (value !== undefined) zoomTo(avatarSliderToZoom(value));
            }}
            aria-label={t('settings.userProfile.edit.crop.zoomLabel')}
            aria-valuetext={t('settings.userProfile.edit.crop.zoomValue', { percent: zoomPercent })}
          />
          <Tip text={t('settings.userProfile.edit.crop.zoomIn')} contentClassName={tipClassName}>
            <Button
              type="button"
              variant="secondary"
              tone="quiet"
              size="md"
              className={ZOOM_BUTTON_CLASS}
              aria-label={t('settings.userProfile.edit.crop.zoomIn')}
              aria-disabled={atMaxZoom}
              onClick={() => zoomTo(zoom * AVATAR_CROP_ZOOM_STEP)}
            >
              <ZoomIn size={16} aria-hidden />
            </Button>
          </Tip>
        </div>
      </div>
    );
  },
);
