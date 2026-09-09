export const CONNECTION_NOTICE_DELAY_MS = 1_000;

/** Cancelling on recovery or unmount prevents brief incidents from flashing a notice. */
export function scheduleConnectionNotice(reveal: () => void): () => void {
  const timer = setTimeout(reveal, CONNECTION_NOTICE_DELAY_MS);
  return () => clearTimeout(timer);
}
