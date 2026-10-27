import { Zap } from 'lucide-react';

/** Keep the two speed marks distinct even when both use the surrounding text color. */
export function SpeedIcon({ mode, size = 14, className }: {
  mode: boolean | 'ultrafast';
  size?: number;
  className?: string;
}) {
  if (mode !== 'ultrafast') return <Zap size={size} className={className} fill="currentColor" />;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M11.5 2 2 13h5l-2 9L15.5 10h-5l1-8Z" />
      <path d="m16 3-1 5h6L10 21" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
