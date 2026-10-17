import { expect, it } from 'vitest';
import { createScrollDebugSampler } from './scrollDebugSampler';

it('bounds continuous frame logs but always keeps interaction changes and final drag samples', () => {
  let now = 0;
  const sample = createScrollDebugSampler(() => now);
  let count = 0;
  for (now = 0; now < 1000; now += 5) if (sample(1, false)) count++;
  expect(count).toBe(4);
  now = 999;
  expect(sample(2, false)).toBe(true);
  expect(sample(2, true)).toBe(true);
  expect(sample(2, false)).toBe(false);
  now += 250;
  expect(sample(2, false)).toBe(true);
  expect(createScrollDebugSampler(() => now)(2, false)).toBe(true);
});
