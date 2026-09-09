const STORAGE_KEY = 'sessionRuntimeFallback.enabled';

type Subscriber = (value: boolean) => void;
const subscribers = new Set<Subscriber>();

export function getSessionRuntimeFallbackEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setSessionRuntimeFallbackEnabled(next: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, next ? 'true' : 'false');
  } catch {
    // Main remains authoritative; this mirror only keeps open windows in sync.
  }
  subscribers.forEach((subscriber) => subscriber(next));
}

export function subscribeSessionRuntimeFallbackEnabled(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) subscriber(getSessionRuntimeFallbackEnabled());
  };
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(subscriber);
    window.removeEventListener('storage', onStorage);
  };
}
