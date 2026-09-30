import { expect, it, vi } from 'vitest';
import type { UnifiedModelEntry } from '@cindy/model-providers';
import { addModelFavorite, matchesEntry, mobileUnifiedEntries, resolveMobileModelConfig, sameConfiguration } from '@/session/unifiedMobileModels';
const cap = (agent: 'codex'|'claude-code') => ({agent,wireModelId:agent === 'codex' ? 'codex/model' : 'model',efforts:['low','medium','high'],defaultEffort:'medium',supportsFastMode:true,contextWindow:200000,defaultEffortSource:"catalog",contextWindowVerified:true});
const entry = {providerId:'account-a',modelId:'model',displayName:'Model',candidates:['codex','claude-code'],recommended:'codex',nativeAgent:'codex',capabilities:{codex:cap('codex'),'claude-code':cap('claude-code')}} as unknown as UnifiedModelEntry;
const fastCapable = () => true;
it('merges engine aliases but preserves the selected engine wire id', () => {
  expect(matchesEntry(entry,'codex/model')).toBe(true);
  expect(resolveMobileModelConfig(entry,{fastCapable}).modelId).toBe('codex/model');
});
it('uses catalog defaults instead of carrying another model effort', () => {
  expect(resolveMobileModelConfig(entry,{fastCapable}).effort).toBe('medium');
});
it('keeps native recommendation when a different session engine could bridge it', () => {
  expect(resolveMobileModelConfig(entry,{fastCapable,pinned:'claude-code'}).agent).toBe('codex');
});
it('pins a model with no native engine to the existing task', () => {
  expect(resolveMobileModelConfig({...entry,nativeAgent:null},{fastCapable,pinned:'claude-code'}).agent).toBe('claude-code');
});
it('explicit engine overrides the session pin; runtime truth overrides both', () => {
  const live={providerId:'account-a',modelId:'codex/model',agent:'codex' as const,effort:'high',fast:true};
  expect(resolveMobileModelConfig(entry,{fastCapable,pinned:'codex',override:'claude-code'}).agent).toBe('claude-code');
  expect(resolveMobileModelConfig(entry,{fastCapable,override:'claude-code',live})).toEqual(live);
});
it('favorites restore independent complete configurations without reading model memory', () => {
  const favorite={uid:'1',providerId:'account-a',modelId:'model',agent:'claude-code' as const,effort:'high',fast:true};
  const memory={getEffort:vi.fn(()=> 'low'),getFast:vi.fn(()=>false),setEffort:vi.fn(),setFast:vi.fn()};
  expect(resolveMobileModelConfig(entry,{fastCapable,favorite,memory})).toEqual({...favorite,uid:undefined});
  expect(memory.getEffort).not.toHaveBeenCalled();
});
it('capability removal clamps stale favorites without mutating them', () => {
  const favorite={uid:'1',providerId:'account-a',modelId:'model',agent:'pi' as const,effort:'ultra',fast:true};
  const result=resolveMobileModelConfig(entry,{fastCapable:()=>false,favorite});
  expect(result).toMatchObject({agent:'codex',effort:'medium',fast:false});
  expect(favorite.effort).toBe('ultra');
});
it('deduplicates identical favorites but keeps distinct configurations and accounts', () => {
  const config=resolveMobileModelConfig(entry,{fastCapable});
  const one=addModelFavorite({favorites:[],engines:{}},config,'1');
  expect(addModelFavorite(one,config,'2')).toBe(one);
  expect(addModelFavorite(one,{...config,effort:'high'},'2').favorites).toHaveLength(2);
  expect(sameConfiguration(config,{...config,providerId:'account-b'})).toBe(false);
});
it('an explicitly empty catalog never revives capability models', () => {
  expect(mobileUnifiedEntries([],['codex'],{},false)).toEqual([]);
});
