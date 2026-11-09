/**
 * 回归 #9546:root 命名空间安装的 cindy-github 填了 PAT 后,/issue 确认卡仍
 * 只列官方 Bot。设置页按 installedGhostStoragePart(ghost) 写凭证,反馈判据
 * 却只查裸 ghostId,两者键名不一致导致本人身份被静默隐藏。
 *
 * 被测生产入口:buildGithubUserSubmitterDeps() 装配出的真实依赖 +
 * resolveGithubIssueSubmissionChoices() 的最终身份选项(用户可观察结果)。
 * 最小失败输入:仅 `_root__cindy-github` 这个键存有 github_pat。
 * tier:unit(进程内依赖注入,不读真实凭证库、不启动 Electron)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../shared/ghost.js';

const h = vi.hoisted(() => ({
  ghosts: [] as InstalledGhost[],
  savedKeys: new Set<string>(),
  callGhostTool: vi.fn(),
}));

vi.mock('../../cindy-brain/index.js', () => ({
  getGhostManager: () => ({ list: () => h.ghosts }),
  getGhostPipeDispatcher: () => ({ callGhostTool: h.callGhostTool }),
}));
vi.mock('../../cindy-brain/ghostWorkdirPrefs.js', () => ({ isGhostDisabledForWorkdir: () => false }));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../secrets/providerSecretStore.js', () => ({
  ghostSecretSaved: (instanceKey: string, secretKey: string) =>
    secretKey === 'github_pat' && h.savedKeys.has(instanceKey),
}));

import {
  buildGithubUserSubmitterDeps,
  githubCredentialInstanceKeys,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.ghosts = [];
  h.savedKeys.clear();
  h.callGhostTool.mockResolvedValue({ ok: true, result: { data: { login: 'octocat' } } });
});

describe('githubCredentialInstanceKeys', () => {
  it('同时覆盖 root 命名空间安装键与裸 ghostId', () => {
    expect(githubCredentialInstanceKeys([installed(ROOT_INSTALL)])).toEqual([
      'cindy-github',
      '_root__cindy-github',
    ]);
  });

  it('扁平安装只有一个键，企业命名空间实例也纳入', () => {
    expect(githubCredentialInstanceKeys([installed(FLAT_INSTALL)])).toEqual(['cindy-github']);
    expect(
      githubCredentialInstanceKeys([installed('/virtual/cindy-brain/_ns/acme/cindy-github')]),
    ).toEqual(['cindy-github', '_ns__acme__cindy-github']);
  });

  it('忽略其它插件，安装目录异常时仍保留裸 ghostId', () => {
    const others = installed(ROOT_INSTALL, {
      manifest: { id: 'cindy-art' } as InstalledGhost['manifest'],
    });
    expect(githubCredentialInstanceKeys([others])).toEqual(['cindy-github']);
    expect(githubCredentialInstanceKeys([installed('/virtual/weird/place')])).toEqual([
      'cindy-github',
    ]);
  });
});

describe('反馈卡身份选项（凭证键一致性）', () => {
  it('root 命名空间安装的 PAT 被认出时追加本人账号', async () => {
    h.ghosts = [installed(ROOT_INSTALL)];
    h.savedKeys.add('_root__cindy-github');

    const deps = buildGithubUserSubmitterDeps();
    expect(deps.isGithubCredentialSaved()).toBe(true);
    await expect(resolveGithubIssueSubmissionChoices(deps)).resolves.toEqual({
      platform: PLATFORM_ISSUE_SUBMISSION_IDENTITY,
      githubUser: { kind: 'github-user', login: 'octocat' },
    });
  });

  it('旧扁平安装的 PAT 仍被认出（不回归）', async () => {
    h.ghosts = [installed(FLAT_INSTALL)];
    h.savedKeys.add('cindy-github');

    await expect(resolveGithubIssueSubmissionChoices(buildGithubUserSubmitterDeps())).resolves.toEqual({
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
