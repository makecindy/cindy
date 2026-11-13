/** A local URI is accepted only when the native decrypt/cache adapter produced
 * this very object. Remote JSON cannot authorize arbitrary local file reads. */
const receipts = new WeakSet<object>();
export function localAgentNetMediaReceipt<T extends object>(value: T): T { receipts.add(value); return value; }
export function isLocalAgentNetMediaReceipt(value: unknown): boolean {
  return !!value && typeof value === 'object' && receipts.has(value);
}
