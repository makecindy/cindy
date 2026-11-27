// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelPickerView } from '@/session/UnifiedModelPickerView';
import { UnifiedModelPickerView as IosModelPickerView } from '@/session/UnifiedModelPickerView.ios';
const virtualList = vi.hoisted(() => ({ scrollToOffset: vi.fn(), scrollToIndex: vi.fn(), props: null as any }));
const theme = vi.hoisted(() => ({ mode: 'light' as 'light' | 'dark' }));
vi.mock('react-native', async () => {
  const { createElement: el, useImperativeHandle } = await import('react');
  const View = ({ children, accessibilityElementsHidden, pointerEvents, accessibilityValue, accessibilityLabel }: any) => el('div', { 'aria-hidden': accessibilityElementsHidden, 'data-pointer-events': pointerEvents, 'data-quota': accessibilityValue?.now, 'aria-label': accessibilityLabel }, children);
  return {
    Platform: { OS: "android" },
    View, ScrollView: View,
    FlatList: ({
      ref,
      testID,
      data,
      renderItem,
      ListHeaderComponent,
      ListEmptyComponent,
      ...props
    }: any) => {
      virtualList.props = props;
      useImperativeHandle(
        ref,
        () => ({ scrollToOffset: virtualList.scrollToOffset, scrollToIndex: virtualList.scrollToIndex }),
        [],
      );
      return el(
        "div",
        { "data-testid": testID },
        ListHeaderComponent,
        data.length
          ? data.map((item: any, index: number) =>
              el("div", { key: item.key }, renderItem({ item, index })),
            )
          : ListEmptyComponent,
      );
    },

    Pressable: ({ children, onPress, disabled, accessibilityLabel, testID }: any) => el('button', { onClick: onPress, disabled, 'aria-label':accessibilityLabel, 'data-testid':testID }, children),
    StyleSheet: { create: (styles: any) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  };
});
vi.mock('@/components/AppText', async () => {
  const { createElement: el } = await import('react');
  return { Text: ({ children }: any) => el('span', null, children), TextInput: ({ onChangeText }: any) => el('input', { 'aria-label': 'Model search', onInput: (event: any) => onChangeText(event.target.value) }) };
});
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 40, bottom: 20 }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('lucide-react-native', () => ({
  ...Object.fromEntries(['Clock3', 'Brain', 'Puzzle', 'SlidersHorizontal', 'Check', 'Zap', 'LayoutGrid', 'Search', 'X', 'ChevronDown', 'ChevronRight', 'ChevronsUpDown', 'CircleAlert', 'Waypoints'].map(key => [key, () => null])),
  Star: ({ fill, color }: any) => createElement('span', { 'data-star-fill': fill, 'data-star-color': color }),
}));
vi.mock('react-native-svg', () => ({
  default: ({ children, ...props }: any) => createElement('svg', props, children),
  Path: (props: any) => createElement('path', props),
}));
vi.mock('@expo/ui/swift-ui', async () => {
  const { useRef } = await import('react');
  const Container = ({ children, modifiers, testID, initialScrollTargetId }: any) => createElement('div', {
    'data-testid': testID, 'data-modifiers': JSON.stringify(modifiers), 'data-initial-scroll': initialScrollTargetId,
    'aria-hidden': modifiers?.some((m:any) => m.accessibilityHidden === true),
  }, children);
  return {
    ...Object.fromEntries(['Form', 'BottomSheet', 'Group', 'ZStack', 'Image', 'Spacer', 'HStack', 'Picker', 'ProgressView', 'RNHostView', 'VStack', 'Text', 'TextField', 'Toggle'].map(key => [key, Container])),
    Button: ({ children, onPress, modifiers }: any) => createElement('button', {onClick:onPress, 'aria-label':modifiers?.find((m:any)=>m.accessibilityLabel)?.accessibilityLabel}, children),
    useNativeState: (initial: string) => useRef({ value: initial, get() { return this.value; }, set(value: string) { this.value = value; } }).current,
  };
});
vi.mock('@expo/ui/swift-ui/modifiers', () => ({...Object.fromEntries(
  ['id', 'containerRelativeFrame', 'onGeometryChange'].map(key => [key, (value: any) => ({ [key]: value })]),
), ...Object.fromEntries(
  ['background', 'fixedSize', 'accessibilityElement', 'accessibilityHidden', 'opacity', 'scrollDisabled', 'scrollContentBackground', 'presentationDetents', 'presentationDragIndicator', 'interactiveDismissDisabled', 'contentShape', 'accessibilityLabel', 'buttonStyle', 'disabled', 'font', 'foregroundStyle', 'frame', 'pickerStyle', 'progressViewStyle', 'tint', 'tag', 'padding', 'autocorrectionDisabled', 'textInputAutocapitalization', 'lineLimit'].map(key => [key, (value: any) => ({ [key]: value })]),
), shapes:{rectangle:()=>({}), roundedRectangle:(value: any)=>value}}));
vi.mock('@expo/ui', () => ({Host:({children}:any)=>children}));
vi.mock('@/session/ComposerSheet', () => import('@/session/ComposerSheet.ios'));
vi.mock('@/session/ComposerNativeSection', () => ({ ComposerNativeSection: ({ children, title, header }: any) => createElement('div', null, header ?? title, children) }));
vi.mock('@/session/ComposerNativeRow', () => ({
  ComposerNativeRow: ({ leading, title, subtitleContent, subtitle, testID, onPress }: any) =>
    createElement('div', { 'data-testid': testID, onClick: onPress }, leading, title, subtitleContent ?? subtitle),
}));
vi.mock('@/platform/chrome', () => ({ NativePullDownMenu: ({ children }: any) => children, NativeSwitch: () => null, usesNativePullDownMenu: () => true }));
vi.mock('@/components/MobileAgentMark', () => ({ MobileAgentMark: () => null }));
// 远程标记由 mark 自己按 remote 画(字形不缩放不移位),桩里只留一个可数的记号。
vi.mock('@/session/MobileProviderMark', () => {
  const stub = ({ remote }: any) => (remote ? createElement('span', { 'data-remote-mark': '' }) : null);
  return { MobileModelIconMark: stub, MobileProviderMark: stub };
});
vi.mock('@/session/SheetModal', () => ({ SheetModal: ({ children }: any) => children }));
vi.mock('@/session/SheetSurface', () => ({ SheetSurface: ({ children, pinnedTop, onBack, backAccessibilityLabel, testID, renderScrollContent }: any) => createElement('section', null,
  onBack ? createElement('button', {onClick:onBack, 'aria-label':backAccessibilityLabel ?? 'shared.back'}, 'Back') : null,
  pinnedTop, renderScrollContent ? renderScrollContent({ testID: `${testID}.scroll` }) : createElement('div', {'data-testid':`${testID}.scroll`}, children)) }));
vi.mock('@/session/sessionAgentSwitch', () => ({ mobileAgentLabel: (agent: string) => agent }));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return { ...tokens, useTheme: () => ({ colors: tokens.palettes[theme.mode] }), useThemedStyles: (factory: any) => factory(tokens.palettes[theme.mode]) };
});
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  virtualList.scrollToOffset.mockReset();
  virtualList.scrollToIndex.mockReset();
  virtualList.props = null;
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  root = createRoot(host);
});
afterEach(() => act(() => root.unmount()));
// A pool is not one synthetic progress bar. Exercise both platform renderers,
// including the native iOS source row, with separate known and unknown quotas.
it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'renders independent account quota bars before allocation on %s', async (_platform, Component) => {
    const members = [{ remaining: 34, label: 'first@example.test · 34%' },
      { remaining: 80, label: 'second@example.test · 80%' }, { label: 'unknown@example.test · —' }];
    await act(async () => root.render(createElement(Component, {
      visible: true, testID: 'pool', title: 'Models', query: '', filter: 'all', groups: [],
      filters: [{ id: 'account', label: '3 accounts', providerMark: { name: 'Anthropic' },
        quota: { label: members.map(member => member.label).join('\n'), members } }],
    } as any)));
    await act(async () => (host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement).click());
    expect([...host.querySelectorAll('[data-quota]')].map(node => node.getAttribute('data-quota'))).toEqual(['34','80']);
    expect(host.querySelector('[data-quota="34"]')?.getAttribute('aria-label')).toBe('first@example.test · 34%');
    expect(host.querySelector('[data-quota="80"]')?.getAttribute('aria-label')).toBe('second@example.test · 80%');
  },
);
it.each([null, '2d · 70%'])('keeps both account identities visible with quota %s', async quotaLabel => {
  const rows = ['first@example.com', 'second@example.com'].map(subtitle => ({
    key: subtitle, subtitle, quotaLabel, entry: { displayName: 'Same Model' },
    config: { agent: 'codex' }, providerMark: {},
  }));
  await act(async () => root.render(createElement(UnifiedModelPickerView, {
    visible: true, groups: [{ key: 'favorites', title: 'Favorites', rows }], filters: [],
  } as any)));
  for (const row of rows) expect(host.textContent).toContain(row.subtitle);
  if (quotaLabel) expect(host.textContent).toContain(quotaLabel);
});

it.each([
  ['Android', 'light', UnifiedModelPickerView],
  ['Android', 'dark', UnifiedModelPickerView],
  ['iOS', 'light', IosModelPickerView],
  ['iOS', 'dark', IosModelPickerView],
] as const)('shows add/remove favorite states on %s in %s mode while retaining source settings', async (_platform, mode, Component) => {
  theme.mode = mode;
  const row = {
    key: 'model', entry: { capabilities: { codex: { efforts: [] } } },
    config: { agent: 'codex' },
  };
  const render = async (isFavorite: boolean | undefined, favorite = false) => {
    await act(async () => root.render(createElement(Component, {
      visible: true, groups: [], filters: [], query: '',
      options: { row: { ...row, favorite: favorite ? { uid: 'saved' } : undefined }, agents: ['codex'], isFavorite, canReset:true },
    } as any)));
  };
  const fill = () => host.querySelector('[data-star-fill]')?.getAttribute('data-star-fill');
  await render(false);
  expect(fill()).toBe('none');
  expect(host.textContent).toContain('models.unified.favoriteConfiguration');
  await render(true);
  const color = host.querySelector('[data-star-fill]')?.getAttribute('data-star-color');
  expect(color).toBeTruthy();
  expect(fill()).toBe(color);
  expect(host.textContent).toContain('models.unified.savedConfiguration');
  expect(host.textContent).toContain('models.unified.restoreRecommended');
  await render(false);
  expect(fill()).toBe('none');
  expect(host.textContent).toContain('models.unified.favoriteConfiguration');
  await render(undefined, true);
  expect(fill()).toBe(color);
  expect(host.textContent).toContain('models.unified.savedConfiguration');
});

it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'separates recommendation status, reset and explicit favorite editing on %s', async (_platform, Component) => {
    const row={key:'model',entry:{displayName:'Model',capabilities:{codex:{efforts:[]}}},config:{agent:'codex',effort:'high',fast:false},providerMark:{}};
    const render=async(extra:Record<string,unknown>)=>act(async()=>root.render(createElement(Component,{
      visible:true,testID:'modelSheet',title:'Model',query:'',filter:'all',groups:[],filters:[],
      options:{row,agents:['codex'],isFavorite:true,configurationSummary:'Codex · high',...extra},
    } as any)));
    await render({canReset:false});
    expect(host.textContent).toContain('models.unified.usingRecommended');
    expect(host.textContent).not.toContain('models.unified.restoreRecommended');
    expect(host.textContent).toContain('models.unified.savedConfiguration');
    await render({canReset:true,onEditFavorite:vi.fn()});
    expect(host.textContent).toContain('models.unified.customized');
    expect(host.textContent).toContain('models.unified.restoreRecommended');
    expect(host.textContent).toContain('models.unified.resetScopeHint');
    expect(host.textContent).toContain('models.unified.editFavorite');
    await render({canReset:true,editingFavorite:true});
    expect(host.textContent).toContain('models.unified.editFavoriteHint');
    expect(host.textContent).toContain('models.unified.saveFavorite');
    expect(host.textContent).toContain('models.unified.cancelEdit');
    expect(host.textContent).not.toContain('models.unified.restoreRecommended');
    expect(host.textContent).not.toContain('models.unified.savedConfiguration');
  },
);

it.each([
  ['Android', UnifiedModelPickerView, 'modelSheet.scroll', 'modelSheet.list.scroll'],
  ['iOS', IosModelPickerView, 'modelSheet.list', 'modelSheet.list'],
] as const)('retains the long list and its scroll position when returning from details on %s', async (_platform, Component, listId, hiddenListId) => {
  const rows = Array.from({length:60}, (_, i) => ({
    key:`model-${i}`, entry:{displayName:`Model ${i}`, capabilities:{codex:{efforts:[]}}},
    config:{agent:'codex'}, subtitle:'Provider', providerMark:{},
  }));
  const props = {
    visible:true, testID:'modelSheet', title:'Models', query:'Model', filter:'provider',
    filters:[{id:'provider',label:'Provider'}], groups:[{key:'provider',title:'Provider',rows}],
    onClose:vi.fn(),
  };
  const render = (options?: any) => root.render(createElement(Component, {
    ...props, options, onBack:options ? () => render() : undefined,
  } as any));
  await act(async () => render());
  const list = host.querySelector(`[data-testid="${listId}"]`) as HTMLElement;
  expect(list).not.toBeNull();
  list.scrollTop = 960;
  virtualList.scrollToOffset.mockClear();
  const listChildren = [...list.childNodes];
  for (const row of [rows[35], rows[40]]) {
    await act(async () => render({row, agents:['codex']}));
    expect(host.querySelector(`[data-testid="${hiddenListId}"]`)).toBe(list);
    expect([...list.childNodes]).toEqual(listChildren);
    expect(list.closest('[aria-hidden="true"]')).not.toBeNull();
    const back = host.querySelector('button[aria-label="models.picker.backToModels"]') as HTMLButtonElement;
    expect(back).not.toBeNull();
    await act(async () => back.click());
    expect(host.querySelector(`[data-testid="${listId}"]`)).toBe(list);
    expect(list.scrollTop).toBe(960);
    expect(virtualList.scrollToOffset).not.toHaveBeenCalled();
    expect(list.closest('[aria-hidden="true"]')).toBeNull();
  }
  const sources = host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement;
  await act(async () => sources.click());
  expect(host.querySelector(`[data-testid="${hiddenListId}"]`)).toBe(list);
  expect(list.closest('[aria-hidden="true"]')).not.toBeNull();
  const back = host.querySelector('button[aria-label="models.picker.backToModels"], button[aria-label="shared.back"]') as HTMLButtonElement;
  await act(async () => back.click());
  expect(host.querySelector(`[data-testid="${listId}"]`)).toBe(list);
  expect(list.scrollTop).toBe(960);
  expect(list.closest('[aria-hidden="true"]')).toBeNull();
});

// Unit, 2026-11-18 decision. Each platform must render the reason supplied
// for a single remote copy on both the source and model rows.
it.each([
  ['Android', UnifiedModelPickerView],
  ['iOS', IosModelPickerView],
] as const)('lists each other computer as its own source block on %s', async (_platform, Component) => {
  const remote = (deviceId: string, deviceName: string, providerLabel: string) => ({
    id: `remote:${deviceId}:${providerLabel}`,
    label: `${providerLabel} · ${deviceName}`,
    providerMark: { name: providerLabel },
    remote: { deviceId, deviceName, providerLabel },
  });
  const filters = [
    { id: 'all', label: 'All' },
    { id: 'account', label: 'Local Provider', providerMark: { name: 'Local Provider' } },
    { ...remote('studio', 'Studio Mac', 'Claude Sub'), sourceUnavailableReason: 'Claude Sub on Home Mac is unavailable' },
    remote('office', 'Office PC', 'Codex Sub'),
    remote('studio', 'Studio Mac', 'OpenRouter'),
  ];
  const onFilter = vi.fn();
  await act(async () => root.render(createElement(Component, {
    visible: true, testID: 'modelSheet', title: 'Models', query: '', filter: 'all', filters, groups: [], onFilter,
  } as any)));
  const sourceButton = host.querySelector('button[aria-label="models.unified.source"]') as HTMLButtonElement;
  await act(async () => sourceButton.click());
  const text = host.textContent ?? '';
  // 每台电脑一块,块标题是电脑名;块里的行只写供应商名。
  expect(text).toContain('Studio Mac');
  expect(text).toContain('Office PC');
  expect(text.indexOf('Local Provider')).toBeLessThan(text.indexOf('Studio Mac'));
  expect(text.indexOf('Studio Mac')).toBeLessThan(text.indexOf('Claude Sub'));
  expect(text.indexOf('OpenRouter')).toBeLessThan(text.indexOf('Office PC'));
  expect(text).not.toContain('Claude Sub · Studio Mac');
  expect(host.querySelector('[data-testid="modelSheet.source.remote:studio:Claude Sub"]')?.textContent)
    .toContain('Claude Sub on Home Mac is unavailable');
  // 其他电脑的供应商图标带远程标记,本机的不带。
  expect(host.querySelectorAll('[data-remote-mark]')).toHaveLength(3);
});

it.each([
  ['Android', UnifiedModelPickerView],
  ['iOS', IosModelPickerView],
] as const)('marks model rows from another computer on %s', async (_platform, Component) => {
  const row = (key: string, remoteDevice?: { deviceId: string; name: string }) => ({
    key, entry: { displayName: key, capabilities: { codex: { efforts: [] } } },
    config: { agent: 'codex' }, subtitle: '', providerMark: {}, ...(remoteDevice ? { remoteDevice } : {}),
  });
  await act(async () => root.render(createElement(Component, {
    visible: true, testID: 'modelSheet', title: 'Models', query: '', filter: 'all', filters: [],
    groups: [
      { key: 'account', title: 'Local Provider', rows: [row('local')] },
      { key: 'remote', title: 'Claude Sub · Studio Mac', rows: [{
        ...row('remote', { deviceId: 'studio', name: 'Studio Mac' }),
        sourceUnavailableReason: 'Claude Sub on Home Mac is unavailable',
      }] },
    ],
  } as any)));
  expect(host.textContent).toContain('Claude Sub · Studio Mac');
  expect(host.querySelectorAll('[data-remote-mark]')).toHaveLength(1);
  expect(host.querySelector('[data-testid="modelSheet.model.remote"]')?.textContent)
    .toContain('Claude Sub on Home Mac is unavailable');
});

it('keeps selection errors visible in the retained native root list', async () => {
  await act(async () => root.render(createElement(IosModelPickerView, {
    visible:true, testID:'modelSheet', query:'', filters:[], groups:[], error:'Save failed',
  } as any)));
  const list = host.querySelector('[data-testid="modelSheet.list"]');
  expect(list?.textContent).toContain('Save failed');
});

it.each(["query", "filter"])(
  "returns to the first result when %s changes after scrolling",
  async (field) => {
    const props = {
      visible: true,
      groups: [],
      filters: [],
      query: "",
      filter: "all",
      emptyHint: "No results",
    };
    await act(async () =>
      root.render(createElement(UnifiedModelPickerView, props as any)),
    );
    virtualList.scrollToOffset.mockClear();
    await act(async () =>
      root.render(
        createElement(UnifiedModelPickerView, {
          ...props,
          [field]: "changed",
        } as any),
      ),
    );
    expect(virtualList.scrollToOffset).toHaveBeenCalledWith({
      offset: 0,
      animated: false,
    });
    expect(host.textContent).toContain("No results");
  },
);

// Integration: chosen design C exposes reset warnings once per source and lets
// a tap reach account details, without selecting a model or changing its route.
it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'opens account details from the source average and reset warning on %s', async (_platform, Component) => {
    const quota = {remaining:57,summary:'Average 57%',resetSoon:true,reset:{remaining:80,time:'6h',level:'crit'},resetParts:['',' 后重置'],resetDescription:'Resets in 6h · Remaining 80%',label:'Account A 34% · Account B 80% · resets in 6h',
      members:[{remaining:34,label:'Account A 34%'},{remaining:80,label:'Account B 80%'}]};
    const onSelect=vi.fn(), onFilter=vi.fn();
    await act(async()=>root.render(createElement(Component, {
      visible:true,testID:'modelSheet',query:'',filter:'anthropic',onClose:vi.fn(),onSelect,onFilter,
      filters:[{id:'anthropic',label:'Anthropic',providerMark:{providerId:'anthropic'},quota}],
      groups:[{key:'anthropic',title:'Anthropic',quota,rows:[]}],
    } as any)));
    const button=host.querySelector('button[aria-label="Average 57% · models.unified.quotaResetSoon · Resets in 6h · Remaining 80%"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('80%6h 后重置');
    expect(button.textContent).not.toContain('models.unified.quotaResetSoon');
    expect(button.textContent).not.toContain('Average');
    expect(button.textContent).toContain('57%');
    await act(async()=>button.click());
    expect(host.querySelectorAll('[data-quota="80"]')).toHaveLength(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onFilter).not.toHaveBeenCalled();
  },
);

// Regression: opening a long catalog used to leave the selected model offscreen.
// Existing view tests only exercised row contents. Unit tier: late rows, refresh,
// and reopen through the production view, asserting the native list scroll command.
it('locates a late selected model once per opening without snapping back on refresh', async () => {
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  virtualList.scrollToIndex.mockClear();
  const row = { key: 'selected', selected: true, entry: { displayName: 'Selected', capabilities: {} }, config: { agent: 'codex' } };
  const render = (visible: boolean, rows: any[]) => act(() => root.render(createElement(UnifiedModelPickerView, {
    visible, groups: [{ key: 'provider', title: 'Provider', rows }], filters: [], query: '', filter: 'all',
  } as any)));
  const flush = () => act(() => { frames.splice(0).forEach(callback => callback(0)); });
  try {
    render(true, []);
    flush();
    expect(virtualList.scrollToIndex).not.toHaveBeenCalled();
    render(true, [{ ...row, key: 'first', selected: false }, row]);
    flush();
    expect(virtualList.scrollToIndex).toHaveBeenLastCalledWith({ index: 2, viewPosition: 0.5, animated: false });
    render(true, [{ ...row, key: 'first', selected: false }, { ...row }]);
    flush();
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(1);
    render(false, [row]);
    flush();
    render(true, [row]);
    flush();
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(2);
  } finally { vi.unstubAllGlobals(); }
});

// Native boundary: the Form must receive a unique group + row target, even
// when a favorite and provider entry share a model key. Native motion needs device verification.
it('passes the first selected row target to the iOS form after late data', () => {
  const row = { key: 'same-model', selected: true, entry: { displayName: 'Selected', capabilities: {} }, config: { agent: 'codex' } };
  const render = (groups: any[]) => act(() => root.render(createElement(IosModelPickerView, {
    visible: true, testID: 'picker', groups, filters: [], query: '',
  } as any)));
  render([]);
  expect(host.querySelector('[data-initial-scroll]')).toBeNull();
  render([{ key: 'favorites', rows: [row] }, { key: 'provider', rows: [row] }]);
  expect(host.querySelector('[data-testid="picker.list"]')?.getAttribute('data-initial-scroll')).toBe('favorites:same-model');
});

// PR #10552 / review r4573357542: exercise the real view's native callback
// boundary for an unmeasured target outside the first render window. Previously
// the FlatList stub discarded failure/layout/drag callbacks, so compensation,
// its bound, and cancellation could all break unnoticed. Unit tier; fake time.
function mountUnmeasuredModelTarget() {
  vi.useFakeTimers();
  let measured = false;
  let landedIndex: number | null = null;
  const rows = Array.from({ length: 40 }, (_, index) => ({
    key: `model-${index}`, selected: index === 39,
    entry: { displayName: `Model ${index}`, capabilities: {} }, config: { agent: 'codex' },
  }));
  const props = {
    visible: true, groups: [{ key: 'provider', title: 'Provider', rows }],
    filters: [], query: '', filter: 'all', onQuery: vi.fn(),
  };
  const render = (visible = true) => act(() => root.render(createElement(UnifiedModelPickerView, { ...props, visible } as any)));
  virtualList.scrollToIndex.mockImplementation(({ index }) => {
    if (measured) landedIndex = index;
    else virtualList.props.onScrollToIndexFailed({ index, averageItemLength: 60, highestMeasuredFrameIndex: 7 });
  });
  render();
  const tick = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  tick(20); // First animation frame: target is outside the measured window.
  return {
    render, tick, onQuery: props.onQuery,
    measure: () => { measured = true; },
    landed: () => landedIndex,
    cleanup: () => { act(() => root.render(null)); vi.useRealTimers(); },
  };
}

it.each(['timer', 'content-size'] as const)('reaches the initially unmeasured selected row after %s recovery', trigger => {
  const picker = mountUnmeasuredModelTarget();
  try {
    expect(picker.landed()).toBeNull();
    expect(virtualList.scrollToOffset).toHaveBeenLastCalledWith({ offset: 2400, animated: false });
    picker.measure();
    if (trigger === 'timer') picker.tick(50);
    else act(() => virtualList.props.onContentSizeChange(400, 3000));
    expect(picker.landed()).toBe(40);
    const attempts = virtualList.scrollToIndex.mock.calls.length;
    picker.tick(1000);
    act(() => virtualList.props.onContentSizeChange(400, 3100));
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(attempts);
  } finally { picker.cleanup(); }
});

it('stops compensation after five failed recovery attempts', () => {
  const picker = mountUnmeasuredModelTarget();
  try {
    picker.tick(1000);
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(6); // Initial try + five recoveries.
    expect(picker.landed()).toBeNull();
    const offsets = virtualList.scrollToOffset.mock.calls.length;
    picker.measure();
    act(() => virtualList.props.onContentSizeChange(400, 3000));
    picker.tick(1000);
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(6);
    expect(virtualList.scrollToOffset).toHaveBeenCalledTimes(offsets);
    expect(picker.landed()).toBeNull();
  } finally { picker.cleanup(); }
});

it.each(['drag', 'search', 'close'] as const)('keeps pending compensation cancelled after %s', cancel => {
  const picker = mountUnmeasuredModelTarget();
  try {
    if (cancel === 'drag') act(() => virtualList.props.onScrollBeginDrag());
    else if (cancel === 'search') act(() => {
      const search = host.querySelector('input[aria-label="Model search"]') as HTMLInputElement;
      search.value = 'another';
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    else picker.render(false);
    if (cancel === 'search') expect(picker.onQuery).toHaveBeenCalledWith('another');
    picker.measure();
    const attempts = virtualList.scrollToIndex.mock.calls.length;
    const offsets = virtualList.scrollToOffset.mock.calls.length;
    act(() => virtualList.props.onContentSizeChange(400, 3000));
    picker.tick(1000);
    expect(virtualList.scrollToIndex).toHaveBeenCalledTimes(attempts);
    expect(virtualList.scrollToOffset).toHaveBeenCalledTimes(offsets);
    expect(picker.landed()).toBeNull();
  } finally { picker.cleanup(); }
});

// model-groups.md §6.2, user 2026-11-20「漏了补全客户端」: the host's model groups are one section at the top of the
// phone picker on both platforms. Production entry: the platform views. Observable: group rows with their hint,
// the current one selected, a tap reports the group id. Minimal input: one group row. tier: unit (jsdom).
it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'lists the host computer\'s model groups above the models on %s', async (_platform, Component) => {
    const onSelect = vi.fn();
    await act(async () => root.render(createElement(Component, {
      visible: true, testID: 'picker', query: '', filter: 'all', groups: [], filters: [],
      modelGroups: { title: 'Model groups', rows: [{ id: 'night', title: 'Night', subtitle: '2 sources · In order', selected: true }], onSelect },
    } as any)));
    expect(host.textContent).toContain('Model groups');
    expect(host.textContent).toContain('2 sources · In order');
    expect(host.textContent).not.toContain('models.picker.noResults');
    const row = host.querySelector('[data-testid="picker.modelGroup.night"]')
      ?? [...host.querySelectorAll('button')].find(node => node.textContent?.includes('Night'));
    await act(async () => (row as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith('night');
  },
);

// 生产入口：Android(UnifiedModelPickerView) 与 iOS(UnifiedModelPickerView.ios)；
// 可观察结果：Antigravity 多配额分组在双端分组头内联分开显示 Gemini 与 Claude & GPT（与内置分组头一致，不画多余进度条），
// 且各模型行分别渲染所属配额池的 quotaLabel。
// 规则依据：用户需求「Gemini 与其他模型分开显示，参照其他模型风格」与双端一致性。
// 最小失败输入与 tier：unit(jsdom)，任一端未分开显示 Gemini/Claude & GPT 或漏渲染行级 quotaLabel。
it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'renders separate Gemini and Claude & GPT quota in header and model rows for Antigravity on %s', async (_platform, Component) => {
    await act(async () => root.render(createElement(Component, {
      visible: true,
      testID: 'picker',
      title: 'Models',
      query: '',
      filter: 'all',
      filters: [{ id: 'all', label: 'All' }],
      groups: [],
      pluginEngines: {
        onSelect: vi.fn(),
        groups: [
          {
            key: 'plugin-engine:acp-plugin:agy:agy',
            providerId: 'acp-plugin:agy:agy',
            title: 'Antigravity',
            quota: {
              summary: 'Gemini 57% · Claude & GPT 24%',
              level: 'warn',
              accessibilityLabel: 'Gemini · 57% · 1h · Claude & GPT · 24% · 4d',
              isMultiGroup: true,
              groups: [
                {
                  id: 'label:gemini models',
                  label: 'Gemini',
                  remaining: 57,
                  level: 'normal',
                  reset: '1h',
                  summary: '57% · 1h',
                  accessibilityLabel: 'Gemini · 57% · 1h',
                },
                {
                  id: 'label:claude and gpt models',
                  label: 'Claude & GPT',
                  remaining: 24,
                  level: 'warn',
                  reset: '4d',
                  summary: '24% · 4d',
                  accessibilityLabel: 'Claude & GPT · 24% · 4d',
                },
              ],
            },
            rows: [
              {
                key: 'acp-plugin:agy:agy#gemini-4-neon',
                providerId: 'acp-plugin:agy:agy',
                modelId: 'gemini-4-neon',
                title: 'Gemini 4 Neon',
                quotaLabel: '1h · 57%',
                effort: null,
                efforts: [],
                effortLabel: '',
                selected: false,
                disabled: false,
              },
              {
                key: 'acp-plugin:agy:agy#claude-sonnet-5-5',
                providerId: 'acp-plugin:agy:agy',
                modelId: 'claude-sonnet-5-5',
                title: 'Claude Sonnet 5.5',
                quotaLabel: '4d · 24%',
                effort: null,
                efforts: [],
                effortLabel: '',
                selected: false,
                disabled: false,
              },
            ],
          },
          {
            key: 'plugin-engine:acp-plugin:dsh:dsh',
            providerId: 'acp-plugin:dsh:dsh',
            title: 'DeepSeek Harness',
            quota: {
              summary: '64% · 2h',
              level: 'normal',
              accessibilityLabel: 'Weekly · 64% · 2h',
              remaining: 64,
              groups: [
                {
                  id: 'default',
                  label: 'Weekly',
                  remaining: 64,
                  level: 'normal',
                  reset: '2h',
                  summary: '64% · 2h',
                  accessibilityLabel: 'Weekly · 64% · 2h',
                },
              ],
            },
            rows: [
              {
                key: 'acp-plugin:dsh:dsh#v4',
                providerId: 'acp-plugin:dsh:dsh',
                modelId: 'v4',
                title: 'DeepSeek V4',
                effort: null,
                efforts: [],
                effortLabel: '',
                selected: false,
                disabled: false,
              },
            ],
          },
        ],
      },
    } as any)));

    expect(host.querySelectorAll('[data-quota]')).toHaveLength(0);
    expect(host.textContent).toContain('Gemini');
    expect(host.textContent).toContain('57%');
    expect(host.textContent).toContain('Claude & GPT');
    expect(host.textContent).toContain('24%');
    expect(host.textContent).toContain('1h · 57%');
    expect(host.textContent).toContain('4d · 24%');
    expect(host.textContent).toContain('64% · 2h');
  },
);

// 生产入口：Android(UnifiedModelPickerView) 与 iOS(UnifiedModelPickerView.ios)；
// 可观察结果：两端都在「收藏」分组渲染插件引擎收藏行、在插件引擎行上提供配置入口、并渲染 pluginEngineOptions 收藏页。
// 规则依据：protocol-compatibility/plugin-harnesses.md「插件引擎模型收藏」与双端一致性。
// 最小失败输入与 tier：unit(jsdom)，任一端漏渲染收藏行或漏接 pluginEngineOptions.onFavorite。
it.each([['Android', UnifiedModelPickerView], ['iOS', IosModelPickerView]] as const)(
  'renders plugin engine favorites and pluginEngineOptions page on %s', async (_platform, Component) => {
    const onSelect = vi.fn();
    const onOptions = vi.fn();
    const onFavorite = vi.fn();
    const favRow = {
      key: 'fav-1',
      providerId: 'acp-plugin:dsh:dsh',
      modelId: 'pro',
      title: 'Pro',
      subtitle: 'DeepSeek Harness',
      engineName: 'DeepSeek Harness',
      effort: 'max' as const,
      efforts: ['low', 'high', 'max'] as ('low' | 'high' | 'max')[],
      effortLabel: 'Max',
      selected: false,
      disabled: false,
      favorite: { uid: 'fav-1', providerId: 'acp-plugin:dsh:dsh', modelId: 'pro', agent: 'claude-code' as const, effort: 'max', fast: false },
    };
    await act(async () => root.render(createElement(Component, {
      visible: true, testID: 'picker', query: '', filter: 'favorites', filters: [],
      groups: [{ key: 'favorites', title: 'Favorites', rows: [], items: [{ kind: 'pluginEngine', row: favRow }] }],
      pluginEngines: { groups: [], onSelect, onOptions },
    } as any)));
    expect(host.textContent).toContain('Favorites');
    expect(host.textContent).toContain('Pro');
    expect(host.textContent).toContain('DeepSeek Harness');
    const rowEl = host.querySelector('[data-testid="picker.pluginEngine.fav-1"]')
      ?? [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('Pro'));
    await act(async () => (rowEl as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith(favRow);

    await act(async () => root.render(createElement(Component, {
      visible: true, testID: 'picker', query: '', filter: 'all', filters: [], groups: [],
      pluginEngineOptions: {
        row: favRow,
        context: 'DeepSeek Harness',
        effort: 'max',
        efforts: ['low', 'high', 'max'],
        onChangeEffort: vi.fn(),
        favoritesDisabled: false,
        isFavorite: false,
        configurationSummary: 'DeepSeek Harness · Max',
        editingFavorite: false,
        onFavorite,
      },
    } as any)));
    const favBtn = host.querySelector('[data-testid="picker.favorite"]')
      ?? [...host.querySelectorAll('button')].find((node) => node.textContent?.includes('models.unified.favoriteConfiguration'));
    expect(favBtn).toBeTruthy();
    await act(async () => (favBtn as HTMLElement).click());
    expect(onFavorite).toHaveBeenCalledOnce();
  },
);
