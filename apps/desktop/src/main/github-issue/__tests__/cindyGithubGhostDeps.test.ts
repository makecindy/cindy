/**
 * #9546: real dependency wiring -> confirmation choices and shared My Issues readiness.
 * Pure submitter tests inject readiness and missed physical root PAT keys / CLI-only login.
 * Minimum failure: only the root instance has a saved PAT, or approved gh-cli with no PAT.
 * unit: in-memory installation/secret/dispatcher ports; no real credentials, CLI or network.
 * Short health-probe failure must not block a valid identity response within its real timeout.
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
  readToken: vi.fn(async (): Promise<string | null> => null),
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
  getSharedGhCliTokenSource: () => ({ probeAvailability: h.probe, readToken: h.readToken }),
}));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyAccountServices: false }) }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => 'synthetic-owner' }));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpoint: vi.fn() }));
vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({ outboundFetch: vi.fn() }));
vi.mock('../../serverApiClient.desktop', () => ({ serverApiFetch: vi.fn() }));
vi.mock('../submittedIssueLedger.js', () => ({ listSubmittedIssues: () => [] }));
vi.mock('../myIssuesSnapshotStore.js', () => ({ readMyIssuesSnapshot: () => null, writeMyIssuesSnapshot: vi.fn() }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn(), debug: vi.fn(), child: () => ({}) }) }));

import { installedGhostStoragePart } from '../../../shared/pluginIdentity.js';
import { submitGithubIssueWithConfirm } from '../githubIssueSubmitService.js';
import { getMyIssuesService } from '../myIssuesRuntime.js';
import { buildGithubUserSubmitterDeps } from '../cindyGithubGhostDeps.js';
import {
  PLATFORM_ISSUE_SUBMISSION_IDENTITY,
  callCindyGithubOperation,
  postGithubIssueAsUser,
  resolveGithubIssueSubmissionChoices,
} from '../githubUserIssueSubmitter.js';

const platformOnly = { platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY };
const personal = { ...platformOnly, githubUser: { kind: 'github-user', login: 'synthetic-user' } } as const;
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
  h.readToken.mockResolvedValue(null);
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

  it('offers valid CLI identity after one second even when the short network probe fails', async () => {
    vi.useFakeTimers();
    try {
      h.probe.mockResolvedValue(false);
      h.dispatch.mockImplementationOnce(() => new Promise(resolve => {
        setTimeout(() => resolve({ ok: true, result: { data: { login: 'synthetic-user' } } }), 1000);
      }));
      const choices = resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo');
      await vi.advanceTimersByTimeAsync(1000);
      await expect(choices).resolves.toEqual(personal);
      expect(h.probe).not.toHaveBeenCalled();
      expect(h.dispatch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
    h.dispatch.mockResolvedValue({ ok: false, errorCode: 'AUTH_REQUIRED', message: 'No login' });
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual(platformOnly);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.probe).not.toHaveBeenCalled();
  });
  it.each([false, true])('My Issues distinguishes absent credentials from a saved but failing PAT (saved=%s)', async (saved) => {
    if (saved) h.saved.add('_root__cindy-github');
    h.dispatch.mockResolvedValue({ ok: false, errorCode: 'AUTH_REQUIRED', message: 'No login' });
    const result = await getMyIssuesService().list({ force: true });
    expect(result.githubEnhancement).toBeNull();
    expect(result.githubEnhancementFailed).toBe(saved);
    expect(h.dispatch).toHaveBeenCalledTimes(1);
    expect(h.probe).not.toHaveBeenCalled();
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

  it.each(['PAT', 'CLI'])('rechecks directory access before create after a successful %s identity response', async (source) => {
    if (source === 'PAT') h.saved.add('_root__cindy-github');
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

  it.each(['PAT', 'CLI'].flatMap(source =>
    ['revision', 'directory', 'instance', 'unchanged'].map(change => [source, change] as const),
  ))('binds the %s confirmation to its original install (%s)', async (source, change) => {
    if (source === 'PAT') h.saved.add('_root__cindy-github');
    const deps = buildGithubUserSubmitterDeps();
    h.dispatch.mockImplementation(async (request) => request.args.name === 'create_issue'
      ? { ok: true, result: { data: { number: 80, html_url: 'https://github.com/makecindy/cindy/issues/80' } } }
      : { ok: true, result: { data: { login: 'synthetic-user' } } });
    const result = await submitGithubIssueWithConfirm({
      resolveSubmissionChoices: workdir => resolveGithubIssueSubmissionChoices(deps, workdir),
      confirm: async (_session, draft, _env, choices) => {
        expect(choices).toEqual(personal);
        // A replacement can keep the same login; only a matching install may submit.
        const over: Partial<InstalledGhost> = change === 'revision'
          ? { approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' } }
          : change === 'directory' ? { dir: path.join('/other', 'cindy-github'), instanceKey: '_root__cindy-github' }
          : change === 'instance' ? { dir: path.join('/virtual', 'cindy-github'), instanceKey: 'cindy-github' }
          : {};
        h.ghosts = [installed(over)];
        if (source === 'PAT') h.saved.add(installedGhostStoragePart(h.ghosts[0]!));
        return { confirmed: true, ...draft, submissionIdentity: choices.githubUser! };
      },
      postIssue: (identity, body) => postGithubIssueAsUser(deps,
        identity as Extract<typeof identity, { kind: 'github-user' }>, body(), '/repo'),
      getAppVersion: () => '0.0.0',
      getOsInfo: () => ({ platform: 'darwin', arch: 'arm64', osVersion: 'synthetic' }),
      getTurnModelId: async () => 'synthetic-model',
      getRegion: () => 'cn',
      getFallbackLocale: () => 'en',
      getSubmitterName: () => undefined,
    }, { sessionId: 'synthetic-session', agentKind: 'codex', workingDir: '/repo',
      title: 'Synthetic', body: 'Synthetic', type: 'bug' });
    expect(result).toMatchObject(change === 'unchanged' ? { ok: true, issueNumber: 80 }
      : { ok: false, errorCode: 'AUTH_NOT_READY' });
    expect(h.dispatch).toHaveBeenCalledTimes(change === 'unchanged' ? 3 : 1);
  });

  it('rechecks the pinned install between resolution and actual dispatch', async () => {
    const deps = buildGithubUserSubmitterDeps();
    await expect(resolveGithubIssueSubmissionChoices(deps, '/repo')).resolves.toEqual(personal);
    h.dispatch.mockClear();
    const pending = postGithubIssueAsUser(deps, personal.githubUser,
      { title: 'Synthetic', description: 'Synthetic', type: 'bug', appVersion: '0.0.0' }, '/repo');
    h.ghosts[0]!.approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
    await expect(pending).rejects.toMatchObject({ issueErrorCode: 'AUTH_NOT_READY' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it('blocks replacement after the post-confirmation identity response before create', async () => {
    const deps = buildGithubUserSubmitterDeps();
    await resolveGithubIssueSubmissionChoices(deps, '/repo');
    h.dispatch.mockImplementationOnce(async () => {
      h.ghosts[0]!.approval = { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' };
      return { ok: true, result: { data: { login: 'synthetic-user' } } };
    });
    await expect(postGithubIssueAsUser(deps, { kind: 'github-user', login: 'synthetic-user' },
      { title: 'Synthetic', description: 'Synthetic', type: 'bug', appVersion: '0.0.0' }, '/repo'))
      .rejects.toMatchObject({ issueErrorCode: 'AUTH_NOT_READY' });
    expect(h.dispatch).toHaveBeenCalledTimes(2);
  });

  it('a fresh submission and shared reads use the new install without rebinding an old confirmation', async () => {
    const old = buildGithubUserSubmitterDeps();
    await resolveGithubIssueSubmissionChoices(old, '/repo');
    h.ghosts = [installed({ approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' } })];
    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo')).resolves.toEqual(personal);
    const shared = buildGithubUserSubmitterDeps({ pinInstallation: false });
    await resolveGithubIssueSubmissionChoices(shared);
    h.ghosts = [installed()];
    await expect(resolveGithubIssueSubmissionChoices(shared)).resolves.toEqual(personal);
    h.dispatch.mockClear();
    h.ghosts = [installed({ approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' } })];
    await expect(postGithubIssueAsUser(old, { kind: 'github-user', login: 'synthetic-user' },
      { title: 'Synthetic', description: 'Synthetic', type: 'bug', appVersion: '0.0.0' }, '/repo'))
      .rejects.toMatchObject({ issueErrorCode: 'AUTH_NOT_READY' });
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it.each([true, false])('shared read exact lookup falls back once without borrowing another instance (present=%s)', async (present) => {
    h.preciseMissing = true;
    h.ghosts = present ? [installed()] : [installed({ namespace: 'acme',
      dir: path.join('/virtual', '_ns', 'acme', 'cindy-github') })];
    h.saved.add('_root__cindy-github');
    h.saved.add('_ns__acme__cindy-github');
    const result = await callCindyGithubOperation(buildGithubUserSubmitterDeps({ pinInstallation: false }), 'get_current_user', {},
      { instanceId: '_root__cindy-github' });
    expect(result.ok).toBe(present);
    expect(h.scans).toBe(1);
    expect(h.dispatch).toHaveBeenCalledTimes(present ? 1 : 0);
  });

});
