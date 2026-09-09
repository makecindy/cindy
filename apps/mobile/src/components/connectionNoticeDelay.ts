export const CONNECTION_NOTICE_DELAY_MS = 1_000;

/** Cancelling on recovery or unmount prevents brief incidents from flashing a notice. */
export function scheduleConnectionNotice(reveal: () => void): () => void {
  const timer = setTimeout(reveal, CONNECTION_NOTICE_DELAY_MS);
  return () => clearTimeout(timer);
}

/** Completion may linger only if the preceding incident was already visible. */
export function updateConnectionNoticeVisibility(
  active: boolean,
  completed: boolean,
  visible: boolean,
  setVisible: (visible: boolean) => void,
): (() => void) | undefined {
  if (active) return visible ? undefined : scheduleConnectionNotice(() => setVisible(true));
  if (completed && visible) {
    const timer = setTimeout(() => setVisible(false), 2_000);
    return () => clearTimeout(timer);
  }
  setVisible(false);
}
