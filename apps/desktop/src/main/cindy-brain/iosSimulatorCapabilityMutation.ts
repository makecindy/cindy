import { AsyncLocalStorage } from 'node:async_hooks';

interface IOSSimulatorCapabilityManifest {
  slots: readonly string[];
}

let mutationTail: Promise<void> = Promise.resolve();
const heldMutation = new AsyncLocalStorage<boolean>();

async function acquireIOSSimulatorCapabilityMutation(): Promise<() => void> {
  if (heldMutation.getStore() === true) return () => undefined;

  const previous = mutationTail;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationTail = previous.then(
    () => gate,
    () => gate,
  );
  await previous.catch(() => undefined);

  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
  };
}

/**
 * Serialize durable iOS Simulator capability changes with Host teardown.
 * A later enable must not report success while an older disable can still
 * retire viewer, driver, media, device, or ownership state underneath it.
 */
export function runIOSSimulatorCapabilityMutation<T>(mutation: () => Promise<T>): Promise<T> {
  // Install/update cardpoints can re-enter through a narrower shared helper
  // after they already acquired this queue. Treat that as the same mutation;
  // enqueueing behind our own unresolved tail would self-deadlock.
  if (heldMutation.getStore() === true) return mutation();

  return (async () => {
    const release = await acquireIOSSimulatorCapabilityMutation();
    try {
      return await heldMutation.run(true, mutation);
    } finally {
      release();
    }
  })();
}

/**
 * Serialize a package mutation only when either the installed or incoming
 * manifest owns the Host-managed iOS Simulator slot.
 */
export function runIOSSimulatorManifestMutation<T>(
  manifests: readonly (IOSSimulatorCapabilityManifest | null | undefined)[],
  mutation: () => Promise<T>,
): Promise<T> {
  return manifests.some((manifest) => manifest?.slots.includes('ios-simulator'))
    ? runIOSSimulatorCapabilityMutation(mutation)
    : mutation();
}

/** Acquire the same FIFO around an existing mutation body without reindenting it. */
export function acquireIOSSimulatorManifestMutation(
  manifests: readonly (IOSSimulatorCapabilityManifest | null | undefined)[],
): Promise<() => void> {
  return manifests.some((manifest) => manifest?.slots.includes('ios-simulator'))
    ? acquireIOSSimulatorCapabilityMutation()
    : Promise.resolve(() => undefined);
}
