import {
  isMobileAuthOwnerCurrent,
  subscribeMobileAuthOwner,
  type MobileAuthOwnerGeneration,
} from '@/auth/authOwnerGeneration';
import { beginBackgroundWork } from '@/notifications/backgroundWork';
import { isDurableOutboxHandedOff, type DurableOutboxRecord } from './durableOutbox';

const MAX_BUDGET_MS = 20_000;
const INITIAL_BUDGET_MS = 8_000;

interface DeliveryWindow {
  owner: MobileAuthOwnerGeneration;
  deviceId: string;
  clientId: string;
  until: number;
  end(): void;
}

const windows = new Map<string, DeliveryWindow>();

/** One bounded execution window for an explicit, already persisted first send. */
export function beginNewSessionBackgroundDelivery(
  owner: MobileAuthOwnerGeneration,
  deviceId: string,
  sessionId: string,
  clientId: string,
  holdConnection?: () => () => void,
): () => void {
  if (!holdConnection || !owner.accountKey || !isMobileAuthOwnerCurrent(owner)) return () => {};
  windows.get(sessionId)?.end();
  const start = Date.now();
  const releaseConnection = holdConnection();
  let releaseWork: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout>;
  const window: DeliveryWindow = {
    owner, deviceId, clientId, until: start + INITIAL_BUDGET_MS,
    end() {
      if (windows.get(sessionId) !== window) return;
      windows.delete(sessionId);
      clearTimeout(timer);
      unsubscribe();
      releaseConnection();
      releaseWork?.();
    },
  };
  const unsubscribe = subscribeMobileAuthOwner(() => {
    if (!isMobileAuthOwnerCurrent(owner)) window.end();
  });
  windows.set(sessionId, window);
  timer = setTimeout(window.end, INITIAL_BUDGET_MS);
  void beginBackgroundWork(MAX_BUDGET_MS).then((work) => {
    if (windows.get(sessionId) !== window) {
      work.end();
      return;
    }
    releaseWork = work.end;
    window.until = start + work.budgetMs;
    clearTimeout(timer);
    const remaining = window.until - Date.now();
    if (remaining <= 0) window.end();
    else timer = setTimeout(window.end, remaining);
  }).catch(() => undefined);
  return window.end;
}

function windowFor(record: DurableOutboxRecord): DeliveryWindow | undefined {
  const window = windows.get(record.item.sessionId);
  if (window?.owner.accountKey !== record.accountId || !isMobileAuthOwnerCurrent(window.owner)
    || window.deviceId !== record.deviceId || window.clientId !== record.item.clientId) return undefined;
  return window;
}

export function canDeliverNewSessionInBackground(record: DurableOutboxRecord): boolean {
  const window = windowFor(record);
  return !!window && Date.now() < window.until;
}

export function endNewSessionBackgroundDelivery(record: DurableOutboxRecord): void {
  if (!isDurableOutboxHandedOff(record)) return;
  windowFor(record)?.end();
}
