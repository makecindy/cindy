import type { PluginPageEvent } from '@cindy/device-link';

export type MobileRelayOperation =
  | { op: 'connect'; pageId: string; channels: string[] }
  | { op: 'post'; pageId: string; channel: string; data: unknown }
  | { op: 'poll'; pageId: string; after: number }
  | { op: 'disconnect'; pageId: string };

/** Runs in the existing, owner-scoped logic sandbox. No new process or plugin API. */
function relay(operation: MobileRelayOperation) {
  type Page = {
    channels: Map<string, BroadcastChannel>;
    events: PluginPageEvent[];
    sequence: number;
    bytes: number;
    overflow: boolean;
  };
  const root = globalThis as typeof globalThis & { __cindyMobilePages?: Map<string, Page> };
  const pages: Map<string, Page> = (root.__cindyMobilePages ??= new Map<string, Page>());
  let page: Page | undefined = pages.get(operation.pageId);
  if (operation.op === 'connect') {
    if (page) return;
    page = { channels: new Map(), events: [], sequence: 0, bytes: 0, overflow: false };
    const target = page;
    for (const name of operation.channels) {
      const channel = new BroadcastChannel(name);
      channel.onmessage = (event) => {
        let data: unknown, bytes: number;
        try {
          const json = JSON.stringify(event.data);
          bytes = new TextEncoder().encode(json).length;
          data = JSON.parse(json);
        } catch {
          return;
        }
        // A slow controller must recover its page state; never silently skip an ACK.
        if (bytes > 49_152 || target.events.length >= 256 || target.bytes + bytes > 1_048_576) {
          target.overflow = true;
          return;
        }
        target.events.push({ sequence: ++target.sequence, channel: name, data });
        target.bytes += bytes;
      };
      target.channels.set(name, channel);
    }
    pages.set(operation.pageId, target);
    return;
  }
  if (!page) throw new Error('PLUGIN_PAGE_CLOSED');
  if (operation.op === 'disconnect') {
    for (const channel of page.channels.values()) channel.close();
    pages.delete(operation.pageId);
    return;
  }
  if (operation.op === 'poll') {
    if (page.overflow) throw new Error('PLUGIN_PAGE_RESYNC_REQUIRED');
    page.events = page.events.filter((event) => event.sequence > operation.after);
    page.bytes = new TextEncoder().encode(JSON.stringify(page.events)).length;
    const batch: PluginPageEvent[] = [];
    let bytes = 0;
    for (const event of page.events) {
      const size = new TextEncoder().encode(JSON.stringify(event)).length;
      if (batch.length && bytes + size > 64 * 1024) break;
      batch.push(event);
      bytes += size;
    }
    return batch;
  }
  const channel = page.channels.get(operation.channel);
  if (!channel) throw new Error('PLUGIN_CHANNEL_UNAVAILABLE');
  const data = operation.data;
  // Plugins forward this opaque origin when requesting a host confirmation.
  channel.postMessage(
    data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data, mobilePageId: operation.pageId }
      : data,
  );
}

export function mobilePageRelayScript(operation: MobileRelayOperation): string {
  return `(${relay.toString()})(${JSON.stringify(operation)})`;
}
