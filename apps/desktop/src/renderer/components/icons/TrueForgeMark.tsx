import { cn } from '@/lib/utils';

export function TrueForgeMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex shrink-0 items-center justify-center font-semibold tracking-[-0.08em]', className)}
      style={{ width: size, height: size, fontSize: size * 0.58, lineHeight: `${size}px` }}
    >
      TF
    </span>
  );
}
