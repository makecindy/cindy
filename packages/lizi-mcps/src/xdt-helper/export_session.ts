/**
 * xdt-helper/export_session.ts —— 把一个 session 导出成 .cshare 分享包(control 类)。
 *
 * 对应 GUI 会话菜单的「导出分享包」。GUI 弹系统保存框选路径;工具侧由调用方给出
 * 目标绝对路径,其余(打包、可选密码、体积上限)复用主进程 session-share 的导出编排。
 * 远程会话、协同 worker、已删除会话不能导出(与 host 守卫同口径)。
 */

import { BRAND_NAME } from '@cindy/maker-shared/branding';
import { z } from 'zod';

import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { ControlResult } from '../lizi_xdtHelperMcpServer.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';
import { hostErrorPayload } from './_session_ops.js';

export interface ExportSessionOk {
  filePath: string;
  fidelity: string;
  missingTranscripts: string[];
  mediaMissing: number;
  orcaWorkers: number;
}

export type ExportSessionResult = ControlResult<
  ExportSessionOk,
  'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INVALID_ARGS' | 'OVERSIZE' | 'HOST_NOT_READY' | 'INTERNAL'
> & { data?: Record<string, unknown> };

export interface ExportSessionDeps {
  getSessionContext(): LiziMcpSessionContext;
  exportSession(params: {
    sessionId: string;
    targetPath: string;
    password: string | null;
    excludeMedia: boolean;
  }): Promise<ExportSessionResult>;
}

const DESCRIPTION =
  `把一个 ${BRAND_NAME} 历史对话/session 导出为 .cshare 分享包文件(可在另一台 ${BRAND_NAME} 导入)。` +
  '等价于侧栏菜单的「导出分享包」,但由你指定 target_path(绝对路径,扩展名不是 .cshare 时会自动补上)。' +
  '可选 password 加密;体积超限时返回 OVERSIZE,可用 exclude_media=true 只导出文本与转录重试。' +
  '限制:远程会话、协同 worker、已删除会话不能导出。' +
  '失败码: NOT_FOUND / PRECONDITION_FAILED / OVERSIZE(data 含 total_bytes / limit_bytes) / INVALID_ARGS / HOST_NOT_READY / INTERNAL。';

export function registerExportSessionTool(
  registry: XdtHelperToolRegistry,
  deps: ExportSessionDeps,
): void {
  registry.register({
    name: 'export_session',
    category: 'control',
    description: DESCRIPTION,
    inputShape: {
      session_id: z.string().min(1).describe('要导出的 session id。'),
      target_path: z
        .string()
        .min(1)
        .describe('导出文件的绝对路径;所在目录须已存在。'),
      password: z.string().min(1).optional().describe('可选:给分享包加密的密码。'),
      exclude_media: z
        .boolean()
        .default(false)
        .describe('true 时跳过全部媒体附件,只保留消息文本与转录(超限重试用)。'),
    },
    handler: async ({ session_id, target_path, password, exclude_media }) => {
      const ctx = deps.getSessionContext();
      if (!ctx.sessionId) {
        return errorPayload(
          'NO_SESSION_CONTEXT',
          `本次 MCP 调用没有绑定 ${BRAND_NAME} session,无法访问会话数据。`,
        );
      }
      const result = await deps.exportSession({
        sessionId: session_id,
        targetPath: target_path,
        password: password ?? null,
        excludeMedia: exclude_media,
      });
      if (!result.ok) return hostErrorPayload(result, BRAND_NAME, result.data ?? {});
      return okPayload({
        session_id,
        file_path: result.filePath,
        fidelity: result.fidelity,
        missing_transcripts: result.missingTranscripts,
        media_missing: result.mediaMissing,
        orca_workers: result.orcaWorkers,
      });
    },
  });
}
