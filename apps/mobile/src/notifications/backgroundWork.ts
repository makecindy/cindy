import { requireOptionalNativeModule } from 'expo-modules-core';
import { AppRegistry, Platform } from 'react-native';

interface NativeBackgroundWork {
  begin(): Promise<{ id: number; remainingMs: number }>;
  end(id: number): Promise<void>;
  waitUntilEnded?(id: number): Promise<void>;
}

const native = Platform.OS === 'ios' || Platform.OS === 'android'
  ? requireOptionalNativeModule<NativeBackgroundWork>('CindyBackgroundWork')
  : null;

// The native task keeps RN's timer loop running after Activity.onPause. Its
// promise settles on explicit release or the native deadline, including when
// release wins the race with this JS task starting. Old Android builds omit it.
if (Platform.OS === 'android' && native?.waitUntilEnded) {
  AppRegistry.registerHeadlessTask('CindyBackgroundWork', () => async ({ id }: { id: number }) => {
    await native.waitUntilEnded!(id);
  });
}

/** Without a grant the app may be suspended at any moment; do not plan long work. */
const UNGRANTED_BUDGET_MS = 8_000;
/** Leave the system's last seconds unused: an overrun terminates the app. */
const SAFETY_MARGIN_MS = Platform.OS === 'ios' ? 3_000 : 0;

/**
 * Asks the system for background run time for one piece of work the person
 * started from a notification. `budgetMs` is how long that work may take.
 * Always call `end`. Installed apps without this native module get a short
 * budget and no grant. Android only keeps RN timers active, not the process.
 */
export async function beginBackgroundWork(maxMs: number): Promise<{ budgetMs: number; end(): void }> {
  const grant = await native?.begin().catch(() => null) ?? null;
  if (!grant || grant.id === 0) return { budgetMs: Math.min(maxMs, UNGRANTED_BUDGET_MS), end: () => {} };
  const granted = grant.remainingMs < 0 ? maxMs : Math.max(0, grant.remainingMs - SAFETY_MARGIN_MS);
  let ended = false;
  return {
    budgetMs: Math.min(maxMs, granted),
    end: () => {
      if (ended) return;
      ended = true;
      void native?.end(grant.id).catch(() => undefined);
    },
  };
}
