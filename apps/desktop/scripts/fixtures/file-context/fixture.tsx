import { useState } from 'react';
import { FileTabsBar } from '../../../src/renderer/features/cc-agent/workdir-browse/FileTabsBar';
import { FileBodyView } from '../../../src/renderer/features/cc-agent/workdir-browse/FileBodyView';
import { FilterResultList } from '../../../src/renderer/features/cc-agent/workdir-browse/FilterResultList';
import { addTab } from '../../../src/renderer/features/cc-agent/workdir-browse/lib/openTabsStore';
import { TabStrip } from '../../../src/renderer/features/right-sidebar/TabBar';
import '../../../src/renderer/features/right-sidebar/plugins/file-browser';
import { mountPage, subscription, forbid, ctx } from '../../ui-page/harness';

const prefix = typeof ctx.data.prefix === 'string' ? ctx.data.prefix : '';
const paths = ['AGENTS.md', `${prefix}apps/one/src/AGENTS.md`, `${prefix}apps/two/src/AGENTS.md`];
const workdir = ctx.case === 'windows-narrow' ? 'C:\\projects\\example' : '/projects/example';
for (const path of paths) addTab(workdir, path);

function Fixture() {
  const [selected, setSelected] = useState(paths[0]);
  const [sidebarTabs, setSidebarTabs] = useState(() => paths.map((path, index) => ({
    id: String(index), kind: 'file-browser' as const, state: { selectedFilePath: path },
  })));
  const narrow = ctx.case === 'windows-narrow';
  const source = '# Example project rules\n\nKeep changes focused.\n';
  return <main className="flex h-screen min-w-0 flex-col bg-background text-foreground">
    <div className="min-w-0 shrink-0" data-sidebar-file-tabs>
      <TabStrip
        tabs={sidebarTabs}
        activeTabId={String(paths.indexOf(selected))}
        onActivate={id => setSelected(paths[Number(id)])}
        onClose={id => setSidebarTabs(current => current.filter(tab => tab.id !== id))}
        onReorder={ids => setSidebarTabs(current => ids.map(id => current.find(tab => tab.id === id)!))}
        creationMenu={{ items: [], select: () => {} }}
        pillVariant="chip" addButtonWrapperClassName="h-[30px]"
      />
    </div>
    <div className="flex min-h-0 min-w-0 flex-1">
      {!narrow && <aside className="flex w-64 shrink-0 flex-col border-r border-[var(--border-default)]" data-file-list>
        <FilterResultList files={paths} truncated={false} isLoading={false} selectedPath={selected} onSelectFile={setSelected} />
      </aside>}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div data-file-tabs><FileTabsBar workdir={workdir} activePath={selected} onActivate={setSelected} onClear={() => setSelected('')} /></div>
        <div className="min-h-0 flex-1"><FileBodyView workdir={workdir} relPath={selected} allowEdit={false}
          content={ctx.data.contentKind === 'loading' ? { kind: 'loading' }
            : ctx.data.contentKind === 'error' ? { kind: 'error', message: 'Example read failure' }
            : { kind: 'text', relPath: selected, content: source, size: source.length, mtimeMs: 0, truncated: false }} />
        </div>
      </section>
    </div>
  </main>;
}

mountPage({
  host: current => ({
    appShortcuts: { getState: () => ({ platform: current.platform, overrides: {}, globalFailures: [] }), onChanged: subscription('shortcuts') },
    fileBrowser: {
      onEvent: subscription('files'),
      readFile: async ({ relPath }: { relPath: string }) => current.data.template ? ({ ok: true, data: {
        relPath, content: JSON.stringify({ version: 5, files: { 'AGENTS.md': 'a'.repeat(64) } }), size: 120, mtimeMs: 0, truncated: false,
      } }) : ({ ok: false, code: 'NOT_FOUND', message: 'No template record' }),
      writeFile: forbid('fileBrowser.writeFile'),
    },
  }),
  render: () => <Fixture />,
});
