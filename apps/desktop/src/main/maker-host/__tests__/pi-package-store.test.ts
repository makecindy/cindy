import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/cindy-pi-package-store-test' },
}));

vi.mock('../../agent-binaries/index.js', () => ({
  getReadyBinaryPath: () => undefined,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(),
    child() { return this; },
  }),
}));

import { findAffectedPiPackage, parsePiPackageListOutput } from '../pi-package-store.js';
import { evaluatePiRuntimeRequirements } from '../pi-package-compatibility.js';
import {
  hasPiPackageCompatibilityWarning,
  isRelativeLocalPiPackageSource,
  mergePiPackageCommands,
  shouldShowPiPackagePostMutationNotice,
  shouldListPiPackageCommands,
} from '../../../shared/piPackages.js';

describe('Pi package list parser', () => {
  it('distinguishes task-relative paths from registry and Git package sources', () => {
    expect(isRelativeLocalPiPackageSource('./extension.ts')).toBe(true);
    expect(isRelativeLocalPiPackageSource('../extensions/context-mode')).toBe(true);
    expect(isRelativeLocalPiPackageSource('extensions/context-mode')).toBe(true);
    expect(isRelativeLocalPiPackageSource('file:./extension.ts')).toBe(true);
    expect(isRelativeLocalPiPackageSource('file:../extensions/context-mode')).toBe(true);
    expect(isRelativeLocalPiPackageSource('C:extensions\\context-mode')).toBe(true);
    expect(isRelativeLocalPiPackageSource('file:///absolute/extensions/context-mode')).toBe(false);
    expect(isRelativeLocalPiPackageSource('C:\\extensions\\context-mode')).toBe(false);
    expect(isRelativeLocalPiPackageSource('context-mode')).toBe(false);
    expect(isRelativeLocalPiPackageSource('@scope/context-mode')).toBe(false);
    expect(isRelativeLocalPiPackageSource('npm:context-mode')).toBe(false);
    expect(isRelativeLocalPiPackageSource('git:https://example.com/org/repo.git')).toBe(false);
    expect(isRelativeLocalPiPackageSource('git@example.com:org/repo.git')).toBe(false);
  });

  it('parses Pi user package sources and installed paths without accepting headings', () => {
    expect(parsePiPackageListOutput([
      'User packages:',
      '  npm:@scope/one@1.2.3',
      '    /data/pi/npm/node_modules/@scope/one',
      '  https://github.com/acme/two.git (filtered)',
      '    /data/pi/git/github.com/acme/two',
      '',
    ].join('\n'))).toEqual([
      { source: 'npm:@scope/one@1.2.3', installedPath: '/data/pi/npm/node_modules/@scope/one' },
      {
        source: 'https://github.com/acme/two.git',
        installedPath: '/data/pi/git/github.com/acme/two',
        filtered: true,
      },
    ]);
  });

  it('returns an empty list for Pi empty-state output', () => {
    expect(parsePiPackageListOutput('No packages installed.\n')).toEqual([]);
  });

  it('matches Pi-normalized npm sources for the post-install compatibility notice', () => {
    const pkg = {
      source: 'npm:sample-package', name: 'sample-package', enabled: true, resources: [],
    };
    expect(findAffectedPiPackage([pkg], 'sample-package')).toBe(pkg);
    expect(findAffectedPiPackage([pkg], 'npm:sample-package')).toBe(pkg);
    expect(findAffectedPiPackage([pkg], 'other-package')).toBeUndefined();
  });
});

describe('Pi package runtime compatibility', () => {
  it('reports whether Cindy Pi satisfies package peer requirements', () => {
    expect(evaluatePiRuntimeRequirements({
      '@earendil-works/pi-coding-agent': '>=0.84.1 <0.85.0',
      unrelated: '^1.0.0',
    }, '0.83.0')).toEqual([{
      packageName: '@earendil-works/pi-coding-agent',
      range: '>=0.84.1 <0.85.0',
      currentVersion: '0.83.0',
      compatible: false,
    }]);

    expect(evaluatePiRuntimeRequirements({
      '@earendil-works/pi-tui': '^0.83.0',
    }, '0.83.0')[0]?.compatible).toBe(true);

    expect(evaluatePiRuntimeRequirements({
      '@earendil-works/pi-ai': '^0.83.0',
      '@earendil-works/pi-agent-core': '>=0.84.0',
    }, '0.83.0')).toMatchObject([
      { packageName: '@earendil-works/pi-ai', compatible: true },
      { packageName: '@earendil-works/pi-agent-core', compatible: false },
    ]);
  });

  it('keeps invalid ranges or unknown Cindy versions visible as unknown', () => {
    expect(evaluatePiRuntimeRequirements({
      '@mariozechner/pi-tui': 'not-a-semver-range',
    }, '0.83.0')[0]).toMatchObject({
      compatible: false,
      reason: 'legacy-runtime-package',
    });
    expect(evaluatePiRuntimeRequirements({
      '@earendil-works/pi-tui': '>=0.84.0',
    }, undefined)[0]).toMatchObject({ compatible: null });
  });

  it('flags every legacy Pi runtime namespace used by the real package template', () => {
    expect(evaluatePiRuntimeRequirements({
      '@mariozechner/pi-ai': '*',
      '@mariozechner/pi-agent-core': '*',
      '@mariozechner/pi-coding-agent': '*',
      '@mariozechner/pi-tui': '*',
    }, '0.83.0')).toEqual([
      '@mariozechner/pi-ai',
      '@mariozechner/pi-agent-core',
      '@mariozechner/pi-coding-agent',
      '@mariozechner/pi-tui',
    ].map((packageName) => ({
      packageName,
      range: '*',
      currentVersion: '0.83.0',
      compatible: false,
      reason: 'legacy-runtime-package',
    })));
  });

  it('treats runtime mismatches as a user-visible compatibility warning', () => {
    expect(hasPiPackageCompatibilityWarning({
      source: 'npm:sample',
      name: 'sample',
      enabled: true,
      resources: [],
      runtimeRequirements: [{
        packageName: '@earendil-works/pi-tui',
        range: '>=0.84.0',
        currentVersion: '0.83.0',
        compatible: false,
      }],
    })).toBe(true);
  });

  it('shows a post-install notice for approval gates and failed or bounded inspection', () => {
    const base = { source: 'npm:sample', name: 'sample', enabled: false, resources: [] };
    expect(shouldShowPiPackagePostMutationNotice({
      ...base,
      requiresExtensionApproval: true,
    })).toBe(true);
    expect(shouldShowPiPackagePostMutationNotice({
      ...base,
      warning: 'inspection-limit',
    })).toBe(true);
    expect(shouldShowPiPackagePostMutationNotice(base)).toBe(false);
  });
});

describe('Pi package slash command isolation', () => {
  const builtin = [{ kind: 'agent-builtin' as const, name: 'compact', description: 'Compact' }];
  const prompts = [{ name: 'package-review', description: 'Review with the installed Pi package' }];

  it('adds package prompts only to Pi', () => {
    expect(mergePiPackageCommands('pi', builtin, prompts).map((command) => command.name))
      .toEqual(['compact', 'package-review']);
    expect(mergePiPackageCommands('claude-code', builtin, prompts)).toEqual(builtin);
    expect(mergePiPackageCommands('codex', builtin, prompts)).toEqual(builtin);
  });

  it('does not let a package prompt replace a Pi builtin', () => {
    expect(mergePiPackageCommands('pi', builtin, [
      { name: 'COMPACT', description: 'Package collision' },
    ])).toEqual(builtin);
  });

  it('lists local package prompts only for new or ordinary local Pi tasks', () => {
    expect(shouldListPiPackageCommands('pi', false, null)).toBe(true);
    expect(shouldListPiPackageCommands('pi', false, null, false)).toBe(false);
    expect(shouldListPiPackageCommands('pi', true, {
      agentKind: 'pi',
    })).toBe(true);
    expect(shouldListPiPackageCommands('pi', true, {
      agentKind: 'pi',
      reviewMode: true,
    })).toBe(false);
    expect(shouldListPiPackageCommands('pi', true, {
      agentKind: 'pi',
      remoteHostId: 'ssh-host',
    })).toBe(false);
    expect(shouldListPiPackageCommands('pi', true, null)).toBe(false);
    expect(shouldListPiPackageCommands('claude-code', false, null)).toBe(false);
    expect(shouldListPiPackageCommands('codex', false, null)).toBe(false);
  });
});
