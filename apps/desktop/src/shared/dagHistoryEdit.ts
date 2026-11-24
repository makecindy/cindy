/** Local trusted desktop API; never accepts a renderer-authored deletion manifest. */
export type DagHistoryEditAction = 'delete' | 'withdraw';
export type DagHistoryEditPreview = {
  operationId: string;
  sessionId: string;
  clientId: string;
  action: DagHistoryEditAction;
  turnCount: number;
  branchCount: number;
  canCommit: boolean;
  reason?: string;
};
export type DagHistoryEditReceipt = {
  operationId: string;
  sessionId: string;
  status: 'committed' | 'undone';
  removedSessionIds: string[];
  question?: string;
};
export type DagHistoryChange = { ids: string[]; owner: import('./dataOwnerPush').DataOwnerPushStamp };
export interface DagHistoryEditApi {
  onChanged?(listener: (change: DagHistoryChange) => void): () => void;
  preview(
    sessionId: string,
    clientId: string,
    action: DagHistoryEditAction,
    owner: import('./dataOwnerPush').DataOwnerPushStamp,
  ): Promise<DagHistoryEditPreview>;
  commit(
    operationId: string,
    owner: import('./dataOwnerPush').DataOwnerPushStamp,
  ): Promise<DagHistoryEditReceipt>;
  undo(
    operationId: string,
    owner: import('./dataOwnerPush').DataOwnerPushStamp,
  ): Promise<DagHistoryEditReceipt>;
  status(
    operationId: string,
    owner: import('./dataOwnerPush').DataOwnerPushStamp,
  ): Promise<DagHistoryEditReceipt | null>;
}
