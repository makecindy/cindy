import assert from 'node:assert/strict';

const prStatus = {
  ok: true,
  provider: 'github',
  host: 'github.com',
  owner: 'makecindy',
  repo: 'cindy',
  prNumber: 9261,
  status: 'open',
  title: 'feat(chat): 聊天 PR / MR 链接悬停显示同款详情浮窗',
  htmlUrl: 'https://github.com/makecindy/cindy/pull/9261',
  branch: 'feat/chat-pr-mr-hover-popover',
  unresolvedCount: 2,
  conflicts: false,
  checks: { total: 12, passed: 10, pending: 1, failed: 1, skipped: 0 },
};

const mrStatus = {
  ok: true,
  provider: 'gitlab',
  host: 'git.example.com',
  owner: 'team/sub',
  repo: 'repo',
  prNumber: 42,
  status: 'merged',
  title: 'fix(gitlab): 同步合并请求悬停卡片状态',
  htmlUrl: 'https://git.example.com/team/sub/repo/-/merge_requests/42',
  branch: 'fix/mr-hover',
  unresolvedCount: 0,
  conflicts: false,
  checks: { total: 4, passed: 4, pending: 0, failed: 0, skipped: 0 },
};

export default {
  name: 'pr-link-hover',
  entry: './fixture.tsx',
  viewport: { width: 640, height: 420 },
  real: 'MarkdownRenderer, UserMessageUrlLink, PrLinkHoverPopover, PrSummaryPopoverContent, Radix Popover and production theme',
  notCovered: 'Live GitHub/GitLab API network calls and remote device-link tunnel transport',
  stubs: {
    'src/renderer/contexts/PrRefsContext': {
      partial: `const pr=${JSON.stringify(prStatus)}; const mr=${JSON.stringify(mrStatus)}; const statuses=new Map([['github:github.com/makecindy/cindy#9261',pr],['gitlab:git.example.com/team/sub/repo#42',mr]]); export const usePrRefsForSession=()=>[]; export const usePrStatuses=()=>({statuses,successfulStatuses:statuses,refreshError:false,fetchStatusesForSession:()=>{}}); export const usePrActions=()=>({invalidateRemotePrRefs:()=>{},ensurePrStatus:()=>{}});`,
    },
  },
  cases: {
    default: { about: 'Markdown GitHub PR link opens the shared summary popover on hover' },
    gitlab: { about: 'User message GitLab MR link opens the shared summary popover on hover' },
  },
  async check(page, ui) {
    const link = page.getByRole('link').first();
    await link.hover();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    const expectedText = ui.case === 'gitlab' ? 'team/sub/repo !42' : 'makecindy/cindy #9261';
    assert.equal((await dialog.textContent())?.includes(expectedText), true);
    await ui.capture('hover-popover');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
  },
};
