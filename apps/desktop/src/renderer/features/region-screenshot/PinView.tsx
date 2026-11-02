import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { MousePointer2 } from 'lucide-react';

import i18n from '@/i18n';
import type { RegionScreenshotPinState } from '../../../shared/regionScreenshot';
import { bitmapToImageData, type RegionScreenshotPinBridge } from './bridge';
import { SCREENSHOT_OVERLAY } from './screenshotColors';
import { isPreciseWheel, pinchZoomFactor } from './trackpad';

/** 触控板一次滑动会产生很多滚轮事件, 累计到这个量才缩放一级。 */
const WHEEL_STEP = 40;
/** 与 main 的单级缩放倍率一致: 捏合按连续倍率换算成 (小数) 级数。 */
const ZOOM_STEP_LOG = Math.log(1.1);
const ZOOM_BADGE_MS = 900;

/**
 * 贴图窗口内容: 整窗显示截图。拖动移动、滚轮缩放 (macOS 触控板用双指捏合连续缩放,
 * 双指滑动不缩放)、Ctrl / ⌘ + 滚轮调不透明度、
 * 双击或 Esc 关闭、右键菜单; 鼠标穿透时只在右上角留一个「恢复」按钮接收点击。
 * 截图本身是用户内容; 描边、按钮与缩放提示走主题 token。
 */
export function PinView({ bridge }: { bridge: RegionScreenshotPinBridge }) {
  const { t } = useTranslation();
  const isMac = window.electronAPI?.platform === 'darwin';
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<RegionScreenshotPinState>({ opacity: 1, passThrough: false, zoom: 1 });
  const [zoomBadge, setZoomBadge] = useState(false);
  const dragging = useRef(false);
  const frame = useRef<number | null>(null);
  const wheel = useRef(0);
  const pinch = useRef<{ steps: number; x: number; y: number; frame: number | null }>({ steps: 0, x: 0, y: 0, frame: null });
  const lastZoom = useRef(1);

  useEffect(() => {
    const offInit = bridge.onInit((payload) => {
      if (payload.locale && i18n.language !== payload.locale) void i18n.changeLanguage(payload.locale);
      const canvas = canvasRef.current;
      if (!canvas) return;
      canvas.width = payload.image.width;
      canvas.height = payload.image.height;
      canvas.getContext('2d')?.putImageData(bitmapToImageData(payload.image), 0, 0);
      requestAnimationFrame(() => bridge.painted());
    });
    const offState = bridge.onState((next) => {
      setState(next);
      if (next.zoom !== lastZoom.current) {
        lastZoom.current = next.zoom;
        setZoomBadge(true);
      }
    });
    bridge.shellReady();
    return () => {
      offInit();
      offState();
    };
  }, [bridge]);

  useEffect(() => {
    if (!zoomBadge) return;
    const timer = setTimeout(() => setZoomBadge(false), ZOOM_BADGE_MS);
    return () => clearTimeout(timer);
  }, [zoomBadge, state.zoom]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey : event.ctrlKey;
      const key = event.key.toLowerCase();
      if (event.key === 'Escape') bridge.command('close');
      else if (mod && key === 'c') bridge.command('copy');
      else if (mod && key === 's') {
        event.preventDefault();
        bridge.command('save');
      } else if (!mod && key === '0') bridge.command('zoom-reset');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bridge, isMac]);

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ cursor: 'move', background: SCREENSHOT_OVERLAY.backdrop }}
      onPointerDown={(event) => {
        if (event.button !== 0 || state.passThrough) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        bridge.dragStart();
      }}
      onPointerMove={() => {
        if (!dragging.current || frame.current !== null) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          if (dragging.current) bridge.dragMove();
        });
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onDoubleClick={() => {
        if (!state.passThrough) bridge.command('close');
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        if (!state.passThrough) bridge.menu();
      }}
      onWheel={(event) => {
        if (state.passThrough) return;
        if (isMac && event.ctrlKey) {
          // 双指捏合: 每帧合并一次, 按捏合倍率连续缩放, 以指针为锚点。
          const gesture = pinch.current;
          gesture.steps += Math.log(pinchZoomFactor(event.deltaY)) / ZOOM_STEP_LOG;
          gesture.x = event.clientX;
          gesture.y = event.clientY;
          gesture.frame ??= requestAnimationFrame(() => {
            gesture.frame = null;
            const steps = gesture.steps;
            gesture.steps = 0;
            if (steps) bridge.zoom(steps, gesture.x, gesture.y);
          });
          return;
        }
        // macOS 触控板双指滑动是最常用的手势, 不拿来缩放; 鼠标滚轮与 ⌘ + 滑动照旧。
        if (isMac && !event.metaKey && isPreciseWheel(event.nativeEvent)) return;
        wheel.current += event.deltaY;
        if (Math.abs(wheel.current) < WHEEL_STEP) return;
        const steps = wheel.current < 0 ? 1 : -1;
        wheel.current = 0;
        if (isMac ? event.metaKey : event.ctrlKey) bridge.opacity(steps);
        else bridge.zoom(steps, event.clientX, event.clientY);
      }}
    >
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 0 1px var(--border-default)' }}
      />
      {zoomBadge && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2 py-0.5 text-12 tabular-nums text-[var(--text-primary)]">
          {Math.round(state.zoom * 100)}%
        </div>
      )}
      {state.passThrough && (
        <button
          type="button"
          aria-label={t('regionScreenshot.pin.unlock')}
          title={t('regionScreenshot.pin.unlock')}
          className="absolute right-1.5 top-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          onPointerEnter={() => bridge.unlockHover(true)}
          onPointerLeave={() => bridge.unlockHover(false)}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => bridge.command('unlock')}
        >
          <MousePointer2 size={14} />
        </button>
      )}
    </div>
  );
}
