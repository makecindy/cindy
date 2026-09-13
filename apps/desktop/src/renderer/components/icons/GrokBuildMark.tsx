/**
 * GrokBuildMark — Grok Build (xAI terminal coding agent) identity mark.
 *
 * Geometric "G" / chevron mark at 13-14px, visual weight aligned with PiMark /
 * ClaudeMark / CodexMark. Not SuperGrok OAuth branding.
 */

interface GrokBuildMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function GrokBuildMark({ size = 14, className }: GrokBuildMarkProps) {
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
        <path d="M7 7.2h10.4v9.6H7.6c-1.5 0-2.4-.9-2.4-2.4V9.6c0-1.5.9-2.4 2.4-2.4Z" />
        <path d="M12.4 12h5" />
      </g>
    </svg>
  );
}
