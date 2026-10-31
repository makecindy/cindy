// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  confirm: vi.fn(),
  localScan: vi.fn(),
  localInstall: vi.fn(),
  localRead: vi.fn(),
  t: (key: string) => key,
  user: { id: 'owner', membershipKind: 'org' },
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: mocks.t, i18n: { language: 'en' } }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: mocks.user, dataOwnerId: 'owner', mode: 'cloud' }),
}));
vi.mock('@/hooks/useCCSessions', () => ({
  useCCSessions: () => ({ sessions: [], isLoading: false }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock('@/features/cc-agent/NewMakerDraftRoute', () => ({ NEW_MAKER_DRAFT_KEY: 'draft' }));
vi.mock('@/lib/composerDraftStore', () => ({ plainTextToTiptapDoc: vi.fn(), saveDraft: vi.fn() }));
vi.mock('@/state/newMakerDraft', () => ({ resetDraftWorkspaceTargets: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
// Local detail rendering has separate coverage; keep its production controls/executor here.
vi.mock('../SkillhubDetailView', async () => {
  const { useEffect, useState } = await import('react');
  const { useSkillhubTarget } = await import('../SkillhubTargetContext');
  const { LocalSkillControls } = await import('../components/LocalSkillControls');
  return {
    SkillhubDetailView: ({
      entryOverride: skill,
      renderNavigation,
      onUninstalled,
    }: {
      entryOverride: SkillhubSkill;
      renderNavigation: () => React.ReactNode;
      onUninstalled: () => void;
    }) => {
      const target = useSkillhubTarget()!;
      const [text, setText] = useState('');
      useEffect(() => {
        void target.api
          .readSkill({ mdPath: skill.mdPath })
          .then((result) => setText(result.content ?? ''));
      }, [target.api, skill.mdPath]);
      return (
        <div>
          {renderNavigation()}
          <p>{text}</p>
          <LocalSkillControls skill={skill} onUninstalled={onUninstalled} />
        </div>
      );
    },
  };
});
import { RemoteSkillsPage } from '../RemoteSkillsPage';

const market = (name = 'public-skill', scope = 'market') => ({
  name,
  displayName: name === 'public-skill' ? 'Public skill' : name,
  description: name + ' description',
  authorId: 'author',
  authorName: 'Target author',
  isMine: false,
  canManage: false,
  latestVersion: '1.0.0',
  visibility: 'PUBLIC',
  visibleDeptIds: [],
  categories: ['knowledge'],
  tags: [{ slug: 'research', name: 'Research' }],
  githubUrl: null,
  publishedAt: '2026-10-01T00:00:00Z',
  downloads: 321,
  catalogScope: scope,
});
const snapshot = (device: string) => ({
  version: 1,
  items: [
    {
      id: 'physical-instance',
      revision: 'r1',
      name: device + ' installed',
      description: 'Target-only local skill',
      kind: 'skill',
      scope: 'global',
      engines: ['Codex'],
      enabled: true,
      canUninstall: true,
      managedByPlugin: false,
      builtIn: false,
      market: { name: 'public-skill', catalogScope: 'market' },
      version: '1.0.0',
    },
  ],
  market: [],
  nextCursor: null,
  marketUnavailable: false,
  projects: [{ id: 'project-b', revision: 'p1', name: 'Target project' }],
});
const requests = (action: string) =>
  mocks.invoke.mock.calls.filter((call) => call[2]?.[0]?.actionId === 'management:' + action);
const page = (id = 'B', online = true, active = true) => (
  <MemoryRouter initialEntries={['/skillhub/local']}>
    <RemoteSkillsPage
      key={id}
      device={{ deviceId: id, name: 'Computer ' + id }}
      online={online}
      active={active}
    />
  </MemoryRouter>
);
beforeEach(() => {
  // jsdom does not implement the browser scrolling APIs used by the real category bar.
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true, writable: true, value: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true, writable: true, value: vi.fn(),
  });
  vi.clearAllMocks();
  setDataOwnerGeneration('owner');
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mocks.confirm.mockImplementation(async (_device, operationId) => ({
    operationId,
    phase: 'succeeded',
  }));
  window.electronAPI = {
    skillhub: { scan: mocks.localScan, install: mocks.localInstall, readSkill: mocks.localRead },
    deviceLink: {
      invoke: mocks.invoke,
      confirmSkillMutation: mocks.confirm,
      onRemotePush: () => () => {},
    },
  } as never;
  mocks.invoke.mockImplementation(async (device, channel, [request]) => {
    if (channel.endsWith(':manifest'))
      return {
        collections: [
          { id: 'skills', actions: [{ id: 'management:snapshot' }, { id: 'management:catalog' }] },
        ],
      };
    const input = request.input;
    let result;
    switch (request.actionId) {
      case 'management:snapshot':
        result = snapshot(device);
        break;
      case 'management:catalog': {
        const scope = input.scope;
        if (input.method === 'list')
          result = {
            success: true,
            items: [
              market(
                input.cursor ? 'next-page' : scope === 'team' ? 'Team skill' : 'public-skill',
                scope,
              ),
            ],
            nextCursor: input.cursor ? null : '2',
          };
        if (input.method === 'categories')
          result = {
            success: true,
            categories: [{ slug: 'knowledge', name: 'Knowledge', count: 40 }],
          };
        if (input.method === 'info') result = { success: true, info: market(input.name, scope) };
        if (input.method === 'files')
          result = {
            success: true,
            files: [{ path: 'SKILL.md', size: 18, language: 'markdown', truncated: false }],
          };
        if (input.method === 'file')
          result = {
            success: true,
            file: { path: 'SKILL.md', content: '# Published target content', language: 'markdown' },
          };
        break;
      }
      case 'management:read-file':
      case 'management:detail':
        result = {
          success: true,
          content: '# Target local content',
          markdown: '# Target local content',
        };
        break;
      case 'management:children':
        result = { success: true, entries: [] };
        break;
      case 'management:begin':
        result = {
          operationId: input.operationId,
          phase: ['enable', 'disable'].includes(input.kind) ? 'succeeded' : 'confirmation',
          ...(['enable', 'disable'].includes(input.kind)
            ? {}
            : {
                confirmation: {
                  requestId: 'confirm',
                  kind: input.kind,
                  name: input.name ?? 'Target local',
                },
              }),
        };
        break;
      default:
        result = { operationId: input.operationId, phase: 'running' };
    }
    return { result, effects: [] };
  });
});
afterEach(cleanup);

describe('full Skill Hub bound to the selected computer', () => {
  it('shows original market cards/categories and target installed state together', async () => {
    render(page());
    await screen.findByText('Public skill');
    expect(screen.getByText('Target author')).toBeTruthy();
    expect(screen.getByText('321')).toBeTruthy();
    expect(await screen.findByRole('radio', { name: 'Knowledge' })).toBeTruthy();
    expect(screen.getByText('skillhub.home.installed')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.remote.managingDescription')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeNull();
    expect(screen.queryByText('B installed')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    await screen.findByText('B installed');
    expect(screen.queryByText('Public skill')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.managingDescription')).toBeTruthy();
    expect(requests('snapshot')[0][2][0].input).toEqual({ installedOnly: true });
    expect(mocks.localScan).not.toHaveBeenCalled();
  });
  it('paginates and sends category/search/organization filters to the selected Host', async () => {
    render(page());
    await screen.findByText('Public skill');
    fireEvent.click(screen.getByText('skillhub.home.loadMore'));
    await screen.findByText('next-page');
    expect(
      requests('catalog').some((call) => call[0] === 'B' && call[2][0].input.cursor === '2'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Knowledge' }));
    await waitFor(() =>
      expect(requests('catalog').some((call) => call[2][0].input.category === 'knowledge')).toBe(
        true,
      ),
    );
    fireEvent.click(
      screen.getByRole('radio', { name: 'skillhub.home.catalogFilter.organization' }),
    );
    await screen.findByText('Team skill');
    expect(screen.queryByText('Public skill')).toBeNull();
    expect(screen.queryByText('B installed')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'skillhub.home.search' }), {
      target: { value: 'Team' },
    });
    await waitFor(() =>
      expect(
        requests('catalog').some(
          (call) => call[2][0].input.q === 'Team' && call[2][0].input.scope === 'team',
        ),
      ).toBe(true),
    );
  });
  it('keeps the complete installed list when an older Host reports a built-in user scope', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (device, channel, args) => {
      const response = await original(device, channel, args);
      if (args[0].actionId === 'management:snapshot') {
        response.result.items.push({
          ...snapshot(device).items[0],
          id: 'built-in',
          name: 'Built-in user skill',
          scope: 'user',
          builtIn: true,
          canUninstall: false,
        });
      }
      return response;
    });
    render(page());
    await screen.findByText('Public skill');
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    await screen.findByText('B installed');
    expect(screen.getByText('Built-in user skill')).toBeTruthy();
    expect(mocks.localScan).not.toHaveBeenCalled();
  });
  it('associates the target author’s published copy with its visible market record', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (device, channel, args) => {
      const response = await original(device, channel, args);
      if (args[0].actionId === 'management:snapshot') {
        response.result.items[0].market = {
          name: 'public-skill',
          origin: 'published',
          authorId: 'author',
        };
      }
      if (args[0].actionId === 'management:catalog' && args[0].input.method === 'list') {
        Object.assign(response.result.items[0], { isMine: true, isCreator: true, canManage: true });
      }
      return response;
    });
    render(page());
    await screen.findByText('Public skill');
    await screen.findByText('skillhub.home.installed');
    expect(mocks.localScan).not.toHaveBeenCalled();
  });
  it.each(['learned', 'imported'])('keeps %s target copies readable', async (origin) => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (device, channel, args) => {
      const response = await original(device, channel, args);
      if (args[0].actionId === 'management:snapshot') {
        response.result.items[0].market.origin = origin;
      }
      return response;
    });
    render(page());
    await screen.findByText('Public skill');
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    await screen.findByText('B installed');
    expect(mocks.localScan).not.toHaveBeenCalled();
  });
  it('opens full market details and published content using the target Hub', async () => {
    render(page());
    fireEvent.click(await screen.findByText('Public skill'));
    await screen.findByText('# Published target content');
    expect(
      requests('catalog')
        .filter((call) => ['info', 'files', 'file'].includes(call[2][0].input.method))
        .every((call) => call[0] === 'B'),
    ).toBe(true);
    expect(mocks.localRead).not.toHaveBeenCalled();
  });
  it('uses the original picker and installs to the target project with native confirmation', async () => {
    render(page());
    fireEvent.click(await screen.findByText('Public skill'));
    await screen.findByText('# Published target content');
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.marketCard.clone' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Target project/ }),
    );
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests('begin')).toHaveLength(1);
    expect(requests('begin')[0][0]).toBe('B');
    expect(requests('begin')[0][2][0].input).toMatchObject({
      kind: 'install',
      name: 'public-skill',
      catalogScope: 'market',
      version: '1.0.0',
      projectId: 'project-b',
      projectRevision: 'p1',
    });
    expect(JSON.stringify(requests('begin')[0])).not.toContain('installPath');
    expect(mocks.localInstall).not.toHaveBeenCalled();
  });
  it('can confirm the original operation after a lost native confirmation response and reconnect', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (device, channel, args) => {
      if (args[0].actionId === 'management:operation')
        return {
          result: {
            operationId: args[0].input.operationId,
            phase: 'confirmation',
            confirmation: { requestId: 'confirm', kind: 'install', name: 'Public skill' },
          },
          effects: [],
        };
      return original(device, channel, args);
    });
    mocks.confirm.mockRejectedValueOnce(new Error('CONNECTION_LOST'));
    const ui = render(page());
    fireEvent.click(await screen.findByText('Public skill'));
    await screen.findByText('# Published target content');
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.marketCard.clone' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /Target project/ }),
    );
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledOnce());
    ui.rerender(page('B', false));
    ui.rerender(page());
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
    expect(requests('begin')).toHaveLength(1);
    expect(mocks.confirm.mock.calls[1]).toEqual(mocks.confirm.mock.calls[0]);
    expect(mocks.localInstall).not.toHaveBeenCalled();
  });
  it('toggles/uninstalls the displayed physical instance without local mutation IPC', async () => {
    render(page());
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    fireEvent.click(await screen.findByText('B installed'));
    await screen.findByText('# Target local content');
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(requests('begin')).toHaveLength(1));
    expect(requests('begin')[0][2][0]).toMatchObject({
      resourceRef: { id: 'physical-instance' },
      input: { kind: 'disable', expectedRevision: 'r1' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'skillhub.management.moreLabel' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'skillhub.detail.uninstall' }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledWith('B', expect.any(String)));
    expect(requests('begin')[1][2][0].input.kind).toBe('uninstall');
    expect(requests('answer')).toHaveLength(0);
  });
  it.each(['NOT_FOUND', 'INVALID_PARAMS', 'UNSUPPORTED_CAPABILITY', 'PERMISSION_DENIED'])(
    'unlocks and refreshes after begin is explicitly rejected with %s',
    async (code) => {
      const original = mocks.invoke.getMockImplementation()!;
      let rejected = false;
      mocks.invoke.mockImplementation(async (device, channel, args) => {
        if (args[0].actionId === 'management:begin' && !rejected) {
          rejected = true;
          throw new Error(`[${code}] Request rejected`);
        }
        return original(device, channel, args);
      });
      render(page());
      fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
      fireEvent.click(await screen.findByText('B installed'));
      await screen.findByText('# Target local content');
      const reads = requests('snapshot').length;
      fireEvent.click(screen.getByRole('switch'));
      await waitFor(() => {
        expect(requests('begin')).toHaveLength(1);
        expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false);
        expect(requests('snapshot').length).toBeGreaterThan(reads);
      });
      fireEvent.click(screen.getByRole('switch'));
      await waitFor(() => expect(requests('begin')).toHaveLength(2));
      expect(requests('begin')[1][2][0].input.operationId).not.toBe(
        requests('begin')[0][2][0].input.operationId,
      );
    },
  );
  it('queries the same receipt after a lost begin response without replaying begin', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation(async (device, channel, args) => {
      if (args[0].actionId === 'management:begin') throw new Error('[TIMEOUT] Response lost');
      if (args[0].actionId === 'management:operation')
        return { result: { operationId: args[0].input.operationId, phase: 'succeeded' } };
      return original(device, channel, args);
    });
    const ui = render(page());
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    fireEvent.click(await screen.findByText('B installed'));
    await screen.findByText('# Target local content');
    fireEvent.click(screen.getByRole('switch'));
    await screen.findByText('settings.ghosts.remote.unknown');
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    ui.rerender(page('B', false));
    ui.rerender(page());
    await waitFor(() =>
      expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(false),
    );
    expect(requests('begin')).toHaveLength(1);
    expect(requests('operation')[0][2][0].input.operationId).toBe(
      requests('begin')[0][2][0].input.operationId,
    );
  });
  it('keeps offline content visible, disables writes and does not replay', async () => {
    const ui = render(page());
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    fireEvent.click(await screen.findByText('B installed'));
    await screen.findByText('# Target local content');
    ui.rerender(page('B', false));
    expect((screen.getByRole('switch') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('# Target local content')).toBeTruthy();
    expect(requests('begin')).toHaveLength(0);
  });
  it('discards old computer responses and does not read hidden targets', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation((device, channel, args) =>
      device === 'B' && args[0].actionId === 'management:snapshot'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(device, channel, args),
    );
    const ui = render(page('B', true, false));
    expect(mocks.invoke).not.toHaveBeenCalled();
    ui.rerender(page());
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    ui.rerender(page('C'));
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    await screen.findByText('C installed');
    await act(async () => finish({ result: snapshot('Late B'), effects: [] }));
    expect(screen.queryByText('Late B installed')).toBeNull();
  });
  it('keeps older Hosts readable without falling back to this computer', async () => {
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'skills', actions: [{ id: 'management:snapshot' }] }] }
        : original(device, channel, args),
    );
    render(page());
    fireEvent.click(screen.getByRole('radio', { name: 'skillhub.home.local' }));
    await screen.findByText('B installed');
    expect(screen.getByText('skillhub.remote.unsupported')).toBeTruthy();
    expect(requests('catalog')).toHaveLength(0);
    expect(mocks.localScan).not.toHaveBeenCalled();
    expect(mocks.localInstall).not.toHaveBeenCalled();
  });
});
