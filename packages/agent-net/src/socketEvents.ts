// Host-neutral event interface. No Node EventEmitter reaches a mobile bundle.
type Listener = (...args: any[]) => void;
export class SocketEvents {
  private listeners = new Map<string, Set<Listener>>();
  on(event: string, listener: Listener): this {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, set = new Set());
    set.add(listener); return this;
  }
  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => { this.off(event, wrapped); listener(...args); };
    return this.on(event, wrapped);
  }
  off(event: string, listener: Listener): this { this.listeners.get(event)?.delete(listener); return this; }
  removeListener(event: string, listener: Listener): this { return this.off(event, listener); }
  removeAllListeners(event?: string): this {
    if (event === undefined) this.listeners.clear(); else this.listeners.delete(event);
    return this;
  }
  emit(event: string, ...args: any[]): boolean {
    const set = this.listeners.get(event);
    for (const listener of [...(set ?? [])]) listener(...args);
    return !!set?.size;
  }
}
