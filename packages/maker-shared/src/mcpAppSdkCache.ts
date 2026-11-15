import type { McpAppDocument } from './mcpApps.js';

type Sdk = NonNullable<McpAppDocument['sdk']>;
/** Wire hash: SHA-256 (UTF-8), lowercase hex, of this fixed-order JSON tuple. */
export function mcpAppSdkCacheText(sdk: Sdk): string {
  const addon = sdk.addons?.['cindy/view-state'];
  return JSON.stringify([sdk.source, addon?.source ?? null, addon?.reactSource ?? null]);
}

/** Optimization only: eviction never limits which Apps can be opened. */
export class McpAppSdkCache {
  private owner: unknown = Symbol();
  private readonly entries = new Map<string, { peer: string; hash: string; sdk: Sdk; chars: number }>();
  private chars = 0;
  constructor(private readonly digest: (text: string) => string | Promise<string>) {}

  async open(
    owner: unknown, peer: string, input: Record<string, unknown>,
    send: (input: Record<string, unknown>) => Promise<unknown>, assertCurrent: () => void,
  ): Promise<McpAppDocument> {
    assertCurrent();
    if (this.owner !== owner) { this.entries.clear(); this.chars = 0; this.owner = owner; }
    // Pin advertised bytes through the request: concurrent opens/evictions cannot
    // invalidate a promise already made to the executor.
    const offered = new Map([...this.entries.values()].filter(entry => entry.peer === peer).map(entry => [entry.hash, entry.sdk]));
    let document = await send({ ...input, sdkCacheHashes: [...offered.keys()] }) as McpAppDocument;
    assertCurrent();
    if (!document.sdk && document.sdkRef !== undefined) {
      const sdk = offered.get(document.sdkRef);
      if (sdk) {
        const { sdkRef: _ref, ...rest } = document;
        return { ...rest, sdk };
      }
      // Unknown/incorrect references get one source-only reopen. Retire the first
      // View before opening another; never replay a page tool or reset the link.
      await send({ op: 'teardown', viewId: document.viewId });
      assertCurrent();
      document = await send({ ...input, sdkCacheHashes: [] }) as McpAppDocument;
      assertCurrent();
      if (!document.sdk && document.sdkRef !== undefined) {
        await send({ op: 'teardown', viewId: document.viewId });
        throw new Error('MCP_APP_INVALID_DOCUMENT');
      }
    }
    if (document.sdk && typeof document.sdk.source === 'string') {
      const addon = document.sdk.addons?.['cindy/view-state'];
      const sdk: Sdk = Object.freeze({ source: document.sdk.source, ...(addon &&
        typeof addon.source === 'string' && typeof addon.reactSource === 'string' ? {
          addons: Object.freeze({ 'cindy/view-state': Object.freeze({ source: addon.source, reactSource: addon.reactSource }) }),
        } : {}) });
      const text = mcpAppSdkCacheText(sdk);
      if (text.length <= 4 * 1024 * 1024) {
        // Hashing failure must not prevent a complete, valid document from opening.
        let hash: string | undefined;
        try { hash = await this.digest(text); } catch { /* Keep the full-source path. */ }
        assertCurrent();
        if (hash && /^[a-f0-9]{64}$/.test(hash) && this.owner === owner) {
          const key = JSON.stringify([peer, hash]);
          this.chars -= this.entries.get(key)?.chars ?? 0;
          this.entries.delete(key);
          this.entries.set(key, { peer, hash, sdk, chars: text.length });
          this.chars += text.length;
          while (this.entries.size > 8 || this.chars > 4 * 1024 * 1024) {
            const oldest = this.entries.keys().next().value!;
            this.chars -= this.entries.get(oldest)!.chars;
            this.entries.delete(oldest);
          }
        }
      }
    }
    const { sdkRef: _ref, ...rest } = document;
    return rest;
  }
}
