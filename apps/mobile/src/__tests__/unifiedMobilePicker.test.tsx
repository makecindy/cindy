// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelPickerSheet } from '@/session/UnifiedModelPickerSheet';
vi.mock('expo-crypto', () => ({ randomUUID: () => 'test-uuid' }));
const test = vi.hoisted(() => ({ view: null as any, favoritesReady:true, quotas:{} as any, syncError:null as unknown, prefs: {favorites:[],engines:{}} as any, save: vi.fn(), entries: [] as any[] }));
vi.mock('@/session/UnifiedModelPickerView', () => ({ UnifiedModelPickerView: (p:any) => {test.view=p;return null;} }));
vi.mock('@/session/useMobileModelQuotas',()=>({useMobileModelQuotas:()=>({quotas:test.quotas,now:0})}));
vi.mock('@/session/mobileModelPreferences', async () => {
  const {useReducer} = await import('react');
  return {useMobileModelPreferences:()=>{
    const [,refresh] = useReducer(value => value + 1, 0);
    return {ready:true,favoritesReady:test.favoritesReady,error:test.syncError,value:test.prefs,
      save:async (value:typeof test.prefs)=>{await test.save(value);refresh();}};
  }};
});
vi.mock('@/session/providerModelSections', () => ({buildMobileModelSections:()=>({activeSourceId:'account'})}));
vi.mock('@/session/draftModelMemory',()=>({useDraftModelMemoryVersion:()=>0}));
vi.mock('@/session/sessionModelMirror',()=>({useSessionModelMirrorVersion:()=>0}));
vi.mock('@/session/modelPickerRows',()=>({budgetRowDisabled:()=>false,presentPickerPrice:()=>null}));
vi.mock('@/session/unifiedMobileModels',async importOriginal=>({...await importOriginal<any>(),mobileUnifiedEntries:()=>test.entries}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;
beforeEach(()=>{test.favoritesReady=true;test.syncError=null;test.quotas={};test.save.mockReset().mockImplementation(async value => {test.prefs=value;});test.prefs={favorites:[],engines:{}};test.entries=[{
  providerId:'account',modelId:'model',displayName:'Model',candidates:['codex','claude-code'],recommended:'codex',nativeAgent:'codex',
  capabilities:{codex:{wireModelId:'codex/model',efforts:['medium','high'],defaultEffort:'medium',supportsFastMode:true,contextWindow:200000},
  'claude-code':{wireModelId:'model',efforts:['medium','high'],defaultEffort:'medium',supportsFastMode:false,contextWindow:200000}},
}];root=createRoot(document.createElement('div'));});
afterEach(()=>act(()=>root.unmount()));
async function mount(onSelect=vi.fn(async()=>true),extra={}) {
  const onClose=vi.fn();
  await act(async()=>root.render(createElement(UnifiedModelPickerSheet,{
    visible:true,onClose,providers:[{id:'account',name:'Provider',models:{},connected:true}],agentKind:'codex',capabilities:{hasFastMode:true},
    activeModelId:'codex/model',selectedProviderId:'account',selectedEffort:'medium',selectedFastMode:false,
    existingSessionRoute:true,modelMemory:{getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn()},
    unified:{scope:'user-device',agents:['codex','claude-code'],loadCapabilities:async()=>({hasFastMode:true}),onSelect},...extra,
  } as any)));
  return {onSelect,onClose};
}
it('keeps the sheet and preferences unchanged after cancelled selection',async()=>{
  const {onClose}=await mount(vi.fn(async()=>false));
  await act(async()=>test.view.onSelect(test.view.groups[0].rows[0]));
  expect(onClose).not.toHaveBeenCalled();expect(test.save).not.toHaveBeenCalled();
});
it('only closes after selection succeeds and passes the full wire configuration',async()=>{
  const {onSelect,onClose}=await mount();
  await act(async()=>test.view.onSelect(test.view.groups[0].rows[0]));
  expect(onSelect).toHaveBeenCalledWith({providerId:'account',modelId:'codex/model',agent:'codex',effort:'medium',fast:false});
  expect(onClose).toHaveBeenCalledOnce();
});
it('shows favorites before recommendations, with selected mark only on the model',async()=>{
  test.prefs.favorites=[{uid:'fav',providerId:'account',modelId:'codex/model',agent:'codex',effort:'high',fast:true}];
  await mount();expect(test.view.groups.map((g:any)=>g.key)).toEqual(['favorites','recommended']);
  expect(test.view.groups[0].rows[0].selected).toBe(false);
  expect(test.view.groups[0].rows[0].config).toMatchObject({effort:'high',fast:true});
  expect(test.view.groups[1].rows[0].selected).toBe(true);
});
it('edits a favorite only through explicit editing and save, without changing the current task',async()=>{
  test.prefs.favorites=[{uid:'fav',providerId:'account',modelId:'codex/model',agent:'codex',effort:'high',fast:false}];
  const {onSelect}=await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onEditFavorite());
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'medium'}));
  expect(test.save).not.toHaveBeenCalled();
  await act(async()=>test.view.options.onSaveEdit());
  expect(onSelect).not.toHaveBeenCalled();expect(test.save).toHaveBeenCalledWith(expect.objectContaining({favorites:[expect.objectContaining({uid:'fav',effort:'medium'})]}));
});
it('does not save an engine override when applying the selected row is cancelled',async()=>{
  await mount(vi.fn(async()=>false));
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,agent:'claude-code',modelId:'model'}));
  expect(test.save).not.toHaveBeenCalled();
});
it('surfaces write errors and leaves the sheet open',async()=>{
  const {onClose}=await mount(vi.fn(async()=>{throw new Error('offline');}));
  await act(async()=>test.view.onSelect(test.view.groups[0].rows[0]));
  expect(test.view.error).toBe('models.unified.saveFailed');expect(onClose).not.toHaveBeenCalled();
});
it('search spans all sources and clearing preserves the selected filter',async()=>{
  await mount();await act(async()=>test.view.onFilter('favorites'));expect(test.view.groups).toHaveLength(0);
  await act(async()=>test.view.onQuery('Model'));expect(test.view.groups).toHaveLength(1);
  await act(async()=>test.view.onQuery(''));expect(test.view.groups).toHaveLength(0);expect(test.view.filter).toBe('favorites');
});

it('preserves remote provider branding in model rows and source choices',async()=>{
  await mount(undefined,{providers:[{id:'account',name:'OpenAI · account',models:{},connected:true,logoKind:'openai'}]});
  expect(test.view.groups[0].rows[0].providerMark).toMatchObject({providerId:'account',name:'OpenAI · account',logoKind:'openai'});
  expect(test.view.filters.find((item:any)=>item.id==='account').providerMark).toMatchObject({logoKind:'openai'});
});

it('attaches account remaining quota only to the matching source filter',async()=>{
  test.quotas={account:{remaining:37,resetsAt:3600},other:{remaining:99,resetsAt:7200}};
  await mount();
  expect(test.view.filters.find((item:any)=>item.id==='account').quota).toMatchObject({remaining:37});
  expect(test.view.filters.filter((item:any)=>item.id==='all'||item.id==='favorites').every((item:any)=>item.quota===undefined)).toBe(true);
});
it('does not show an empty or full quota bar when account quota is unknown',async()=>{
  await mount();
  expect(test.view.filters.find((item:any)=>item.id==='account').quota).toBeUndefined();
});

it('silences background favorite sync failures',async()=>{
  test.syncError=new Error('offline');
  await mount();
  expect(test.view.error).toBeNull();
});

it('puts only a compact countdown and remaining percentage in the model quota line',async()=>{
  test.quotas={account:{remaining:40,resetsAt:273600,source:'claude',raw:{sevenDay:{utilization:60,resetsAt:273600}}}};
  await mount();
  const row=test.view.groups[0].rows[0];
  expect(row.quotaLabel).toBe('4models.unified.timeUnit.day · 40%');
  expect(row.effortLabel).toBe('models.options.effortLevels.medium');
});

it('keeps model selection and settings usable when an old host lacks favorites',async()=>{
  test.favoritesReady=false;
  test.syncError=new Error('CHANNEL_NOT_ALLOWED');
  const {onSelect,onClose}=await mount();
  expect(test.view.busy).toBe(false);
  expect(test.view.filters.some((f:any)=>f.id==='favorites')).toBe(false);
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  expect(test.view.options.favoritesDisabled).toBe(true);
  await act(async()=>test.view.options.onFavorite());
  expect(test.save).not.toHaveBeenCalled();
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({effort:'high'}));
  await act(async()=>test.view.onSelect(test.view.options.row));
  expect(onClose).toHaveBeenCalled();
  expect(test.view.error).toBeNull();
});

it('preserves search and source filtering when returning from model details', async () => {
  await mount();
  await act(async () => test.view.onFilter('account'));
  await act(async () => test.view.onQuery('Model'));
  const groups = test.view.groups;
  await act(async () => test.view.onOptions(groups[0].rows[0]));
  await act(async () => test.view.onBack());
  expect(test.view.options).toBeUndefined();
  expect(test.view.query).toBe('Model');
  expect(test.view.filter).toBe('account');
  expect(test.view.groups).toEqual(groups);
});

it('adds and removes a favorite in place only after saving, without changing the current configuration', async () => {
  let finishSave!: () => void;
  test.save.mockImplementation(value => new Promise<void>(resolve => {
    finishSave = () => {
      // The host, rather than the phone, assigns the persisted favorite UID.
      test.prefs = { ...value, favorites: value.favorites.map((item: any) => ({ ...item, uid: 'remote-saved' })) };
      resolve();
    };
  }));
  const { onSelect, onClose } = await mount(undefined, {selectedEffort:'high', selectedFastMode:true});
  await act(async () => test.view.onOptions(test.view.groups[0].rows[0]));
  const source = test.view.options.row;
  await act(async () => test.view.options.onFavorite());
  expect(test.view.busy).toBe(true);
  expect(test.view.options.isFavorite).toBe(false);
  await act(async () => test.view.options.onFavorite());
  expect(test.save).toHaveBeenCalledTimes(1);
  expect(test.save).toHaveBeenCalledWith(expect.objectContaining({
    favorites: [expect.objectContaining({ ...source.config, modelId: source.entry.modelId })],
  }));
  await act(async () => finishSave());
  expect(test.view.busy).toBe(false);
  expect(test.view.options.isFavorite).toBe(true);
  expect(test.view.options.row).toEqual(source);
  expect(test.view.groups[0].rows[0].favorite.uid).toBe('remote-saved');
  await act(async () => test.view.options.onFavorite());
  expect(test.view.busy).toBe(true);
  expect(test.view.options.isFavorite).toBe(true);
  expect(test.save).toHaveBeenLastCalledWith(expect.objectContaining({ favorites: [] }));
  await act(async () => finishSave());
  expect(test.view.options.isFavorite).toBe(false);
  expect(test.view.options.row).toEqual(source);
  expect(onSelect).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it.each([false, true])('preserves favorite state after a failed toggle and allows retry (saved=%s)', async saved => {
  if (saved) test.prefs.favorites = [{ uid: 'existing', providerId: 'account', modelId: 'model', agent: 'codex', effort: 'medium', fast: false }];
  test.save.mockRejectedValueOnce(new Error('offline'));
  await mount();
  await act(async () => test.view.onOptions(test.view.groups.find((g:any) => g.key === 'recommended').rows[0]));
  await act(async () => test.view.options.onFavorite());
  expect(test.view.error).toBe('models.unified.saveFailed');
  expect(test.view.busy).toBe(false);
  expect(test.view.options.isFavorite).toBe(saved);
  await act(async () => test.view.options.onFavorite());
  expect(test.view.error).toBeNull();
  expect(test.view.options.isFavorite).toBe(!saved);
});

it.each(['model', 'codex/model'])('recognizes an existing favorite with ID %s and removes only the matching configuration', async modelId => {
  const matching = { uid: 'existing', providerId: 'account', modelId, agent: 'codex', effort: 'medium', fast: false };
  const others = [
    { ...matching, uid: 'other-effort', effort: 'high' },
    { ...matching, uid: 'other-fast', fast: true },
    { ...matching, uid: 'other-provider', providerId: 'other' },
    { ...matching, uid: 'other-model', modelId: 'other' },
    { ...matching, uid: 'other-agent', agent: 'claude-code' },
    { ...matching, uid: 'unsupported-effort', effort: 'max' },
  ];
  test.prefs.favorites = [...others, matching];
  await mount();
  await act(async () => test.view.onOptions(test.view.groups[1].rows[0]));
  expect(test.view.options.isFavorite).toBe(true);
  await act(async () => test.view.options.onFavorite());
  expect(test.prefs.favorites).toEqual(others);
  expect(test.view.options.isFavorite).toBe(false);
});

it('updates favorite state after changing the displayed effort or Fast without editing existing copies', async () => {
  const saved = { uid: 'existing', providerId: 'account', modelId: 'model', agent: 'codex', effort: 'high', fast: true };
  test.prefs.favorites = [saved];
  await mount();
  await act(async () => test.view.onOptions(test.view.groups[1].rows[0]));
  expect(test.view.options.isFavorite).toBe(false);
  await mount(undefined, { selectedEffort: 'high', selectedFastMode: true });
  expect(test.view.options.isFavorite).toBe(true);
  await mount(undefined, { selectedEffort: 'high', selectedFastMode: false });
  expect(test.view.options.isFavorite).toBe(false);
  await act(async () => test.view.options.onFavorite());
  expect(test.prefs.favorites).toEqual([saved, expect.objectContaining({ effort: 'high', fast: false })]);
  expect(test.view.options.isFavorite).toBe(true);
});

it('reflects persisted favorite state after reopening the source details', async () => {
  await mount();
  const source = test.view.groups[0].rows[0];
  await act(async () => test.view.onOptions(source));
  await act(async () => test.view.options.onFavorite());
  await act(async () => test.view.onBack());
  await act(async () => test.view.onOptions(source));
  expect(test.view.options.isFavorite).toBe(true);
  await act(async () => test.view.options.onFavorite());
  await act(async () => test.view.onBack());
  await act(async () => test.view.onOptions(source));
  expect(test.view.options.isFavorite).toBe(false);
});

it('removes a favorite copy without applying a fallback and keeps its details open', async () => {
  const saved = { uid: 'existing', providerId: 'account', modelId: 'model', agent: 'codex', effort: 'high', fast: true };
  test.prefs.favorites = [saved];
  const {onSelect} = await mount(vi.fn(async () => false), {selectedEffort:'high', selectedFastMode:true});
  await act(async () => test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async () => test.view.options.onFavorite());
  expect(onSelect).not.toHaveBeenCalled();
  expect(test.save).toHaveBeenCalledWith(expect.objectContaining({favorites:[]}));
  expect(test.view.options.row.config).toMatchObject({effort:'high',fast:true});
  expect(test.view.options.isFavorite).toBe(false);
});

it('adjusts model preferences from favorite details without overwriting the original copy', async () => {
  const saved = {uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'high',fast:true};
  test.prefs.favorites=[saved];
  const {onSelect}=await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  expect(test.view.options.isFavorite).toBe(true);
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,fast:false}));
  expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({effort:'high',fast:false}));
  expect(test.prefs.favorites).toEqual([saved]);
  expect(test.view.options.row.config).toMatchObject({effort:'high',fast:false});
  expect(test.view.options.isFavorite).toBe(false);
  expect(test.view.options.notice).toBe('models.unified.originalFavoriteKept');
  await act(async()=>test.view.options.onFavorite());
  expect(test.prefs.favorites).toEqual([saved,expect.objectContaining({effort:'high',fast:false})]);
});

it('cancels explicit editing without saving or changing the active configuration', async () => {
  const saved={uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'medium',fast:false};
  test.prefs.favorites=[saved];
  const {onSelect}=await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onEditFavorite());
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  expect(test.view.options.editingFavorite).toBe(true);
  await act(async()=>test.view.onBack());
  expect(test.view.options.editingFavorite).toBe(false);
  expect(test.view.options.row.config.effort).toBe('medium');
  expect(test.prefs.favorites).toEqual([saved]);
  expect(onSelect).not.toHaveBeenCalled();
  expect(test.save).not.toHaveBeenCalled();
});

it('keeps explicit edits after failed saving and updates only the favorite when retried', async () => {
  const saved={uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'medium',fast:false};
  test.prefs.favorites=[saved];
  const {onSelect}=await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onEditFavorite());
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  test.save.mockRejectedValueOnce(new Error('offline'));
  await act(async()=>test.view.options.onSaveEdit());
  expect(test.view.error).toBe('models.unified.saveFailed');
  expect(test.view.options.editingFavorite).toBe(true);
  expect(test.view.options.row.config.effort).toBe('high');
  expect(test.prefs.favorites).toEqual([saved]);
  await act(async()=>test.view.options.onSaveEdit());
  expect(test.view.options.editingFavorite).toBe(false);
  expect(test.prefs.favorites).toEqual([{...saved,effort:'high'}]);
  expect(onSelect).not.toHaveBeenCalled();
});

it.each(['changed','removed'])('rejects a stale edit when the original was %s remotely',async mode=>{
  const saved={uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'medium',fast:false};
  test.prefs.favorites=[saved];
  await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onEditFavorite());
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  test.prefs={...test.prefs,favorites:mode==='changed'?[{...saved,fast:true}]:[]};
  await mount();
  await act(async()=>test.view.options.onSaveEdit());
  expect(test.save).not.toHaveBeenCalled();
  expect(test.view.error).toBe('models.unified.favoriteChanged');
  expect(test.view.options.editingFavorite).toBe(true);
});

it('rejects duplicate configurations during explicit favorite editing',async()=>{
  const saved={uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'medium',fast:false};
  test.prefs.favorites=[saved,{...saved,uid:'other',modelId:'codex/model',effort:'high'}];
  await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onEditFavorite());
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  await act(async()=>test.view.options.onSaveEdit());
  expect(test.save).not.toHaveBeenCalled();
  expect(test.view.error).toBe('models.unified.favoriteExists');
});

it('distinguishes recommended settings from explicit overrides with the same values',async()=>{
  await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  expect(test.view.options.canReset).toBe(false);
  test.prefs.engines[JSON.stringify(['account','model'])]='codex';
  await mount();
  expect(test.view.options.canReset).toBe(true);
  await act(async()=>test.view.options.onReset());
  expect(test.view.options.canReset).toBe(false);
  expect(test.prefs.engines).toEqual({});
});

it('resets engine, effort and Fast overrides for this model while preserving favorites and other models',async()=>{
  const effort=new Map([['codex:codex/model','high'],['claude-code:model','high'],['codex:other','high']]);
  const fast=new Map([['codex:codex/model',true],['claude-code:model',false],['codex:other',true]]);
  const memory={
    getEffort:(a:string,_p:string,m:string)=>effort.get(`${a}:${m}`),
    getFast:(a:string,_p:string,m:string)=>fast.get(`${a}:${m}`),
    setEffort:vi.fn(),setFast:vi.fn(),
    clearEffort:vi.fn((a:string,_p:string,m:string)=>{effort.delete(`${a}:${m}`);}),
    clearFast:vi.fn((a:string,_p:string,m:string)=>{fast.delete(`${a}:${m}`);}),
  };
  const saved={uid:'original',providerId:'account',modelId:'model',agent:'codex',effort:'high',fast:true};
  test.prefs={favorites:[saved],engines:{[JSON.stringify(['account','model'])]:'claude-code',[JSON.stringify(['account','other'])]:'codex'}};
  const {onSelect}=await mount(undefined,{activeModelId:'other',modelMemory:memory});
  const source=test.view.groups.flatMap((g:any)=>g.rows).find((r:any)=>!r.favorite);
  await act(async()=>test.view.onOptions(source));
  expect(test.view.options.canReset).toBe(true);
  await act(async()=>test.view.options.onReset());
  expect(test.view.options.canReset).toBe(false);
  expect(test.view.options.row.config).toMatchObject({agent:'codex',effort:'medium',fast:false});
  expect([...effort.entries()]).toEqual([['codex:other','high']]);
  expect([...fast.entries()]).toEqual([['codex:other',true]]);
  expect(test.prefs.engines).toEqual({[JSON.stringify(['account','other'])]:'codex'});
  expect(test.prefs.favorites).toEqual([saved]);
  expect(onSelect).not.toHaveBeenCalled();
});

it('does not clear model memory when restoring the active configuration is cancelled',async()=>{
  const memory={getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn(),clearEffort:vi.fn(),clearFast:vi.fn()};
  await mount(vi.fn(async()=>false),{selectedEffort:'high',selectedFastMode:true,modelMemory:memory});
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onReset());
  expect(test.view.options.canReset).toBe(true);
  expect(test.view.options.row.config).toMatchObject({effort:'high',fast:true});
  expect(memory.clearEffort).not.toHaveBeenCalled();
  expect(memory.clearFast).not.toHaveBeenCalled();
  expect(test.save).not.toHaveBeenCalled();
});

it('restores session mirrors through the existing value-only remote accessors',async()=>{
  const {makeSessionMirrorAccessors,clearSessionMirror}=await vi.importActual<typeof import('@/session/sessionModelMirror')>('@/session/sessionModelMirror');
  const onWrite=vi.fn();
  const memory=makeSessionMirrorAccessors('restore-test',onWrite);
  try {
    memory.setEffort('codex','account','codex/model','high');
    memory.setFast('codex','account','codex/model',true);
    onWrite.mockClear();
    await mount(undefined,{activeModelId:'other',modelMemory:memory});
    await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
    expect(test.view.options.canReset).toBe(true);
    await act(async()=>test.view.options.onReset());
    expect(memory.getEffort('codex','account','codex/model')).toBe('medium');
    expect(memory.getFast('codex','account','codex/model')).toBe(false);
    expect(onWrite).toHaveBeenCalledWith('codex','account','codex/model',{effort:'medium'});
    expect(onWrite).toHaveBeenCalledWith('codex','account','codex/model',{fast:false});
    expect(test.view.options.canReset).toBe(false);
  } finally { clearSessionMirror('restore-test'); }
});

it('rolls back the active configuration if saving a recommendation reset fails',async()=>{
  const memory={getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn(),clearEffort:vi.fn(),clearFast:vi.fn()};
  const {onSelect}=await mount(undefined,{selectedEffort:'high',selectedFastMode:true,modelMemory:memory});
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  test.save.mockRejectedValueOnce(new Error('disk unavailable'));
  await act(async()=>test.view.options.onReset());
  expect(onSelect).toHaveBeenNthCalledWith(1,expect.objectContaining({effort:'medium',fast:false}));
  expect(onSelect).toHaveBeenNthCalledWith(2,expect.objectContaining({effort:'high',fast:true}));
  expect(memory.clearEffort).not.toHaveBeenCalled();
  expect(memory.clearFast).not.toHaveBeenCalled();
  expect(test.view.options.notice).toBeNull();
  expect(test.view.error).toBe('models.unified.saveFailed');
});

it('restores the session-pinned baseline without leaving a reset button', async () => {
  test.entries[0].nativeAgent = null;
  test.entries[0].recommended = 'claude-code';
  const memory = {getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn()};
  await mount(undefined, {activeModelId:'other',modelMemory:memory});
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  expect(test.view.options.canReset).toBe(false);
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,agent:'claude-code',modelId:'model',effort:'high'}));
  expect(test.view.options.canReset).toBe(true);
  await act(async()=>test.view.options.onReset());
  expect(test.view.options.row.config).toMatchObject({agent:'codex',effort:'medium',fast:false});
  expect(test.view.options.canReset).toBe(false);
  expect(test.prefs.engines).toEqual({});
});

it.each(['edit','parameters','favorite','failure'])('ignores late %s UI completion after close and reopen', async (operation) => {
  test.prefs.favorites=[{uid:'fav',providerId:'account',modelId:'model',agent:'codex',effort:'medium',fast:false}];
  await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  if (operation === 'edit' || operation === 'failure') {
    await act(async()=>test.view.options.onEditFavorite());
    await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  }
  let finish!:()=>void;
  const pending=new Promise<void>(resolve=>{finish=resolve;});
  test.save.mockImplementationOnce(async value=>{await pending;if(operation==='failure') throw new Error('offline');test.prefs=value;});
  await act(async()=>{
    if(operation==='parameters') test.view.options.onChange({...test.view.options.row.config,effort:'high'});
    else if(operation==='favorite') test.view.options.onFavorite();
    else test.view.options.onSaveEdit();
  });
  expect(test.view.busy).toBe(true);
  await mount(undefined,{visible:false});
  await mount(undefined,{visible:true});
  expect(test.view.options).toBeUndefined();
  expect(test.view.busy).toBe(true);
  await act(async()=>{finish();await pending;});
  expect(test.view.options).toBeUndefined();
  expect(test.view.error).toBeNull();
  expect(test.view.busy).toBe(false);
  if(operation==='edit') expect(test.prefs.favorites[0].effort).toBe('high');
});

it.each(['success', 'cancel', 'save-failure'])('applies ordinary edits of the running favorite while another model is pending: %s', async outcome => {
  const saved = {uid:'running',providerId:'account',modelId:'codex/model',agent:'codex',effort:'high',fast:true};
  test.prefs.favorites = [saved];
  const onSelect = vi.fn(async () => outcome !== 'cancel');
  const memory = {getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn()};
  await mount(onSelect, {
    agentKind:'claude-code',activeModelId:'pending-model',modelMemory:memory,
    unified:{scope:'user-device',agents:['codex','claude-code'],loadCapabilities:async()=>({hasFastMode:true}),onSelect,
      currentSelection:{agentKind:'codex',activeModelId:'codex/model',selectedProviderId:'account',selectedEffort:'high',selectedFastMode:true}},
  });
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  expect(test.view.options.row.selected).toBe(false);
  if(outcome === 'save-failure') test.save.mockRejectedValueOnce(new Error('offline'));
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'medium'}));
  expect(onSelect).toHaveBeenNthCalledWith(1,{providerId:'account',modelId:'codex/model',agent:'codex',effort:'medium',fast:true});
  expect(test.prefs.favorites).toEqual([saved]);
  if(outcome === 'cancel') {
    expect(test.save).not.toHaveBeenCalled();
    expect(memory.setEffort).not.toHaveBeenCalled();
  } else if(outcome === 'save-failure') {
    expect(onSelect).toHaveBeenNthCalledWith(2,{providerId:'account',modelId:'codex/model',agent:'codex',effort:'high',fast:true});
    expect(memory.setEffort).not.toHaveBeenCalled();
    expect(test.view.error).toBe('models.unified.saveFailed');
  } else {
    expect(onSelect).toHaveBeenCalledOnce();
    expect(memory.setEffort).toHaveBeenCalledWith('codex','account','codex/model','medium');
  }
});

it.each(['closed', 'reopened', 'rebound'])('does not roll back a newer selection after the original panel is %s', async lifecycle => {
  let rejectSave!: (error: Error) => void;
  const pending = new Promise<void>((_resolve,reject)=>{rejectSave=reject;});
  test.save.mockImplementationOnce(()=>pending);
  const onSelect = vi.fn(async()=>true);
  await mount(onSelect);
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  expect(onSelect).toHaveBeenCalledOnce();
  expect(test.save).toHaveBeenCalledOnce();
  if(lifecycle === 'rebound') {
    await mount(onSelect,{activeModelId:'new-model',unified:{scope:'other-device',agents:['codex','claude-code'],loadCapabilities:async()=>({hasFastMode:true}),onSelect}});
  } else {
    await mount(onSelect,{visible:false,activeModelId:'new-model'});
    if(lifecycle === 'reopened') await mount(onSelect,{activeModelId:'new-model'});
  }
  await act(async()=>{rejectSave(new Error('stale favorite binding'));});
  expect(onSelect).toHaveBeenCalledOnce();
  expect(test.view.error).toBeNull();
  expect(test.view.busy).toBe(false);
});

it('does not start preference writes after selection completes for a closed panel', async()=>{
  let finish!: (applied: boolean)=>void;
  const onSelect = vi.fn(()=>new Promise<boolean>(resolve=>{finish=resolve;}));
  const memory = {getEffort:()=>undefined,getFast:()=>undefined,setEffort:vi.fn(),setFast:vi.fn()};
  await mount(onSelect,{modelMemory:memory});
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'high'}));
  await mount(onSelect,{visible:false,modelMemory:memory});
  await mount(onSelect,{modelMemory:memory});
  await act(async()=>{finish(true);});
  expect(test.save).not.toHaveBeenCalled();
  expect(memory.setEffort).not.toHaveBeenCalled();
  expect(onSelect).toHaveBeenCalledOnce();
  expect(test.view.options).toBeUndefined();
  expect(test.view.error).toBeNull();
});

it('explains a closed current model without changing it and still allows choosing a replacement', async () => {
  const { onSelect } = await mount(undefined, {
    providersReady: true,
    modelVisibilityOverrides: { 'codex:account:codex/model': false },
  });
  expect(test.view.error).toBe('session.common.modelHiddenReselect');
  expect(onSelect).not.toHaveBeenCalled();
  expect(test.view.busy).toBe(false);
  await act(async () => test.view.onSelect(test.view.groups[0].rows[0]));
  expect(onSelect).toHaveBeenCalledOnce();
});
