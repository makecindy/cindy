import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { UserMessage, UserContentBlock } from '@cindy/maker-core';
import type { InvocationContext } from '../contracts.js';
import { atomicPrivateWrite, privateDirectory } from '../platform.js';

export type AttachmentResolution = { path: string; managedUrl?: string; mimeType?: string; cleanup?: () => Promise<void>; afterAcceptance?: () => Promise<void> };
export type AttachmentLifecycle = { cleanup: Array<() => Promise<void>>; accepted: Array<() => Promise<void>> };
export interface InputHost {
  profileDir: string;
  resolveAttachment?: (reference: string, context: InvocationContext, sessionId: string) => Promise<AttachmentResolution>;
  ingestAttachment?: (input: {sessionId:string;bytes?:Buffer;path?:string;mimeType?:string;name?:string}, context: InvocationContext) => Promise<AttachmentResolution>;
}
const MAX_BYTES = 64 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_INPUT_CONTENT'); return value as Record<string, unknown>; }
function text(value: unknown): string { return typeof value === 'string' ? value : ''; }
function isMedia(mime: string, name: string) { return /^(image|video|audio|model)\//.test(mime) || /\.(png|jpe?g|gif|webp|mp4|mov|webm|mp3|wav|m4a|ogg|glb)$/i.test(name); }
function bytesFromBase64(value: string) {
  const data = value.startsWith('data:') ? /^data:([^;,]*);base64,([\s\S]*)$/.exec(value) : null;
  if (value.startsWith('data:') && !data) throw new Error('INVALID_ATTACHMENT_DATA');
  const encoded = (data?.[2] ?? value).replace(/\s/g, '');
  if (encoded.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) throw new Error('INVALID_ATTACHMENT_DATA');
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('INVALID_ATTACHMENT_SIZE');
  if (bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) throw new Error('INVALID_ATTACHMENT_DATA');
  return { bytes, mime: data?.[1] };
}
async function readSource(file: string) {
  const handle = await open(file, 'r');
  try { const info = await handle.stat(); if (!info.isFile() || info.size > MAX_BYTES) throw new Error('INVALID_ATTACHMENT_SIZE'); return await handle.readFile(); } finally { await handle.close(); }
}

/** Snapshot file inputs before accepting a durable queue item. Media enters the
 * shared media ingester; non-media belongs to this task's attachment directory. */
export async function normalizeTaskInput(host: InputHost, sessionId: string, input: unknown, context: InvocationContext, workingDir: string, guard: () => void, lifecycle?: AttachmentLifecycle): Promise<UserMessage> {
  if (typeof input === 'string') return { type: 'user', content: input };
  const value = object(input);
  const blocks: UserContentBlock[] = [];
  const content = value.type === 'user' ? value.content : value.text;
  if (typeof content === 'string' && content) blocks.push({ type: 'text', text: content });
  const incoming = Array.isArray(content) ? content : [];
  for (const entry of incoming) if (object(entry).type === 'text') blocks.push({ type: 'text', text: text(object(entry).text) });
  const mentions = [...(Array.isArray(value.mentions) ? value.mentions : []), ...incoming.filter(entry => object(entry).type === 'mention')];
  for (const entry of mentions) {
    const mention = object(entry); const kind = mention.kind ?? mention.type;
    if (!['file', 'dir', 'agent'].includes(String(kind)) || !text(mention.path) || !text(mention.name)) throw new Error('INVALID_MENTION');
    if (kind !== 'agent' && context.sharedTask) {
      const target = await realpath(text(mention.path)); const base = await realpath(workingDir);
      if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('SHARED_TASK_ATTACHMENT_SCOPE');
    }
    blocks.push({type:'mention',name:text(mention.name),path:text(mention.path),kind:kind as 'file'|'dir'|'agent'});
  }
  const files = [...(Array.isArray(value.files) ? value.files : []), ...incoming.filter(entry => ['image','file'].includes(String(object(entry).type)))];
  for (const entry of files) {
    guard(); const file = object(entry); let mime = text(file.mimeType); const name = text(file.name) || path.basename(text(file.path)) || 'attachment';
    let source = text(file.url) || text(file.path); let bytes: Buffer | undefined;
    if (text(file.base64) || source.startsWith('data:')) { const decoded = bytesFromBase64(text(file.base64) || source); bytes = decoded.bytes; mime = decoded.mime || mime; source = ''; }
    let resolution: AttachmentResolution | undefined;
    if (source && (!path.isAbsolute(source) || context.source === 'remote')) {
      if (!host.resolveAttachment) throw new Error('ATTACHMENT_RESOLVER_REQUIRED');
      resolution = await host.resolveAttachment(source, context, sessionId); if(resolution.cleanup)lifecycle?.cleanup.push(resolution.cleanup);if(resolution.afterAcceptance)lifecycle?.accepted.push(resolution.afterAcceptance); guard(); source = resolution.path; mime = resolution.mimeType ?? mime;
    }
    if (!source && !bytes) throw new Error('ATTACHMENT_CONTENT_REQUIRED');
    if (source && !path.isAbsolute(source)) throw new Error('ATTACHMENT_PATH_MUST_BE_ABSOLUTE');
    if (source && context.sharedTask && !resolution) {
      const target = await realpath(source); const base = await realpath(workingDir);
      if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error('SHARED_TASK_ATTACHMENT_SCOPE');
    }
    const media = file.type === 'image' || file.category === 'image' || isMedia(mime, name);
    if (media) {
      if (resolution?.managedUrl) { /* Already entered the owner-scoped media store. */ }
      else if (host.ingestAttachment) { resolution = await host.ingestAttachment({sessionId, ...(bytes ? {bytes} : {path:source}),mimeType:mime,name},context); guard(); }
      else if (bytes) throw new Error('MEDIA_INGESTER_REQUIRED');
      else resolution = {path:source,mimeType:mime};
      const image = file.type === 'image' || file.category === 'image' || /^image\//.test(resolution.mimeType ?? mime) || /\.(png|jpe?g|gif|webp)$/i.test(name);
      blocks.push(image ? {type:'image',path:resolution.path, ...(resolution.managedUrl ? {managedUrl:resolution.managedUrl} : {}),mimeType:resolution.mimeType || mime} : {type:'file',path:resolution.path,mimeType:resolution.mimeType || mime});
    } else {
      bytes ??= await readSource(source); guard();
      const directory = path.join(host.profileDir,'tasks',sessionId,'attachments'); await privateDirectory(directory); guard();
      const ext = /^\.[a-zA-Z0-9]{1,12}$/.test(path.extname(name)) ? path.extname(name).toLowerCase() : '';
      const destination = path.join(directory,`${createHash('sha256').update(bytes).digest('hex')}${ext}`);
      await atomicPrivateWrite(destination,bytes); guard(); blocks.push(Object.assign({type:'file' as const,path:destination,...(mime ? {mimeType:mime} : {})},{name}));
    }
  }
  if (Array.isArray(value.sessionRefs) && value.sessionRefs.length) throw new Error('SESSION_REFERENCE_CONTEXT_REQUIRED');
  guard();
  if (!blocks.length) throw new Error('EMPTY_MESSAGE');
  return blocks.length === 1 && blocks[0].type === 'text' ? {type:'user',content:blocks[0].text} : {type:'user',content:blocks};
}
export function appendInputText(message: UserMessage, note: string): UserMessage {
  return {type:'user',content:typeof message.content === 'string' ? `${message.content}\n\n${note}` : [...message.content,{type:'text',text:note}]};
}
export function inputPlainText(message?: UserMessage): string { return !message ? '' : typeof message.content === 'string' ? message.content : message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'); }
export function persistedInput(message: UserMessage): string {
  if (typeof message.content === 'string') return message.content;
  const images = message.content.filter(block=>block.type==='image').map(block=>({url:block.managedUrl ?? block.path,mimeType:block.mimeType}));
  const files = message.content.filter(block=>block.type==='file').map(block=>({name:typeof (block as {name?:unknown}).name === 'string' ? (block as typeof block & {name:string}).name : path.basename(block.path),path:block.path,mimeType:block.mimeType}));
  return JSON.stringify({text:inputPlainText(message),...(images.length?{images}:{}),...(files.length?{files}:{}),mentions:message.content.filter(block=>block.type==='mention')});
}
