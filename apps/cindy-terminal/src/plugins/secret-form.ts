import type { TerminalClient } from '../contracts.js';
import { GHOST_SECRET_VALUE_MAX_CHARS } from '@cindy/plugin-runtime/shared/ghost';

export function parsePluginSecretForm(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('PLUGIN_SECRET_INVALID');
  const input=raw as Record<string,unknown>;
  if(typeof input.pluginId!=='string'||!input.pluginId||input.pluginId.length>256||typeof input.key!=='string'||input.key.length>8192||typeof input.value!=='string'||input.value.length>GHOST_SECRET_VALUE_MAX_CHARS||input.deviceId!==undefined&&(typeof input.deviceId!=='string'||!input.deviceId))throw new Error('PLUGIN_SECRET_INVALID');
  let binding:unknown;try{binding=JSON.parse(Buffer.from(input.key,'base64url').toString());}catch{throw new Error('PLUGIN_SECRET_FORM_STALE');}
  if(!Array.isArray(binding)||binding.length!==2||typeof binding[0]!=='string'||!/^[a-z][a-z0-9_]{0,31}$/.test(binding[0])||typeof binding[1]!=='string'||binding[1].length>4096)throw new Error('PLUGIN_SECRET_FORM_STALE');
  return {pluginId:input.pluginId,key:binding[0],approval:binding[1],value:input.value,deviceId:input.deviceId as string|undefined};
}

/** Never pass a credential to the target's generic resource dispatcher. */
export async function submitPluginSecret(client:TerminalClient,pluginId:string,input:unknown,deviceId?:string):Promise<import('@cindy/device-link').RemoteActionInvokeResponse>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('PLUGIN_SECRET_INVALID');
  const form=input as Record<string,unknown>;
  const args={pluginId,key:form.key,value:form.value,...(deviceId?{deviceId}:{})};
  parsePluginSecretForm(args);
  await client.invoke('terminal:plugin-secret',[args]);
  return {effects:[{kind:'refresh-collection' as const,collectionId:'plugins'}]};
}
