/**
 * CodexMark —— OpenAI Codex 官方 CLI mark(多瓣圆花 + `>_` 终端提示符),双轨:
 *  - variant="mono"(默认):描边花形轮廓(stroke)+ 增重的 `>_`(fill+stroke),
 *    currentColor 单色,跟随主题/状态染色;小尺寸用更粗描边并整体光学放大,
 *    与实心 Claude 像素脸保持视觉重量一致;
 *  - variant="brand":官方彩色版——实心花形剪影填蓝紫渐变
 *    (#b1a7ff → #7a9dff → #3941ff),`>_` 为镂空透底(官方资产的白色圆角
 *    方底已去掉,内联场景透明底)。固定品牌色跨主题一致(语义豁免——同
 *    docs/design-rules/cindy-design-system.md Toast 三色逻辑);渐变 id 用 useId 派生防同屏多实例冲突。
 *
 * 2026-07-20(产品):形状统一用 Codex CLI glyph(比旧 OpenAI 六瓣花结辨识度
 * 高);单色为默认,彩色按场景显式启用。两个 variant 来自同一官方 path 的拆分:
 * mono 把轮廓子路径改 fill=none + stroke,`>_` 子路径保持 fill——原资产里
 * dash 子路径是相对坐标(接在轮廓闭环终点 = 起点 9.064,3.344 之后),拆分时已
 * 换算为绝对坐标 M12.546 13.909(逐段增量累加验证)。
 */

import { useId } from 'react';

import { CODEX_FLOWER_OUTLINE, CODEX_PROMPT_GLYPHS } from '../../../shared/brandMarkPaths';

interface CodexMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function CodexMark({ size = 14, className, variant = 'mono' }: CodexMarkProps) {
  const gradientId = useId();
  const monoStrokeWidth = size <= 14 ? 2 : 1.6;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      {variant === 'brand' ? (
        <>
          {/* 官方原始形态:花形剪影 + `>_` 镂空,同一 path 填渐变(nonzero 反向子路径成孔)。 */}
          <path fill={`url(#${gradientId})`} d={`${CODEX_FLOWER_OUTLINE}m3.482 10.565a.637.637 0 0 0 0 1.272h3.636a.637.637 0 1 0 0-1.272zM8.462 9.23a.637.637 0 0 0-1.106.631l1.272 2.224-1.266 2.136a.636.636 0 1 0 1.095.649l1.454-2.455a.64.64 0 0 0 .005-.64z`} />
          <defs>
            <linearGradient
              id={gradientId}
              x1="12"
              x2="12"
              y1="3"
              y2="21"
              gradientUnits="userSpaceOnUse"
            >
              <stop stopColor="#b1a7ff" />
              <stop offset=".5" stopColor="#7a9dff" />
              <stop offset="1" stopColor="#3941ff" />
            </linearGradient>
          </defs>
        </>
      ) : (
        <g transform="translate(12 12) scale(1.1) translate(-12 -12)">
          <path
            fill="none"
            stroke="currentColor"
            strokeWidth={monoStrokeWidth}
            strokeLinejoin="round"
            d={`${CODEX_FLOWER_OUTLINE}z`}
          />
          <path
            fill="currentColor"
            stroke="currentColor"
            strokeWidth="0.5"
            strokeLinejoin="round"
            d={CODEX_PROMPT_GLYPHS}
          />
        </g>
      )}
    </svg>
  );
}
