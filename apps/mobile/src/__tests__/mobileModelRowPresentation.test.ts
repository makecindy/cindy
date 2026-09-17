import { describe,expect,it } from 'vitest';
import { mobileCostMarks,mobileQuotaSource,mobileWeeklyQuota,quotaCountdown } from '@/session/mobileModelRowPresentation';
import type { ProviderView } from '@cindy/model-providers/registry';
const provider=(extra:object={})=>({id:'xd',connected:true,auth:{method:'api-key'},...extra}) as unknown as ProviderView;
describe('model row cost tiers',()=>{
  it.each([[3,'$'],[3.01,'$$'],[15,'$$'],[15.01,'$$$']])('uses Desktop standard output threshold %s',(output,expected)=>{
    expect(mobileCostMarks(provider(),'model','codex',{model:{inputUsdPerMtok:1,outputUsdPerMtok:output as number,costDiscount:.9}})).toBe(expected);
  });
  it('does not invent costs for missing, free or subscription prices',()=>{
    expect(mobileCostMarks(provider(),'model','codex',{})).toBeNull();
    expect(mobileCostMarks(provider(),'model','codex',{model:{inputUsdPerMtok:0,outputUsdPerMtok:0}})).toBeNull();
    expect(mobileCostMarks(provider({access:{kind:'subscription'}}),'model','codex',{model:{inputUsdPerMtok:1,outputUsdPerMtok:20}})).toBeNull();
  });
});
describe('account weekly quota',()=>{
  it('selects account quota instead of model promotion and converts used into remaining',()=>{
    const generic={limitId:'codex',primary:{windowMinutes:300,usedPercent:95,resetsAt:200},secondary:{windowMinutes:10080,usedPercent:20,resetsAt:1000}};
    expect(mobileWeeklyQuota('codex',{rateLimits:generic,rateLimitsByLimitId:{codex:generic}},100000)).toEqual({remaining:80,resetsAt:1000});
  });
  it('hides expired windows, missing percentages and stale xAI snapshots',()=>{
    expect(mobileWeeklyQuota('claude',{sevenDay:{utilization:20,resetsAt:10}},10000)).toBeNull();
    expect(mobileWeeklyQuota('claude',{sevenDay:{resetsAt:1000}},10000)).toBeNull();
    expect(mobileWeeklyQuota('xai',{creditUsagePercent:20,updatedAt:1},31*60000)).toBeNull();
    expect(mobileWeeklyQuota('xai',{creditUsagePercent:20,updatedAt:100,resetsAt:1000},10000)).toEqual({remaining:80,resetsAt:1000});
  });
  it('does not use same-brand API accounts as subscription accounts',()=>{
    expect(mobileQuotaSource(provider({id:'openai'}))).toBeNull();
    expect(mobileQuotaSource(provider({id:'bound',auth:{method:'oauth',native:'codex'}}))).toBe('codex');
    expect(mobileQuotaSource(provider({id:'bound',auth:{method:'oauth',native:'codex'},suspended:true}))).toBeNull();
  });
  it('keeps reset countdown compact',()=>{
    expect(quotaCountdown(90060,0)).toBe('2d');
    expect(quotaCountdown(3660,0)).toBe('2h');
  });
});

it.each([[86400,'1d'],[86399,'24h'],[3600,'1h'],[3599,'60m'],[60,'1m'],[59,'59s'],[0,null],[-1,null],[NaN,null]])('uses Desktop compact countdown boundary %s',(reset,expected)=>{
  expect(quotaCountdown(reset as number,0)).toBe(expected);
});

it('localizes all countdown units using the supplied language',()=>{
  const unit=(name:string)=>({day:'天',hour:'小时',minute:'分钟',second:'秒'})[name]!;
  expect(quotaCountdown(273600,0,unit)).toBe('4天');
  expect(quotaCountdown(3700,0,unit)).toBe('2小时');
  expect(quotaCountdown(70,0,unit)).toBe('2分钟');
  expect(quotaCountdown(20,0,unit)).toBe('20秒');
});
