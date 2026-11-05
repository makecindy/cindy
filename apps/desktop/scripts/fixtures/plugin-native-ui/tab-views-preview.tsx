import { useState } from 'react';
import { TabBar } from '../../../src/renderer/features/right-sidebar/TabBar';
import '../../../src/renderer/features/right-sidebar/plugins/plugin-tab-view';
import type { TabState } from '../../../src/renderer/features/right-sidebar/types';
import manifest from '../../../resources/system-skills/cindy-plugin-creator/examples/native-ui-reference/ghost.json';

export const namedViewGhost = { manifest, dir: '/plugins/native-ui-reference', enabled: true, namespace: null,
  approval: { state: 'approved', revision: 'fixture' } };
const initialTabs: TabState[] = manifest.ui.tabViews.map(view => ({ id: `fixture:${view.id}`, kind: 'plugin-tab-view',
  state: { instanceId: manifest.id, id: view.id, scope: 'session' } }));

function Page({ id, buildId }: { id: string; buildId: string }) {
  const [count, setCount] = useState(0);
  // Page contents are placeholders. Real HTML/bridge behavior has separate tests.
  return <div className="min-h-[250px] p-5 text-14 leading-relaxed">
    <h1 className="mb-2 text-18 font-semibold">{id === 'build-log' ? '构建日志' : '结果预览'}</h1>
    <p className="mb-3">示例内容，由插件自己绘制。</p>
    <pre className="mb-3 whitespace-pre-wrap break-words">{id === 'build-log' ? '构建' : '定位条目'}：{buildId}{'\n'}归属：example-task</pre>
    <button className="rounded border px-3 py-1" onClick={() => setCount(count => count + 1)}>点击示例</button>
    <p className="mt-3" role="status">{count ? `此视图已点击 ${count} 次` : '尚未点击'}</p>
  </div>;
}
export function TabViewsPreview() {
  const [tabs, setTabs] = useState(initialTabs);
  const [buildId, setBuildId] = useState('example-17');
  return <main className="min-h-screen bg-content-area p-4">
    <div className="mb-4 flex flex-wrap gap-3">
      <button className="rounded border px-3 py-1" onClick={() => setBuildId('example-18')}>定位到构建 18</button>
      <button className="rounded border px-3 py-1" onClick={() => setTabs(initialTabs)}>打开两个示例视图</button>
    </div>
    <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2" data-named-views>
      {tabs.map(tab => {
        const id = (tab.state as { id: string }).id;
        return <section key={tab.id} data-view={id} className="flex min-w-0 flex-col overflow-hidden rounded border bg-[var(--surface)]">
          <TabBar tabs={[tab]} activeTabId={tab.id} sessionId="example-task" onActivate={() => {}}
            onClose={id => setTabs(tabs => tabs.filter(tab => tab.id !== id))} onReorder={() => {}}
            creationMenu={{ items: [], select: () => {} }} showWindowControls={false} chromeWindowDrag={false} />
          <Page id={id} buildId={buildId} />
        </section>;
      })}
    </div>
  </main>;
}
