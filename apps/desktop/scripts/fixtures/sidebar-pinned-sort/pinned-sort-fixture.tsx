import { useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SortableList } from '../../../src/renderer/components/sidebar/SortableList';
import { CardMasonry } from '../../../src/renderer/features/cc-agent/sidebar/CardMasonry';

const params = new URLSearchParams(location.search);
const mode = params.get('mode') ?? 'text';
const columns = Number(params.get('columns') ?? 1);
const native = params.get('native') !== 'false';
const initial = params.has('mixed')
  ? ['project-a', 'task', 'project-b']
  : ['project-a', 'project-b', 'project-c'];
type SortEvent = { type: string; ids?: string[]; target?: string | null };
declare global {
  interface Window {
    pinnedSortEvents: SortEvent[];
  }
}
const record = (value: SortEvent) => window.pinnedSortEvents.push(value);
window.pinnedSortEvents = [];
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');

// Keep the production sortable containers and global stylesheet. The synthetic
// rows reproduce ProjectNode's header/children boundary, with no app or user data.
function App() {
  const [items, setItems] = useState(initial);
  const [clicks, setClicks] = useState(0);
  const renderItem = (id: string) =>
    id === 'task' ? (
      <div data-testid={id} data-split-group-drag-source="true" draggable className="fixture-task">
        <span>Standalone pinned task</span>
      </div>
    ) : (
      <div data-testid={id} data-project-working-dir={`local:/${id}`}>
        <div data-project-header="true" className="fixture-header" role="button" tabIndex={0}>
          <span data-testid={`${id}-title`}>{id}</span>
          <button type="button" onClick={() => setClicks((n) => n + 1)}>
            Action
          </button>
          <input aria-label={`${id} rename`} defaultValue="Rename" />
        </div>
        <div data-no-drag>
          <div className="fixture-child" role="button">
            Child task
          </div>
        </div>
      </div>
    );
  const common = {
    items,
    getId: (id: string) => id,
    renderItem,
    reducedMotion: true,
    forceFallback: !native,
    onReorder: (ids: string[]) => {
      record({ type: 'reorder', ids });
      setItems(ids);
    },
  };
  return (
    <>
      <div
        className="fixture-list"
        style={{ width: mode === 'card' ? [220, 340, 460][columns - 1] : 460 }}
      >
        {mode === 'card' ? (
          <CardMasonry {...common} />
        ) : (
          <SortableList {...common} className="flex flex-col gap-0.5" />
        )}
      </div>
      <output data-testid="order">{JSON.stringify(items)}</output>
      <output data-testid="clicks">{clicks}</output>
      <div id="external">Outside the pinned list</div>
      <img
        id="ordinary-image"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"
      />
    </>
  );
}

for (const type of ['dragstart', 'dragend', 'drop']) {
  document.addEventListener(
    type,
    (event) => {
      record({
        type,
        target:
          (event.target as HTMLElement)?.getAttribute('data-sortable-id') ??
          (event.target as HTMLElement)?.getAttribute('data-card-id'),
      });
    },
    true,
  );
}
createRoot(document.getElementById('root')!).render(<App />);
