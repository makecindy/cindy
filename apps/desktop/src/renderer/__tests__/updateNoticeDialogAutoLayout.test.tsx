// @vitest-environment jsdom

/**
 * UpdateNoticeDialog 的 auto 布局契约。
 *
 * 装完后的自动公告走这条布局,UpdateBanner 的「装前预览」也刻意复用它(见 useUpdateNotice
 * 的 onOpenVersion)。所以这个文件既是既有行为的回归护栏,也是新入口渲染形态的说明:
 *   - 单版本:版本号与日期在版本块内,头部右上无内容
 *   - 跨版本:右上角只有版本数;**没有 v<旧> → v<新> 区间徽标**——#956 单栏改版把
 *     版本身份(版本号/日期/贡献者)全部收进各版本自己的块,头部不再重复报幕
 * 两种情况都没有版本跳转器、没有懒加载占位块。
 *
 * (初版按 #956 之前的旧头部设计写了区间徽标断言,落地即把 main verify 打红;
 * 本文件以现行单栏设计为准,并反向锁住"头部不得再出现区间徽标"。)
 *
 * 弹窗本身在本次改动里一行未改;这里锁住的是「预览入口依赖的那部分不能被顺手清理掉」。
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNoticeDialog } from '@/components/UpdateNoticeDialog';
import type { ReleaseNotes } from '@/release-notes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      const args = Object.entries(opts).map(([k, v]) => `${k}=${String(v)}`).join(',');
      return `${key}(${args})`;
    },
    i18n: { language: 'zh-CN' },
  }),
}));

function notesFor(version: string, date: string): ReleaseNotes {
  return {
    version,
    date,
    contributors: [],
    sections: [],
    topics: [{ title: `条目 ${version}`, text: '正文。', contributors: [] }],
  };
}

const NEWEST = notesFor('0.1.21', '2026-07-29');
const OLDER = notesFor('0.1.20', '2026-07-20');

beforeEach(() => {
  // jsdom 没有 IntersectionObserver;弹窗内部的懒加载与 sticky 表头都依赖它。
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderAuto(releaseNotes: ReleaseNotes[]) {
  return render(
    <UpdateNoticeDialog
      open
      mode="auto"
      releaseNotes={releaseNotes}
      allVersions={null}
      loadVersion={vi.fn().mockResolvedValue(null)}
      onDismiss={vi.fn()}
    />,
  );
}

describe('UpdateNoticeDialog auto layout', () => {
  it('single version: date on the right, plain version badge, single-version aria', () => {
    renderAuto([NEWEST]);

    expect(screen.queryByText(/update\.notice\.versionsSpan/)).toBeNull();
    expect(screen.getAllByText(/2026/).length).toBeGreaterThan(0);
    expect(screen.getByText('v0.1.21')).toBeTruthy();
    expect(
      screen.getByText('update.notice.ariaDescription(version=0.1.21)'),
    ).toBeTruthy();
  });

  it('multiple versions: version count on the right, no range badge, span aria', () => {
    renderAuto([NEWEST, OLDER]);

    expect(screen.getByText('update.notice.versionsSpan(count=2)')).toBeTruthy();
    // 版本身份在各版本块内(见下一个用例),头部不再渲 v<旧> → v<新> 区间徽标。
    expect(screen.queryByText('v0.1.20 → v0.1.21')).toBeNull();
    expect(
      screen.getByText('update.notice.ariaDescriptionSpan(from=0.1.20,count=2)'),
    ).toBeTruthy();
  });

  it('renders one content block per aggregated version', () => {
    renderAuto([NEWEST, OLDER]);

    expect(screen.getByText('条目 0.1.21')).toBeTruthy();
    expect(screen.getByText('条目 0.1.20')).toBeTruthy();
  });
});
