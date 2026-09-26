import {describe, it, expect} from 'vitest';
import {pluginWorkerCompletedAt} from '../pluginWorkerCompletion.js';
const final = {status:'idle',working:false,queued:0,paused:false,startedAt:100,endedAt:200,anchor:{role:'assistant',createdAt:190,agentMeta:'{"turnCompleted":true}'}};
describe('released Worker completion',()=>{
 it('recovers a released final turn from host metadata',()=>expect(pluginWorkerCompletedAt(final)).toBe(200));
 it.each([{working:true},{queued:1},{paused:true},{status:'error'},{startedAt:210},{clearedAt:195},{anchor:{...final.anchor,role:'user'}},{anchor:{...final.anchor,agentMeta:'{}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":false}'}},{anchor:{...final.anchor,agentMeta:'{"turnCompleted":true,"parentUuid":"child"}'}}])('does not infer completion from idle or old/report text: %j',patch=>expect(pluginWorkerCompletedAt({...final,...patch})).toBeNull());
});
