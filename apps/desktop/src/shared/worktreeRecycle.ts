/** Local device storage controls; not a remote-workspace filesystem API. */
export interface WorktreeRecycleStatus {
  id: string;
  generation: string;
  name: string;
  path: string;
  state: 'retrying' | 'waiting' | 'paused' | 'kept';
  failures: number;
  reason: 'in-use' | 'changed' | 'kept' | 'integrity' | 'storage' | 'identity' | 'failed' | 'pending';
}
export interface WorktreeRecycleAction {
  id: string;
  generation: string;
  action: 'retry' | 'keep';
}
