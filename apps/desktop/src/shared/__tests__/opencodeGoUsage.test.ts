import { describe, expect, it } from 'vitest';
import type { ProviderView } from '@cindy/model-providers';

import {
  isOpenCodeGoProvider,
  isOpenCodeGoProviderView,
  opencodeGoUsageEndpoint,
  opencodeGoUsageWindowMinutes,
  parseOpenCodeGoUsage,
} from '../opencodeGoUsage';
import { parseOpenCodeGoAccountUsageResult } from '../providerAccountUsage';

const provider = {
  id: 'opencode-go',
  source: 'user',
  auth: { method: 'apiKey' },
  routing: {
    codex: { upstream: 'https://opencode.ai/zen/go/v1' },
    pi: { upstream: 'https://opencode.ai/zen/go/v1' },
  },
} as unknown as ProviderView;

describe('OpenCode Go usage', () => {
  it('claims only the official Go inference route', () => {
    expect(isOpenCodeGoProvider(provider)).toBe(true);
    expect(isOpenCodeGoProviderView({ ...provider, id: 'go-team' })).toBe(true);
    expect(opencodeGoUsageEndpoint('https://opencode.ai/zen/go/v1')).toBe(
      'https://opencode.ai/zen/go/v1/usage',
    );
    expect(opencodeGoUsageEndpoint('https://opencode.ai/zen/go')).toBe(
      'https://opencode.ai/zen/go/v1/usage',
    );
    for (const upstream of [
      'https://proxy.example/zen/go/v1',
      'https://opencode.ai/zen/v1',
      'http://opencode.ai/zen/go/v1',
      'https://opencode.ai/zen/go/v1?token=x',
    ])
      expect(opencodeGoUsageEndpoint(upstream)).toBeNull();
  });

  it('keeps all three official quota windows and their reset instants', () => {
    expect(
      parseOpenCodeGoUsage(
        {
          usage: {
            rolling: { status: 'ok', percent: 12.5, resetsAt: '2026-11-02T08:00:00Z' },
            weekly: { status: 'rate-limited', percent: 100, resetsAt: '2026-11-08T00:00:00Z' },
            monthly: { status: 'ok', percent: 0, resetsAt: '2026-12-01T00:00:00Z' },
          },
        },
        42,
      ),
    ).toEqual({
      kind: 'opencode-go-quota',
      fetchedAt: 42,
      windows: [
        {
          id: 'rolling',
          usedPercent: 12.5,
          limited: false,
          resetsAt: Date.parse('2026-11-02T08:00:00Z'),
        },
        {
          id: 'weekly',
          usedPercent: 100,
          limited: true,
          resetsAt: Date.parse('2026-11-08T00:00:00Z'),
        },
        {
          id: 'monthly',
          usedPercent: 0,
          limited: false,
          resetsAt: Date.parse('2026-12-01T00:00:00Z'),
        },
      ],
    });
  });

  it('rejects malformed percentages and statuses instead of inventing quota', () => {
    for (const usage of [
      null,
      { rolling: { status: 'ok', percent: -1 } },
      { rolling: { status: 'ok', percent: 101 } },
      { rolling: { status: 'unknown', percent: 10 } },
      { rolling: { status: 'ok', percent: '10' } },
    ])
      expect(() => parseOpenCodeGoUsage({ usage }, 1)).toThrow(/invalid/);
  });

  it('uses the upstream window durations for pacing', () => {
    expect(opencodeGoUsageWindowMinutes('rolling')).toBe(300);
    expect(opencodeGoUsageWindowMinutes('weekly')).toBe(10_080);
    expect(opencodeGoUsageWindowMinutes('monthly')).toBeUndefined();
  });

  it('sanitizes remote quota payloads and rejects malformed windows', () => {
    expect(parseOpenCodeGoAccountUsageResult({
      status: 'ready', stale: false,
      snapshot: {
        kind: 'opencode-go-quota', fetchedAt: 42,
        windows: [{ id: 'weekly', usedPercent: 35, limited: false, resetsAt: null }],
        untrusted: 'ignored',
      },
      dashboardUrl: 'https://evil.example',
    })).toEqual({
      status: 'ready', stale: false,
      snapshot: { kind: 'opencode-go-quota', fetchedAt: 42, windows: [{ id: 'weekly', usedPercent: 35, limited: false, resetsAt: null }] },
    });
    expect(parseOpenCodeGoAccountUsageResult({
      status: 'ready', stale: false,
      snapshot: { kind: 'opencode-go-quota', fetchedAt: 42, windows: [{ id: 'weekly', usedPercent: 101, limited: false, resetsAt: null }] },
    })).toEqual({ status: 'unavailable', error: 'invalid-response' });
  });
});
