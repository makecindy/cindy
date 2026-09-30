import type { MakeSourceStatus } from '../../shared/cindyMakeDoctor.js';
import type { MakeToolchainEnvironment } from './toolchainEnvironment.js';
import { runSourceGit } from './sourceGit.js';

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

export function isSourceBranchName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    !/[\s\x00-\x1f\x7f]/.test(value)
  );
}

export async function readSourceRevisions(
  env: MakeToolchainEnvironment,
  sourcePath: string,
  personalCommit: string,
  upstreamCommit: string | undefined,
  signal: AbortSignal,
): Promise<SourceRevisions> {
  const query = async (args: string[]) => {
    signal.throwIfAborted();
    try {
      const output = await runSourceGit(env.processEnvironment(), args, sourcePath, signal);
      signal.throwIfAborted();
      return output.trim();
    } catch {
      signal.throwIfAborted();
      return undefined;
    }
  };
  const readCommit = async (args: string[]) => {
    const output = await query(args);
    return output && /^[0-9a-f]{7,64}$/i.test(output) ? output : undefined;
  };
  const recordedUpstream = await readCommit([
    'rev-parse',
    '--verify',
    'refs/cindy-make/personal-upstream^{commit}',
  ]);
  const baseCommit =
    recordedUpstream ??
    (upstreamCommit ? await readCommit(['merge-base', personalCommit, upstreamCommit]) : undefined);
  const mainCommit = await readCommit(['rev-parse', '--verify', 'refs/heads/main^{commit}']);
  const mainRemoteCommit = await readCommit([
    'rev-parse',
    '--verify',
    'refs/remotes/origin/main^{commit}',
  ]);
  const branch = await query(['rev-parse', '--abbrev-ref', 'HEAD']);
  const currentBranch = branch === 'HEAD' ? null : isSourceBranchName(branch) ? branch : undefined;
  const revisions: SourceRevisions = { baseCommit, currentBranch, mainCommit, mainRemoteCommit };
  if (mainCommit && mainRemoteCommit) {
    const counts = await query([
      'rev-list',
      '--left-right',
      '--count',
      `${mainCommit}...${mainRemoteCommit}`,
    ]);
    if (counts && /^\d+\s+\d+$/.test(counts)) {
      const [ahead, behind] = counts.split(/\s+/).map(Number);
      if (Number.isSafeInteger(ahead) && Number.isSafeInteger(behind)) {
        revisions.mainAhead = ahead;
        revisions.mainBehind = behind;
      }
    }
  }
  if (mainCommit && personalCommit) {
    const counts = await query([
      'rev-list',
      '--left-right',
      '--count',
      `${personalCommit}...${mainCommit}`,
    ]);
    if (counts && /^\d+\s+\d+$/.test(counts)) {
      const [personalAhead, personalBehind] = counts.split(/\s+/).map(Number);
      if (Number.isSafeInteger(personalAhead) && Number.isSafeInteger(personalBehind)) {
        revisions.personalAhead = personalAhead;
        revisions.personalBehind = personalBehind;
      }
    }
  }
  return revisions;
}
