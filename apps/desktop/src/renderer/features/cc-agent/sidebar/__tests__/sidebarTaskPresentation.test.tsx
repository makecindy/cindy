// @vitest-environment jsdom
/** Test value: production presentation partition + disclosure/parent navigation.
 * Regression: internal dated directories and delegated tasks displace real projects.
 * Existing grouping tests do not distinguish exact delegation from follow/fork metadata.
 * Minimal input: one real project, one diagnostic directory and one exact child ID.
 * Tier: in-process unit; no filesystem, network or runtime creation. */
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../../lib/projectGrouping';
import {
  filterPresentationPinnedEntries,
  includeCollectedPinnedTasks,
  isInternalDiagnosticWorkspace,
  partitionSidebarTaskInput,
  sidebarTaskKind,
  type SidebarTaskInput,
} from '../../lib/sidebarTaskPresentation';
import {
  createSidebarTaskPresentation,
  type SidebarPresentationSnapshot,
} from '../sidebarTaskPresentationView';

const diagnostic = '/app/owners/owner/bots/cindy/workspace/diagnostics/2026-10-28-smoke';
const session = (id: string, workingDir = '/work/project', extra: Partial<Session> = {}) =>
  ({ id, title: id, workingDir, status: 'active', source: 'desktop', ...extra }) as Session;
const project = (path: string, sessions: Session[], extra: Partial<ProjectNode> = {}) =>
  ({
    projectKey: `local:${path}`,
    workingDir: path,
    displayName: path.split('/').at(-1),
    scope: 'local',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    sessions,
    ...extra,
  }) as ProjectNode;
const scopes = [
  { botId: 'cindy', sessionIds: ['ordinary', 'child'], delegatedSessionIds: ['child'] },
];
afterEach(cleanup);

describe('task identity and workspace partition', () => {
  it('does not classify a project by date, basename diagnostics, or general follow responsibility', () => {
    expect(isInternalDiagnosticWorkspace('/work/2026-10-28-client')).toBe(false);
    expect(isInternalDiagnosticWorkspace('/work/diagnostics')).toBe(false);
    expect(sidebarTaskKind(session('ordinary'), scopes)).toBe('ordinary');
    expect(
      sidebarTaskKind(
        session('fork', '/work/project', {
          parentSessionId: 'parent',
          forkedAtMessageId: 'fork-point',
        }),
        scopes,
      ),
    ).toBe('ordinary');
    expect(
      sidebarTaskKind(session('unknown', '/work/project', { parentSessionId: 'parent' }), [
        { botId: 'old-host' },
      ]),
    ).toBe('unknown');
  });

  it('only local exact delegation IDs are children; remote ID collisions stay visible', () => {
    expect(
      sidebarTaskKind(session('child', '/work/project', { parentSessionId: 'parent' }), scopes),
    ).toBe('delegated');
    const remote = session('child', diagnostic, { deviceLinkDeviceId: 'other-computer' });
    const input = {
      projects: [
        project(diagnostic, [remote], { scope: 'remote', deviceLinkDeviceId: 'other-computer' }),
      ],
      dialogues: [],
    };
    expect(partitionSidebarTaskInput(input, scopes).normal.projects[0].sessions).toEqual([remote]);
  });

  it('removes internal-only workspace headers from the normal list without changing identities or mutating inputs', () => {
    const ordinary = session('ordinary');
    const child = session('child', '/work/project', { parentSessionId: 'parent' });
    const probe = session('probe', diagnostic);
    const real = project('/work/project', [ordinary, child], { isPersistentLocal: true });
    const input = { projects: [project(diagnostic, [probe]), real], dialogues: [] };
    const { normal, internal, collected } = partitionSidebarTaskInput(input, scopes);
    expect(normal.projects.map((p) => p.projectKey)).toEqual([real.projectKey]);
    expect(normal.projects[0].sessions.map((s) => s.id)).toEqual(['ordinary']);
    expect(internal.projects.map((p) => p.projectKey)).toEqual(
      input.projects.map((p) => p.projectKey),
    );
    expect(new Set(collected.map((s) => s.id))).toEqual(new Set(['probe', 'child']));
    expect(input.projects[1].sessions).toEqual([ordinary, child]);
  });

  it('retains a real project with no ordinary tasks and never loses hidden pinned tasks', () => {
    const child = session('child', '/work/project', { parentSessionId: 'parent' });
    const input = {
      projects: [project('/work/project', [child], { isPersistentLocal: true })],
      dialogues: [],
    };
    expect(partitionSidebarTaskInput(input, scopes).normal.projects).toHaveLength(1);
    const entries = [
      { kind: 'session', session: child },
      { kind: 'session', session: session('ordinary') },
    ];
    expect(filterPresentationPinnedEntries(entries, scopes).map((e) => e.session.id)).toEqual([
      'ordinary',
    ]);
    const enriched = includeCollectedPinnedTasks({ projects: [], dialogues: [] }, entries, scopes);
    expect(partitionSidebarTaskInput(enriched, scopes).collected.map((s) => s.id)).toEqual([
      'child',
    ]);
  });

  it('preserves every normal project position and grouping when internal projects are interleaved', () => {
    const normalProjects = ['/work/product', '/work/2026-10-28-launch', '/work/design'].map(
      (path, index) => project(path, [session(`ordinary-${index}`, path)]),
    );
    const internalProject = project(diagnostic, [session('probe', diagnostic)]);
    for (const order of [normalProjects, [...normalProjects].reverse()]) {
      const input = { projects: [internalProject, order[0], order[1], order[2]], dialogues: [] };
      const { normal } = partitionSidebarTaskInput(input, scopes);
      expect(normal.projects.map((p) => p.projectKey)).toEqual(order.map((p) => p.projectKey));
      expect(normal.projects.map((p) => p.workingDir)).toEqual(order.map((p) => p.workingDir));
      expect(input.projects[0]).toBe(internalProject);
    }
  });
});

function fixture(overrides: Partial<SidebarPresentationSnapshot> = {}) {
  const navigate = vi.fn();
  let snapshot: SidebarPresentationSnapshot = {
    owner: { dataOwnerId: 'owner', generation: 1 },
    scopes,
    profiles: [{ id: 'cindy', name: 'Cindy', sessions: [{ id: 'parent', role: 'canonical' }] }],
    ...overrides,
  };
  const readSession = vi.fn().mockResolvedValue(null);
  const view = createSidebarTaskPresentation(React, {
    useSnapshot: () => snapshot,
    useLanguage: () => 'zh-CN',
    isOwnerCurrent: (owner) => owner === snapshot.owner,
    readSession,
  });
  const Original = ({ projects, dialogues = [], unclassified = [] }: SidebarTaskInput) => (
    <div>
      {projects.map((p: ProjectNode) => (
        <section key={p.projectKey}>
          <h3>{p.displayName}</h3>
          {p.sessions.map((s) => (
            <React.Fragment key={s.id}>
              {view.wrapRow(<button>{s.title}</button>, { session: s, navigate })}
            </React.Fragment>
          ))}
        </section>
      ))}
      {[...dialogues, ...unclassified].map((s: Session) => (
        <React.Fragment key={s.id}>
          {view.wrapRow(<button>{s.title}</button>, { session: s, navigate })}
        </React.Fragment>
      ))}
    </div>
  );
  const props = {
    projects: [
      project(diagnostic, [
        session('probe', diagnostic),
        session('child', diagnostic, { parentSessionId: 'parent' }),
      ]),
      project('/work/project', [session('ordinary')]),
    ],
    dialogues: [],
    notifications: new Set(['child']),
    runningSessionIds: new Set<string>(),
  };
  return {
    view,
    Original,
    props,
    navigate,
    readSession,
    setSnapshot: (next: SidebarPresentationSnapshot) => {
      snapshot = next;
    },
    getSnapshot: () => snapshot,
  };
}

describe('folded internal tasks and parent links', () => {
  it('defaults closed, keeps normal projects first, and exposes exact task types and canonical parent navigation', () => {
    const { view, Original, props, navigate, readSession } = fixture();
    render(<view.Section {...props} Original={Original} />);
    expect(screen.getByText('ordinary')).toBeTruthy();
    expect(screen.queryByText('probe')).toBeNull();
    expect(screen.queryByText('2026-10-28-smoke')).toBeNull();
    const disclosure = screen.getByRole('button', { name: '内部任务 · 2' });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('status').textContent).toContain('1 项有更新');
    fireEvent.click(disclosure);
    expect(screen.getByText('2026-10-28-smoke')).toBeTruthy();
    expect(screen.getByText('普通任务')).toBeTruthy();
    expect(screen.getByText('↳ 委派任务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '父任务: Cindy' }));
    expect(navigate).toHaveBeenCalledWith('/bots/cindy/session/parent');
    expect(readSession).not.toHaveBeenCalled();
    fireEvent.click(disclosure);
    expect(screen.queryByText('child')).toBeNull();
  });

  it('does not automatically expand on activity and resets disclosure on an owner boundary', () => {
    const f = fixture();
    const mounted = render(<f.view.Section {...f.props} Original={f.Original} />);
    mounted.rerender(
      <f.view.Section {...f.props} runningSessionIds={new Set(['child'])} Original={f.Original} />,
    );
    expect(screen.getByRole('button', { name: '内部任务 · 2' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByText('child')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '内部任务 · 2' }));
    f.setSnapshot({
      ...f.getSnapshot(),
      owner: { dataOwnerId: 'different-owner', generation: 2 },
      scopes: [],
      profiles: [],
    });
    mounted.rerender(<f.view.Section {...f.props} Original={f.Original} />);
    expect(screen.getByRole('button', { name: '内部任务 · 2' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(screen.queryByRole('button', { name: '父任务: Cindy' })).toBeNull();
  });

  it('keeps confirmed delegation visible without inventing a missing parent', () => {
    const f = fixture();
    render(
      f.view.wrapRow(<button>orphan</button>, { session: session('child'), navigate: f.navigate }),
    );
    expect(screen.getByText('未记录父任务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /父任务:/ })).toBeNull();
  });

  it('opens an existing non-canonical parent by its exact task id', async () => {
    const f = fixture({ profiles: [] });
    f.readSession.mockResolvedValue(session('parent', '/work/project', { title: 'Parent work' }));
    render(
      f.view.wrapRow(<button>child</button>, {
        session: session('child', diagnostic, { parentSessionId: 'parent' }),
        navigate: f.navigate,
      }),
    );
    const button = await screen.findByRole('button', { name: '父任务: Parent work' });
    fireEvent.click(button);
    expect(f.readSession).toHaveBeenCalledWith('parent');
    expect(f.navigate).toHaveBeenCalledWith('/cc-agent/parent');
  });

  it('disables the parent link when its actual record is unavailable', async () => {
    const f = fixture({ profiles: [] });
    render(
      f.view.wrapRow(<button>child</button>, {
        session: session('child', diagnostic, { parentSessionId: 'missing-parent' }),
        navigate: f.navigate,
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '父任务不可用' }).hasAttribute('disabled')).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '父任务不可用' }));
    expect(f.navigate).not.toHaveBeenCalled();
  });
});
