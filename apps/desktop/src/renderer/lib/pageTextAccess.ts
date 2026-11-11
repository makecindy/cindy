/** A DOM text consumer can request complete text from each current logical
 * window. This only changes mounting; it never fetches or extends history. */
const leases = new Set<symbol>();
const listeners = new Set<() => void>();
export const PAGE_TEXT_NAVIGATION_EVENT = 'cindy-page-text-navigation';

/** Give an owning scroll coordinator first refusal before generic DOM scrolling.
 * A handled request must preserve the text target and its pagination boundary. */
export function requestPageTextNavigation(range: Range): boolean {
  const element = range.startContainer.parentElement;
  if (!element) return false;
  return !element.dispatchEvent(new CustomEvent<Range>(PAGE_TEXT_NAVIGATION_EVENT, {
    bubbles: true, cancelable: true, detail: range,
  }));
}

export const isPageTextAccessActive = () => leases.size > 0;

export function subscribePageTextAccess(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function acquirePageTextAccess() {
  const lease = Symbol();
  const wasActive = isPageTextAccessActive();
  leases.add(lease);
  if (!wasActive) listeners.forEach(listener => listener());
  return () => {
    if (leases.delete(lease) && !isPageTextAccessActive()) {
      listeners.forEach(listener => listener());
    }
  };
}
