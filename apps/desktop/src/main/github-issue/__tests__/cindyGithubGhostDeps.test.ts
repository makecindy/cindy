/**
 * #9546: real dependency wiring -> confirmation choices and shared My Issues readiness.
 * Pure submitter tests inject readiness and missed physical root PAT keys / CLI-only login.
 * Minimum failure: only the root instance has a saved PAT, or approved gh-cli with no PAT.
 * unit: in-memory installation/secret/dispatcher ports; no real credentials, CLI or network.
 * Same fixture also protects legacy installs, instance isolation and revoked permissions.
 */
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';

const h = vi.hoisted(() => ({
  ghosts: [] as InstalledGhost[],
  scans: 0,
  preciseMissing: false,
  saved: new Set<string>(),
  disabled: new Set<string>(),
  probe: vi.fn(async () => false),
  dispatch: vi.fn(),
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({
    list: () => { h.scans += 1; return h.ghosts; },
    findInstalledInstance: (id: string) => h.preciseMissing ? undefined :
      h.ghosts.find(ghost => installedGhostStoragePart(ghost) === id),
  }),
  getGhostPipeDispatcher: () => ({ callGhostTool: h.dispatch }),
}));
vi.mock('../../cindy-brain/ghostWorkdirPrefs.js', () => ({
  isGhostDisabledForWorkdir: (id: string, workdir?: string | null) =>
    workdir === '/repo' && h.disabled.has(id),
}));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  ghostSecretSaved: (id: string, key: string) => key === 'github_pat' && h.saved.has(id),
}));
vi.mock('../../git-context/ghCliTokenSource.js', () => ({
  getSharedGhCliTokenSource: () => ({ probeAvailability: h.probe }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), child: () => ({}) }) }));

import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { buildGithubUserSubmitterDeps } from '../cindyGithubGhostDeps.js';
import {
  PLATFORM_ISSUE_SUBMISSION_IDENTITY,
  callCindyGithubOperation,
  postGithubIssueAsUser,
  resolveGithubIssueSubmissionChoices,
} from '../githubUserIssueSubmitter.js';

const platformOnly = { platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY };
const personal = { ...platformOnly, githubUser: { kind: 'github-user', login: 'synthetic-user' } };
function installed(over: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    manifest: { id: 'cindy-github', network: { secrets: [{ key: 'github_pat', source: 'gh-cli' }] } },
    dir: path.join('/virtual', 'cindy-brain', '_ns', '_root', 'cindy-github'),
    namespace: null,
    namespaceState: 'confirmed',
    approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
    enabled: true,
    ...over,
  } as InstalledGhost;
}
beforeEach(() => {
  vi.clearAllMocks();
  h.ghosts = [installed()];
  h.scans = 0;
  h.preciseMissing = false;
  h.saved.clear();
  h.disabled.clear();
  h.probe.mockResolvedValue(false);
  h.dispatch.mockResolvedValue({ ok: true, result: { data: { login: 'synthetic-user' } } });
});

describe('GitHub identity wiring', () => {
  it.each([
    ['root', '_root__cindy-github', installed()],
    ['legacy flat', 'cindy-github', installed({ dir: path.join('/virtual', 'cindy-brain', 'cindy-github') })],
  ] as const)('%s PAT offers personal identity and dispatches to its physical instance', async (_label, key, ghost) => {
    h.ghosts = [ghost];
    h.saved.add(key);
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo')).resolves.toEqual(personal);
    expect(h.dispatch).toHaveBeenCalledWith({
      ghostId: key, tool: 'call_tool', args: { name: 'get_current_user', args: {} },
    });
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('approved host login offers personal identity without a saved PAT', async () => {
    h.probe.mockResolvedValue(true);
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(personal);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ ghostId: '_root__cindy-github' }));
  });

  it.each(['_root__cindy-github', 'cindy-github'])('workdir disabled by %s never probes or dispatches', async (key) => {
    h.saved.add('_root__cindy-github');
    h.disabled.add(key);
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo')).resolves.toEqual(platformOnly);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', []],
    ['disabled', [installed({ enabled: false })]],
    ['unapproved', [installed({ approval: { state: 'legacy-unapproved' } })]],
    ['organization only', [installed({ namespace: 'acme', dir: path.join('/virtual', '_ns', 'acme', 'cindy-github') })]],
    ['ambiguous', [installed(), installed({ dir: path.join('/virtual', 'cindy-github') })]],
  ] as const)('%s cannot borrow a saved or host credential', async (_label, ghosts) => {
    h.ghosts = [...ghosts];
    h.saved.add('_root__cindy-github');
    h.saved.add('cindy-github');
    h.probe.mockResolvedValue(true);
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(platformOnly);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('saved credentials from another instance do not enable the root plugin', async () => {
    h.saved.add('cindy-github');
    h.ghosts = [installed({ manifest: { id: 'cindy-github' } as InstalledGhost['manifest'] })];
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(platformOnly);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.probe).not.toHaveBeenCalled();
  });

  it('no saved PAT or host login remains a normal platform-only choice', async () => {
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(platformOnly);
    expect(h.dispatch).not.toHaveBeenCalled();
  });
  it('My Issues readiness and search share the root installation', async () => {
    h.saved.add('_root__cindy-github');
    const deps = buildGithubUserSubmitterDeps();
    const instanceId = await deps.resolveInstanceId(null);
    expect(instanceId).toBe('_root__cindy-github');
    h.dispatch.mockResolvedValue({ ok: true, result: { data: { items: [] } } });
    await expect(callCindyGithubOperation(deps, 'search_issues_and_prs', { q: 'synthetic' }, { instanceId: instanceId! }))
      .resolves.toMatchObject({ ok: true, data: { items: [] } });
    expect(h.scans).toBe(1);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ ghostId: '_root__cindy-github' }));
  });

  it('uses the registry storage identity instead of deriving a new credential key', async () => {
    h.ghosts = [installed({ instanceKey: 'cindy-github' })];
    h.saved.add('cindy-github');
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(personal);
    expect(h.dispatch).toHaveBeenCalledWith(expect.objectContaining({ ghostId: 'cindy-github' }));
  });

  it.each(['pending', 'unconfirmed'] as const)('%s identity cannot use the host login', async (namespaceState) => {
    h.ghosts = [installed({ namespaceState })];
    h.probe.mockResolvedValue(true);
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(platformOnly);
    expect(h.probe).not.toHaveBeenCalled();
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('revoking directory access while host login is probed prevents dispatch', async () => {
    h.probe.mockImplementationOnce(async () => {
      h.disabled.add('_root__cindy-github');
      return true;
    });
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo')).resolves.toEqual(platformOnly);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('rechecks directory access before create after a successful identity response', async () => {
    h.saved.add('_root__cindy-github');
    h.dispatch.mockImplementationOnce(async () => {
      h.disabled.add('_root__cindy-github');
      return { ok: true, result: { data: { login: 'synthetic-user' } } };
    });
    await expect(postGithubIssueAsUser(buildGithubUserSubmitterDeps(),
      { kind: 'github-user', login: 'synthetic-user' },
      { title: 'Synthetic', description: 'Synthetic', type: 'bug', appVersion: '0.0.0' }, '/repo'))
      .rejects.toMatchObject({ issueErrorCode: 'AUTH_NOT_READY' });
    expect(h.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])('exact lookup falls back once without borrowing another instance (present=%s)', async (present) => {
    h.preciseMissing = true;
    h.ghosts = present ? [installed()] : [installed({ namespace: 'acme',
      dir: path.join('/virtual', '_ns', 'acme', 'cindy-github') })];
    h.saved.add('_root__cindy-github');
    h.saved.add('_ns__acme__cindy-github');
    const result = await callCindyGithubOperation(buildGithubUserSubmitterDeps(), 'get_current_user', {},
      { instanceId: '_root__cindy-github' });
    expect(result.ok).toBe(present);
    expect(h.scans).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(present ? 1 : 0);
  });

});
