import type { CindyPluginUi, CindyPluginUiPage, PluginUiContent, CindyPluginTabView, PluginUiActionResult } from '@cindy/maker-shared/plugin-ui';

declare const ui: CindyPluginUi;
const content: PluginUiContent = { controls: [], blocks: [], actions: [], fallbackMarkdown: 'Ready' };
ui.contribute('format', {
  render: ({ scope }) => scope.kind === 'session' ? content : content,
  onAction: async ({ values, data }) => ({ status: values.format ? 'completed' : 'rejected', data: data ?? null }),
});
ui.invalidate({ contributionId: 'format', scope: { kind: 'session', sessionId: 'task' } });
// @ts-expect-error Host binding metadata is not an author-returned field.
const forged: PluginUiContent = { ...content, viewId: 'forged' };
void forged;
void ui.appearance.read().then(snapshot => ui.appearance.set({ uiFont: { size: 16 }, reading: { maxWidth: 720 } }, { ifRevision: snapshot.revision }));
void ui.appearance.reset(['reading']);
void ui.visibility.read().then(values => ui.visibility.set({ workspace: !values.workspace }));
declare const page: CindyPluginUiPage;
void page.read().then(context => context.scope.sessionId);
void page.invoke({ actionId: 'save', values: { format: 'plain' } }).then(result => result.status);
void page.invoke({ actionId: 'load', values: {}, data: { filters: { ids: ['one'] }, offset: 0 } }).then(result => result.data);
// @ts-expect-error Business payloads contain JSON data, not executable callbacks.
void page.invoke({ actionId: 'load', values: {}, data: { callback: () => {} } });
void page.appearance.read();
void page.visibility.set({ sidebar: false });
// @ts-expect-error Only named UI areas can be changed.
void ui.visibility.set({ arbitrarySelector: false });
// @ts-expect-error Page calls cannot choose a host view or another plugin.
void page.invoke({ viewId: 'forged', actionId: 'save', values: {} });
// @ts-expect-error The public appearance surface does not expose host CSS.
void ui.appearance.set({ css: 'body { display: none }' });
declare const view: CindyPluginTabView;
const off = view.onChanged(snapshot => { void snapshot.params.buildId; });
void view.read().then(snapshot => snapshot.scope.kind === 'session' ? snapshot.scope.sessionId : 'global');
off();
const open: PluginUiActionResult = { status: 'completed', openView: { id: 'build-log', params: { buildId: 'b17' } } };
ui.registerCommand('open-log', () => open);
// @ts-expect-error Opening a declared view cannot choose a different physical instance.
const forgedView: PluginUiActionResult = { status: 'completed', openView: { id: 'log', instanceId: 'other' } };
// @ts-expect-error Navigation values cannot contain arbitrary nested objects.
const nested: PluginUiActionResult = { status: 'completed', openView: { id: 'log', params: { row: {} } } };
void forgedView; void nested;
