import { expect, it } from 'vitest';
import { appendCindyMakeBuildLog } from '../cindyMakeSession';

it('keeps a build linked to its resolver through cleanup, packaging and interruption', () => {
  const resolving = appendCindyMakeBuildLog(
    undefined,
    {
      status: 'merging',
      mergeStep: 'conflicts',
      mergeSessionId: 'resolver',
      buildId: 'first',
    },
    1,
  );
  const cleanup = appendCindyMakeBuildLog(
    resolving,
    { status: 'merging', mergeStep: 'cleanup', buildId: 'first' },
    2,
  );
  const packaging = appendCindyMakeBuildLog(cleanup, { status: 'packaging', buildId: 'first' }, 3);
  const interrupted = appendCindyMakeBuildLog(
    packaging,
    { status: 'failed', error: 'interrupted', buildId: 'first' },
    4,
  );
  expect(interrupted.mergeSessionId).toBe('resolver');
  expect(interrupted.logs?.map((log) => log.step)).toEqual([
    'resolving-conflicts',
    'cleaning-merge',
    'packaging',
    'failed',
  ]);
  expect(
    appendCindyMakeBuildLog(interrupted, { status: 'waiting', buildId: 'second' }).mergeSessionId,
  ).toBeUndefined();
});
