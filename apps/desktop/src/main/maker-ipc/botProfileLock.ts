/** Serialize lifecycle changes with shared-history writes in this Main process. */
const profileLocks = new Map<string, Promise<void>>();

export async function withBotProfileLocks<T>(
  botIds: readonly string[],
  run: () => Promise<T>,
): Promise<T> {
  // Opposing private messages must acquire the same pair in the same order.
  const ids = [...new Set(botIds)].sort();
  const acquire = async (index: number): Promise<T> => {
    if (index === ids.length) return run();
    const id = ids[index];
    const previous = profileLocks.get(id);
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    profileLocks.set(id, current);
    await previous;
    try {
      return await acquire(index + 1);
    } finally {
      release();
      if (profileLocks.get(id) === current) profileLocks.delete(id);
    }
  };
  return acquire(0);
}
