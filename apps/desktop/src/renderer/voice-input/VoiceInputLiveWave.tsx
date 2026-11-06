const BAR_COUNT = 14;

/** Decorative level bars for the listening state; no audio data crosses this component. */
export function VoiceInputLiveWave({ className }: { className?: string }) {
  return (
    <span aria-hidden className={`inline-flex h-3 items-center gap-[2px] ${className ?? ''}`}>
      {Array.from({ length: BAR_COUNT }, (_, index) => (
        <span
          key={index}
          className="voice-input-wave-bar"
          style={{
            animationDelay: `${index * 55}ms`,
            animationDuration: `${760 + (index % 4) * 90}ms`,
          }}
        />
      ))}
    </span>
  );
}
