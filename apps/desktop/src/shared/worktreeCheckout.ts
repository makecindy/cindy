/** Same-account checkout operations. Missing detect-cwd capability means read-only. */
export interface CheckoutSession {
  id: string;
  name: string;
  running: boolean;
}
export type CheckoutBlock =
  | 'busy'
  | 'operation'
  | 'occupied'
  | 'changed'
  | 'conflict'
  | 'dirty'
  | 'diverged'
  | 'missing'
  | 'git';
export interface CheckoutStatus {
  current: string;
  head: string;
  files: string[];
  /** Optional display details; older hosts omit them. */
  fileDetails?: Record<string, { kind?: 'new' | 'deleted'; added?: number; removed?: number }>;
  fingerprint: string;
  sessions: CheckoutSession[];
  occupied: string[];
  blocked?: CheckoutBlock;
  carryAllowed: boolean;
  /** Optional detail for conflict; old peers can still use the generic block reason. */
  ignoredCollision?: { branch: string; paths: string[] };
  stashes: Array<{ id: string; branch: string }>;
}
export interface CheckoutReceipt {
  id: string;
  from: string;
  to: string;
  strategy: 'carry' | 'stash';
  hadChanges: boolean;
  /** New commits fetched from the selected remote ref; older peers omit this display detail. */
  fetchedCommits?: number;
  sessions: CheckoutSession[];
}
export type CheckoutRequest =
  | { baseRepo: string; action: 'status'; branch?: string }
  | {
      baseRepo: string;
      action: 'switch';
      branch: string;
      expected: string;
      fingerprint: string;
      strategy: 'carry' | 'stash';
      operationId: string;
    }
  | { baseRepo: string; action: 'undo'; receiptId: string; operationId: string }
  | { baseRepo: string; action: 'restore'; stashId: string; expected: string; operationId: string }
  | { baseRepo: string; action: 'result'; operationId: string };
export type CheckoutResult = {
  status: CheckoutStatus;
  receipt?: CheckoutReceipt;
  /** Checkout has returned to the original branch, even if restoring the stash failed. */
  undoApplied?: boolean;
  blocked?: CheckoutBlock;
};
export type CheckoutReply = CheckoutResult | { pending: true; operationId: string };
