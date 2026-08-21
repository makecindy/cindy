import { describe, expect, it } from 'vitest';

import { resolveRemoteHostRefAgainstCandidates } from '../remoteHostRef';

describe('resolveRemoteHostRefAgainstCandidates', () => {
  const ssh = (alias: string) => ({
    id: `ssh-config:${alias}`,
    alias,
    source: 'ssh-config' as const,
  });
  const cindy = (profileId: string) => ({
    id: `cindy:${profileId}`,
    alias: profileId,
    source: 'manual' as const,
  });

  it('returns an exact HostRef when that candidate exists', () => {
    expect(resolveRemoteHostRefAgainstCandidates('ssh-config:gpu-box', [ssh('gpu-box')]))
      .toBe('ssh-config:gpu-box');
    expect(resolveRemoteHostRefAgainstCandidates('cindy:build', [cindy('build')]))
      .toBe('cindy:build');
  });

  it('resolves a bare SSH alias to the live HostRef', () => {
    expect(resolveRemoteHostRefAgainstCandidates('gpu-box', [ssh('gpu-box')]))
      .toBe('ssh-config:gpu-box');
  });

  it('lets a complete Cindy profile win over a reserved-prefix SSH alias', () => {
    expect(resolveRemoteHostRefAgainstCandidates('cindy:build', [
      ssh('cindy:build'),
      cindy('build'),
    ])).toBe('cindy:build');
  });

  it('recovers a reserved-prefix SSH alias when no Cindy profile owns that HostRef', () => {
    expect(resolveRemoteHostRefAgainstCandidates('cindy:build', [ssh('cindy:build')]))
      .toBe('ssh-config:cindy:build');
  });

  it('recovers a pre-namespace alias that itself starts with ssh-config:', () => {
    expect(resolveRemoteHostRefAgainstCandidates('ssh-config:foo', [ssh('ssh-config:foo')]))
      .toBe('ssh-config:ssh-config:foo');
  });

  it('keeps an unmatched complete HostRef instead of wrapping it again', () => {
    expect(resolveRemoteHostRefAgainstCandidates('ssh-config:missing', [ssh('gpu-box')]))
      .toBe('ssh-config:missing');
    expect(resolveRemoteHostRefAgainstCandidates('cindy:missing', [cindy('build')]))
      .toBe('cindy:missing');
  });

  it('wraps a bare unmatched value as an SSH HostRef', () => {
    expect(resolveRemoteHostRefAgainstCandidates('gpu-box', [])).toBe('ssh-config:gpu-box');
  });
});
