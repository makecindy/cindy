import { createChatMedia as createSharedChatMedia } from '@cindy/companion-core/chatMedia';
import { chatErrorDiagnostic } from '@cindy/companion-core/chatServerErrors';
import { retryAfterDeadline } from '@cindy/auth-client';
import fs from 'node:fs/promises';
import path from 'node:path';
import { botGroupAttachmentsPath } from '@cindy/companion-core/botGroupWorkDir';
import { safeAttachmentFileName } from './botGroupAttachments.js';
import type { ChatApi } from '@cindy/companion-core/chatServerMigration';
export function createChatMediaRuntime(host: {
 fetch: typeof globalThis.fetch;
 getDbClient(): import('@cindy/runtime-db').DbClient;
 ownerScopedUserDataPath(): string;
 blobStore: Pick<ReturnType<typeof import('./persistedMedia.js').createPersistedMedia>['blobStore'], 'readFile'|'supportedMime'>;
 ingestMedia: ReturnType<typeof import('./persistedMedia.js').createPersistedMedia>['ingestMedia'];
}) {
const { fetch, getDbClient, ownerScopedUserDataPath, ingestMedia, blobStore: {readFile:readMedia,supportedMime} } = host;
function createChatMedia(api:ChatApi,current:()=>boolean,log?:{warn(message:string,meta?:Record<string,unknown>):void},options:{allowLoopback?:boolean}={}) {
 return createSharedChatMedia(api,current,{
  fetch:(...args)=>fetch(...args),retryAfterDeadline,diagnostic:chatErrorDiagnostic,
  read:async(attachment,maxSize,check)=>{if(attachment.path){const stat=await fs.stat(attachment.path);await check();if(!stat.isFile()||stat.size>maxSize)throw new Error('ATTACHMENT_TOO_LARGE');}return attachment.url?.startsWith('cindy-media://')?(await readMedia(attachment.url)).buffer:attachment.path?await fs.readFile(attachment.path):null;},
  cache:async({roomId,mediaId,name,mimeType,size,buffer},check)=>{const root=ownerScopedUserDataPath();const db=getDbClient().drizzle;const base={id:mediaId,name,mimeType,size};if(mimeType.startsWith('image/')&&supportedMime(mimeType)){const stored=await ingestMedia({buffer,mimeType,isCache:true,refs:[],assertStillValid:check},db);return {...base,category:'image',url:stored.url,path:null};}const dir=path.join(botGroupAttachmentsPath(root,roomId),mediaId);await fs.mkdir(dir,{recursive:true});check();const file=path.join(dir,safeAttachmentFileName(name));await fs.writeFile(file,buffer);check();return {...base,category:'file',url:null,path:file};}
 },log,options);
}

return {createChatMedia};
}
