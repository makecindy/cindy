import { describe, expect, it } from 'vitest';

import { compareAppUpdateVersions } from '../updateVersionPolicy';

describe('compareAppUpdateVersions', () => {
  it.each([
    ['0.0.65', '0.0.64', 'newer'],
    ['0.0.10', '0.0.9', 'newer'],
    ['1.0.0', '1.0.0-beta.1', 'newer'],
    ['1.0.0-beta.2', '1.0.0-beta.1', 'newer'],
    ['0.0.64', '0.0.64', 'same'],
    ['0.0.64+release', '0.0.64+beta', 'same'],
    ['0.0.63', '0.0.64', 'older'],
  ] as const)('classifies target %s against current %s as %s', (target, current, expected) => {
    expect(compareAppUpdateVersions(target, current)).toBe(expected);
  });

  it.each([
    ['not-semver', '0.0.64'],
    ['0.0.65', 'not-semver'],
    [65, '0.0.64'],
    ['0.0.65', null],
  ])('fails closed for malformed versions (%s, %s)', (target, current) => {
    expect(compareAppUpdateVersions(target, current)).toBe('invalid');
  });
});
