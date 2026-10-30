/** Bound both offer and fallback enumeration; late results have no side effects. */
export async function enumerateDesktopSources<T>(
  enumerate: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      enumerate(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DESKTOP_VIDEO_TIMEOUT')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A display can remain attached while its capture source is temporarily unavailable. */
export function desktopCaptureSource<T extends { display_id: string }>(
  sources: readonly T[],
  displayId: string,
  displays: readonly { id: number }[],
): T | null {
  if (!displays.some(display => String(display.id) === displayId))
    throw new Error('DESKTOP_DISPLAY_MISSING');
  // Never substitute another monitor or guess a mapping from source ordering.
  return sources.find(source => source.display_id === displayId) ?? null;
}
