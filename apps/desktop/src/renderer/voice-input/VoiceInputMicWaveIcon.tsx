/**
 * Shared "mic with animated level bars" icon.
 *
 * Consumed in two forms:
 * - `MIC_WAVE_ICON_SVG` raw string — the in-app voice caret builds plain DOM
 *   inside a ProseMirror widget (VoiceInputDraftDecoration) where React
 *   components are not available.
 * - `VoiceInputMicWaveIcon` React component — React surfaces such as the
 *   dictation overlay title.
 *
 * Lucide `Mic` outline kept static; the three level bars inside the capsule
 * animate via the `voice-mic-wave` keyframes in globals.css only when the
 * host marks the icon active. Sized by the host: the svg fills its container
 * (width/height 100%), color follows `currentColor`. Static markup only —
 * never interpolate user content here.
 */
export const MIC_WAVE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-ink-icon=""><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/><g stroke-width="1"><line data-voice-mic-bar="1" x1="10.4" x2="10.4" y1="7.4" y2="9.6"/><line data-voice-mic-bar="2" x1="12" x2="12" y1="6.2" y2="10.8"/><line data-voice-mic-bar="3" x1="13.6" x2="13.6" y1="7.4" y2="9.6"/></g></svg>`;

export function VoiceInputMicWaveIcon({
  // Default off, opt-in to animate: the level bars are an infinite animation,
  // so the host must turn them on only while truly live (listening). Defaulting
  // on would let a new caller silently burn GPU on a hidden/idle surface — the
  // exact regression this gate fixes.
  active = false,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={className}
      data-voice-mic-active={active ? 'true' : undefined}
      // Static module constant, no user content — safe by construction.
      dangerouslySetInnerHTML={{ __html: MIC_WAVE_ICON_SVG }}
    />
  );
}
