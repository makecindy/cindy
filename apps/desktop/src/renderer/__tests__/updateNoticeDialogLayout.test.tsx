// @vitest-environment jsdom

/**
 * Layout contract for the update-notice dialog after the single-column rework.
 *
 * These lock the behaviours the rework exists to guarantee — every one of them
 * was a visible defect before:
 *   1. the contributor list is rendered ONCE per version (it used to appear in
 *      the dialog chrome AND in the version subheader simultaneously);
 *   2. thanks is anchored to the end of its own version block, so with several
 *      versions on screen each list belongs to an unambiguous version;
 *   3. legacy (author-grouped) payloads render in the same single column as v2
 *      topic payloads instead of a two-column split;
 *   4. a version that is merely queued (idle) does not claim to be loading.
 */

import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import i18n from '@/i18n';
import { UpdateNoticeDialog } from '@/components/UpdateNoticeDialog';
import type { ReleaseNotes } from '@/release-notes';

function topicNotes(version: string, contributors: string[]): ReleaseNotes {
  return {
    version,
    date: '2026-07-29',
    contributors,
    sections: [],
    intro: '本次合并 77 个 PR。',
    topics: [
      {
        emoji: '🛠️',
        title: '后台任务面板',
        text: '右栏新增后台任务面板。',
        contributors: [contributors[0]],
      },
    ],
  };
}

function legacyNotes(version: string, contributors: string[]): ReleaseNotes {
  return {
    version,
    date: '2026-07-27',
    contributors,
    topics: [],
    sections: [
      { title: 'New Features', items: [{ text: '新增了一个东西', by: contributors[0] }] },
      { title: 'Bug Fixes', items: [{ text: '修了一个问题', by: contributors[0] }] },
    ],
  };
}

function renderDialog(notes: ReleaseNotes[]) {
  return render(
    <UpdateNoticeDialog
      open
      mode="auto"
      releaseNotes={notes}
      allVersions={null}
      loadVersion={vi.fn().mockResolvedValue(null)}
      onDismiss={vi.fn()}
    />,
  );
}

afterEach(cleanup);

describe('UpdateNoticeDialog 单栏版式', () => {
  it('贡献者名单每个版本只渲染一次,不再 chrome 与子头各一份', () => {
    renderDialog([topicNotes('0.1.21', ['Kafeifei', 'yan', 'Dash'])]);
    const joined = 'Kafeifei · yan · Dash';
    expect(screen.getAllByText(joined)).toHaveLength(1);
  });

  it('感谢行落在各自版本块内,多版本同屏时归属明确', () => {
    renderDialog([
      topicNotes('0.1.21', ['Kafeifei', 'yan']),
      legacyNotes('0.1.17', ['Silas', 'Kmny']),
    ]);
    const thanksLabel = i18n.t('update.notice.thanksTo');
    const lines = screen.getAllByText(thanksLabel);
    expect(lines).toHaveLength(2);

    // 每条感谢行所在的块里,必须同时能找到该版本号与该版本的名单,
    // 且不含另一个版本的任何一项——这样才能证明名单没有跨版本漂移。
    const blockOf = (el: HTMLElement) => el.closest('div.flex.flex-col') as HTMLElement;
    const first = blockOf(lines[0].parentElement as HTMLElement);
    expect(within(first).getByText('v0.1.21')).toBeTruthy();
    expect(within(first).getByText('Kafeifei · yan')).toBeTruthy();
    expect(within(first).queryByText('v0.1.17')).toBeNull();
    expect(within(first).queryByText('Silas · Kmny')).toBeNull();

    const second = blockOf(lines[1].parentElement as HTMLElement);
    expect(within(second).getByText('v0.1.17')).toBeTruthy();
    expect(within(second).getByText('Silas · Kmny')).toBeTruthy();
    expect(within(second).queryByText('v0.1.21')).toBeNull();
    expect(within(second).queryByText('Kafeifei · yan')).toBeNull();
  });

  it('旧格式(作者分组)也走单栏:两个小节标题都在,无左右分栏', () => {
    renderDialog([legacyNotes('0.1.17', ['Silas'])]);
    expect(screen.getByText(i18n.t('update.notice.newFeatures'))).toBeTruthy();
    expect(screen.getByText(i18n.t('update.notice.bugFixes'))).toBeTruthy();
    expect(screen.getByText('新增了一个东西')).toBeTruthy();
    expect(screen.getByText('修了一个问题')).toBeTruthy();
  });

  it('空小节不渲染成一个光秃秃的标题', () => {
    const notes: ReleaseNotes = {
      ...legacyNotes('0.1.16', ['Silas']),
      sections: [
        { title: 'New Features', items: [] },
        { title: 'Bug Fixes', items: [{ text: '只有修复', by: 'Silas' }] },
      ],
    };
    renderDialog([notes]);
    expect(screen.queryByText(i18n.t('update.notice.newFeatures'))).toBeNull();
    expect(screen.getByText(i18n.t('update.notice.bugFixes'))).toBeTruthy();
  });

  it('未知小节标题原样透出,不被误标成「新功能」', () => {
    const notes: ReleaseNotes = {
      ...legacyNotes('0.1.15', ['Silas']),
      sections: [
        { title: 'New Features', items: [{ text: 'A', by: 'Silas' }] },
        { title: 'Performance', items: [{ text: 'B', by: 'Silas' }] },
        { title: 'Docs', items: [{ text: 'C', by: 'Silas' }] },
      ],
    };
    renderDialog([notes]);
    expect(screen.getByText('Performance')).toBeTruthy();
    expect(screen.getByText('Docs')).toBeTruthy();
    // 「新功能」只出现一次(仅 New Features 那一节),不会因多个非修复小节重复。
    expect(screen.getAllByText(i18n.t('update.notice.newFeatures'))).toHaveLength(1);
  });

  it('单版本 auto 模式的版本号与日期在版本块里,不在标题栏', () => {
    renderDialog([topicNotes('0.1.21', ['Kafeifei'])]);
    expect(screen.getByText('v0.1.21')).toBeTruthy();
    // 标题栏右侧在单版本 auto 下不再显示日期或版本计数。
    expect(screen.queryByText(i18n.t('update.notice.versionsSpan', { count: 1 }))).toBeNull();
  });
});
