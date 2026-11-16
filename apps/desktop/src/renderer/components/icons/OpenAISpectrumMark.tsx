import { useId } from 'react';
import { MODEL_SPECTRUM_COLORS } from '@cindy/model-providers/branding';
import { OPENAI_MARK_PATH } from '../../../shared/brandMarkPaths';

/** Adds spectrum color to the OpenAI blossom only for XD's byok-openai-codex
 * provider. Temporary stand-in: remove when administrators can upload provider
 * icons in the backend. Never reuse for other brands or as a general UI gradient.
 * Do not add data-ink-icon: it would dim the colored artwork as well.
 */
export function OpenAISpectrumMark({ size = 14, className }: { size?: number; className?: string }) {
  const gradientId = `openai-spectrum-${useId()}`;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1="2" y1="2" x2="22" y2="22">
          {MODEL_SPECTRUM_COLORS.light.map((_, index, colors) => (
            <stop key={index} offset={index / (colors.length - 1)} stopColor={`var(--model-spectrum-${index + 1})`} />
          ))}
        </linearGradient>
      </defs>
      <path d={OPENAI_MARK_PATH} fill="currentColor" className="opacity-[0.35] dark:opacity-[0.30]" />
      <path d={OPENAI_MARK_PATH} fill={`url(#${gradientId})`} className="opacity-[0.72] dark:opacity-[0.78]" />
    </svg>
  );
}
