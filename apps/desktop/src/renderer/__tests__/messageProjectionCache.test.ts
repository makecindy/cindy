import { expect, it, vi } from 'vitest';
import { createMessageProjectionCache } from '@/components/chat/messageProjectionCache';

it('reuses history when switching away and back, but invalidates each changed projection input', () => {
  const project = createMessageProjectionCache<object[], object>();
  const a = [{}];
  const b = [{}];
  const compute = vi.fn(() => ({}));
  const dependencies: unknown[] = [new Map(), {}, false, [], '/work', undefined];
  const first = project(a, dependencies, compute);
  project(b, dependencies, compute);
  expect(project(a, [...dependencies], compute)).toBe(first);
  expect(compute).toHaveBeenCalledTimes(2);
  for (let index = 0; index < dependencies.length; index++) {
    dependencies[index] = {};
    expect(project(a, [...dependencies], compute)).not.toBe(first);
    expect(compute).toHaveBeenCalledTimes(index + 3);
  }
  const beforeNewMessages = compute.mock.calls.length;
  project([...a], dependencies, compute);
  expect(compute).toHaveBeenCalledTimes(beforeNewMessages + 1);
});

it('does not publish a failed projection', () => {
  const project = createMessageProjectionCache<object, string>();
  const snapshot = {};
  expect(() =>
    project(snapshot, [], () => {
      throw new Error('failed');
    }),
  ).toThrow('failed');
  expect(project(snapshot, [], () => 'ready')).toBe('ready');
});
