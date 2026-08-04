import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDesktopCapabilityRoutingPolicy,
  DESKTOP_CAPABILITY_ROUTING_POLICY,
  refreshDesktopCapabilityRoutingPolicy,
} from '../maker-host/capability-routing';

let tmpDirs: string[] = [];

afterEach(async () => {
  const dirs = tmpDirs;
  tmpDirs = [];
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  refreshDesktopCapabilityRoutingPolicy();
});

describe('buildDesktopCapabilityRoutingPolicy', () => {
  it('binds GitHub publish helpers only when git-workflow exists', async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-capability-routing-'));
    tmpDirs.push(homeDir);
    const publishRoutes = () => buildDesktopCapabilityRoutingPolicy(homeDir)
      .overrides.filter((route) => route.capabilityId === 'github-publish-workflow');

    expect(publishRoutes()).toEqual([]);

    const skillFile = path.join(
      homeDir,
      '.agents',
      'skills',
      'git-workflow',
      'SKILL.md',
    );
    await fs.mkdir(path.dirname(skillFile), { recursive: true });
    await fs.writeFile(skillFile, '---\nname: git-workflow\n---\n', 'utf8');

    const routes = publishRoutes();
    expect(routes).toHaveLength(2);
    expect(routes.map((route) => route.source.harness)).toEqual([
      'codex',
      'codex',
    ]);
    expect(routes.every((route) => route.invocation === 'explicit-only')).toBe(true);
    expect(routes.every(
      (route) => route.prerequisiteSkills?.[0]?.skillFile === skillFile,
    )).toBe(true);

    refreshDesktopCapabilityRoutingPolicy(homeDir);
    expect(DESKTOP_CAPABILITY_ROUTING_POLICY.overrides.filter(
      (route) => route.capabilityId === 'github-publish-workflow',
    )).toEqual(routes);

    await fs.rm(skillFile);
    refreshDesktopCapabilityRoutingPolicy(homeDir);
    expect(DESKTOP_CAPABILITY_ROUTING_POLICY.overrides.filter(
      (route) => route.capabilityId === 'github-publish-workflow',
    )).toEqual([]);
  });
});
