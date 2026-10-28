import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { clampIntoArea, type RegionPoint, type RegionRect, type RegionSize } from '../../../shared/regionScreenshot';
import { SCREENSHOT_OVERLAY } from './screenshotColors';

/** 放大镜取样边长 (原图像素, 奇数让指针落在正中一格) 与放大倍数。 */
const SAMPLE = 15;
const ZOOM = 8;
const VIEW = SAMPLE * ZOOM;
const OFFSET = 20;

export interface PixelColor {
  r: number;
  g: number;
  b: number;
}

export function colorHex({ r, g, b }: PixelColor): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function colorRgb({ r, g, b }: PixelColor): string {
  return `${r}, ${g}, ${b}`;
}

/**
 * 跟随指针的放大镜: 放大原图像素、十字线标出当前像素, 下方是物理像素坐标与颜色。
 * 放大区与色块显示的是用户截图内容本身; 外框与文字走主题 token。
 */
export function Magnifier({
  frame,
  frameSize,
  point,
  viewport,
  bounds,
  color,
  scaleFactor,
}: {
  frame: HTMLCanvasElement | null;
  frameSize: RegionSize;
  point: RegionPoint;
  viewport: RegionSize;
  /** 放大镜可放置的区域 (避开刘海与 Dock); 缺省为整个视口。 */
  bounds?: RegionRect;
  color: PixelColor | null;
  scaleFactor: number;
}) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fx = Math.floor((point.x * frameSize.width) / viewport.width);
  const fy = Math.floor((point.y * frameSize.height) / viewport.height);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(VIEW * dpr);
    canvas.height = Math.round(VIEW * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = SCREENSHOT_OVERLAY.backdrop;
    ctx.fillRect(0, 0, VIEW, VIEW);
    const half = Math.floor(SAMPLE / 2);
    ctx.drawImage(frame, fx - half, fy - half, SAMPLE, SAMPLE, 0, 0, VIEW, VIEW);
    // 十字线与中心格: 覆盖在任意截图内容上的功能像素, 暗色带 + 白框保证都看得见。
    const center = half * ZOOM;
    ctx.fillStyle = SCREENSHOT_OVERLAY.crosshair;
    ctx.fillRect(0, center, VIEW, ZOOM);
    ctx.fillRect(center, 0, ZOOM, VIEW);
    ctx.strokeStyle = SCREENSHOT_OVERLAY.edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(center + 0.5, center + 0.5, ZOOM - 1, ZOOM - 1);
  }, [frame, fx, fy]);

  const width = VIEW + 2;
  const height = VIEW + 58;
  const area = bounds ?? { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const left = point.x + OFFSET + width > area.x + area.width ? point.x - OFFSET - width : point.x + OFFSET;
  const top = point.y + OFFSET + height > area.y + area.height ? point.y - OFFSET - height : point.y + OFFSET;
  const position = clampIntoArea({ x: left, y: top }, { width, height }, area);

  return (
    <div
      className="pointer-events-none fixed overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]"
      style={{ left: position.x, top: position.y, width }}
    >
      <canvas ref={canvasRef} style={{ width: VIEW, height: VIEW, display: 'block' }} />
      <div className="flex flex-col gap-0.5 border-t border-[var(--border-default)] px-2 py-1.5 text-12 leading-[1.35] tabular-nums">
        <div className="text-[var(--text-secondary)]">
          {Math.floor(point.x * scaleFactor)}, {Math.floor(point.y * scaleFactor)}
        </div>
        <div className="flex items-center gap-1.5 text-[var(--text-primary)]">
          <span
            className="inline-block h-3 w-3 shrink-0 rounded-sm border border-[var(--border-default)]"
            style={{ background: color ? colorHex(color) : 'transparent' }}
          />
          <span>{color ? colorHex(color) : '—'}</span>
        </div>
        <div className="text-[var(--text-tertiary)]">{t('regionScreenshot.magnifier.copyHint')}</div>
      </div>
    </div>
  );
}
