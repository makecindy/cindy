/**
 * Shared ownership of a WebContents debugger attachment.
 *
 * Several features drive the same guest through its debugger (the browser automation,
 * a phone viewing a plugin preview). Whoever finds the debugger detached attaches it and
 * owns a lease; whoever finds it attached by a lease holder joins that ownership; an
 * attachment nobody leased (DevTools) is never ours to detach. The last lease out detaches,
 * so one party finishing never cuts the session another is still using.
 */

export interface LeasableDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
}

export interface DebuggerLease {
  /** False for a debugger someone else attached outside the lease scheme. */
  readonly owns: boolean;
}

export const DEBUGGER_PROTOCOL_VERSION = '1.3';

const leaseCounts = new WeakMap<object, number>();

export function acquireDebuggerLease(
  transport: LeasableDebugger,
  protocolVersion: string = DEBUGGER_PROTOCOL_VERSION,
): DebuggerLease {
  const existing = leaseCounts.get(transport);
  const owns = existing !== undefined || !transport.isAttached();
  if (!transport.isAttached()) transport.attach(protocolVersion);
  if (owns) leaseCounts.set(transport, (existing ?? 0) + 1);
  return { owns };
}

/** True when this was the last lease, i.e. the caller should detach if still attached. */
export function releaseDebuggerLease(transport: object, lease: DebuggerLease): boolean {
  if (!lease.owns) return false;
  const remaining = (leaseCounts.get(transport) ?? 1) - 1;
  if (remaining > 0) {
    leaseCounts.set(transport, remaining);
    return false;
  }
  leaseCounts.delete(transport);
  return true;
}
