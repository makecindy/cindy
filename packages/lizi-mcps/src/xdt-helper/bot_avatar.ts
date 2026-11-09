import { z } from 'zod';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult, LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export interface TeammateAvatarInput {
  callerSessionId: string;
  target: string;
  imageSource: string;
  expectedVersion: number;
  expectedAvatar: string;
  crop?: { left: number; top: number; width: number; height: number };
}
export interface TeammateAvatarCallbacks {
  set(input: TeammateAvatarInput): Promise<ControlResult<{
    target: string; avatar: string; profileVersion: number;
    imageFormat: '256px-png'; synchronization?: 'complete' | 'unconfirmed'; warning?: string;
  }, string>>;
}

/** Generation and binding are separate: this tool cannot submit a paid media request. */
export function registerBotAvatarTools(registry: XdtHelperToolRegistry, deps: {
  getSessionContext(): LiziMcpSessionContext;
  callbacks: TeammateAvatarCallbacks;
}) {
  registry.register({
    name: 'set_target_teammate_avatar', category: 'bots',
    description: '将当前任务有权读取的受管图片绑定为伙伴头像。target 使用本机稳定 botId；先读取目标配置，带上 expectedVersion 和 expectedAvatar。图片按当前任务授权读取并在本机验证和保存；不是生图工具，不提交付费生成。保存为 256px PNG，保留透明背景。冲突先重新读取，写入未知不得自动重放。',
    inputShape: {
      target: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
      imageSource: z.string().regex(/^cindy-media:\/\/blobs\/[0-9a-f]{64}\.(?:png|jpe?g|webp)$/),
      expectedVersion: z.number().int().positive(),
      expectedAvatar: z.string().min(1).max(2000),
      crop: z.strictObject({ left: z.number().int().nonnegative(), top: z.number().int().nonnegative(), width: z.number().int().positive(), height: z.number().int().positive() }).optional().describe('Square crop in EXIF-oriented ORIGINAL image pixels, before any HDR downscaling; must fit wholly inside the source.'),
    },
    handler: async input => {
      const callerSessionId = deps.getSessionContext().sessionId;
      if (!callerSessionId) return errorPayload('NO_SESSION_CONTEXT', '当前调用未绑定任务');
      const result = await deps.callbacks.set({ ...input, callerSessionId });
      if (!result.ok) return errorPayload(result.errorCode, result.message);
      return okPayload({ target: result.target, avatar: result.avatar, profileVersion: result.profileVersion, imageFormat: result.imageFormat, synchronization: result.synchronization, ...(result.warning ? { warning: result.warning } : {}) });
    },
  });
}
