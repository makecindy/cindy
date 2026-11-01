// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DragEvent } from 'react';
import type { Session } from '@/lib/ccAgent.types';
import type { ProjectNode } from '../../lib/projectGrouping';

const sortableMock = vi.hoisted(() => {
  class MockSortable {
    static active: MockSortable | null = null;
    static instances: MockSortable[] = [];
    constructor(
      readonly el: HTMLElement,
      readonly options: Record<string, unknown>,
    ) {}
    static create(el: HTMLElement, options: Record<string, unknown>) {
      const instance = new MockSortable(el, options);
      MockSortable.instances.push(instance);
      return instance;
    }
    option(name: string, value: unknown) {
      this.options[name] = value;
    }
    destroy() {}
  }
  return { MockSortable };
});
vi.mock('sortablejs', () => ({ default: sortableMock.MockSortable }));

import { SortableList } from '@/components/sidebar/SortableList';
import { DraggableCardColumns } from '../DraggableCardColumns';
import { startSessionDrag } from '../../splitGroupDnd';
import { useSessionProjectDrop } from '../useSessionProjectDrop';

const task = {
  id: 'task',
  title: 'Task',
  status: 'active',
  workingDir: '/a',
  workspaceKind: 'project',
  _count: { messages: 2 },
} as Session;
const project = { projectKey: '/b', workingDir: '/b', scope: 'local' } as ProjectNode;
const items = ['task', 'other', 'project', 'last'];

function Harness({
  cards,
  fallback,
  move,
  reorder,
  session = task,
}: {
  cards: boolean;
  fallback: boolean;
  move: ReturnType<typeof vi.fn>;
  reorder: ReturnType<typeof vi.fn>;
  session?: Session;
}) {
  const drop = useSessionProjectDrop({
    getSession: () => session,
    getProject: () => project,
    expandProject: vi.fn(),
    onMoveSession: move,
  });
  const common = {
    items,
    getId: (id: string) => id,
    onReorder: reorder,
    forceFallback: fallback,
    renderItem: (id: string) => (
      <div
        data-testid={id}
        data-session-project-drop={id === 'project' ? project.projectKey : undefined}
        draggable={id === 'task'}
        onDragStart={
          id === 'task'
            ? (event: DragEvent) =>
                startSessionDrag(event, {
                  sessionId: session.id,
                  enabled: true,
                  needsDedicatedHandle: false,
                })
            : undefined
        }
      >
        {id}
      </div>
    ),
  };
  return (
    <div onDropCapture={drop.onDropCapture} onDragOverCapture={drop.onDragOverCapture}>
      {cards ? (
        <DraggableCardColumns {...common} columns={2} reducedMotion />
      ) : (
        <SortableList {...common} />
      )}
    </div>
  );
}

afterEach(() => {
  fireEvent.dragEnd(window);
  cleanup();
  sortableMock.MockSortable.instances = [];
  sortableMock.MockSortable.active = null;
});

describe('task moves composed with pinned sorting', () => {
  it.each([false, true])('restores transient DOM without saving a reorder (cards=%s)', (cards) => {
    const move = vi.fn(),
      reorder = vi.fn();
    render(<Harness cards={cards} fallback={false} move={move} reorder={reorder} />);
    const instances = sortableMock.MockSortable.instances;
    const source = instances[0]!;
    const target = instances.at(-1)!;
    const original = instances.map(({ el }) => Array.from(el.children));
    const moved = source.el.children[0] as HTMLElement;
    const data = new Map<string, string>();
    const transfer = {
      get types() {
        return [...data.keys()];
      },
      effectAllowed: '',
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? '',
      clearData: () => data.clear(),
    };
    sortableMock.MockSortable.active = source;
    fireEvent.dragStart(screen.getByTestId('task'), { dataTransfer: transfer });
    (source.options.onStart as () => void)();
    target.el.append(moved);

    // Document capture records an internal sortable drop before React capture
    // recognizes the project move and stops propagation. onEnd must honor it.
    fireEvent.drop(screen.getByTestId('project'), { dataTransfer: transfer });
    const end = () =>
      (source.options.onEnd as (event: unknown) => void)({
        item: moved,
        from: source.el,
        to: target.el,
        oldIndex: 0,
        newIndex: target.el.children.length - 1,
        newDraggableIndex: target.el.children.length - 1,
      });
    end();
    expect(move).toHaveBeenCalledExactlyOnceWith('task', { kind: 'project', workingDir: '/b' });
    expect(reorder).not.toHaveBeenCalled();
    expect(instances.map(({ el }) => Array.from(el.children))).toEqual(original);

    // The claim belongs to one drop event; the next ordinary drag still sorts,
    // even if it passes over a project before dropping on another task.
    fireEvent.dragEnd(window);
    fireEvent.dragStart(screen.getByTestId('task'), { dataTransfer: transfer });
    (source.options.onStart as () => void)();
    target.el.append(moved);
    fireEvent.dragOver(screen.getByTestId('project'), { dataTransfer: transfer });
    fireEvent.drop(screen.getByTestId('other'), { dataTransfer: transfer });
    end();
    expect(reorder).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledOnce();
    expect(instances.map(({ el }) => Array.from(el.children))).toEqual(original);
  });

  it.each([false, true])(
    'keeps pointer fallback sorting without a native drop (cards=%s)',
    (cards) => {
      const reorder = vi.fn();
      render(<Harness cards={cards} fallback move={vi.fn()} reorder={reorder} />);
      const instances = sortableMock.MockSortable.instances;
      const source = instances[0]!,
        target = instances.at(-1)!;
      const moved = source.el.children[0] as HTMLElement;
      sortableMock.MockSortable.active = source;
      (source.options.onStart as () => void)();
      target.el.append(moved);
      (source.options.onEnd as (event: unknown) => void)({
        item: moved,
        from: source.el,
        to: target.el,
        oldIndex: 0,
        newIndex: target.el.children.length - 1,
        newDraggableIndex: target.el.children.length - 1,
      });
      expect(reorder).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ['cindy-make', false],
    ['cindy-make', true],
    ['cindy-make-merge', false],
    ['cindy-make-merge', true],
  ] as const)('keeps ordinary pin sorting for %s (cards=%s)', (sessionSource, cards) => {
    const move = vi.fn(),
      reorder = vi.fn();
    render(
      <Harness
        cards={cards}
        fallback={false}
        move={move}
        reorder={reorder}
        session={{ ...task, source: sessionSource }}
      />,
    );
    const instances = sortableMock.MockSortable.instances;
    const source = instances[0]!,
      target = instances.at(-1)!;
    const moved = source.el.children[0] as HTMLElement;
    const data = new Map<string, string>();
    const transfer = {
      get types() {
        return [...data.keys()];
      },
      effectAllowed: '',
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? '',
      clearData: () => data.clear(),
    };
    sortableMock.MockSortable.active = source;
    fireEvent.dragStart(screen.getByTestId('task'), { dataTransfer: transfer });
    (source.options.onStart as () => void)();
    target.el.append(moved);
    fireEvent.drop(screen.getByTestId('other'), { dataTransfer: transfer });
    (source.options.onEnd as (event: unknown) => void)({
      item: moved,
      from: source.el,
      to: target.el,
      oldIndex: 0,
      newIndex: target.el.children.length - 1,
      newDraggableIndex: target.el.children.length - 1,
    });
    expect(move).not.toHaveBeenCalled();
    expect(reorder).toHaveBeenCalledOnce();
  });
});
