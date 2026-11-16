/** Registered business handlers. Caller identity and channel admission remain
 * in the shared Device Link dispatcher; this registry grants no permissions. */
export function createInvokeRegistry() {
  const handlers = new Map<string, (args: unknown[]) => unknown>();
  return {
    register(channel: string, handler: (args: unknown[]) => unknown): void {
      handlers.set(channel, handler);
    },
    remove(channel: string): void { handlers.delete(channel); },
    has(channel: string): boolean { return handlers.has(channel); },
    size(): number { return handlers.size; },
    clear(): void { handlers.clear(); },
    async dispatch(channel: string, args: unknown[]): Promise<unknown> {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`[NOT_FOUND] no local IPC handler for channel '${channel}'`);
      return await handler(args);
    },
  };
}
