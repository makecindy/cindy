/**
 * 一次性 Forge icon utility-process。Sharp/libvips 完全隔离在本进程中，
 * Electron main 的 5 秒 wall-clock 超时可直接 kill 本进程，不留下后台任务。
 */

import sharp from 'sharp';

import { GHOST_ICON_MAX_BYTES } from '../../shared/ghost.js';
import type {
  ForgeIconConversionRequest,
  ForgeIconConversionResponse,
} from './forgeIconConversionProtocol.js';

const FORGE_ICON_EDGE_PX = 1024;

interface ParentPortLike {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

export async function convertForgeIconFile(
  absPath: string,
  timeoutSeconds: number,
): Promise<Buffer> {
  const png = await sharp(absPath, {
    failOn: 'error',
    limitInputPixels: 64 * 1024 * 1024,
  })
    .rotate()
    .resize(FORGE_ICON_EDGE_PX, FORGE_ICON_EDGE_PX, {
      fit: 'cover',
      position: 'centre',
    })
    .png({ compressionLevel: 9, palette: true, colours: 256, effort: 7 })
    .timeout({ seconds: timeoutSeconds })
    .toBuffer();
  if (png.byteLength === 0 || png.byteLength > GHOST_ICON_MAX_BYTES) {
    throw new Error(`AI 图标转换结果必须在 1–${GHOST_ICON_MAX_BYTES} 字节之间`);
  }
  return png;
}

if (parentPort) {
  let started = false;
  parentPort.on('message', (event) => {
    if (started) return;
    const request = parseRequest(event.data);
    if (!request) return;
    started = true;
    void convertForgeIconFile(request.absPath, request.timeoutSeconds)
      .then<ForgeIconConversionResponse, ForgeIconConversionResponse>(
        (png) => ({
          kind: 'result',
          id: request.id,
          ok: true,
          png: new Uint8Array(png),
        }),
        (error) => ({
          kind: 'result',
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .then((response) => parentPort.postMessage(response));
  });
}

function parseRequest(value: unknown): ForgeIconConversionRequest | null {
  if (!value || typeof value !== 'object') return null;
  const request = value as Partial<ForgeIconConversionRequest>;
  if (
    request.kind !== 'convert' ||
    typeof request.id !== 'string' ||
    request.id.length === 0 ||
    typeof request.absPath !== 'string' ||
    request.absPath.length === 0 ||
    !Number.isInteger(request.timeoutSeconds) ||
    (request.timeoutSeconds ?? 0) < 1 ||
    (request.timeoutSeconds ?? 0) > 3600
  ) {
    return null;
  }
  return request as ForgeIconConversionRequest;
}
