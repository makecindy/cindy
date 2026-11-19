/**
 * 回归 #9546 与 PR #9556 的 P1 review：root 命名空间安装的 cindy-github 填了
 * PAT 后反馈卡仍只列官方 Bot；且凭证、启用态、workdir 偏好与 callGhostTool
 * 派发必须用同一个已锁定实例，不能各用一套 id 拼出不同目标。
 *
 * 被测生产入口：buildGithubUserSubmitterDeps() 装配的真实依赖 +
 * resolveGithubIssueSubmissionChoices() 的最终身份选项（用户可观察结果），
 * 以及 deps 四个判定与派发 ghostId 的一致性。
 * 最小失败输入：仅 `_root__cindy-github` 键存有 github_pat；workdir 偏好里
 * 记录 `_root__cindy-github` 被禁用。
 * tier：unit（进程内依赖注入，不读真实凭证库、不启动 Electron）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';

const h = vi.hoisted(() => ({
  ghosts: [] as InstalledGhost[],
  savedKeys: new Set<string>(),
  disabledIds: [] as string[],
  callGhostTool: vi.fn(),
}));

vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => h.ghosts }),
  getGhostPipeDispatcher: () => ({ callGhostTool: h.callGhostTool }),
}));
vi.mock('../../cindy-brain/ghostWorkdirPrefs.js', () => ({
  isGhostDisabledForWorkdir: (id: string, workdir: string | null | undefined) =>
    workdir === '/repo' && h.disabledIds.includes(id),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  ghostSecretSaved: (instanceKey: string, secretKey: string) =>
    secretKey === 'github_pat' && h.savedKeys.has(instanceKey),
}));

import {
  buildGithubUserSubmitterDeps,
  resolveCindyGithubInstance,
} from '../cindyGithubGhostDeps';
import {
  PLATFORM_ISSUE_SUBMISSION_IDENTITY,
  resolveGithubIssueSubmissionChoices,
} from '../githubUserIssueSubmitter';

function installed(dir: string, over: Partial<InstalledGhost> = {}): InstalledGhost {
  return {
    manifest: { id: 'cindy-github' } as InstalledGhost['manifest'],
    dir,
    namespace: null,
    namespaceState: 'confirmed',
    enabled: true,
    ...over,
  } as InstalledGhost;
}

const ROOT_INSTALL = '/virtual/cindy-brain/_ns/_root/cindy-github';
const FLAT_INSTALL = '/virtual/cindy-brain/cindy-github';
const ENTERPRISE_INSTALL = '/virtual/cindy-brain/_ns/acme/cindy-github';

beforeEach(() => {
  vi.clearAllMocks();
  h.ghosts = [];
  h.savedKeys.clear();
  h.disabledIds = [];
  h.callGhostTool.mockResolvedValue({ ok: true, result: { data: { login: 'octocat' } } });
});

describe('resolveCindyGithubInstance', () => {
  it('按安装布局推导出凭证与偏好共用的 instanceKey', () => {
    expect(resolveCindyGithubInstance([installed(ROOT_INSTALL)])).toEqual({
      instanceKey: '_root__cindy-github', enabled: true,
    });
    expect(resolveCindyGithubInstance([installed(FLAT_INSTALL)])).toEqual({
      instanceKey: 'cindy-github', enabled: true,
    });
    expect(resolveCindyGithubInstance([installed(ENTERPRISE_INSTALL, { namespace: 'acme' })])).toEqual({
      instanceKey: '_ns__acme__cindy-github', enabled: true,
    });
  });

  it('带出 enabled，供启用判定复用同一实例', () => {
    expect(resolveCindyGithubInstance([installed(ROOT_INSTALL, { enabled: false })]))
      .toEqual({ instanceKey: '_root__cindy-github', enabled: false });
  });

  it('无实例、同名多实例歧义、异常安装目录都 fail-closed', () => {
    expect(resolveCindyGithubInstance([])).toBeNull();
    expect(resolveCindyGithubInstance([
      installed(ROOT_INSTALL),
      installed(FLAT_INSTALL),
    ])).toBeNull();
    expect(resolveCindyGithubInstance([installed('/weird/place', { namespace: 'BAD!' })])).toBeNull();
    expect(resolveCindyGithubInstance([installed(ROOT_INSTALL, {
      manifest: { id: 'cindy-art' } as InstalledGhost['manifest'],
    })])).toBeNull();
  });
});

describe('四处的实例一致性', () => {
  it('enabled / 凭证 / workdir / 派发都用锁定的 instanceKey', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('_root__cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.resolveInstanceId()).toBe('_root__cindy-github');
    expect(deps.isGithubGhostEnabled()).toBe(true);
    expect(deps.isGithubCredentialSaved()).toBe(true);

    await expect(resolveGithubIssueSubmissionChoices(deps, '/other')).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      githubUser: { kind: 'github-user', login: 'octocat' },
    });
    expect(h.callGhostTool).toHaveBeenCalledWith({
      ghostId: '_root__cindy-github',
      tool: 'call_tool',
      args: { name: 'get_current_user', args: {} },
    });
  });

  it('workdir 偏好写 instanceKey 时必须挡住，不能仍以裸 id 判定', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('_root__cindy-github');
    h.disabledIds.push('_root__cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.isGithubGhostDisabledForWorkdir('/repo')).toBe(true);
    await expect(resolveGithubIssueSubmissionChoices(deps, '/repo')).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(h.callGhostTool).not.toHaveBeenCalled();
  });

  it('旧版偏好存裸 ghostId 时同样挡住', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('_root__cindy-github');
    h.disabledIds.push('cindy-github');

    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps(), '/repo'))
      .resolves.toEqual({ platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY });
    expect(h.callGhostTool).not.toHaveBeenCalled();
  });

  it('歧义实例不派发、不追加本人身份', async () => {
    h.ghosts = [installed(ROOT_INSTALL), installed(FLAT_INSTALL)];
    h.savedKeys.add('cindy-github');
    h.savedKeys.add('_root__cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.resolveInstanceId()).toBeNull();
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(h.callGhostTool).not.toHaveBeenCalled();
  });

  it('凭证只认锁定实例的键，别处同名键不算', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.isGithubCredentialSaved()).toBe(false);
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(h.callGhostTool).not.toHaveBeenCalled();
  });
});

describe('反馈卡身份选项（凭证键一致性）', () => {
  it('root 命名空间安装的 PAT 被认出时追加本人账号', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('_root__cindy-github');

    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      githubUser: { kind: 'github-user', login: 'octocat' },
    });
  });

  it('旧扁平安装的 PAT 仍被认出（不回归）', async () => {
    h.ghosts = [installed(FLAT_INSTALL)];
    h.savedKeys.add('cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.resolveInstanceId()).toBe('cindy-github');
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      githubUser: { kind: 'github-user', login: 'octocat' },
    });
  });

  it('没存凭证时仍只返回官方 Bot，且不调插件', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];

    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
    });
    expect(h.callGhostTool).not.toHaveBeenCalled();
  });
});
