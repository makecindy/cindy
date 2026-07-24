type VoiceInputStartPreflightLock = { current: boolean };

export async function runVoiceInputStartPreflight(
  lock: VoiceInputStartPreflightLock,
  preflight?: () => boolean | Promise<boolean>,
): Promise<boolean> {
  if (lock.current) return false;
  lock.current = true;
  try {
    return preflight ? await preflight() : true;
  } finally {
    lock.current = false;
  }
}
