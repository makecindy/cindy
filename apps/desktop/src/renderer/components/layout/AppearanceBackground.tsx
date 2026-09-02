import { useAppearanceBackground } from '@/hooks/useAppearanceBackground';

/** Decorative app background; interaction and accessibility stay with foreground UI. */
export function AppearanceBackground() {
  const { backgroundImage, backgroundOverlay, backgroundBlur } = useAppearanceBackground();
  if (!backgroundImage) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="absolute inset-[-24px] bg-cover bg-center bg-no-repeat"
        style={{
          backgroundImage: `url("${backgroundImage}")`,
          filter: backgroundBlur > 0 ? `blur(${backgroundBlur}px)` : undefined,
        }}
      />
      <div className="absolute inset-0 bg-content-area" style={{ opacity: backgroundOverlay }} />
    </div>
  );
}
