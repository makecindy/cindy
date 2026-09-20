import type {
  CindyMakeCompletionMeta,
  CindyMakePersonalBuildState,
  CindyMakeTestState,
} from './cindyMakeSession';

export type MakeFeatureAction = 'integrate' | 'revert' | 'reapply';
export interface MakeFeatureReceipt {
  id: string;
  action: MakeFeatureAction;
  at: number;
  baselineCommit: string;
  commit: string;
  beforeTree: string;
  tree: string;
  taskTree: string;
}
export interface MakeHistoryCompletion extends CindyMakeCompletionMeta {
  id: string;
}
export interface MakeHistoryVersion {
  operationId: string;
  commit: string;
  at?: number;
  versionId?: string;
}
/** Durable, owner-private facts; directory cleanup does not delete this record. */
export interface CindyMakeHistoryRecord {
  schema: 1;
  runId: string;
  sessionId: string;
  title: string;
  request: string;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  /** User dismissed this record from Settings; durable facts remain for builds and undo. */
  hiddenAt?: number;
  completions: MakeHistoryCompletion[];
  receipts: MakeFeatureReceipt[];
  versions: MakeHistoryVersion[];
}
export type MakeHistoryAction =
  | MakeFeatureAction
  | 'open'
  | 'continue'
  | 'test'
  | 'resolve'
  | 'retry'
  | 'build'
  | 'end'
  | 'retry-prepare'
  | 'retry-cleanup'
  | 'hide';
export type MakeHistoryLifecycle =
  'preparing' | 'running' | 'editing' | 'ready' | 'failed' | 'ended' | 'cleanup';
export type MakeHistoryIntegration =
  'unintegrated' | 'integrated' | 'changed' | 'reverted' | 'unknown' | 'unchanged';
export type MakeHistoryActionReason =
  | 'busy'
  | 'checking'
  | 'ended'
  | 'sessionUnavailable'
  | 'completionUnavailable'
  | 'sourceUnavailable'
  | 'changedAfterCompletion';
export interface CindyMakeHistoryItem extends CindyMakeHistoryRecord {
  lifecycle: MakeHistoryLifecycle;
  integration: MakeHistoryIntegration;
  actions: MakeHistoryAction[];
  completionId?: string;
  resolutionSessionId?: string;
  operation?: MakeFeatureAction | 'end' | 'build';
  conflict?: boolean;
  operationError?: string;
  needsBuild?: boolean;
  build?: CindyMakePersonalBuildState;
  /** The current completion card's test receipt, reconciled by the same Main controller. */
  test?: CindyMakeTestState;
  /** Why the action area is empty; derived from Main facts, never guessed by Renderer. */
  actionReason?: MakeHistoryActionReason;
  /** Main-owned permission to hide this entry after its workspace is reclaimed. */
  canHide?: boolean;
}
export interface CindyMakeHistoryState {
  items: CindyMakeHistoryItem[];
  busy: boolean;
  canBuild: boolean;
  build?: CindyMakePersonalBuildState;
}
/** The last undo removes all preceding active changes; reapply starts a new effective delta. */
export function activeFeatureReceipts(receipts: MakeFeatureReceipt[]): MakeFeatureReceipt[] {
  const lastUndo = receipts.findLastIndex((receipt) => receipt.action === 'revert');
  return receipts.slice(lastUndo + 1).filter((receipt) => receipt.action !== 'revert');
}
/** One policy for both the visible controls and Main's action admission. */
export function makeHistoryActions(facts: {
  lifecycle: MakeHistoryLifecycle;
  integration: MakeHistoryIntegration;
  sessionAvailable: boolean;
  workspaceAvailable: boolean;
  sourceAvailable: boolean;
  completed: boolean;
  hasReceipts: boolean;
  busy: boolean;
  conflict: boolean;
  newChanges?: boolean;
  recoverableFailure?: boolean;
  buildFailed?: boolean;
  needsBuild?: boolean;
  buildSourceAvailable?: boolean;
  canEdit?: boolean;
  /** A different task owns the global project lock, but this task can still be ended safely. */
  allowCleanupWhileBusy?: boolean;
  /** Use the completion controller's receipt for admission as well as presentation. */
  test?: CindyMakeTestState;
}): MakeHistoryAction[] {
  const actions: MakeHistoryAction[] = facts.sessionAvailable ? ['open'] : [];
  if (facts.test?.status === 'starting') return actions;
  // Continue is the one action that stops a ready test through its controller.
  // Do not depend on a global busy snapshot taken before the latest receipt.
  if (facts.test?.status === 'ready')
    return facts.completed &&
      facts.sessionAvailable &&
      facts.workspaceAvailable &&
      facts.lifecycle === 'ready' &&
      !facts.conflict
      ? [...actions, 'continue']
      : actions;
  if (facts.busy) {
    if (!facts.allowCleanupWhileBusy) return actions;
    if (facts.conflict || facts.lifecycle === 'preparing' || facts.lifecycle === 'running')
      return actions;
    if (facts.lifecycle === 'cleanup') return [...actions, 'retry-cleanup'];
    if (facts.lifecycle === 'ended' || !facts.sessionAvailable) return actions;
    if (facts.integration === 'unknown' && !(facts.sourceAvailable || !facts.workspaceAvailable))
      return actions;
    return [...actions, 'end'];
  }
  if (facts.recoverableFailure) return [...actions, 'retry'];
  if (
    (facts.buildFailed || facts.needsBuild) &&
    (facts.buildSourceAvailable ?? facts.sourceAvailable)
  )
    actions.push('build');
  if (facts.conflict) return [...actions, 'resolve'];
  if (facts.lifecycle === 'cleanup') return [...actions, 'retry-cleanup'];
  if (facts.lifecycle === 'preparing' || facts.lifecycle === 'running') return actions;
  if (facts.integration === 'unknown')
    return facts.lifecycle !== 'ended' &&
      facts.sessionAvailable &&
      (facts.sourceAvailable || !facts.workspaceAvailable)
      ? [...actions, 'end']
      : actions;
  if (facts.lifecycle === 'failed' && facts.sessionAvailable && facts.canEdit !== false)
    return [...actions, 'retry-prepare', 'end'];
  if (facts.lifecycle !== 'ended' && facts.sessionAvailable) {
    if (facts.workspaceAvailable && facts.completed) {
      actions.push('continue');
      if (facts.sourceAvailable && facts.integration !== 'unchanged') actions.push('test');
    }
  }
  if (
    facts.completed &&
    (facts.workspaceAvailable || facts.lifecycle === 'ended') &&
    facts.sourceAvailable &&
    facts.integration !== 'integrated' &&
    facts.integration !== 'unchanged' &&
    (facts.integration !== 'reverted' || facts.newChanges) &&
    !actions.includes('integrate')
  )
    actions.push('integrate');
  if (facts.lifecycle !== 'ended' && facts.sessionAvailable) actions.push('end');
  if (facts.sourceAvailable && facts.hasReceipts) {
    if (facts.integration === 'reverted') {
      if (!actions.includes('integrate')) actions.push('reapply');
    } else if (facts.integration === 'integrated' || facts.integration === 'changed')
      actions.push('revert');
  }
  return actions;
}
