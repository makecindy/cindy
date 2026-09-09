import fs from 'node:fs/promises';
import { nativeImage } from 'electron';
import { callCindyMedia } from '../cindy-media/invocationService.js';
import { resolveSafe, writeBlob } from '../cindy-media/blobStore.js';
import { recordBlob, type LedgerDb } from '../cindy-media/ledger.js';

/** Consume Core's executable catalog, without embedding a plugin or a model id. */
export async function prepareBotInvitationAvatar(assertOwner: () => void): Promise<string | null> {
  const catalog = await callCindyMedia({ action: 'list_models', capability: 'image.generate' });
  assertOwner();
  if (!catalog.ok || !Array.isArray(catalog.models)) return null;
  const models = catalog.models as Array<{ id: string; provider_id: string }>;
  const model = models.find((candidate) => candidate.provider_id === 'xd') ?? models[0];
  if (!model) return null;
  const prepared = await callCindyMedia({
    action: 'prepare',
    capability: 'image.generate',
    modelId: model.id,
    providerId: model.provider_id,
  });
  assertOwner();
  if (!prepared.ok || typeof prepared.invocation_id !== 'string') return null;
  const schema = prepared.input_schema as
    { properties?: Record<string, unknown>; required?: string[] } | undefined;
  // The simple portrait request is supported only by guides accepting prompt alone.
  // Never invent vendor parameters or copy an example that requests multiple paid images.
  if (!schema?.properties?.prompt || schema.required?.some((key) => key !== 'prompt')) return null;
  return prepared.invocation_id;
}

export async function finishBotInvitationAvatar(
  invocationId: string,
  prompt: string,
  assertOwner: () => void,
  db: LedgerDb,
): Promise<{ url: string; hash: string }> {
  assertOwner();
  // Core's request operation replays completed results and materializes saved
  // synchronous responses. Its durable CAS dispatches only a prepared invocation.
  // Reuse the same id; never create a fresh paid request to recover an unknown result.
  let result = await callCindyMedia({ action: 'request', invocationId, body: { prompt } });
  assertOwner();
  if (!result.ok && result.errorCode === 'INVOCATION_ALREADY_USED') {
    result = await callCindyMedia({ action: 'poll', invocationId });
  }
  const deadline = Date.now() + 120000;
  while (result.ok && result.status !== 'complete' && Date.now() < deadline) {
    assertOwner();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assertOwner();
    result = await callCindyMedia({ action: 'poll', invocationId });
  }
  assertOwner();
  const urls = result.xdt_image_urls;
  if (
    !result.ok ||
    result.status !== 'complete' ||
    !Array.isArray(urls) ||
    typeof urls[0] !== 'string'
  )
    throw new Error('INVITATION_AVATAR_UNAVAILABLE');
  const source = resolveSafe(urls[0]);
  const stat = await fs.stat(source.absPath);
  if (stat.size > 32 * 1024 * 1024) throw new Error('INVITATION_AVATAR_TOO_LARGE');
  const image = nativeImage.createFromBuffer(await fs.readFile(source.absPath));
  if (image.isEmpty()) throw new Error('INVITATION_AVATAR_INVALID');
  const size = image.getSize();
  const side = Math.min(size.width, size.height);
  const buffer = image
    .crop({
      x: Math.floor((size.width - side) / 2),
      y: Math.floor((size.height - side) / 2),
      width: side,
      height: side,
    })
    .resize({ width: 256, height: 256, quality: 'best' })
    .toPNG();
  assertOwner();
  const written = await writeBlob({ buffer, mimeType: 'image/png' });
  assertOwner();
  await recordBlob(
    {
      hash: written.hash,
      ext: written.ext,
      mimeType: written.mimeType,
      bytes: written.bytes,
      isCache: false,
    },
    db,
  );
  assertOwner();
  return { url: written.url, hash: written.hash };
}
