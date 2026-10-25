import { app, dialog, BrowserWindow } from 'electron';
import { createLogger } from '../logger';
import { isCindyPersonalRuntime } from '../cindy-make/versionRuntimeIdentity.js';
import { recordDesktopDevLocalDbStartupResult } from '../devStartupStatus';
import { t } from '../i18n';
import { createBetterSqliteDatabase } from './betterSqliteFactory';
import * as migrations from './migrate';
import * as backup from './backup';
import * as vector from './sqliteVecLoader';
import { detectSchemaDrift } from './schemaDriftDetector';
import * as repair from './schemaDriftRepair';
import * as orcaIndex from './orcaStaleIndexCleanup';
import * as orcaLead from './orcaStrandedLeadReconcile';
import * as codexHistory from './codexHistoryPromptInit';
import { dialogueWorkspaceRoots } from './dialogueWorkspace';
import { runPendingDbSlimmingAtStartup } from './dbSlimmingStartup';
import { shouldShowNativeFatalDialog, type EnsureReadyErrorCode } from './fatalDialogPolicy';
import { createDatabaseRuntime } from '@cindy/runtime-db/runtime';
export type { EnsureReadyResult, CloseDbOptions } from '@cindy/runtime-db/runtime';
const log = createLogger('localDb');
export const { getDrizzle, getRawDb, getCurrentDbPath, getCurrentUserId, getDbPathForUser, ensureReady, closeDb } = createDatabaseRuntime({
  logger: log, sqlite: { createBetterSqliteDatabase }, migrations, backup, vector,
  detectSchemaDrift, ...repair, ...orcaIndex, ...orcaLead, ...codexHistory,
  runPendingDbSlimmingAtStartup, dialogueWorkspaceRoots, t,
  userDataDirectory: () => app.getPath('userData'),
  isPackaged: () => app.isPackaged,
  isPersonalRuntime: isCindyPersonalRuntime,
  broadcast(channel, payload) {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(channel, payload); } catch { /* window closed */ }
    }
  },
  presentFailure: ({ title, detail, code }) => showFatalDialog(title, detail, code),
  confirmDatabaseReset(_file, residual) {
    const detail = residual.slice(0, 10).map(r => `[${r.table}] ${r.kind} — ${r.detail}`).join('\n');
    return dialog.showMessageBoxSync({
      type: 'warning',
      title: '本地 DB schema 仍有残留不一致',
      message: '反射自愈无法修复以下不一致(改类型 / 删列 / 缺 NOT NULL 列等):',
      detail: `${detail}\n\n选「Nuke 重建」会把当前 DB 文件改名为 .bak.nuke-<时间>(永久保留),下次启动建空库重跑迁移。\n选「忽略继续」会带着不一致启动,业务层大概率会报 SqliteError —— 仅推荐用于排查。`,
      buttons: ['Nuke 重建', '忽略继续'],
      defaultId: 0,
      cancelId: 1,
    }) === 0;
  },
  didResetDatabase(nukePath) {
    dialog.showMessageBoxSync({
      type: 'info',
      title: '本地 DB 已 nuke',
      message: `当前 DB 已重命名为:\n${nukePath}\n\n请重启应用,下次启动会建一个空库并跑全套 migration。`,
      buttons: ['好的'],
    });
  },
  exit: (code) => app.exit(code),
});

function showFatalDialog(title: string, detail: string, code: EnsureReadyErrorCode): void {
  // showMessageBoxSync blocks the main process until a person dismisses it. Report
  // first so an agent waiting in `pnpm restart:desktop:*` receives the concrete
  // database failure without depending on UI interaction.
  recordDesktopDevLocalDbStartupResult({
    ready: false,
    error: { code, message: detail },
  });
  // MIGRATE_FAILED 由 renderer 的 LocalDbFatalScreen 全屏接管（可安装已暂存更新），
  // 不再弹阻塞式原生对话框；错误详情随 ensureReady 的 invoke reply 回渲染层。
  if (!shouldShowNativeFatalDialog(code)) {
    log.error(JSON.stringify({ event: 'localDb.fatal.rendererOwned', code, title, detail }));
    return;
  }
  try {
    dialog.showMessageBoxSync({
      type: 'error',
      title,
      message: title,
      detail: `${detail}\n\n请重启应用，或在系统资源管理器中打开数据目录手动处理。`,
      buttons: ['好的'],
      defaultId: 0,
    });
  } catch (err) {
    log.error('showFatalDialog failed', err);
  }
}
