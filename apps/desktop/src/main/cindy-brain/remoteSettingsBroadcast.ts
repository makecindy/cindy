/** Installed settings scripts keep using BroadcastChannel; only its transport changes. */
function bridge(endpoint: string) {
  const call = async (command: unknown) => {
    const response = await fetch(endpoint, { method: 'POST', body: JSON.stringify(command) });
    if (!response.ok) throw new Error('PLUGIN_PAGE_UNAVAILABLE');
    return response.json();
  };
  const channels = new Map<string, Set<RemoteChannel>>();
  let ready = Promise.resolve(),
    after = 0,
    polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      await ready;
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
      const members = channels.get(this.name) ?? new Set();
      members.add(this);
      channels.set(this.name, members);
      ready = ready.then(() => call({ kind: 'subscribe', channels: [this.name] }));
      void poll();
    }
    postMessage(data: unknown) {
      if (this.closed) throw new DOMException('Channel closed', 'InvalidStateError');
      const copy = structuredClone(data);
      void ready
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
        ready = ready.then(() => call({ kind: 'unsubscribe', channel: this.name }));
        void ready.catch(() => {});
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
