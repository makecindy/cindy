/**
 * A connection merged into an account pool is hidden behind that pool and has no remote-use settings of
 * its own on screen, so its 「允许被远程调用」 and remote model range follow the pool (2026-11-18 user decision).
 * The provider service wires the resolver at startup; it owns account placement, which keeps the permission
 * stores free of that dependency. Without a resolver every id stands for itself.
 */
let mergedProviderPool: ((providerId: string) => string | undefined) | null = null;

export function setMergedProviderPoolResolver(resolver: ((providerId: string) => string | undefined) | null): void {
  mergedProviderPool = resolver;
}

/** The provider whose remote-use settings apply to `providerId`. */
export function remoteAccessProviderId(providerId: string): string {
  try {
    return mergedProviderPool?.(providerId) ?? providerId;
  } catch {
    return providerId;
  }
}
