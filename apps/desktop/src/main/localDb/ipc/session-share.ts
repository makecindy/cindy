/**
 * 会话分享(.cshare,旧名 .xdtshare)IPC。
 *
 * 导出:`local-db:session-share:export` —— main 弹系统保存对话框(先选路径再做
 * 重活,取消零成本),编排在 session-share/sessionShareExport.ts。
 * 导入:inspect(选文件/收拖入路径 → 解头)→ unlock(密码)→ commit(落三层)
 * → cancel,编排在 session-share/sessionShareImport.ts,draft 驻留 main 内存。
 * 取消与超限走 `{status}` 返回(renderer 需要结构化信息驱动分支:取消静默、
 * 超限提供"排除媒体重试",符合 docs/dev-rules/engineering-conventions.md 的查询型例外);其余错误一律
 * throwIpcError。密码只经参数传递,不落日志。
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { BRAND_NAME } from '@cindy/maker-shared/branding';

import { isIpcErrorCode } from '../../../shared/ipc-errors.js';
import { createLogger } from '../../logger.js';
import { notifyGhostSessionEvent } from '../../cindy-brain/index.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import {
  exportSessionShare,
  type SessionShareExportOutcome,
} from '../../session-share/sessionShareExport.js';
import { SHARE_FILE_EXT, SHARE_FILE_EXTENSIONS } from '../../session-share/xdtshareFormat.pure.js';
import {
  cancelShareDraft,
  cleanupReplacedSessionMediaRefs,
  commitShareImport,
  inspectShareFile,
  unlockShareDraft,
  type CommitShareImportResult,
  type InspectResult,
  type SharePreview,
  type ShareImportDraftPrefs,
} from '../../session-share/sessionShareImport.js';
import { getDbClient, tryGetDbClient } from '../client/current.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { captureMediaRefCompensationScope } from '../../cindy-media/refCompensationJournal.js';
import {
  broadcastSessionPatched,
  captureSessionRecycleScope,
  recycleSessionWorktreeForStatusChange,
} from './sessions.js';

const log = createLogger('session-share-ipc');

interface SessionShareExportRequest {
  sessionId?: unknown;
  password?: unknown;
  excludeMedia?: unknown;
}

export type SessionShareExportResponse = SessionShareExportOutcome | { status: 'canceled' };

export type SessionShareInspectResponse = InspectResult | { status: 'canceled' };

/** 统一错误出口:业务码原样透传,未知错误按 fallbackCode 抛。 */
function rethrowIpc(
  err: unknown,
  fallbackCode: 'SHARE_EXPORT_FAILED' | 'SHARE_IMPORT_FAILED',
): never {
  const code = (err as { code?: unknown }).code;
  const message = err instanceof Error ? err.message : String(err);
  if (isIpcErrorCode(code)) throwIpcError(code, message);
  throwIpcError(fallbackCode, message);
}

export function registerSessionShareIpc(): void {
  ipcMain.handle(
    'local-db:session-share:export',
    async (_e, request?: SessionShareExportRequest): Promise<SessionShareExportResponse> => {
      const payload = requireObject(request, 'request');
      const sessionId = requireString(payload.sessionId, 'sessionId');
      const password =
        typeof payload.password === 'string' && payload.password.length > 0
          ? payload.password
          : null;
      const excludeMedia = payload.excludeMedia === true;

      const targetWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!targetWin) return { status: 'canceled' };
      const title = await readSessionTitle(sessionId);
      const result = await dialog.showSaveDialog(targetWin, {
        defaultPath: `${sanitizeFilename(title)}${SHARE_FILE_EXT}`,
        filters: [{ name: `${BRAND_NAME} Session Share`, extensions: [SHARE_FILE_EXT.slice(1)] }],
      });
      if (result.canceled || !result.filePath) return { status: 'canceled' };

      try {
        return await exportSessionShare({
          sessionId,
          targetPath: result.filePath,
          password,
          excludeMedia,
        });
      } catch (err) {
        log.warn('session share export failed', {
          sessionId,
          code: (err as { code?: unknown }).code,
          message: err instanceof Error ? err.message : String(err),
        });
        rethrowIpc(err, 'SHARE_EXPORT_FAILED');
      }
    },
  );

  // inspect:filePath 缺省时弹系统打开对话框(设置页按钮路径);拖入路径直接传。
  ipcMain.handle(
    'local-db:session-share:inspect',
    async (_e, request?: { filePath?: unknown }): Promise<SessionShareInspectResponse> => {
      let filePath = typeof request?.filePath === 'string' ? request.filePath : null;
      if (!filePath) {
        const targetWin = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
        if (!targetWin) return { status: 'canceled' };
        const result = await dialog.showOpenDialog(targetWin, {
          properties: ['openFile'],
          // 旧扩展名 .xdtshare 仍可导入(文件内容格式未变,仅改了后缀)。
          filters: [
            {
              name: `${BRAND_NAME} Session Share`,
              extensions: SHARE_FILE_EXTENSIONS.map((ext) => ext.slice(1)),
            },
          ],
        });
        if (result.canceled || result.filePaths.length === 0) return { status: 'canceled' };
        filePath = result.filePaths[0];
      }
      try {
        return await inspectShareFile(filePath);
      } catch (err) {
        log.warn('session share inspect failed', {
          code: (err as { code?: unknown }).code,
          message: err instanceof Error ? err.message : String(err),
        });
        rethrowIpc(err, 'SHARE_IMPORT_FAILED');
      }
    },
  );

  ipcMain.handle(
    'local-db:session-share:unlock',
    async (_e, request?: { draftId?: unknown; password?: unknown }): Promise<SharePreview> => {
      const payload = requireObject(request, 'request');
      const draftId = requireString(payload.draftId, 'draftId');
      const password = requireString(payload.password, 'password');
      try {
        return await unlockShareDraft(draftId, password);
      } catch (err) {
        // 不打 password;错误码(SHARE_PASSWORD_WRONG 等)原样透传给向导
        rethrowIpc(err, 'SHARE_IMPORT_FAILED');
      }
    },
  );

  ipcMain.handle(
    'local-db:session-share:commit',
    async (
      _e,
      request?: {
        draftId?: unknown;
        workingDir?: unknown;
        draftPrefs?: unknown;
        overwrite?: unknown;
        useWorktree?: unknown;
      },
    ): Promise<CommitShareImportResult> => {
      const payload = requireObject(request, 'request');
      const draftId = requireString(payload.draftId, 'draftId');
      const workingDir = typeof payload.workingDir === 'string' ? payload.workingDir : null;
      const draftPrefs = sanitizeDraftPrefs(payload.draftPrefs);
      const overwrite = payload.overwrite === true;
      const useWorktree = payload.useWorktree === true;
      try {
        const ownerScopeKey = activeOwnerScopeKey();
        const importDbClient = getDbClient();
        const recycleScope = captureSessionRecycleScope(importDbClient);
        const refCompensationScope = captureMediaRefCompensationScope(ownerScopeKey);
        const isStillCurrent = (): boolean =>
          !isAppSessionBoundaryPending() &&
          activeOwnerScopeKey() === ownerScopeKey &&
          tryGetDbClient() === importDbClient;
        const assertStillValid = (): void => {
          if (!isStillCurrent()) {
            throw new Error('Session share import owner changed during import');
          }
          refCompensationScope.assertStillValid();
        };
        const result = await commitShareImport(
          { draftId, workingDir, draftPrefs, overwrite, useWorktree },
          { dbClient: importDbClient, assertStillValid, refCompensationScope },
        );
        // 覆盖事务成功后再执行不可随 SQLite 回滚的运行时/UI/资源收尾：
        // - 广播 patched 让 sidebar/会话视图立即移除旧任务；
        // - 经统一回收链在 route lock 下复验 deleted，关闭 runtime 并回收旧 worktree；
        // - 删除旧 session 名下的媒体引用，引用归零的共享 blob 交 recycler 回收。
        // 不直接删除转录或媒体字节：同 resume id/内容的新任务可能复用它们。
        for (const replaced of result.replacedSessions) {
          if (!isStillCurrent()) break;
          broadcastSessionPatched(replaced.id, { status: 'deleted' }, recycleScope.ownerScope);
          await recycleSessionWorktreeForStatusChange(replaced.id, 'deleted', recycleScope);
        }
        if (isStillCurrent()) {
          await cleanupReplacedSessionMediaRefs(result.replacedSessions, importDbClient.drizzle);
        }
        // The cleanup awaits above may outlive the captured owner even though
        // the DB transaction itself completed under the correct client. Never
        // project that old-owner session id into the replacement Renderer.
        assertStillValid();
        // replacedSessions 是 main 内部收尾信息，不暴露给 renderer/preload 契约。
        const publicResult: CommitShareImportResult = {
          sessionId: result.sessionId,
          fidelity: result.fidelity,
          notes: result.notes,
          orcaWorkers: result.orcaWorkers,
        };
        // 在此补发(fire-and-forget;workdir 由通知内部的资格查询回填)——否则订阅
        // 了 session 的意识对导入会话只见 switched/archived 不见 created(review P2)。
        if (isStillCurrent()) {
          notifyGhostSessionEvent('created', { sessionId: result.sessionId });
        }
        return publicResult;
      } catch (err) {
        log.warn('session share commit failed', {
          code: (err as { code?: unknown }).code,
          message: err instanceof Error ? err.message : String(err),
        });
        rethrowIpc(err, 'SHARE_IMPORT_FAILED');
      }
    },
  );

  ipcMain.handle('local-db:session-share:cancel', async (_e, request?: { draftId?: unknown }) => {
    const draftId = typeof request?.draftId === 'string' ? request.draftId : null;
    if (draftId) cancelShareDraft(draftId);
    return { ok: true };
  });

  // 窗口级拖拽路由的路径分类:.cshare / 旧 .xdtshare → 导入向导;目录 → 新建
  // 会话(PR4);其它忽略。放本模块因为分享文件识别是它的域;目录分支为通用能力。
  ipcMain.handle(
    'local-db:session-share:classify-path',
    async (
      _e,
      request?: { path?: unknown },
    ): Promise<{ kind: 'share' | 'directory' | 'other' }> => {
      const raw = typeof request?.path === 'string' ? request.path : '';
      if (!raw) return { kind: 'other' };
      const stat = await fsp.stat(raw).catch(() => null);
      if (!stat) return { kind: 'other' };
      if (stat.isDirectory()) return { kind: 'directory' };
      const ext = path.extname(raw).toLowerCase();
      if (stat.isFile() && (SHARE_FILE_EXTENSIONS as readonly string[]).includes(ext)) {
        return { kind: 'share' };
      }
      return { kind: 'other' };
    },
  );
}

/**
 * commit 请求里的草稿默认值只做形状清洗(逐字段类型过滤,脏值丢弃),取值合法性
 * (effort / permissionMode 白名单)由 sessionShareImport 的 buildSessionRow 兜底。
 */
function sanitizeDraftPrefs(raw: unknown): ShareImportDraftPrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  return {
    model: typeof r.model === 'string' && r.model.length > 0 ? r.model : undefined,
    effort: typeof r.effort === 'string' ? r.effort : undefined,
    permissionMode: typeof r.permissionMode === 'string' ? r.permissionMode : undefined,
    planMode: r.planMode === true,
    fastMode: r.fastMode === true,
    providerId: typeof r.providerId === 'string' && r.providerId.length > 0 ? r.providerId : null,
  };
}

async function readSessionTitle(sessionId: string): Promise<string> {
  const row = await getDbClient().queryOne<{ title: string | null }>(
    'SELECT title FROM sessions WHERE id = ? LIMIT 1',
    [sessionId],
  );
  return row?.title || 'session';
}

/** 标题转安全文件名:去掉两端空白与路径/非法字符,过长截断,空了兜底。 */
function sanitizeFilename(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex -- 显式清洗 Windows 非法文件名字符(含控制符)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || 'session';
}
