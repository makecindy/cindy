import { useEffect, useLayoutEffect, useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { PluginUiControls, PluginUiContributionControls } from '../../../src/renderer/cindy-brain/PluginUiControls';
import { PluginUiCommandShortcuts } from '../../../src/renderer/cindy-brain/PluginUiCommandShortcuts';
import { PluginUiRendererView } from '../../../src/renderer/cindy-brain/PluginUiRendererView';
import { PluginUiStatusBar } from '../../../src/renderer/cindy-brain/PluginUiStatusBar';
import { MessageActionBar } from '../../../src/renderer/components/chat/MessageActionBar';
import { Button } from '../../../src/renderer/components/ui/button';
import type { PluginUiView } from '@cindy/maker-shared';
import { ChatBubble } from '../../../src/renderer/components/chat/ChatBubble';
import { applyPluginAppearance } from '../../../src/renderer/cindy-brain/usePluginAppearance';
import { applyFontSettings } from '../../../src/renderer/hooks/useFontSettings';
import { normalizeAppearanceSettings } from '../../../src/shared/appearanceSettings';
import { usePluginUiVisibilityOwner } from '../../../src/renderer/cindy-brain/usePluginUiVisibility';
import type { PluginUiVisibilityApplication } from '../../../src/shared/pluginUiVisibility';
import wallpaper from '../../../src/renderer/assets/wallpapers/dune-dawn.webp';
import { namedViewGhost, TabViewsPreview } from './tab-views-preview';

const visible = { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true };
let statusBarPaused = false;
function StatusBarPreview() {
  return <main className="flex h-screen flex-col p-4">
    <section className="flex flex-1 flex-col justify-end gap-4 pb-3">
      <p>原任务内容</p><div className="rounded-xl border p-4 text-13 text-[var(--text-secondary)]">原输入区</div>
    </section>
    <footer data-statusbar-row className="mt-1.5 flex w-full items-center justify-between gap-3 px-1">
      <span data-statusbar-original className="min-w-0 truncate text-12" title="plugin-native-ui">plugin-native-ui</span>
      <PluginUiStatusBar sessionId="task" />
      <span data-statusbar-original className="h-5 shrink-0 text-12">剩余额度 95%</span>
    </footer>
  </main>;
}
function VisibilityPreview({ critical }: { critical: boolean }) {
  usePluginUiVisibilityOwner();
  useLayoutEffect(() => {
    document.documentElement.dataset.wallpaperActive = 'true';
    document.documentElement.style.setProperty('--app-wallpaper-image', `url(${wallpaper})`);
    document.documentElement.style.setProperty('--app-wallpaper-veil', '20%');
    return () => { delete document.documentElement.dataset.wallpaperActive; };
  }, []);
  return <>
    <div className="app-wallpaper-video" data-visibility-wallpaper><video poster={wallpaper} /></div>
    <div data-plugin-ui-element="workspace" className="flex h-screen bg-content-area">
      <aside data-plugin-ui-element="sidebar" className="w-40 shrink-0 border-r p-4"><div className="visible" data-visibility-sidebar>应用导航与列表</div></aside>
      <main className="flex-1 p-4">任务内容
        {critical ? <div data-plugin-ui-keep-visible><div className="mt-4 rounded border bg-[var(--surface-elevated)] p-4" data-visibility-critical>必要的权限提示</div></div> : null}
        <div data-chat-input-root className="mt-4"><PluginUiContributionControls sessionId="task" point="composer.tools" /></div>
      </main>
    </div>
  </>;
}

function AppearancePreview() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let current = true;
    const style = document.createElement('style'); document.head.appendChild(style);
    const settings = normalizeAppearanceSettings({ bodyFont: { family: 'Georgia', size: 18 },
      reading: { bodyLineHeight: 1.8, codeLineHeight: 1.6, maxWidth: 520 },
      contentStyle: { messagePadding: 14, messageRadius: 18, messageGap: 8 } });
    void applyPluginAppearance(settings, { style, faces: new Map(), bridge: {} as never, applyFonts: applyFontSettings,
      current: () => current, dark: () => document.documentElement.classList.contains('dark') })
      .then(() => { if (current) setReady(true); });
    return () => { current = false; style.remove(); };
  }, []);
  return <main className="mx-auto w-full max-w-2xl p-5" data-appearance-ready={ready}>
    <ChatBubble speaker="user">Use the plugin's reading and bubble settings.</ChatBubble>
    <ChatBubble bare>
      <div className="msg-markdown"><p>正文保留宿主主题，并使用插件配置的字体、行距、间距和圆角。</p>
        <pre className="whitespace-pre-wrap font-mono"><code>{'const background = "wallpaper";\n// Original content remains unchanged.'}</code></pre></div>
    </ChatBubble>
  </main>;
}

function Preview({ variant }: { variant: string }) {
  const [format, setFormat] = useState('plain');
  const [status, setStatus] = useState('Ready');
  const view: PluginUiView = { version: 1, viewId: 'fixture-view', revision: '1', contributionId: 'output-format',
    point: 'composer.tools', fallbackMarkdown: 'The original plugin tool remains available.', blocks: [],
    controls: variant === 'fallback' ? [] : [
      { id: 'format', kind: 'select', label: 'Output format', value: format, actionId: 'set-format',
        options: [{ value: 'plain', label: variant === 'long' ? 'Plain text with a descriptive format name that wraps in narrow layouts' : 'Plain' },
          { value: 'markdown', label: 'Markdown' }] },
      { id: 'preview', kind: 'button', label: variant === 'long' ? 'Preview the current task using the selected output format' : 'Preview text', actionId: 'preview' },
      { id: 'state', kind: 'status', label: 'Plugin state', text: status },
    ], actions: variant === 'fallback' ? [] : [{ id: 'set-format', label: 'Change format' }, { id: 'preview', label: 'Preview text' }] };
  return <main className="mx-auto w-full max-w-2xl p-5">
    <PluginUiControls view={view} pending={variant === 'pending'} disabled={variant === 'disabled'}
      onAction={(id, values) => { if (id === 'set-format') setFormat(String(values.format)); else setStatus('Preview requested'); }} />
    <output className="mt-4 block text-13 text-[var(--text-secondary)]">{format}</output>
  </main>;
}

const shortcutId = `plugin:${'a'.repeat(64)}`;
if (!crypto.randomUUID) {
  let nextId = 0;
  Object.defineProperty(crypto, 'randomUUID', { value: () =>
    `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` });
}
function ShortcutPreview() {
  return <main className="p-5" data-plugin-ui-session="task">
    {['first', 'second'].map(id => <div key={id} data-message-client-id={id} className="my-4">
      <button type="button" className="rounded border px-3 py-2" data-shortcut-target={id}>{id}</button>
      <PluginUiCommandShortcuts sessionId="task" entry="message" targetId={id} focusMessageId={id} />
    </div>)}
  </main>;
}
function CommandMenuPreview() {
  return <main className="p-5" data-plugin-ui-session="task">
    <div data-message-client-id="first">
      <p>Message with a plugin command</p>
      <MessageActionBar copyText="Message" align="left" hovered
        pluginUiTarget={{ sessionId: 'task', id: 'first' }} />
    </div>
  </main>;
}
function RendererPreview({ header = false }: { header?: boolean }) {
  return <main className="mx-auto w-full max-w-2xl p-5">
    {header ? <header className="mb-4 flex min-h-11 flex-wrap items-center gap-2 border-b pb-2">
      <Button variant="secondary" tone="quiet" size="sm" compact>原生操作</Button>
      <PluginUiContributionControls sessionId="task" point="session.header.actions" />
    </header> : null}
    <p className="mb-2 text-12 text-[var(--text-secondary)]">Plugin · Writer</p>
    <ChatBubble speaker="user"><PluginUiRendererView sessionId="task" point="message.body" target={{ kind: 'message', id: 'first' }}>
      <p>Original message stays available.</p>
    </PluginUiRendererView></ChatBubble>
  </main>;
}
let rendererSelected = false;

mountPage({
  route: '/plugin-native-ui',
  host: context => context.case === 'tab-views' ? {
    ghosts: { listSync: () => ({ ghosts: [namedViewGhost] }), onChanged: () => () => {} },
  } : context.case.startsWith('statusbar') ? {
    ghosts: { ui: {
      onChanged: subscription('statusbarChanged'), release: async () => {},
      read: async () => ({ revision: String(statusBarPaused), views: document.documentElement.dataset.statusbarEmpty ? [] : [{
        version: 1, viewId: 'status-view', revision: String(statusBarPaused), contributionId: 'status', point: 'session.statusbar',
        controls: [{ id: 'toggle', kind: 'button', actionId: 'toggle', label: context.case === 'statusbar-long'
          ? `${'插件提供的较长底栏内容示例 · '.repeat(6)}${statusBarPaused ? '已暂停' : '已就绪'}`
          : `插件底栏示例：${statusBarPaused ? '已暂停' : '已就绪'} · 点击切换` }],
        actions: [{ id: 'toggle', label: '切换状态' }], blocks: [], fallbackMarkdown: '底栏内容示例',
      }] }),
      invoke: async ({ input }: { input: { invocationId: string } }) => {
        statusBarPaused = !statusBarPaused;
        return { invocationId: input.invocationId, status: 'completed' };
      },
    } },
  } : context.case.startsWith('visibility') ? {
    ghosts: { ui: {
      onChanged: subscription('pluginUiChanged'), release: async () => {}, closePage: async () => {},
      openPage: async () => { throw new Error('Fixture uses the page fallback'); },
      read: async () => ({ revision: '1', views: [{ version: 1, viewId: 'page-view', revision: '1',
        contributionId: 'page', point: 'composer.tools', page: true,
        controls: [{ kind: 'button', id: 'open', label: '打开示例弹层', actionId: 'open' }],
        actions: [{ id: 'open', label: '打开示例弹层' }], blocks: [], fallbackMarkdown: '插件示例页面' }] }),
    } },
    pluginUiVisibility: {
      get: async () => visible,
      onApply: (handler: (request: PluginUiVisibilityApplication) => void) => {
        const receive = (event: Event) => handler({ requestId: 'fixture', values: (event as CustomEvent).detail });
        window.addEventListener('fixture-visibility', receive);
        return () => window.removeEventListener('fixture-visibility', receive);
      },
      applied: async () => {}, release: async () => {},
    },
  } : !['shortcut-trigger', 'command-menu', 'renderer-body', 'header-actions'].includes(context.case) ? {} : {
    appShortcuts: {
      getState: () => ({ platform: 'darwin', overrides: {}, pluginShortcuts: [{
        id: shortcutId, label: 'Format', pluginName: 'Writer', instanceId: 'writer', scope: 'message',
        points: ['message.actions'],
        defaultCombo: { code: 'KeyJ', meta: false, ctrl: false, alt: true, shift: true },
      }] }),
      onChanged: subscription('shortcutsChanged'),
    },
    voiceInput: {
      getDataSnapshot: () => ({ settings: { shortcut: null } }),
      onDataChanged: subscription('voiceChanged'),
    },
    ghosts: {
      listSync: () => ({ ghosts: [{ instanceKey: 'writer', manifest: { id: 'writer' },
        iconDataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGMIqDjxnxLMMGrAqAGjBgwXAwCbb48ftfSEpgAAAABJRU5ErkJggg==' }] }),
      onChanged: subscription('ghostsChanged'),
      ui: {
      onChanged: subscription('pluginUiChanged'),
      read: async (request: { point: string; target?: { id: string } }) => {
        const id = request.target?.id ?? '';
        document.documentElement.dataset.shortcutReads = String(Number(document.documentElement.dataset.shortcutReads ?? 0) + 1);
        if (request.point === 'session.header.actions') return { revision: '1', views: ['插件操作', '插件页面', '更多插件操作'].map((label, index) => ({
          version: 1, viewId: `header-${index}`, revision: '1', contributionId: `header-${index}`, point: request.point,
          ...(index === 1 ? { page: true } : {}), controls: [{ kind: 'button', id: 'run', label, actionId: 'run' }],
          actions: [{ id: 'run', label }], blocks: [], fallbackMarkdown: label,
        })) };
        if (request.point === 'message.body') {
          const selected = rendererSelected || context.case === 'header-actions';
          const candidate = { instanceId: 'writer', contributionId: 'body', pluginName: 'Writer' };
          return { revision: '1', renderer: { candidates: [candidate], preference: selected ? 'selected' : 'original',
            ...(selected ? { selected: { instanceId: 'writer', contributionId: 'body' } } : {}) },
            views: selected ? [{ version: 1, viewId: 'renderer-view', revision: '1', contributionId: 'body',
              point: request.point, controls: [], actions: [], blocks: [], fallbackMarkdown: 'Plugin display of the saved message.' }] : [] };
        }
        return { revision: '1', views: [{ version: 1, viewId: `view-${id}`, revision: '1',
          contributionId: 'format', point: request.point, command: { shortcutId },
          controls: [{ kind: 'button', id: 'run', label: 'Format', actionId: 'run' }],
          actions: [{ id: 'run', label: 'Format' }], blocks: [], fallbackMarkdown: 'Format' }] };
      },
      chooseRenderer: async ({ choice }: { choice: unknown }) => { rendererSelected = choice !== null; },
      invoke: async ({ input }: { input: { invocationId: string; viewId: string } }) => {
        document.documentElement.dataset.shortcutInvoked = input.viewId;
        if (context.case === 'header-actions') await new Promise<void>(resolve => window.addEventListener('fixture-action-complete', () => resolve(), { once: true }));
        return { invocationId: input.invocationId, status: 'completed' };
      },
      release: async () => {
        document.documentElement.dataset.shortcutReleases = String(Number(document.documentElement.dataset.shortcutReleases ?? 0) + 1);
      },
      },
    },
  },
  render: context => context.case === 'tab-views' ? <TabViewsPreview />
    : context.case.startsWith('statusbar') ? <StatusBarPreview />
    : context.case.startsWith('visibility') ? <VisibilityPreview critical={context.case === 'visibility-critical'} />
    : context.case === 'appearance' ? <AppearancePreview />
    : context.case === 'shortcut-trigger' ? <ShortcutPreview />
      : context.case === 'renderer-body' || context.case === 'header-actions' ? <RendererPreview header={context.case === 'header-actions'} />
      : context.case === 'command-menu' ? <CommandMenuPreview /> : <Preview variant={context.case} />,
});
