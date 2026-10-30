import { describe, expect, it } from 'vitest';

import {
  nextCollabEnabledEdge,
  type CollabEnabledBaseline,
  type CollabEnabledEdge,
} from '../collabEnabledEdge';

type Step = [sessionId: string | null, collabEnabled: boolean | null];

/** 按视图实例复用的顺序依次喂入 (sessionId, 是否 Lead)，返回每一步的边沿。 */
function run(steps: Step[]): CollabEnabledEdge[] {
  let baseline: CollabEnabledBaseline | null = null;
  return steps.map(([sessionId, collabEnabled]) => {
    const result = nextCollabEnabledEdge(baseline, sessionId, collabEnabled);
    baseline = result.baseline;
    return result.edge;
  });
}

describe('nextCollabEnabledEdge', () => {
  it('does not reveal when switching from a plain task back to a Lead task', () => {
    expect(run([['lead-a', true], ['plain-b', false], ['lead-a', true]])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('does not close the collaboration tab of the plain task switched to', () => {
    expect(run([['lead-a', true], ['plain-b', false]])).toEqual([null, null]);
  });

  it('fires on real edges within the same task', () => {
    expect(run([['task-a', false], ['task-a', true], ['task-a', true], ['task-a', false]])).toEqual([
      null,
      'enabled',
      null,
      'disabled',
    ]);
  });

  it('does not treat the first load of a Lead task as an enable edge', () => {
    expect(run([['lead-a', null], ['lead-a', true]])).toEqual([null, null]);
  });

  it('does not reuse the previous task baseline while the next task is still loading', () => {
    expect(run([['plain-b', false], ['lead-a', null], ['lead-a', true]])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it('keeps the same-task baseline across a transient unknown state', () => {
    expect(run([['task-a', false], ['task-a', null], ['task-a', true]])).toEqual([
      null,
      null,
      'enabled',
    ]);
    expect(run([['lead-a', true], ['lead-a', null], ['lead-a', true]])).toEqual([null, null, null]);
  });

  it('resets without firing when there is no task', () => {
    expect(run([['task-a', false], [null, true], ['task-a', true]])).toEqual([null, null, null]);
  });
});
