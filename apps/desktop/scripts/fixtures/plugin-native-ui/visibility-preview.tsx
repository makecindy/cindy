import { useLayoutEffect } from 'react';
import { mountPage } from '../../ui-page/harness';
import { usePluginUiVisibilityOwner } from '../../../src/renderer/cindy-brain/usePluginUiVisibility';
import wallpaper from '../../../src/renderer/assets/wallpapers/dune-dawn.webp';
import type { PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';

const visible: PluginUiVisibilityValues = { workspace: true, sidebar: true, header: true, messages: true, composer: true, tools: true, windowControls: true };
function Preview({ scenario }: { scenario: string }) {
  usePluginUiVisibilityOwner();
  useLayoutEffect(() => {
    document.documentElement.dataset.wallpaperActive = 'true';
    document.documentElement.style.setProperty('--app-wallpaper-image', `url(${wallpaper})`);
    document.documentElement.style.setProperty('--app-wallpaper-veil', '20%');
    return () => { delete document.documentElement.dataset.wallpaperActive; };
  }, []);
  return <div data-plugin-ui-element="workspace" className="relative flex h-screen bg-content-area text-foreground">
    <aside data-plugin-ui-element="sidebar" className="w-56 shrink-0 border-r p-5">侧栏</aside>
    <main className="flex flex-1 flex-col bg-content-area">
      <header data-plugin-ui-element="header" className="border-b p-4">标题栏</header>
      <div data-plugin-ui-element="messages" className="flex-1 p-8">一条对话消息</div>
      <div className="p-6">
        <div className="contents" data-plugin-ui-keep-visible>
          {scenario === 'permission' && <div className="rounded border bg-[var(--surface-elevated)] p-4">权限提示仍然可见</div>}
        </div>
        <div data-chat-input-root className="rounded border bg-[var(--surface-elevated)] p-4">输入区</div>
      </div>
    </main>
    <div data-plugin-ui-element="windowControls" className="absolute right-2 top-2">窗口按钮</div>
  </div>;
}
mountPage({
  cases: ['visible', 'wallpaper', 'permission', 'partial'],
  host: context => ({ pluginUiVisibility: {
    get: async () => context.case === 'wallpaper' || context.case === 'permission' ? { ...visible, workspace: false } :
      context.case === 'partial' ? { ...visible, sidebar: false, messages: false } : visible,
    onApply: () => () => {}, applied: async () => {}, release: async () => {},
  } }),
  render: context => <Preview scenario={context.case} />,
});
