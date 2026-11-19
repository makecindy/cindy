import { stat } from 'node:fs/promises';
import { sessionCanRead } from '../cindy-media/ledger.js';
import { taskImageReferences } from '../cindy-media/taskImageMarkdown.js';
import { getCurrentDbClientSnapshot, type CurrentDbClientSnapshot } from '../localDb/client/current.js';
import { prependNoteToWireUserMessage, type HandoffWireMessage } from './agentHandoff.js';

type PrepareMessage = (sessionId: string, message: HandoffWireMessage) => Promise<HandoffWireMessage>;
export interface PrivateChatContext {
  text: string;
  imageUrls: string[];
  sourceSessionId: string;
  owner: CurrentDbClientSnapshot;
}

/** The database row selected by the host owns the attachment list. Never follow paths in prose. */
export function privateMessageParts(raw: string, role: string) {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { value = raw; }
  let text = typeof value === 'string' ? value : '';
  const names: string[] = [];
  const urls: string[] = [];
  if (role === 'user' && value && typeof value === 'object') {
    const row = value as { text?: unknown; images?: unknown; files?: unknown };
    if (typeof row.text === 'string') text = row.text;
    for (const image of Array.isArray(row.images) ? row.images : []) {
      names.push(typeof image?.originalName === 'string' && image.originalName || '图片');
      if (typeof image?.url === 'string') urls.push(image.url);
    }
    for (const file of Array.isArray(row.files) ? row.files : []) {
      names.push(typeof file?.name === 'string' && file.name || '文件');
    }
  } else if (role === 'assistant') {
    urls.push(...taskImageReferences(text).map(ref => ref.url).filter(url => /^(?:cindy-media|xdt-image):\/\//.test(url)));
  }
  return { text: text.trim() || null, attachments: names, imageUrls: [...new Set(urls)] };
}

/** Context images use the platform's regular image normalization, only for the wire message. */
export async function prependPrivateChatContext(message: HandoffWireMessage, context: PrivateChatContext,
  targetSessionId: string, prepare: PrepareMessage): Promise<HandoffWireMessage> {
  const current = typeof message === 'string' ? message : message.content;
  const blocks: Array<{ type: string; [key: string]: unknown }> = typeof current === 'string' ? [{ type: 'text', text: current }] : current;
  const images = blocks.filter(block => block.type === 'image');
  const seen = new Set(images.map(block => block.managedUrl ?? block.path));
  const extra: typeof images = [];
  let missing = false;
  for (const url of context.imageUrls) {
    if (seen.has(url)) continue;
    if (extra.length + images.length >= 6) { missing = true; break; }
    if (getCurrentDbClientSnapshot() !== context.owner) throw new Error('OWNER_CHANGED');
    try {
      const blob = /^cindy-media:\/\/blobs\/([a-f0-9]{64})\.(?:png|jpe?g|gif|webp)$/i.exec(url);
      const prefix = `xdt-image://${context.sourceSessionId}/`;
      const legacy = url.startsWith(prefix) && /^[^/\\?#]+$/.test(url.slice(prefix.length));
      if (!legacy && (!blob || !await sessionCanRead(blob[1]!, context.sourceSessionId, context.owner.client.drizzle))) {
        missing = true; continue;
      }
      if (getCurrentDbClientSnapshot() !== context.owner) break;
      const normalized = await prepare(targetSessionId, { type: 'user', content: [{ type: 'image', path: url }] });
      const image = typeof normalized !== 'string' && Array.isArray(normalized.content) ? normalized.content[0] : undefined;
      if (image?.type !== 'image' || typeof image.path !== 'string' || !String(image.mimeType).startsWith('image/')) {
        missing = true; continue;
      }
      const disk = await stat(image.path);
      if (!disk.isFile() || !disk.size || disk.size > 20 * 1024 * 1024) { missing = true; continue; }
      if (seen.has(image.path)) continue;
      extra.push(image);
      seen.add(image.path);
      seen.add(url);
    } catch { missing = true; }
  }
  if (getCurrentDbClientSnapshot() !== context.owner) throw new Error('OWNER_CHANGED');
  const note = context.text + (missing ? '\n部分背景图片未随本轮送达。' : '');
  const withImages: HandoffWireMessage = extra.length ? { type: 'user', content: [...blocks, ...extra] } : message;
  return prependNoteToWireUserMessage(withImages, note);
}
