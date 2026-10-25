import type { MakeSourceStatus, MakeSourceGitProgress } from '@cindy/maker-shared/cindy-make-doctor';
export type SourceRevisions = Pick<
  MakeSourceStatus,
  | 'baseCommit'
  | 'currentBranch'
  | 'mainCommit'
  | 'mainRemoteCommit'
  | 'mainBehind'
  | 'mainAhead'
  | 'personalBehind'
  | 'personalAhead'
>;
export type CindyBuildChannel = 'dev' | 'beta' | 'release';
export interface CindyBuildIdentity {
  channel: CindyBuildChannel;
  version: string;
}

export interface CindySourceTarget {
  channel: CindyBuildChannel;
  version: string;
  ref: string;
  candidates: string[];
}

export interface SourcePreparationResult extends SourceRevisions {
  status: 'ready' | 'failed' | 'cancelled';
  path: string;
  target: CindySourceTarget;
  /** HEAD of the checkout: the personal baseline branch. */
  commit?: string;
  branch?: string;
  error?: MakeSourceStatus['error'];
  cleared?: boolean;
}

export interface SourcePreparationProgress extends SourceRevisions {
  status: 'preparing' | 'ready' | 'failed' | 'cancelled';
  path: string;
  target: CindySourceTarget;
  commit?: string;
  branch?: string;
  error?: SourcePreparationResult['error'];
  phase?: MakeSourceStatus['phase'];
  progress?: MakeSourceGitProgress;
  dependencies?: MakeSourceStatus['dependencies'];
}

