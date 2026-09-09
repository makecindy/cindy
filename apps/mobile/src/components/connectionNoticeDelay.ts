export const CONNECTION_NOTICE_DELAY_MS = 3_000;

/** Cancelling on recovery or unmount prevents brief incidents from flashing a notice. */
export function scheduleConnectionNotice(reveal: () => void): () => void {
  const timer = setTimeout(reveal, CONNECTION_NOTICE_DELAY_MS);
  return () => clearTimeout(timer);
}

/** Clear immediately when work or an incident ends; no completion notification. */
export function updateConnectionNoticeVisibility(
  active: boolean,
  visible: boolean,
  setVisible: (visible: boolean) => void,
): (() => void) | undefined {
  if (active) return visible ? undefined : scheduleConnectionNotice(() => setVisible(true));
  setVisible(false);
}
