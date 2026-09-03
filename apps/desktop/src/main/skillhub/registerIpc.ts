import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { Maker } from '@cindy/maker-core';
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { getCurrentDataOwnerId } from '../authManager';
import { isAppSessionBoundaryPending } from '../appSessionState';
import { ensureReady as ensureLocalDbReady, getRawDb } from '../localDb';
import { createLogger } from '../logger';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import { isSkillhubCatalogScope } from '../../shared/skillhubCatalog.js';
import { computeFolderHashDetailed } from './folderHash';
import { type MdKind, parseAndValidateFrontmatter } from './frontmatterValidation';
import * as importLocalSkill from './importLocalSkill';
import * as installService from './installService';
import { SkillhubMarketService, skillhubIpcError } from './marketService';
import type { PublishParams } from './publishService';
import { SkillPublishService } from './publishService';
import { reconcileMineRegistry } from './reconcileMineRegistry';
import { registryService } from './registry';
import {
  isExistingSkillPathGranted,
  listSkillFolderChildren,
  readSkillContent,
  readSkillRawFile,
  readSkillSiblingFile,
  renameLocalSkill,
  resolveExistingSkillPathForGrant,
  scanAllSkills,
  writeSkillFile,
} from './scanner';
import { computeSnapshotDiff, snapshotExists } from './snapshot';
import {
  getLocalSkillUsageDiagnosisContext,
  getLocalSkillUsageSummary,
  requestLocalSkillUsageAnalyticsRefresh,
} from './usageIndexer';

const log = createLogger('skillhub');
const LOCAL_IMPORT_GRANT_TTL_MS = 10 * 60 * 1_000;
const MAX_LOCAL_IMPORT_GRANTS = 32;

interface LocalImportGrant {
  filePath: string;
  senderId: number;
  expiresAt: number;
}

interface ScannedSkillGrant {
  ownerId: string;
  entries: Array<{
    root: string;
    projectRootKey?: string;
  }>;
}

export interface RegisterSkillhubIpcOptions {
  getMaker: () => Maker;
  getAllowedProjectRoots: () => Promise<readonly string[]>;
  marketService?: SkillhubMarketService;
  publishService?: SkillPublishService;
}

function projectRootKey(value: unknown): string | null {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('\uFFFD')) return null;
  const normalized = normalizeWorkingDirForStorage(value);
  if (!normalized || !path.isAbsolute(normalized)) return null;
  try {
    const resolved = path.resolve(normalized);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  } catch {
    return null;
  }
}

async function validateRequestedProjects(
  requestedProjects: import('./scanner').ProjectInput[] | undefined,
  getAllowedProjectRoots: RegisterSkillhubIpcOptions['getAllowedProjectRoots'],
): Promise<import('./scanner').ProjectInput[]> {
  const projects = requestedProjects ?? [];
  if (projects.length === 0) return [];

  const allowedKeys = new Set(
    (await getAllowedProjectRoots())
      .map(projectRootKey)
      .filter((key): key is string => key !== null),
  );
  const validated: import('./scanner').ProjectInput[] = [];
  for (const project of projects) {
    const key = projectRootKey(project.projectRoot);
    if (!key || !allowedKeys.has(key)) {
      throw new Error('projectRoot is not owned by an active local project session');
    }
    validated.push(project);
  }
  return validated;
}

/**
 * Registers all SkillHub IPC channels.
 *
 * The handler bodies delegate to scanner/publish/install/market services; this
 * file is the Electron boundary for renderer calls and progress broadcasts.
 */
export function registerSkillhubIpc(options: RegisterSkillhubIpcOptions): void {
  const marketService = options.marketService ?? new SkillhubMarketService();
  const localImportGrants = new Map<string, LocalImportGrant>();
  const scannedSkillRootsBySender = new Map<number, ScannedSkillGrant>();
  const scanGenerationBySender = new Map<number, number>();
  const scanGrantCleanupRegistered = new WeakSet<object>();

  const ensureScanGrantCleanup = (event: Electron.IpcMainInvokeEvent) => {
    if (scanGrantCleanupRegistered.has(event.sender)) return;
    scanGrantCleanupRegistered.add(event.sender);
    event.sender.once('destroyed', () => {
      scannedSkillRootsBySender.delete(event.sender.id);
      scanGenerationBySender.delete(event.sender.id);
    });
  };

  const rememberScannedSkillRoots = (
    event: Electron.IpcMainInvokeEvent,
    ownerId: string,
    skills: import('./scanner').Skill[],
  ) => {
    const entries: ScannedSkillGrant['entries'] = [];
    const seenEntries = new Set<string>();
    for (const skill of skills) {
      const skillProjectRootKey = skill.scope === 'project'
        ? projectRootKey(skill.projectRoot)
        : undefined;
      if (skill.scope === 'project' && !skillProjectRootKey) continue;
      // discoveredPath preserves an allowed lexical alias when absolutePath was
      // canonicalized through a parent-directory symlink.
      for (const candidate of [skill.discoveredPath, skill.absolutePath]) {
        const root = resolveExistingSkillPathForGrant(candidate);
        if (root) {
          const entryKey = `${root}\0${skillProjectRootKey ?? ''}`;
          if (!seenEntries.has(entryKey)) {
            seenEntries.add(entryKey);
            entries.push({
              root,
              ...(skillProjectRootKey ? { projectRootKey: skillProjectRootKey } : {}),
            });
          }
          break;
        }
      }
    }
    scannedSkillRootsBySender.set(event.sender.id, { ownerId, entries });
  };

  const hasScannedSkillGrant = (
    event: Electron.IpcMainInvokeEvent,
    targetPath: string,
  ): Promise<boolean> => {
    assertTrustedAppRendererEvent(event);
    const grant = scannedSkillRootsBySender.get(event.sender.id);
    const ownerId = getCurrentDataOwnerId();
    if (
      !grant
      || !ownerId
      || isAppSessionBoundaryPending()
      || grant.ownerId !== ownerId
    ) {
      if (grant) scannedSkillRootsBySender.delete(event.sender.id);
      return Promise.resolve(false);
    }
    const matchingEntries = grant.entries.filter(({ root }) => (
      isExistingSkillPathGranted(targetPath, new Set([root]))
    ));
    if (matchingEntries.length === 0) return Promise.resolve(false);
    if (matchingEntries.some(({ projectRootKey: key }) => !key)) return Promise.resolve(true);

    return options.getAllowedProjectRoots()
      .then((roots) => {
        const allowedKeys = new Set(
          roots.map(projectRootKey).filter((key): key is string => key !== null),
        );
        return matchingEntries.some(({ projectRootKey: key }) => (
          key !== undefined && allowedKeys.has(key)
        ));
      })
      .catch(() => false);
  };

  const scanGrantDenied = () => ({
    success: false as const,
    error: 'path was not granted by this renderer\'s latest SkillHub scan',
  });

  const sweepLocalImportGrants = () => {
    const now = Date.now();
    for (const [token, grant] of localImportGrants) {
      if (grant.expiresAt <= now) localImportGrants.delete(token);
    }
  };
  const makeRoomForLocalImportGrant = () => {
    while (localImportGrants.size >= MAX_LOCAL_IMPORT_GRANTS) {
      const oldestToken = localImportGrants.keys().next().value as string | undefined;
      if (!oldestToken) break;
      localImportGrants.delete(oldestToken);
    }
  };

  const refreshCodexProjectSkillCache = async (workingDir?: string): Promise<void> => {
    if (!workingDir) return;
    try {
      await options.getMaker().listAgentSkills('codex', {
        workingDir,
        forceReload: true,
      });
    } catch (err) {
      // 安装 / 卸载已经成功落盘，缓存刷新失败不能反向把文件操作标成失败。
      log.warn('[skillhub:project-skill-cache] Codex refresh failed:', {
        workingDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const broadcastPublishProgress = (payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('skillhub:publish-progress', payload);
      } catch {
        // Window teardown can race with background scan reconciliation.
      }
    }
  };
  const broadcastUsageAnalyticsRefreshed = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('skillhub:usage-analytics-refreshed', {});
      } catch {
        // 窗口关闭和后台索引完成可能竞态，忽略即可。
      }
    }
  };
  const publishService = options.publishService ?? new SkillPublishService({
    onProgress: broadcastPublishProgress,
  });
  let usageRefreshBroadcastPromise: Promise<void> | null = null;
  const scheduleUsageAnalyticsRefresh = (db: ReturnType<typeof getRawDb>) => {
    const promise = requestLocalSkillUsageAnalyticsRefresh(db);
    if (!promise || usageRefreshBroadcastPromise === promise) return;
    usageRefreshBroadcastPromise = promise;
    void promise
      .catch((err) => {
        log.warn('[skillhub:usage-refresh] failed:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        broadcastUsageAnalyticsRefreshed();
        if (usageRefreshBroadcastPromise === promise) usageRefreshBroadcastPromise = null;
      });
  };

  // ── SkillHub: 扫盘 + 商店 manifest 合并 ───────────────────────────────────
  // v0.7 起 agent-customization 发现 (~/.claude 扫盘 / codex RPC) 由 maker-core 完成,
  // 本 handler 只负责 join registry / 补 SkillhubSkill 字段 (id / projectHash)。
  ipcMain.handle(
    'skillhub:scan',
    async (
      event,
      params: { projects?: import('./scanner').ProjectInput[] },
    ) => {
      assertTrustedAppRendererEvent(event);
      ensureScanGrantCleanup(event);
      const scanGeneration = (scanGenerationBySender.get(event.sender.id) ?? 0) + 1;
      scanGenerationBySender.set(event.sender.id, scanGeneration);
      // A new scan attempt supersedes the previous snapshot immediately. If
      // discovery fails, stale paths must not remain authorized.
      scannedSkillRootsBySender.delete(event.sender.id);
      try {
        const scanOwnerId = getCurrentDataOwnerId();
        if (!scanOwnerId || isAppSessionBoundaryPending()) {
          throw new Error('active data owner is unavailable');
        }
        const projects = await validateRequestedProjects(
          params?.projects,
          options.getAllowedProjectRoots,
        );
        const result = await scanAllSkills({ projects }, options.getMaker());
        if (
          scanGenerationBySender.get(event.sender.id) === scanGeneration
          && !isAppSessionBoundaryPending()
          && getCurrentDataOwnerId() === scanOwnerId
        ) {
          rememberScannedSkillRoots(event, scanOwnerId, result.skills);
        }
        return { success: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[skillhub:scan] failed:', err);
        return { success: false, error: message };
      }
    },
  );

  // Read a single .md's markdown body (frontmatter stripped) for the detail
  // view. Path validation lives in the scanner module to keep this channel
  // from devolving into a generic file-read API.
  ipcMain.handle(
    'skillhub:read-skill',
    async (event, params: { mdPath: string }) => {
      if (!await hasScannedSkillGrant(event, params.mdPath)) return scanGrantDenied();
      return readSkillContent(params);
    },
  );

  // Lazy-list children of a subfolder inside a skill. The FILES panel only
  // ships a one-level-deep listing in the scan result; expanding a folder
  // calls back into here for its contents.
  ipcMain.handle(
    'skillhub:list-children',
    async (event, params: { dirPath: string }) => {
      if (!await hasScannedSkillGrant(event, params.dirPath)) return scanGrantDenied();
      return listSkillFolderChildren(params);
    },
  );

  // Read a sibling file inside a skill folder for in-pane preview. Used
  // when the user clicks a non-SKILL.md file in the FILES list.
  ipcMain.handle(
    'skillhub:read-sibling-file',
    async (event, params: { filePath: string }) => {
      if (!await hasScannedSkillGrant(event, params.filePath)) return scanGrantDenied();
      return readSkillSiblingFile(params);
    },
  );

  // ── v0.2.2: in-app md edit ──────────────────────────────────────────────
  // read-raw returns the file verbatim (frontmatter intact) so the editor
  // can round-trip without losing YAML. Path whitelist covers all three
  // kinds (skills / commands / agents) since the editor is opened on a
  // .md across kind boundaries.
  ipcMain.handle(
    'skillhub:read-raw',
    async (event, params: { filePath: string }) => {
      if (!await hasScannedSkillGrant(event, params.filePath)) return scanGrantDenied();
      return readSkillRawFile(params);
    },
  );
  // write-file: atomic tmp+rename, file-must-exist (no creation), 1MB cap,
  // realpath check defends against symlink-out-of-tree. See scanner module.
  ipcMain.handle(
    'skillhub:write-file',
    async (event, params: { filePath: string; content: string }) => {
      if (!await hasScannedSkillGrant(event, params.filePath)) return scanGrantDenied();
      return writeSkillFile(params);
    },
  );
  // validate-frontmatter: 解析+校验 .md frontmatter,返回 issues 列表。
  // 放在 main 是为了避免 renderer 打包 gray-matter (Rollup 会对其 eval 报警),
  // 同时统一 main/renderer 的 YAML 解析行为,防止之前出现过的浏览器/Node 差异。
  ipcMain.handle(
    'skillhub:validate-frontmatter',
    async (_event, params: { content: string; kind: MdKind }) => {
      try {
        return { success: true, ...parseAndValidateFrontmatter(params.content, params.kind) };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );
  // rename-local: 改名整个 skill (目录名 + SKILL.md frontmatter `name`)。
  // 用于"市场名字撞车,本地需改名再发布"流程。返回新的 absolutePath,调用方
  // 拿去走 publish 即可。失败时盘上已回滚到原状态。
  ipcMain.handle(
    'skillhub:rename-local',
    async (event, params: { absolutePath: string; newName: string }) => {
      if (!await hasScannedSkillGrant(event, params.absolutePath)) return scanGrantDenied();
      return renameLocalSkill(params);
    },
  );

  // ── SkillHub market broker IPC ───────────────────────────────────────────
  ipcMain.handle(
    'skillhub:sync',
    async (_event, params: { skills?: unknown; slugs?: string[] } | undefined) => {
      try {
        return await marketService.sync(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[skillhub:sync] failed:', err);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    'skillhub:list-market',
    async (_event, params: Parameters<SkillhubMarketService['listMarket']>[0]) => {
      try {
        return await marketService.listMarket(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[skillhub:list-market] failed:', err);
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    'skillhub:info',
    async (_event, { name, catalogScope }: { name: string; catalogScope?: unknown }) => {
      try {
        return await marketService.info(name, isSkillhubCatalogScope(catalogScope) ? catalogScope : undefined);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = (err as { code?: string }).code;
        if ((err as { statusCode?: number }).statusCode === 404) {
          return { success: true, deleted: true };
        }
        return { success: false, error: message, errorCode: code };
      }
    },
  );

  ipcMain.handle(
    'skillhub:get-published-files',
    async (_event, params: { name: string; version?: string; catalogScope?: unknown }) => {
      try {
        return await marketService.getPublishedFiles({
          name: params.name,
          ...(params.version !== undefined ? { version: params.version } : {}),
          ...(isSkillhubCatalogScope(params.catalogScope) ? { catalogScope: params.catalogScope } : {}),
        });
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:read-published-file',
    async (_event, params: { name: string; path: string; version?: string; catalogScope?: unknown }) => {
      try {
        return await marketService.readPublishedFile({
          name: params.name,
          path: params.path,
          ...(params.version !== undefined ? { version: params.version } : {}),
          ...(isSkillhubCatalogScope(params.catalogScope) ? { catalogScope: params.catalogScope } : {}),
        });
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:list-published-versions',
    async (_event, { name, catalogScope }: { name: string; catalogScope?: unknown }) => {
      try {
        return await marketService.listPublishedVersions(name, isSkillhubCatalogScope(catalogScope) ? catalogScope : undefined);
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:update-published',
    async (_event, { name, fields }: {
      name: string;
      fields: Parameters<SkillhubMarketService['updatePublished']>[1];
    }) => {
      try {
        return await marketService.updatePublished(name, fields);
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:delete-published',
    async (_event, { name }: { name: string }) => {
      try {
        return await marketService.deletePublished(name);
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:unpublish-published',
    async (_event, { name }: { name: string }) => {
      try {
        return await marketService.unpublishPublished(name);
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  ipcMain.handle(
    'skillhub:set-published-visibility',
    async (_event, params: Omit<Parameters<SkillhubMarketService['setPublishedVisibility']>[0], 'previousCatalogScope'> & { previousCatalogScope?: unknown }) => {
      try {
        const { previousCatalogScope, ...fields } = params;
        return await marketService.setPublishedVisibility({
          ...fields,
          ...(isSkillhubCatalogScope(previousCatalogScope) ? { previousCatalogScope } : {}),
        });
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  // 读取已发布 skill 的可见对象(共享团队 + 可见部门),编辑可见范围弹窗回显用
  ipcMain.handle(
    'skillhub:get-published-visibility',
    async (_event, { name }: { name: string }) => {
      try {
        return await marketService.getPublishedVisibility(name);
      } catch (err) {
        return skillhubIpcError(err);
      }
    },
  );

  // 拉当前用户所属一级部门（PublishDialog 打开前触发，按需获取）
  ipcMain.handle(
    'skillhub:get-my-depts',
    async () => {
      log.debug('get-my-depts requested');
      try {
        const result = await marketService.getMyDepts();
        log.debug('get-my-depts succeeded', {
          deptCount: result.ids.length,
          hasNames: result.names.length > 0,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('get-my-depts failed', message);
        return { success: false, error: message, ids: [], names: [] };
      }
    },
  );

  // Market 分类列表 — 若 broker / 网络不可用，降级空数组
  ipcMain.handle(
    'skillhub:list-categories',
    async (_event, params?: { scope?: 'market' | 'team' }) => {
      try {
        // Renderer payload is untrusted: only the two catalog scopes are valid,
        // and an absent/invalid value keeps the historical market behavior.
        const scope = params?.scope === 'team' ? 'team' : 'market';
        return await marketService.listCategories(scope);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('list-categories failed', message);
        return { success: true, categories: [], totalCount: 0, myTotalCount: 0 };
      }
    },
  );

  // 拉当前用户所属团队列表（PublishDialog 选多团队可见时触发）
  ipcMain.handle(
    'skillhub:list-user-teams',
    async () => {
      try {
        return await marketService.listUserTeams();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('list-user-teams failed', message);
        return { success: false, error: message, teams: [] };
      }
    },
  );

  // 查询发布后的安全扫描状态（renderer 轮询用）
  ipcMain.handle(
    'skillhub:get-scan-status',
    async (_event, params: { slug: string; version?: string; catalogScope?: unknown }) => {
      try {
        return await marketService.getScanStatus({
          slug: params.slug,
          ...(params.version !== undefined ? { version: params.version } : {}),
          ...(isSkillhubCatalogScope(params.catalogScope) ? { catalogScope: params.catalogScope } : {}),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message, status: 'unknown' };
      }
    },
  );

  ipcMain.handle('skillhub:stop-scan-poll', () => {
    publishService.stopScanPoll();
    return { success: true };
  });

  ipcMain.handle(
    'skillhub:start-scan-poll',
    (_event, { slug, version }: { slug: string; version: string }) => {
      publishService.startScanPoll(slug, version);
      return { success: true };
    },
  );

  // 计算本地 skill 文件夹 hash（进入 DetailView 时触发）
  // 返回 hash + manifest（文件清单 + 各自 sha256），manifest 用于 renderer 端
  // 排查"我没改但 dirty" — 直接 console.table 即可看到本地参与 hash 的全部文件。
  ipcMain.handle(
    'skillhub:get-folder-hash',
    async (_event, { absolutePath }: { absolutePath: string }) => {
      try {
        const { hash, manifest } = await computeFolderHashDetailed(absolutePath);
        return { success: true, folderHash: hash, manifest };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  );

  // 计算本地 skill 与上次发布快照的文件级 diff（点击 dirty banner 触发）
  // hasSnapshot=false 表示本地无快照(历史已发布或换机器),UI 显示提示
  ipcMain.handle(
    'skillhub:get-snapshot-diff',
    async (_event, { absolutePath, name }: { absolutePath: string; name: string }) => {
      try {
        const result = await computeSnapshotDiff(absolutePath, name);
        return { success: true, ...result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  );

  // 仅查 snapshot 是否存在 — DetailView 状态机判断"hash 不一致但本地无快照"用,
  // 一次 fs.stat,比上面的 diff IPC 轻得多,适合每次进 detail 都打。
  ipcMain.handle(
    'skillhub:has-snapshot',
    (_event, { name }: { name: string }) => {
      return { success: true, exists: snapshotExists(name) };
    },
  );

  // 读取单个 skill 的本地真实使用表现。只返回派生统计;原始 transcript 内容仍留在
  // Claude/Codex 自己的 JSONL 文件里,不复制进 Cindy DB。
  ipcMain.handle(
    'skillhub:get-usage-summary',
    async (_event, { name, mdPath }: { name: string; mdPath?: string }) => {
      try {
        let currentSkillContent: string | null = null;
        if (mdPath) {
          const raw = await readSkillRawFile({ filePath: mdPath });
          if (raw.success) currentSkillContent = raw.content ?? null;
        }
        const readSummary = async () => {
          if (isAppSessionBoundaryPending()) {
            throw new Error('localDb not ready: app session is switching');
          }
          const db = getRawDb();
          scheduleUsageAnalyticsRefresh(db);
          return await getLocalSkillUsageSummary({ skillName: name, currentSkillContent, db });
        };
        try {
          return await readSummary();
        } catch (err) {
          if (!isLocalDbNotReady(err)) throw err;
          const ready = await ensureSkillUsageLocalDbReady();
          if (!ready.success) return ready;
          return await readSummary();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('[skillhub:get-usage-summary] failed:', message);
        return { success: false, error: message };
      }
    },
  );

  // 生成 skill 诊断会话首条消息。只返回统计摘要和 transcript 索引,不复制原始对话内容。
  ipcMain.handle(
    'skillhub:get-usage-diagnosis-context',
    async (_event, { name, mdPath }: { name: string; mdPath?: string }) => {
      try {
        let currentSkillContent: string | null = null;
        if (mdPath) {
          const raw = await readSkillRawFile({ filePath: mdPath });
          if (raw.success) currentSkillContent = raw.content ?? null;
        }
        try {
          if (isAppSessionBoundaryPending()) {
            return { success: false, error: 'localDb not ready: app session is switching' };
          }
          return await getLocalSkillUsageDiagnosisContext({
            skillName: name,
            currentSkillContent,
            skillPath: mdPath ?? null,
          });
        } catch (err) {
          if (!isLocalDbNotReady(err)) throw err;
          const ready = await ensureSkillUsageLocalDbReady();
          if (!ready.success) return ready;
          return await getLocalSkillUsageDiagnosisContext({
            skillName: name,
            currentSkillContent,
            skillPath: mdPath ?? null,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('[skillhub:get-usage-diagnosis-context] failed:', message);
        return { success: false, error: message };
      }
    },
  );

  // 发布 skill（renderer 点"发布"按钮时触发）
  ipcMain.handle(
    'skillhub:publish',
    async (event, params: PublishParams) => {
      void event;
      return publishService.publish(params);
    },
  );

  // 取消当前发布（renderer 点"取消"时触发）
  ipcMain.handle('skillhub:cancel-publish', () => {
    publishService.cancel();
    return { success: true };
  });

  // ── Local import (zip / SKILL.md) ────────────────────────────────────────
  ipcMain.handle(
    'skillhub:pick-local',
    async (event) => {
      assertTrustedAppRendererEvent(event);
      const owner = BrowserWindow.fromWebContents(event.sender);
      if (!owner || owner.isDestroyed()) {
        return { success: false, errorCode: 'INTERNAL', message: '无法打开文件选择器' };
      }
      const picked = await dialog.showOpenDialog(owner, {
        properties: ['openFile'],
        filters: [{ name: 'Skill package', extensions: ['zip', 'md'] }],
      });
      const filePath = picked.filePaths[0];
      if (picked.canceled || !filePath) {
        return { success: true, canceled: true };
      }

      const inspected = await importLocalSkill.inspectLocalSkill({ filePath });
      if (!inspected.success) return inspected;

      sweepLocalImportGrants();
      makeRoomForLocalImportGrant();
      const grantToken = randomUUID();
      localImportGrants.set(grantToken, {
        filePath,
        senderId: event.sender.id,
        expiresAt: Date.now() + LOCAL_IMPORT_GRANT_TTL_MS,
      });
      return {
        success: true,
        canceled: false,
        grantToken,
        name: inspected.name,
        description: inspected.description,
        version: inspected.version,
      };
    },
  );

  ipcMain.handle(
    'skillhub:import-local',
    async (
      event,
      params: { grantToken?: unknown; installPath?: unknown; force?: unknown },
    ) => {
      assertTrustedAppRendererEvent(event);
      sweepLocalImportGrants();
      if (
        typeof params?.grantToken !== 'string' ||
        !params.grantToken ||
        params.grantToken.length > 128
      ) {
        return { success: false, errorCode: 'PERMISSION_DENIED', message: '本地导入授权无效' };
      }
      const grant = localImportGrants.get(params.grantToken);
      if (!grant || grant.senderId !== event.sender.id) {
        return {
          success: false,
          errorCode: 'PERMISSION_DENIED',
          message: '本地导入授权不存在、已过期或不属于当前窗口',
        };
      }
      const result = await importLocalSkill.importLocalSkill({
        filePath: grant.filePath,
        ...(typeof params.installPath === 'string' && params.installPath
          ? { installPath: params.installPath }
          : {}),
        ...(params.force === true ? { force: true } : {}),
      });
      if (!result.success) return result;
      localImportGrants.delete(params.grantToken);
      await refreshCodexProjectSkillCache(result.projectWorkingDir);
      return {
        success: true,
        name: result.name,
        description: result.description,
        version: result.version,
        absolutePath: result.absolutePath,
      };
    },
  );

  // ── Market install / uninstall / cancel ──────────────────────────────────
  // install：异步流程，进度通过 skillhub:install-progress 推。返回值是终态。
  ipcMain.handle(
    'skillhub:install',
    async (event, params: import('./installService').InstallParams) => {
      const publicParams: import('./installService').InstallParams = {
        name: params.name,
        ...(params.version !== undefined ? { version: params.version } : {}),
        ...(isSkillhubCatalogScope(params.catalogScope) ? { catalogScope: params.catalogScope } : {}),
        ...(params.force !== undefined ? { force: params.force } : {}),
        ...(params.installPath !== undefined ? { installPath: params.installPath } : {}),
        ...(params.skipBackup !== undefined ? { skipBackup: params.skipBackup } : {}),
      };
      const result = await installService.install(publicParams, (e) => {
        event.sender.send('skillhub:install-progress', e);
      });
      if (!result.success) return result;
      await refreshCodexProjectSkillCache(result.projectWorkingDir);
      return {
        success: true,
        name: result.name,
        version: result.version,
        absolutePath: result.absolutePath,
        ...(result.replacedBackupPath ? { replacedBackupPath: result.replacedBackupPath } : {}),
      };
    },
  );

  // 取消正在进行的 install（按 name 索引）
  ipcMain.handle(
    'skillhub:cancel-install',
    (_event, { name }: { name: string }) => {
      const ok = installService.cancelInstall(name);
      return { success: ok };
    },
  );

  // 卸载（删本地文件夹）—— service 内校验路径白名单
  ipcMain.handle(
    'skillhub:uninstall',
    async (_event, { absolutePath }: { absolutePath: string }) => {
      const result = await installService.uninstall(absolutePath);
      if (!result.success) return result;
      await refreshCodexProjectSkillCache(result.projectWorkingDir);
      return { success: true };
    },
  );

  // ── SkillHub Registry: 一次性回填 authorId 到本地 install 记录 ──
  // 历史遗留:之前的 publish 流程在源目录无 install 记录时不会主动新建,
  // 导致用户在 ~/.claude/skills/* 手写 + 直接 publish 的 skill 没有 registry,
  // sidebar 的 "已安装位置" 会空。新版 publish 已经会 addInstall,这个 IPC
  // 用来一次性补齐历史数据。
  // 输入由 renderer 提供 server 权威 authorId,main 只负责落盘。
  // 已有记录但 authorId 不一致(老 manifest 缺字段或换 server 用户体系)→ 覆盖刷新。
  ipcMain.handle(
    'skillhub:reconcile-mine-registry',
    async (
      _event,
      {
        items,
      }: {
        items: Array<{ name: string; absolutePath: string; version: string; authorId: string; folderHash?: string }>;
      },
    ) => {
      return reconcileMineRegistry(items);
    },
  );

  // ── SkillHub Registry IPC（v0.6 重构新增） ────────────────────────────────
  ipcMain.handle(
    'skillhub:registry:get-by-name',
    async (_event, { name }: { name: string }) => {
      try {
        const manifest = await registryService.readManifest(name);
        return { success: true, manifest };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('[skillhub:registry:get-by-name] failed:', err);
        return { success: false, error: message };
      }
    },
  );
}

function isLocalDbNotReady(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /localDb not ready/i.test(message);
}

async function ensureSkillUsageLocalDbReady(): Promise<{ success: true } | { success: false; error: string }> {
  if (isAppSessionBoundaryPending()) {
    return { success: false, error: 'localDb not ready: app session is switching' };
  }
  const ownerId = getCurrentDataOwnerId();
  if (!ownerId) {
    return { success: false, error: 'localDb not ready: active data owner missing' };
  }
  const result = await ensureLocalDbReady(ownerId);
  if (!result.ready) {
    return { success: false, error: result.error.message };
  }
  return { success: true };
}
