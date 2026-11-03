import { randomUUID } from 'node:crypto';
import { captureTaskActionDeliveryGuard } from './taskActionAuthorization.js';

/** Ephemeral handoff receipts. A restart cannot resurrect a remote queued intervention. */
const receipts = new Map<
  string,
  {
    deviceId: string;
    sessionId: string;
    senderSessionId: string;
    message: string;
    expiresAt: number;
    assertCurrent(): Promise<void>;
  }
>();
const RECEIPT_LIFETIME_MS = 60 * 60_000;

export function issueRemoteTaskActionReceipt(
  input: { deviceId: string; sessionId: string; senderSessionId: string; message: string },
  assertAccount: () => void,
): string {
  for (const [id, receipt] of receipts) if (receipt.expiresAt <= Date.now()) receipts.delete(id);
  if (receipts.size >= 256) throw new Error('Too many pending remote task actions');
  const guard = captureTaskActionDeliveryGuard();
  const id = randomUUID();
  receipts.set(id, {
    ...input,
    expiresAt: Date.now() + RECEIPT_LIFETIME_MS,
    assertCurrent: async () => {
      assertAccount();
      await guard?.();
      assertAccount();
    },
  });
  return id;
}

/** Called only on the authenticated source Host, bound to the consuming computer and body. */
export async function validateRemoteTaskActionReceipt(
  deviceId: string,
  input: {
    receiptId: string;
    sessionId: string;
    targetSessionId: string;
    message: string;
    release?: boolean;
  },
): Promise<boolean> {
  const receipt = receipts.get(input.receiptId);
  if (
    !receipt ||
    receipt.expiresAt <= Date.now() ||
    receipt.deviceId !== deviceId ||
    receipt.senderSessionId !== input.sessionId ||
    receipt.sessionId !== input.targetSessionId ||
    receipt.message !== input.message
  )
    return false;
  try {
    await receipt.assertCurrent();
  } catch {
    receipts.delete(input.receiptId);
    return false;
  }
  if (receipts.get(input.receiptId) !== receipt) return false;
  if (input.release) receipts.delete(input.receiptId);
  return true;
}

export function releaseRemoteTaskActionReceipt(id: string): void {
  receipts.delete(id);
}
