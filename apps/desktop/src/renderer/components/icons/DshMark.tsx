/** Compact neutral mark for the DeepSeek Harness runtime. */
export function DshMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
    >
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
      <path d="M5 4.75v6.5M5 4.75h2.65a3.25 3.25 0 1 1 0 6.5H5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
