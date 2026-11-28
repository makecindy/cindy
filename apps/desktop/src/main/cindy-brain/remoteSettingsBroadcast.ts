/** Installed settings scripts keep using BroadcastChannel; only its transport changes. */
function bridge(endpoint: string) {
  const call = async (command: unknown) => {
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(command) });
    if (!response.ok) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    return response.json();
  };
  const channels = new Map<string, Set<RemoteChannel>>();
  const subscribed = new Set<string>();
  let ready = Promise.resolve();
  let after = 0;
  let polling = false;
  const enqueue = (operation: () => Promise<void>) => {
    const result = ready.then(operation);
    ready = result.catch(() => {});
    return result;
  };
  const subscribe = async (name: string) => {
    if (subscribed.has(name)) return;
    await call({ kind: 'subscribe', channels: [name] });
    subscribed.add(name);
  };
  const subscribeOpenChannel = (name: string) => enqueue(async () => {
    if (channels.has(name)) await subscribe(name);
  }).catch(() => {
    for (const channel of channels.get(name) ?? []) channel.deliverError();
  });
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      const missing = [...channels.keys()].filter((name) => !subscribed.has(name));
      await Promise.all(missing.map(subscribeOpenChannel));
      if (!subscribed.size) return;
      const result = await call({ kind: 'poll', after });
      for (const event of result.events) {
        for (const channel of channels.get(event.channel) ?? []) channel.deliver(event.data);
        after = Math.max(after, event.sequence);
      }
    } catch {
      for (const group of channels.values()) for (const channel of group) channel.deliverError();
    } finally {
      polling = false;
      if (channels.size) setTimeout(() => void poll(), 800);
    }
  }
  class RemoteChannel extends EventTarget {
    // This function is serialized into the guest; avoid emitted class-field helpers.
    declare readonly name: string;
    declare onmessage: ((event: MessageEvent) => void) | null;
    declare onmessageerror: ((event: MessageEvent) => void) | null;
    declare private closed: boolean;
    constructor(name: string) {
      super();
      this.name = String(name);
      this.onmessage = null;
      this.onmessageerror = null;
      this.closed = false;
      const members = channels.get(this.name);
      if (members) members.add(this);
      else channels.set(this.name, new Set([this]));
      if (polling && !members) void subscribeOpenChannel(this.name);
      else void poll();
    }
    postMessage(data: unknown) {
      if (this.closed) throw new DOMException('Channel closed', 'InvalidStateError');
      const copy = structuredClone(data);
      void enqueue(() => subscribe(this.name))
        .then(() => call({ kind: 'post', channel: this.name, data: copy }))
        .catch(() => this.deliverError());
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      const members = channels.get(this.name);
      members?.delete(this);
      if (!members?.size) {
        channels.delete(this.name);
        void enqueue(async () => {
          // An uncertain unsubscribe must not prevent a later subscription.
          subscribed.delete(this.name);
          await call({ kind: 'unsubscribe', channel: this.name });
        }).catch(() => {});
      }
    }
    deliver(data: unknown) {
      if (this.closed) return;
      const event = new MessageEvent('message', { data });
      this.onmessage?.(event);
      this.dispatchEvent(event);
    }
    deliverError() {
      if (this.closed) return;
      const event = new MessageEvent('messageerror');
      this.onmessageerror?.(event);
      this.dispatchEvent(event);
    }
  }
  Object.defineProperty(window, 'BroadcastChannel', { value: RemoteChannel });
}

export function remoteSettingsBroadcastScript(endpoint: string): string {
  return '(' + bridge.toString() + ')(' + JSON.stringify(endpoint) + ');';
}
