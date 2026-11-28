import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { settingsWebCommandSchema, settingsWebConnectSchema, settingsWebResultSchema } from '../settingsWeb.js';

const failed = {domain:'appearance',result:{ok:false,code:'UNREADABLE'}};
describe('batch initialization wire contract (same corpus in both repositories)', () => {
  it('accepts old registration and explicitly negotiated batch registration', () => {
    const old={runtimeId:randomUUID(),domains:['appearance']};
    expect(settingsWebConnectSchema.parse(old)).toEqual(old);
    expect(settingsWebConnectSchema.parse({...old,readBatch:true})).toMatchObject({readBatch:true});
    expect(settingsWebCommandSchema.parse({kind:'readBatch',domains:['appearance','personalization']})).toMatchObject({kind:'readBatch'});
  });
  it.each([
    {kind:'readBatch',domains:[]},
    {kind:'readBatch',domains:['appearance','appearance']},
    {kind:'readBatch',domains:['credentials']},
    {kind:'readBatch',domains:['personalization'],includeUserPrompt:true},
    {kind:'readBatch',domains:['workspaceTools'],workspaceId:'a'.repeat(43)},
    {kind:'readBatch',domains:['appearance'],set:{uiSize:16}},
  ])('rejects invalid batch request %#', value => expect(settingsWebCommandSchema.safeParse(value).success).toBe(false));
  it('accepts partial errors and an explicit remaining suffix', () => {
    expect(settingsWebResultSchema.safeParse({ok:true,entries:[failed],remainingDomains:['personalization']}).success).toBe(true);
  });
  it.each([
    {ok:true,entries:[],remainingDomains:['appearance']},
    {ok:true,entries:[failed,failed],remainingDomains:[]},
    {ok:true,entries:[failed],remainingDomains:['appearance']},
    {ok:true,entries:[{domain:'appearance',result:{ok:true,receipt:{status:'unknown'}}}],remainingDomains:[]},
    {ok:true,entries:[{domain:'appearance',result:{ok:true,entries:[failed],remainingDomains:[]}}],remainingDomains:[]},
    {ok:true,entries:[{domain:'appearance',result:{ok:true,settings:{domain:'personalization',status:'unavailable',revision:null}}}],remainingDomains:[]},
    {ok:true,entries:[{domain:'personalization',result:{ok:true,settings:{domain:'personalization',status:'ready',userPrompt:'private'}}}],remainingDomains:[]},
  ])('rejects incomplete, repeated, nested, mismatched or leaking responses %#', value => expect(settingsWebResultSchema.safeParse(value).success).toBe(false));
});
