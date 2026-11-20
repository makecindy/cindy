// @vitest-environment jsdom

// 测试价值
// - 生产入口与可观察结果：新建项目表单用来决定「先出介绍还是直接出表单」的 useProjectIntro 与
//   真实的 ProjectIntro，读取真实的本机项目列表；断言介绍是否出现、关闭后是否让位给表单、
//   是否只对还没有项目的人出现一次。
// - 规则依据：docs/product-rules/project-settings.md「第一次新建项目的介绍」、
//   docs/design-rules/feature-introduction.md「每台电脑只出现一次」。
// - 现有覆盖缺口：ProjectSettingsDialog 没有单测，界面检查页不在 CI 里运行。
// - 最小失败输入：本机为空但远端发现／任务读取未完成或失败；已有项目；再次新建；编辑项目。
// - tier：unit（jsdom，进程内，无真实资源）。

import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { recentWorkdirsStore, type RecentWorkdirEntry } from '@/lib/recentWorkdirsStore';
import { ProjectIntro, useProjectIntro } from '../ProjectIntro';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

/** Stands where ProjectSettingsDialog stands: the introduction first, then the form. */
function NewProjectEntrance({ create }: { create: boolean }) {
  const [intro, closeIntro] = useProjectIntro(create);
  return intro ? <ProjectIntro open onClose={closeIntro} /> : <form data-project-form="" />;
}

const intro = () => document.querySelector('[data-feature-intro]');
const form = () => document.querySelector('[data-project-form]');

/** This computer's project list as the sidebar has loaded it. */
async function loadProjects(projects: RecentWorkdirEntry[]) {
  Object.assign(window, { electronAPI: { localDb: { recentWorkdirs: { list: async () => projects } } } });
  await recentWorkdirsStore.forceRefresh();
}

describe('project introduction', () => {
  beforeEach(() => {
    localStorage.clear();
    remoteProjectsStore.clear();
  });

  // Runs first: nothing has loaded the list yet.
  it('does not treat a project list that has not loaded as empty, and keeps its turn', async () => {
    const early = render(<NewProjectEntrance create />);
    expect(intro()).toBeNull();
    expect(form()).not.toBeNull();
    early.unmount();

    await loadProjects([]);
    render(<NewProjectEntrance create />);
    expect(intro()).not.toBeNull();
  });

  it.each(['discovery', 'loading', 'failed'] as const)(
    'keeps the introduction unseen while remote projects are unknown (%s)',
    async (state) => {
      await loadProjects([]);
      const settleDiscovery = state === 'discovery'
        ? remoteProjectsStore.beginInitialDiscovery()
        : undefined;
      if (state === 'loading') remoteProjectsStore.markBootstrapLoading('remote-computer');
      if (state === 'failed') remoteProjectsStore.markBootstrapFailed('remote-computer');
      const early = render(<NewProjectEntrance create />);
      expect(intro()).toBeNull();
      expect(form()).not.toBeNull();
      expect(localStorage.getItem('featureIntro.project.seen')).toBeNull();
      early.unmount();

      // A later opening can introduce projects once discovery and snapshots are known.
      if (settleDiscovery) settleDiscovery();
      else remoteProjectsStore.setDeviceSessions('remote-computer', 'Remote computer', []);
      render(<NewProjectEntrance create />);
      expect(intro()).not.toBeNull();
    },
  );

  it('comes before the first project, leads on to the form, then never again', async () => {
    await loadProjects([]);
    const first = render(<NewProjectEntrance create />);
    expect(intro()).not.toBeNull();
    expect(form()).toBeNull();
    act(() => { fireEvent.keyDown(intro()!, { key: 'Escape' }); });
    // Closing it any way leads on to the form the person asked for.
    expect(intro()).toBeNull();
    expect(form()).not.toBeNull();
    first.unmount();

    render(<NewProjectEntrance create />);
    expect(intro()).toBeNull();
    expect(form()).not.toBeNull();
  });

  it('is skipped for someone who already has a project', async () => {
    await loadProjects([{ path: '/Projects/Cindy', lastUsedAt: '2026-11-18T00:00:00.000Z', exists: true }]);
    render(<NewProjectEntrance create />);
    expect(intro()).toBeNull();
    expect(form()).not.toBeNull();
  });

  it('stays out of the settings of an existing project', async () => {
    await loadProjects([]);
    render(<NewProjectEntrance create={false} />);
    expect(intro()).toBeNull();
    expect(form()).not.toBeNull();
  });
});
