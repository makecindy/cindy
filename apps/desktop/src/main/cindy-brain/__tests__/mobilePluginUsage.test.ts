import { expect, it } from 'vitest';
import { parsePluginUsageSummary } from '@cindy/device-link';
import { mobilePluginUsage } from '../mobilePluginUsage.js';
import type { GhostSetupAssessment, InstalledGhost } from '../../../shared/ghost.js';
const ghost = {
  manifest: {
    id: 'demo',
    name: 'Demo',
    version: '1',
    tools: [{ name: 'lookup', description: 'Find things' }],
    settingsHtml: 'settings.html',
  },
  enabled: true,
  approval: { state: 'approved', revision: '1' },
} as InstalledGhost;
it('projects only setup status labels, with any-of alternatives correctly satisfied', () => {
  const assessment: GhostSetupAssessment = {
    state: 'required',
    revision: 1,
    groups: [
      {
        id: 'optional',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:key',
            kind: 'secret',
            label: 'Unneeded key',
            state: 'missing',
            actions: [],
          },
          {
            ref: 'secret:oauth',
            kind: 'oauth',
            label: 'Connected account',
            state: 'satisfied',
            actions: [],
          },
        ],
      },
      {
        id: 'needed',
        mode: 'any_of',
        items: [
          {
            ref: 'secret:other',
            kind: 'oauth',
            label: 'Work account',
            state: 'expired',
            actions: [],
          },
        ],
      },
    ],
  };
  const projected = mobilePluginUsage(ghost, assessment, 'off');
  expect(projected).toMatchObject({
    taskUsable: true,
    hasSettings: true,
    setup: { state: 'required', missing: [], expired: ['Work account'] },
  });
  expect(projected.runtimeIssue).toBeUndefined();
  expect(JSON.stringify(projected)).not.toContain('secret:');
  expect(parsePluginUsageSummary(projected)).toEqual(projected);
});
it('distinguishes approval, retirement, runtime faults, and unavailable assessment', () => {
  const projected = mobilePluginUsage(
    {
      ...ghost,
      approval: { state: 'invalid' },
      retirement: { id: 'old', eligible: true, unread: false },
    },
    undefined,
    'fused',
  );
  expect(projected).toMatchObject({
    approvalRequired: true,
    retired: true,
    runtimeIssue: 'fused',
    setup: { state: 'unknown' },
  });
  expect(
    mobilePluginUsage({
      ...ghost,
      manifest: {
        ...ghost.manifest,
        tools: [],
        command: undefined,
        id: 'page',
        name: 'Page',
        version: '1',
        panel: { html: 'panel.html' },
      },
    }).taskUsable,
  ).toBe(false);
});
it('rejects malformed status data rather than trusting remote booleans or unbounded labels', () => {
  const valid = mobilePluginUsage(ghost);
  expect(parsePluginUsageSummary({ ...valid, taskUsable: 'yes' })).toBeNull();
  expect(
    parsePluginUsageSummary({
      ...valid,
      setup: { state: 'ready', missing: ['x'.repeat(161)], expired: [] },
    }),
  ).toBeNull();
  expect(parsePluginUsageSummary({ ...valid, runtimeIssue: 'running' })).toBeNull();
});
it('keeps unmet alternative groups intact for minimal settings copy', () => {
  const projected = mobilePluginUsage(ghost, {
    state: 'required',
    revision: 2,
    groups: [
      {
        id: 'either',
        mode: 'any_of',
        items: [
          { ref: 'secret:key', label: 'API key', kind: 'secret', state: 'missing', actions: [] },
          { ref: 'secret:oauth', label: 'Account', kind: 'oauth', state: 'expired', actions: [] },
        ],
      },
    ],
  });
  expect(projected.setup.groups).toEqual([{ missing: ['API key'], expired: ['Account'] }]);
});
