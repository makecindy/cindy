// @vitest-environment jsdom
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UnifiedModelPickerSheet } from '@/session/UnifiedModelPickerSheet';
const test = vi.hoisted(() => ({ view: null as any, quotas:{} as any, syncError:null as unknown, prefs: {favorites:[],engines:{}} as any, save: vi.fn(), entries: [] as any[] }));
vi.mock('@/session/UnifiedModelPickerView', () => ({ UnifiedModelPickerView: (p:any) => {test.view=p;return null;} }));
vi.mock('@/session/useMobileModelQuotas',()=>({useMobileModelQuotas:()=>({quotas:test.quotas,now:0})}));
vi.mock('@/session/mobileModelPreferences', () => ({useMobileModelPreferences:()=>({ready:true,error:test.syncError,value:test.prefs,save:test.save})}));
vi.mock('@/session/providerModelSections', () => ({buildMobileModelSections:()=>({activeSourceId:'account'})}));
vi.mock('@/session/draftModelMemory',()=>({useDraftModelMemoryVersion:()=>0}));
vi.mock('@/session/sessionModelMirror',()=>({useSessionModelMirrorVersion:()=>0}));
vi.mock('@/session/modelPickerRows',()=>({budgetRowDisabled:()=>false,presentPickerPrice:()=>null}));
vi.mock('@/session/unifiedMobileModels',async importOriginal=>({...await importOriginal<any>(),mobileUnifiedEntries:()=>test.entries}));
vi.mock('react-i18next',()=>({useTranslation:()=>({t:(key:string)=>key})}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
let root:ReturnType<typeof createRoot>;
beforeEach(()=>{test.syncError=null;test.quotas={};test.save.mockReset();test.prefs={favorites:[],engines:{}};test.entries=[{
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
it('does not mutate a favorite or current task when editing a different configuration copy',async()=>{
  test.prefs.favorites=[{uid:'fav',providerId:'account',modelId:'codex/model',agent:'codex',effort:'high',fast:false}];
  const {onSelect}=await mount();
  await act(async()=>test.view.onOptions(test.view.groups[0].rows[0]));
  await act(async()=>test.view.options.onChange({...test.view.options.row.config,effort:'medium'}));
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
  test.quotas={account:{remaining:40,resetsAt:273600}};
  await mount();
  const row=test.view.groups[0].rows[0];
  expect(row.quotaLabel).toBe('4models.unified.timeUnit.day · 40%');
  expect(row.effortLabel).toBe('models.options.effortLevels.medium');
});
