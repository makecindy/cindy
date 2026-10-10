/**
 * CursorMark —— Cursor 官方 mark(等距立方体 glyph),currentColor 单色,
 * 跟随主题/状态染色(同 ClaudeMark variant="mono" 语义)。
 *
 * path 取自官方品牌资产的单色版(simple-icons `cursor`,CC0):外框立方体 +
 * 反向子路径挖出正面三角(nonzero 成孔),故不能加 fillRule="evenodd"。
 * 官方渐变彩色版本仓内暂无消费点,不做 brand variant。
 */

interface CursorMarkProps {
  size?: number;
  className?: string;
}

export function CursorMark({ size = 14, className }: CursorMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
    >
      <path
        fill="currentColor"
        d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"
      />
    </svg>
  );
}
