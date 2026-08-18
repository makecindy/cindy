/**
 * KimiMark —— Kimi Code CLI(月之暗面 moonshot-ai/kimi-code)的身份 mark。
 *
 * Kimi 没有对外的小尺寸品牌 glyph 规范,这里用细描边 K 字形(13-14px 小尺寸下
 * 保持清晰,视觉重量与 ClaudeMark 像素脸 / CodexMark `>_` 花形 / PiMark π 对齐)。
 *  - variant="mono"(默认):currentColor,跟随主题/状态染色;
 *  - variant="brand":Kimi 无官方小尺寸品牌色规范,当前与 mono 相同(保留参数是
 *    为了与 ClaudeMark/CodexMark 的调用面一致,出现官方色后只改这里)。
 */

interface KimiMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function KimiMark({ size = 14, className }: KimiMarkProps) {
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
        {/* 竖干 */}
        <path d="M7 4.5v15" />
        {/* 上折臂 */}
        <path d="M17.5 4.5 7.8 12.2" />
        {/* 下折臂(自交点外扩,呼应手写 K 的出笔) */}
        <path d="M9.4 10.6 18 19.5" />
      </g>
    </svg>
  );
}
