import type { DeviceAgentServiceDeps } from '@cindy/remote-agent';
import type {AgentRequestReceipt} from '@cindy/maker-shared/forwarded-request-types';
export interface TaskDeliveryProof { controllerDeviceId:string;receiptId:string;sessionId:string;targetSessionId:string;message:string;senderTitle?:string;autoReviewUserText?:AgentRequestReceipt }
export async function validateTaskDelivery(invoke:DeviceAgentServiceDeps['remoteInvoke']|undefined,proof:TaskDeliveryProof,release=false):Promise<void> {
  if(!invoke)throw new Error('TASK_ACTION_AUTHORIZATION_REQUIRED');
  const response=await invoke(proof.controllerDeviceId,'maker:session:handoff',[{action:'validate-task-action',receiptId:proof.receiptId,sessionId:proof.sessionId,targetSessionId:proof.targetSessionId,message:proof.message,...(release?{release:true}:{})}]);
  const result=response.ok ? response.result as {valid?:boolean;released?:boolean} : undefined;
  if(result?.valid!==true || release&&result.released!==true)throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
}
export function readTaskDelivery(value:unknown,controllerDeviceId:string):TaskDeliveryProof {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('INVALID_HANDOFF');
  const request=value as Record<string,unknown>;const sender=request.sender as Record<string,unknown>|undefined;
  const bounded=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error('INVALID_HANDOFF');return value;};
  const targetSessionId=bounded(request.sessionId,512);const sessionId=bounded(sender?.sessionId,512);
  if(targetSessionId.includes('::')||sessionId.includes('::')||/[\s()「」]/.test(sessionId))throw new Error('INVALID_HANDOFF');
  return {controllerDeviceId,receiptId:bounded(request.taskActionReceipt,128),sessionId,targetSessionId,message:bounded(request.message,200_000),...(typeof sender?.title==='string'?{senderTitle:sender.title.replace(/[\r\n\t]/g,' ').slice(0,200)}:{})};
}
