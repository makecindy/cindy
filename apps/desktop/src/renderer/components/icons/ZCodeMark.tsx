/** Monochrome initial for the ZCode engine; inherits the surrounding theme. */
export function ZCodeMark({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg aria-hidden width={size} height={size} viewBox="0 0 24 24" className={className}>
      <path d="M5 6h14L5 18h14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
