/*
 * 测试价值
 * - 生产入口与可观察结果：describeExternalLink / externalLinkLabel，即 Desktop 与 Mobile
 *   群聊里裸链接显示的文字（桌面 GitHub 胶囊在状态未知时的文字、手机胶囊的文字）。
 * - 规则依据：群聊外链可读性需求（两端同一判据）；非 http(s) 与带账号密码的地址不改写。
 * - 现有覆盖缺口：parseGithubPr 只认 PR，且不产出显示文字；此前裸链接原样显示整串 URL。
 * - 最小失败输入：`/pull/1/files` 仍是 `o/r#1`；GitHub 非仓库页面退回网页标签；
 *   非 http(s) 链接必须返回 null 保持原渲染。
 * - tier：unit（纯函数，无 IO）。实测耗时 < 1s。
 */
import { describe, expect, it } from 'vitest';
import { describeExternalLink, externalLinkLabel } from '../externalLink';

describe('externalLinkLabel', () => {
  it.each([
    ['https://github.com/makecindy/cindy/pull/13638', 'makecindy/cindy#13638'],
    ['https://www.github.com/makecindy/cindy/pull/13638/files', 'makecindy/cindy#13638'],
    ['https://github.com/makecindy/cindy/issues/7671', 'makecindy/cindy#7671'],
    ['https://github.com/makecindy/cindy/discussions/12', 'makecindy/cindy#12'],
    ['https://github.com/makecindy/cindy/commit/59acc54cbf7d088fa348f39ca8daca745fb65466', 'makecindy/cindy@59acc54'],
    [
      'https://github.com/makecindy/cindy/blob/main/apps/desktop/src/renderer/components/chat/PrLinkHoverPopover.tsx#L50-L60',
      'makecindy/cindy/PrLinkHoverPopover.tsx:50-60',
    ],
    ['https://github.com/makecindy/cindy/tree/main/apps/mobile', 'makecindy/cindy/mobile/'],
    ['https://github.com/makecindy/cindy/releases/tag/v1.2.0', 'makecindy/cindy@v1.2.0'],
    ['https://github.com/makecindy/cindy', 'makecindy/cindy'],
    ['https://github.com/makecindy/cindy.git', 'makecindy/cindy'],
    // GitHub pages that are not a repository object fall back to the web label.
    ['https://github.com/settings/tokens', 'github.com/settings/tokens'],
    ['https://github.com/makecindy/cindy/pulls?q=is%3Aopen', 'github.com/makecindy/cindy/pulls'],
    ['https://www.example.com/', 'example.com'],
    ['http://localhost:5173/a', 'localhost:5173/a'],
    [
      'https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews?tool=webui#about-pull-request-reviews',
      'docs.github.com/en/…/about-pull-request-reviews',
    ],
    ['https://zh.wikipedia.org/wiki/%E9%93%BE%E6%8E%A5', 'zh.wikipedia.org/wiki/链接'],
  ])('%s → %s', (url, label) => {
    const info = describeExternalLink(url);
    expect(info).not.toBeNull();
    expect(externalLinkLabel(info!)).toBe(label);
  });

  it('keeps labels short and never describes non-web or credentialed links', () => {
    const long = describeExternalLink(`https://example.com/${'a'.repeat(120)}`);
    expect(Array.from(externalLinkLabel(long!)).length).toBeLessThanOrEqual(48);
    expect(describeExternalLink('cindy://session/abc')).toBeNull();
    expect(describeExternalLink('mailto:a@example.com')).toBeNull();
    expect(describeExternalLink('https://user:pw@github.com/o/r')).toBeNull();
    expect(describeExternalLink('not a url')).toBeNull();
  });
});
