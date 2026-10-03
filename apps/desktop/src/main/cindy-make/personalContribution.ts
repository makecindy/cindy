import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';

import {
  CONTRIBUTION_LIMITS,
  isContributionEmail,
  touchesUiPath,
  type CindyMakeContributionDraft,
  type CindyMakeContributionError,
  type CindyMakeContributionState,
  type CindyMakeContributionView,
} from '../../shared/cindyMakeContribution.js';
import { isGithubRepository, sameGithubLogin } from '../../shared/cindyMakePersonalRemote.js';
import {
  OFFICIAL_GITHUB_REPOSITORY,
  PERSONAL_REMOTE_NAME,
  PersonalRemoteError,
  classifyRemoteGitError,
  type GithubIdentity,
  type GithubIdentityResult,
  type PersonalForkHealth,
  type PersonalRemoteGitOptions,
  type PersonalRemoteRecord,
} from './personalRemote.js';

const API = 'https://api.github.com';
const OFFICIAL_URL = `https://github.com/${OFFICIAL_GITHUB_REPOSITORY}.git`;
const OFFICIAL_MAIN_REF = 'refs/cindy-make/contribution/main';
const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const RUN_ID = /^[A-Za-z0-9-]{1,128}$/;

/** Durable record of one submitted change; owner-private like the Make history. */
export interface ContributionRecord {
  runId: string;
  number: number;
  url: string;
  branch: string;
  commit: string;
  submittedAt: number;
}

export function parseContributionStore(raw: string | null): Record<string, ContributionRecord> {
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const store: Record<string, ContributionRecord> = {};
  for (const [runId, entry] of Object.entries(value as Record<string, unknown>)) {
    const record = entry as Partial<ContributionRecord> | null;
    if (
      RUN_ID.test(runId) &&
      record?.runId === runId &&
      Number.isSafeInteger(record.number) &&
      record.number! > 0 &&
      typeof record.url === 'string' &&
      record.url.startsWith(`https://github.com/${OFFICIAL_GITHUB_REPOSITORY}/pull/`) &&
      typeof record.branch === 'string' &&
      /^cindy-make-pr\/[A-Za-z0-9-]{1,64}$/.test(record.branch) &&
      typeof record.commit === 'string' &&
      HASH.test(record.commit) &&
      Number.isSafeInteger(record.submittedAt)
    )
      store[runId] = record as ContributionRecord;
  }
  return store;
}

export class ContributionError extends Error {
  constructor(readonly code: CindyMakeContributionError) {
    super(code);
  }
}
const fail = (code: CindyMakeContributionError) => new ContributionError(code);

/** The change as this computer recorded it: the task's creation baseline and final content. */
export interface ContributionChange {
  title: string;
  request: string;
  baseTree: string;
  tree: string;
}

export interface ContributionDeps {
  source: string;
  /** Stable key of the signed-in Cindy account that started the operation. */
  ownerScope(): string;
  binding(): PersonalRemoteRecord;
  identity(): Promise<GithubIdentityResult>;
  /** The bound repository as GitHub sees it now (see `inspectPersonalFork`). */
  inspectFork(identity: GithubIdentity, repository: string): Promise<PersonalForkHealth>;
  git(args: string[], cwd: string, options?: PersonalRemoteGitOptions): Promise<string>;
  change(runId: string): ContributionChange | undefined;
  /** Ledger file of the account that started the operation (pinned at entry). */
  ledgerPath(): string;
  readStore(file: string): Record<string, ContributionRecord>;
  writeStore(file: string, store: Record<string, ContributionRecord>): void;
  fetch: typeof fetch;
  /** The author's own Git identity, if configured on this computer. */
  gitIdentity(): Promise<{ name?: string; email?: string }>;
  withSourceUse<T>(run: () => Promise<T>): Promise<T>;
  now(): number;
}

const githubHeaders = (token: string): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

/** Prefilled body following `.github/PULL_REQUEST_TEMPLATE.md`; the author edits it before submitting. */
export function contributionBody(input: {
  title: string;
  request: string;
  files: string[];
  touchesUi: boolean;
}): string {
  const type = /^([a-z]+)(?:\([^)]*\))?:/.exec(input.title)?.[1];
  const box = (value: string) => (type === value ? 'x' : ' ');
  const shown = input.files.slice(0, 30).map((file) => `  - \`${file}\``);
  if (input.files.length > shown.length)
    shown.push(`  - 另有 ${input.files.length - shown.length} 个文件`);
  return [
    '## 这次改了什么',
    '',
    '### 摘要',
    '',
    input.request.trim() || input.title,
    '',
    '### 变更类型',
    '',
    `- [${box('feat')}] \`feat\` 新功能`,
    `- [${box('fix')}] \`fix\` 缺陷修复`,
    `- [${type === 'refactor' || type === 'perf' ? 'x' : ' '}] \`refactor\` / \`perf\` 重构或性能优化`,
    `- [${['docs', 'test', 'chore'].includes(type ?? '') ? 'x' : ' '}] \`docs\` / \`test\` / \`chore\` 文档、测试或工程维护`,
    '- [ ] 其他：',
    '',
    '### 范围',
    '',
    '- 关联 Issue / 需求：无',
    `- 本 PR 包含：${input.title}`,
    '- 明确不包含：作者个人版中的其他修改',
    '- 用户可见变化：见摘要',
    '- 是否存在 breaking change：无',
    '',
    '### UI 变化',
    '',
    input.touchesUi ? '修改涉及界面，截图请作者补充。' : '不涉及',
    '',
    input.touchesUi
      ? '- 引用的设计规范：docs/design-rules/DESIGN.md（请作者补充具体章节）'
      : '- 引用的设计规范：不涉及：本修改不改界面代码',
    '',
    '## 怎么验证的',
    '',
    '### 自动验证',
    '',
    '```text',
    '本 PR 分支由 Cindy Make 在官方最新 main 上单独整理，未在本机运行检查，以 CI 结果为准。',
    '```',
    '',
    '### 手工验证',
    '',
    '请作者补充：是否在自己的个人版中实际使用过这项修改，以及怎么验证的。',
    '',
    '### 未执行的验证',
    '',
    '本 PR 分支未在本机单独运行测试。',
    '',
    '## 风险',
    '',
    '### 风险分类',
    '',
    '- [ ] 无已知风险',
    '- [ ] 其他：请维护者评估',
    '',
    '### 影响与回滚',
    '',
    '- 影响范围：',
    ...shown,
    '- 回滚 / 降级方式：回滚本 PR',
    '',
    '### 提交前检查',
    '',
    '- [x] 每个 commit 都带 DCO 签名（`git commit -s`，见 [DCO](../DCO)）',
    '- [x] 未提交凭证、令牌或授权文件',
    '',
    '由 Cindy Make 制作。',
    '',
  ].join('\n');
}

/**
 * Turns one recorded change into an official pull request through the repository's
 * normal flow: a single DCO-signed commit by the author on top of the latest
 * official `main`, pushed to the author's fork, opened against `makecindy/cindy`.
 * Only this change is included; the author's other personal changes stay out.
 */
export class PersonalContribution {
  private statusCache: { at: number; states: Map<number, CindyMakeContributionState> } | undefined;

  constructor(private readonly deps: ContributionDeps) {}

  private async requireBinding(): Promise<{ repository: string; identity: GithubIdentity }> {
    const record = this.deps.binding();
    if (!record.repository || !isGithubRepository(record.repository) || record.choice !== 'github')
      throw fail('notBound');
    const identity = await this.deps.identity();
    if (identity.status !== 'connected') throw fail('github');
    if (!sameGithubLogin(record.login, identity.identity.login)) throw fail('account');
    // The saved name must still be this account's official fork: after a deletion,
    // an unrelated repository can answer under it, and nothing is ever pushed there.
    try {
      await this.deps.inspectFork(identity.identity, record.repository);
    } catch (error) {
      const code = error instanceof PersonalRemoteError ? error.code : undefined;
      throw fail(
        code === 'forkMissing'
          ? 'notBound'
          : code === 'github'
            ? 'github'
            : code === 'network'
              ? 'network'
              : 'failed',
      );
    }
    return { repository: record.repository, identity: identity.identity };
  }

  /**
   * Every owner-scoped read or write of a submission belongs to the account that
   * started it: a Cindy account switch in the middle of the awaits must not read
   * another account's history, push with its identity or write its ledger.
   */
  private assertScope(scope: string): void {
    if (this.deps.ownerScope() !== scope) throw fail('account');
  }

  private requireChange(runId: string, scope: string): ContributionChange {
    if (!RUN_ID.test(runId)) throw fail('invalid');
    this.assertScope(scope);
    const change = this.deps.change(runId);
    if (!change || !HASH.test(change.baseTree) || !HASH.test(change.tree))
      throw fail('unavailable');
    if (change.baseTree === change.tree) throw fail('empty');
    return change;
  }

  private git(args: string[], options?: PersonalRemoteGitOptions): Promise<string> {
    return this.deps.git(args, this.deps.source, options);
  }

  private async changedFiles(change: ContributionChange): Promise<string[]> {
    try {
      return (
        await this.git(['diff', '--name-only', '--no-renames', '-z', change.baseTree, change.tree])
      )
        .split('\0')
        .filter(Boolean);
    } catch {
      throw fail('unavailable');
    }
  }

  /** The author's real identity: their Git configuration, then their public GitHub profile. */
  private async author(identity: GithubIdentity): Promise<{ name: string; email: string }> {
    const local = await this.deps
      .gitIdentity()
      .catch(() => ({}) as { name?: string; email?: string });
    let name = local.name?.trim() ?? '';
    let email = local.email?.trim() ?? '';
    if (!name || !email) {
      try {
        const response = await this.deps.fetch(`${API}/user`, {
          headers: githubHeaders(identity.token),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const profile = (await response.json()) as { name?: unknown; email?: unknown };
          if (!name && typeof profile.name === 'string') name = profile.name.trim();
          if (!email && typeof profile.email === 'string') email = profile.email.trim();
        } else await response.body?.cancel();
      } catch {
        // The author fills in what is missing in the confirmation dialog.
      }
    }
    return { name: name || identity.login, email: isContributionEmail(email) ? email : '' };
  }

  private view(
    record: ContributionRecord,
    state?: CindyMakeContributionState,
  ): CindyMakeContributionView {
    return {
      runId: record.runId,
      number: record.number,
      url: record.url,
      submittedAt: record.submittedAt,
      ...(state ? { state } : {}),
    };
  }

  async draft(runId: string): Promise<CindyMakeContributionDraft> {
    const scope = this.deps.ownerScope();
    const ledger = this.deps.ledgerPath();
    const { repository, identity } = await this.requireBinding();
    const change = this.requireChange(runId, scope);
    const files = await this.changedFiles(change);
    const touchesUi = files.some(touchesUiPath);
    const title = `feat: ${change.title.trim() || change.request.trim().split('\n')[0]}`.slice(
      0,
      CONTRIBUTION_LIMITS.title,
    );
    const author = await this.author(identity);
    this.assertScope(scope);
    const existing = this.deps.readStore(ledger)[runId];
    const state = existing && (await this.pullState(existing, githubHeaders(identity.token)));
    return {
      runId,
      title,
      body: contributionBody({ title, request: change.request, files, touchesUi }),
      ...author,
      files,
      touchesUi,
      repository,
      ...(existing ? { existing: this.view(existing, state) } : {}),
    };
  }

  private async pullState(
    record: ContributionRecord,
    headers: Record<string, string>,
  ): Promise<CindyMakeContributionState | undefined> {
    try {
      const response = await this.deps.fetch(
        `${API}/repos/${OFFICIAL_GITHUB_REPOSITORY}/pulls/${record.number}`,
        { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) {
        await response.body?.cancel();
        return undefined;
      }
      const pull = (await response.json()) as { state?: unknown; merged_at?: unknown };
      return pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'open';
    } catch {
      // Unknown state is shown as "submitted"; nothing is guessed.
      return undefined;
    }
  }

  /** PR states for submitted changes; cached briefly so the history list stays cheap. */
  async statuses(): Promise<CindyMakeContributionView[]> {
    const records = Object.values(this.deps.readStore(this.deps.ledgerPath()));
    if (!records.length) return [];
    if (!this.statusCache || this.deps.now() - this.statusCache.at > 5 * 60_000) {
      const states = new Map<number, CindyMakeContributionState>();
      const identity = await this.deps.identity().catch(() => undefined);
      const headers =
        identity?.status === 'connected'
          ? githubHeaders(identity.identity.token)
          : { Accept: 'application/vnd.github+json' };
      await Promise.all(
        records.map(async (record) => {
          const state = await this.pullState(record, headers);
          if (state) states.set(record.number, state);
        }),
      );
      this.statusCache = { at: this.deps.now(), states };
    }
    return records.map((record) => this.view(record, this.statusCache!.states.get(record.number)));
  }

  async submit(input: {
    runId: string;
    title: string;
    body: string;
    name: string;
    email: string;
  }): Promise<CindyMakeContributionView> {
    const title = input.title.trim();
    const name = input.name.trim();
    const email = input.email.trim();
    if (
      !title ||
      title.length > CONTRIBUTION_LIMITS.title ||
      /[\r\n]/.test(title) ||
      input.body.length > CONTRIBUTION_LIMITS.body ||
      !name ||
      name.length > CONTRIBUTION_LIMITS.name ||
      /[<>\r\n]/.test(name) ||
      !isContributionEmail(email)
    )
      throw fail('invalid');
    const scope = this.deps.ownerScope();
    const ledger = this.deps.ledgerPath();
    const { repository, identity } = await this.requireBinding();
    const change = this.requireChange(input.runId, scope);
    const auth = { repository, token: identity.token };
    return this.deps.withSourceUse(async () => {
      // 1. What an earlier submission's branch may receive is decided *before* any
      //    Git work: a pull request the maintainers closed keeps its branch and its
      //    commits exactly as they are, and the resubmission starts a new branch.
      this.assertScope(scope);
      const store = this.deps.readStore(ledger);
      const existing = store[input.runId];
      const prior = existing
        ? await this.pullState(existing, githubHeaders(identity.token))
        : undefined;
      // An unknown state never guesses: only a confirmed closed or merged pull
      // request may be left behind for a new one — the dialog promised "update",
      // and a transient lookup failure must not publish a second PR.
      if (existing && prior === undefined) throw fail('network');
      const updating = prior === 'open' ? existing : undefined;
      // 2. The latest official main, independent of the personal version and its baseline.
      try {
        await this.git([
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-auto-maintenance',
          OFFICIAL_URL,
          `+refs/heads/main:${OFFICIAL_MAIN_REF}`,
        ]);
      } catch (error) {
        throw fail(classifyRemoteGitError(error) === 'network' ? 'network' : 'failed');
      }
      const main = (
        await this.git(['rev-parse', '--verify', `${OFFICIAL_MAIN_REF}^{commit}`])
      ).trim();
      if (!HASH.test(main)) throw fail('failed');

      // 3. Only this change, applied to main in a private index; the checkout is untouched.
      const temporary = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-contribution-'));
      try {
        const index = path.join(temporary, 'index');
        const patch = path.join(temporary, 'change.patch');
        const message = path.join(temporary, 'message');
        await this.git(['read-tree', main], { indexFile: index });
        await this.git([
          'diff',
          '--binary',
          '--full-index',
          '--no-ext-diff',
          '--no-textconv',
          '--no-renames',
          `--output=${patch}`,
          change.baseTree,
          change.tree,
          '--',
        ]);
        try {
          await this.git(['apply', '--cached', '--3way', '--whitespace=nowarn', patch], {
            indexFile: index,
          });
        } catch {
          throw fail('conflict');
        }
        if ((await this.git(['ls-files', '--unmerged'], { indexFile: index })).trim())
          throw fail('conflict');
        const tree = (await this.git(['write-tree'], { indexFile: index })).trim();
        if (tree === (await this.git(['rev-parse', `${main}^{tree}`])).trim()) throw fail('empty');

        // 4. One commit by the author, signed off with the same identity (DCO).
        await writeFile(message, `${title}\n\nSigned-off-by: ${name} <${email}>\n`, 'utf8');
        const commit = (
          await this.git(
            ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', main, '-F', message],
            { indexFile: index, identity: { name, email } },
          )
        ).trim();
        if (!HASH.test(commit)) throw fail('failed');

        // 5. Push the branch to the author's fork, never rewriting an earlier one.
        this.assertScope(scope);
        const base = `cindy-make-pr/${input.runId.slice(0, 36)}`;
        const push = (branch: string, lease: string) =>
          this.git(
            [
              'push',
              '--porcelain',
              '--no-verify',
              '--no-follow-tags',
              `--force-with-lease=refs/heads/${branch}:${lease}`,
              PERSONAL_REMOTE_NAME,
              `${commit}:refs/heads/${branch}`,
            ],
            { auth },
          );
        const pushFailed = (error: unknown) => {
          const code = classifyRemoteGitError(error);
          return fail(
            code === 'workflowScope' || code === 'github' || code === 'network' ? code : 'failed',
          );
        };
        let branch = '';
        let reconciled: ContributionRecord | undefined;
        this.assertScope(scope);
        if (updating) {
          branch = updating.branch;
          try {
            await push(branch, updating.commit);
          } catch (error) {
            if (classifyRemoteGitError(error) !== 'failed') throw pushFailed(error);
            // The lease only fails when the branch moved; retry once if it no longer exists.
            const current = await this.git(
              ['ls-remote', '--refs', PERSONAL_REMOTE_NAME, `refs/heads/${branch}`],
              { auth },
            ).catch((lookup: unknown) => {
              throw pushFailed(lookup);
            });
            if (current.trim()) throw pushFailed(error);
            await push(branch, '').catch((retry: unknown) => {
              throw pushFailed(retry);
            });
          }
          // The moved branch is recorded before the PR API call and before any
          // scope assertion — in the ledger pinned to the account that started the
          // submission. If that call or an account switch interrupts, a retry
          // leases against this commit instead of failing forever against a branch
          // this client itself moved.
          this.deps.writeStore(ledger, {
            ...this.deps.readStore(ledger),
            [input.runId]: { ...updating, commit },
          });
          this.assertScope(scope);
        } else {
          // The lease requires the branch not to exist yet, so an earlier submission's
          // branch (whatever its pull request's state) is never rewritten.
          for (let attempt = 0; attempt < 4; attempt += 1) {
            const candidate = attempt ? `${base}-${attempt + 1}` : base;
            try {
              await push(candidate, '');
              branch = candidate;
              break;
            } catch (error) {
              // The name is taken — for example by the earlier submission's own
              // branch, which is never rewritten — or the push failed; a taken
              // name is retried under a new one.
              if (attempt === 3 || classifyRemoteGitError(error) !== 'failed')
                throw pushFailed(error);
              // Any occupied candidate can be this client's own earlier push whose
              // pull request response was lost — the canonical name may belong to
              // an earlier closed pull request, sending this change to `-2` before
              // its own response is lost in turn. Reconcile the pull request of
              // this exact candidate instead of publishing a second one, and only
              // leave the name behind when it has no open pull request.
              const found = await this.openPullFor(candidate, identity);
              if (found) {
                const tip = (
                  await this.git(
                    ['ls-remote', '--refs', PERSONAL_REMOTE_NAME, `refs/heads/${candidate}`],
                    { auth },
                  ).catch((lookup: unknown) => {
                    throw pushFailed(lookup);
                  })
                )
                  .split(/\s/)[0]
                  ?.trim();
                if (!tip || !HASH.test(tip)) throw pushFailed(error);
                await push(candidate, tip).catch((retry: unknown) => {
                  throw pushFailed(retry);
                });
                branch = candidate;
                reconciled = found;
                break;
              }
            }
          }
          if (!branch) throw fail('failed');
        }

        // 6. Open the pull request, or update the one this change already has.
        this.assertScope(scope);
        const pull = await this.openPull({
          identity,
          branch,
          title,
          body: input.body,
          existing: reconciled ?? updating,
        });
        this.assertScope(scope);
        const record: ContributionRecord = {
          runId: input.runId,
          number: pull.number,
          url: pull.url,
          branch,
          commit,
          submittedAt: this.deps.now(),
        };
        this.deps.writeStore(ledger, { ...this.deps.readStore(ledger), [input.runId]: record });
        this.statusCache = undefined;
        return this.view(record, 'open');
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }

  /** The open pull request an earlier attempt already opened for this branch. */
  private async openPullFor(
    branch: string,
    identity: GithubIdentity,
  ): Promise<ContributionRecord | undefined> {
    let response: Response;
    try {
      response = await this.deps.fetch(
        `${API}/repos/${OFFICIAL_GITHUB_REPOSITORY}/pulls?state=open&head=${encodeURIComponent(
          `${identity.login}:${branch}`,
        )}`,
        {
          method: 'GET',
          headers: githubHeaders(identity.token),
          redirect: 'error',
          signal: AbortSignal.timeout(15_000),
        },
      );
    } catch {
      throw fail('network');
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Unknown is not "no pull request": only a confirmed empty list lets the
      // caller open a new branch, so a lookup failure aborts for a retry.
      throw fail('network');
    }
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!Array.isArray(body)) throw fail('network');
    const first = body[0] as { number?: unknown; html_url?: unknown } | undefined;
    if (!first) return undefined;
    if (
      !Number.isSafeInteger(first.number) ||
      typeof first.html_url !== 'string' ||
      !first.html_url.startsWith(`https://github.com/${OFFICIAL_GITHUB_REPOSITORY}/pull/`)
    )
      throw fail('failed');
    return {
      runId: '',
      number: first.number as number,
      url: first.html_url,
      branch,
      commit: '',
      submittedAt: this.deps.now(),
    };
  }

  private async openPull(input: {
    identity: GithubIdentity;
    branch: string;
    title: string;
    body: string;
    existing?: ContributionRecord;
  }): Promise<{ number: number; url: string; closed: boolean }> {
    const request = async (url: string, init: RequestInit): Promise<Response> => {
      try {
        return await this.deps.fetch(url, {
          ...init,
          headers: { ...githubHeaders(input.identity.token), 'Content-Type': 'application/json' },
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw fail('network');
      }
    };
    const parse = async (
      response: Response,
    ): Promise<{ number: number; url: string; closed: boolean }> => {
      const pull = (await response.json().catch(() => ({}))) as {
        number?: unknown;
        html_url?: unknown;
        state?: unknown;
      };
      if (
        !Number.isSafeInteger(pull.number) ||
        typeof pull.html_url !== 'string' ||
        !pull.html_url.startsWith(`https://github.com/${OFFICIAL_GITHUB_REPOSITORY}/pull/`)
      )
        throw fail('failed');
      return { number: pull.number as number, url: pull.html_url, closed: pull.state === 'closed' };
    };
    const pulls = `${API}/repos/${OFFICIAL_GITHUB_REPOSITORY}/pulls`;
    if (input.existing) {
      // The dialog promised "update": this pull request is edited in place. A state
      // that changed under way (a maintainer closed it mid-flight) aborts instead of
      // publishing a second PR the user never confirmed.
      const current = await request(`${pulls}/${input.existing.number}`, { method: 'GET' });
      const open = current.ok ? !(await parse(current)).closed : false;
      if (!current.ok) await current.body?.cancel();
      if (!open) throw fail('failed');
      const response = await request(`${pulls}/${input.existing.number}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: input.title, body: input.body }),
      });
      if (response.ok) return parse(response);
      await response.body?.cancel();
      throw fail('failed');
    }
    const created = await request(pulls, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: `${input.identity.login}:${input.branch}`,
        base: 'main',
        maintainer_can_modify: true,
      }),
    });
    if (created.ok) return parse(created);
    const status = created.status;
    await created.body?.cancel();
    if (status === 422) {
      // GitHub refuses a duplicate; reuse the open pull request for this branch.
      const listed = await request(
        `${pulls}?state=open&head=${encodeURIComponent(`${input.identity.login}:${input.branch}`)}`,
        { method: 'GET' },
      );
      if (listed.ok) {
        const pullsFound = (await listed.json().catch(() => [])) as unknown[];
        const first = Array.isArray(pullsFound) ? pullsFound[0] : undefined;
        if (first) return parse(new Response(JSON.stringify(first)));
      } else await listed.body?.cancel();
    }
    throw fail([401, 403, 404].includes(status) ? 'github' : 'failed');
  }
}
