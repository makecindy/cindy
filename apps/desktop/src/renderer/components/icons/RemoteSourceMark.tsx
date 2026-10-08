/**
 * RemoteSourceMark —— 「另一台电脑上的供应商」图标。
 *
 * 品牌图形右上角加一道波纹和一个点标出远端：仍是**一个**图标位，一眼读出「这个供应商，
 * 在远处」。不在 Logo 旁边另放电脑图标(2026-10-06 用户裁决)。
 *
 * 远程供应商 Logo 与侧栏等处的远程 Agent 图标(VendorIcon remote)是**同一种做法**:
 * 图形保持原大小、原位置(与本机同列图标对齐，切换本机 / 远程模型时不跳)，波纹叠在
 * 图形右上角外侧，不占布局(2026-10-08 用户裁决：早先缩小品牌塞进同一方框的做法让
 * Logo 偏到左下、比文字低)。
 *
 * 几何(16 单位画布):品牌区是左下 12.5 × 12.5,波纹从品牌区右上角向外发出，点落在
 * 连接角内。颜色全部跟随 currentColor,Light / Dark 由外层文字色决定。
 */
import type { CSSProperties, ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** 品牌区在 16 单位画布里的边长(左下对齐)。 */
const BRAND_UNITS = 12.5;
/** 波纹在品牌区右上外侧占的带宽(16 单位画布)。 */
const SIGNAL_BAND_UNITS = 16 - BRAND_UNITS;

/** 波纹 + 点本体(16 单位画布)。 */
function RemoteSignal({
  size,
  className,
  style,
}: {
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={className}
      style={style}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 1.4A2.6 2.6 0 0 1 14.6 4" />
      <circle cx="12.6" cy="3.4" r="0.95" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 给原位、原大小的图形叠波纹：父级方框就是品牌区，波纹画到它右上角外侧。
 *
 * markSize 决定波纹大小(与图形同比例);anchorX / anchorY 是图形笔画右上角在父级方框里
 * 的位置(0–1),像素脸、花形这类不顶满方框的图形按实际笔画给，波纹才贴着图形而不是
 * 悬在方框角上。父级需要 `relative`,方框大小等于图形，且不能裁剪溢出。
 */
export function RemoteSignalOverlay({
  markSize,
  anchorX = 1,
  anchorY = 0,
}: {
  /** 被叠加图形的边长，px。 */
  markSize: number;
  anchorX?: number;
  anchorY?: number;
}) {
  const unit = markSize / BRAND_UNITS;
  return (
    <RemoteSignal
      size={unit * 16}
      className="pointer-events-none absolute"
      style={{
        right: (1 - anchorX) * markSize - SIGNAL_BAND_UNITS * unit,
        top: anchorY * markSize - SIGNAL_BAND_UNITS * unit,
      }}
    />
  );
}

export function RemoteSourceMark({
  markSize = 13,
  className,
  children,
}: {
  /** children 的原生边长，px;决定波纹大小。 */
  markSize?: number;
  className?: string;
  /** 品牌图形(ProviderMark / ModelIconMark 等，颜色请用 currentColor;不要带外边距)。 */
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      data-remote-source-mark
      className={cn('relative inline-flex shrink-0', className)}
    >
      {children}
      <RemoteSignalOverlay markSize={markSize} />
    </span>
  );
}
