import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { McpUiDownloadFileRequest } from '@modelcontextprotocol/ext-apps';
import { replaceFile } from '../utils/replaceFile.js';

export type AppDownloadContent = McpUiDownloadFileRequest['params']['contents'][number];
export function appDownloadName(value: string): string {
  const name = value.split(/[\\/]/).pop()?.replace(/[<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, '').slice(0, 180) ?? '';
  return !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'download' : name;
}

/** Save dialog is the user's confirmation. Only the Host can provide the destination. */
export async function saveAppDownload(input: {
  content: AppDownloadContent;
  showSaveDialog(name: string): Promise<string | null>;
  readGranted(uri: string): Promise<Response>;
  assertCurrent(): Promise<void>;
  signal: AbortSignal;
}): Promise<{ isError?: boolean }> {
  const check = async () => { input.signal.throwIfAborted(); await input.assertCurrent(); input.signal.throwIfAborted(); };
  await check();
  const content = input.content;
  // Recheck grants before presenting a dialog. No arbitrary external ResourceLink downloads.
  const name = appDownloadName(content.type === 'resource_link' ? content.name : content.resource.uri);
  const destination = await input.showSaveDialog(name);
  await check();
  if (!destination) return { isError: true };
  let response: Response;
  if (content.type === 'resource_link') response = await input.readGranted(content.uri);
  else {
    const resource = content.resource;
    if ('text' in resource) response = new Response(resource.text);
    else {
      if (resource.blob.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(resource.blob)) throw new Error('MCP_APP_FILE_INVALID');
      response = new Response(Buffer.from(resource.blob, 'base64'));
    }
  }
  const staging = path.join(path.dirname(destination), `.cindy-download-${randomUUID()}`);
  const reader = response.body?.getReader();
  try {
    await check();
    if (!response.ok) throw new Error('MCP_APP_FILE_UNAVAILABLE');
    const file = await fs.open(staging, 'wx', 0o600);
    try {
      while (reader) {
        await check();
        const next = await reader.read();
        if (next.done) break;
        await check();
        await file.writeFile(next.value);
      }
      await file.sync();
    } finally { await file.close(); }
    await check();
    await replaceFile(staging, destination);
    return {};
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await fs.rm(staging, { force: true });
  }
}
