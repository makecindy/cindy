/**
 * PiMark —— pi coding agent(earendil-works/pi)的身份 mark。
 *
 * pi 上游没有对外的品牌 glyph 规范,这里用细描边 π 字形(13-14px 小尺寸下
 * 保持清晰,视觉重量与 ClaudeMark 像素脸 / CodexMark `>_` 花形对齐)。
 *  - variant="mono"(默认):currentColor,跟随主题/状态染色;
 *  - variant="brand":pi 无官方品牌色,当前与 mono 相同(保留参数是为了与
 *    ClaudeMark/CodexMark 的调用面一致,出现官方色后只改这里)。
 */

interface PiMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function PiMark({ size = 14, className }: PiMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* 横梁(两端微出头) */}
        <path d="M3.6 6.6h16.8" />
        {/* 左腿 */}
        <path d="M8.4 6.6v11.8" />
        {/* 右腿:底部向右收笔,呼应手写 π */}
        <path d="M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2" />
      </g>
    </svg>
  );
}
