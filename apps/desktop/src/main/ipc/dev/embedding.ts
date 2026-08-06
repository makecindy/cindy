/**
 * dev-only IPC: embedding-host 状态查询 + 同步嵌入烟测。
 *
 * Channels (仅 `!app.isPackaged` 时注册):
 *   - `dev:embedding:status`     → EmbeddingService.getStatus()
 *   - `dev:embedding:test-embed` → embedSync 烟测 (texts, modelId) → 返回 dim + 前 5 维 + tokensUsed
 *
 * 这两个 channel 不暴露到 preload (与 dev:sqlite-vec:status 同模式)。
 * 验证方式: 在 main 进程内直接调 EmbeddingService API, 或 dev 工具临时桥接
 * ipcRenderer.invoke('dev:embedding:status') / ipcRenderer.invoke('dev:embedding:test-embed',{texts,modelId})。
 */

import { app, ipcMain } from 'electron';
import { isKnownEmbeddingModel } from '@cindy/embedding-client';

import {
  getEmbeddingService,
  isEmbeddingHostStarted,
} from '../../embedding-host';
import { IPC_CHANNELS } from '@cindy/cindy-ipc';

export function registerDevEmbeddingIpc(): void {
  if (app.isPackaged) return;

  ipcMain.handle(IPC_CHANNELS.DEV.EMBEDDING_STATUS, async () => {
    if (!isEmbeddingHostStarted()) {
      return { ok: false, error: 'embedding-host not started' };
    }
    try {
      const status = await getEmbeddingService().getStatus();
      return { ok: true, status };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS.DEV.EMBEDDING_TEST_EMBED, async (_e, payload: unknown) => {
    if (!isEmbeddingHostStarted()) {
      return { ok: false, error: 'embedding-host not started' };
    }
    const args = (payload ?? {}) as { texts?: unknown; modelId?: unknown };
    if (
      !Array.isArray(args.texts) ||
      args.texts.length === 0 ||
      !args.texts.every((t) => typeof t === 'string')
    ) {
      return { ok: false, error: 'texts must be a non-empty string[]' };
    }
    if (typeof args.modelId !== 'string' || !isKnownEmbeddingModel(args.modelId)) {
      return {
        ok: false,
        error: `modelId must be one of the catalog ids; got '${String(args.modelId)}'`,
      };
    }
    try {
      const res = await getEmbeddingService().embedSync(args.texts as string[], {
        modelId: args.modelId,
      });
      const first = res.embeddings[0] ?? [];
      return {
        ok: true,
        modelUsed: res.modelUsed,
        tokensUsed: res.tokensUsed,
        cacheHits: res.cacheHits,
        dim: first.length,
        // 前 5 维, 便于肉眼校验是真返回了浮点数而不是 0
        preview: first.slice(0, 5),
        count: res.embeddings.length,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        code: (err as { code?: string }).code ?? null,
      };
    }
  });
}
