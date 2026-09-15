/**
 * Settings → Session Import IPC.
 *
 * Scanning is read-only. Local session rows are written only after the user
 * explicitly selects sessions and confirms import in Settings.
 */

import { ipcMain } from 'electron';

import { getCurrentDbClientUserId, getDbClient } from '../client/current.js';
import { createLogger } from '../../logger.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import {
  importExternalCodexSessions,
  scanExternalCodexSessions,
} from '../../maker-host/codex-local-sessions.js';
import {
  importExternalClaudeCodeSessions,
  scanExternalClaudeCodeSessions,
} from '../../maker-host/claude-local-sessions.js';
import { dialogueWorkspaceRootDir } from '../dialogueWorkspace.js';
import {
  normalizeWorkingDirForGrouping,
  normalizeWorkingDirForStorage,
} from '../../../shared/workingDir.js';

const log = createLogger('session-import');

type ImportSource = 'codex' | 'claude';
type SidebarBucket = 'project' | 'dialogue';

interface ImportCandidate {
  key: string;
  source: ImportSource;
  id: string;
  title: string;
  cwd: string;
  updatedAt: string;
  archived: boolean;
  workspaceKind: 'project' | 'dialogue';
  sidebarBucket: SidebarBucket;
  projectDir: string | null;
}

interface SessionImportScanResult {
  sources: {
    codexHomes: string[];
    claudeRoots: string[];
  };
  candidates: ImportCandidate[];
  rejected: {
    codex: number;
    claude: number;
    existing: number;
    /** Cindy 管理目录下的孤儿/内部对话(不计入 existing,避免误导为「已在应用内」)。 */
    managedDialogue: number;
    /** Claude 侧拒绝原因分类(合计等于 claude;见 claude-local-sessions 的 rejected)。 */
    claudeReasons: {
      unreadable: number;
      internal: number;
      noEvents: number;
      windowLimit: number;
      invalidId: number;
    };
  };
  currentProjectDirs: string[];
}

interface SessionImportRequest {
  items?: Array<{ source?: unknown; id?: unknown }>;
}

interface SessionImportScanRequest {
  force?: unknown;
}

interface CodexProjectLinkRequest {
  workingDir?: unknown;
}

const SESSION_IMPORT_SCAN_CACHE_TTL_MS = 30_000;

let cachedSessionImportScan: { scope: string; result: SessionImportScanResult; expiresAt: number } | null = null;
let inFlightSessionImportScan: {
  scope: string;
  force: boolean;
  promise: Promise<SessionImportScanResult>;
} | null = null;
let sessionImportScanCacheVersion = 0;

export function registerSessionImportIpc(): void {
  invalidateSessionImportScanCache();

  ipcMain.handle('local-db:session-import:scan', async (_e, request?: SessionImportScanRequest): Promise<SessionImportScanResult> => {
    const force = request?.force === true;
    const cacheScope = currentSessionImportScanCacheScope();
    if (
      !force &&
      cachedSessionImportScan &&
      cachedSessionImportScan.scope === cacheScope &&
      cachedSessionImportScan.expiresAt > Date.now()
    ) {
      return cachedSessionImportScan.result;
    }
    if (
      inFlightSessionImportScan &&
      inFlightSessionImportScan.scope === cacheScope &&
      (!force || inFlightSessionImportScan.force)
    ) {
      return inFlightSessionImportScan.promise;
    }

    const scanCacheVersion = ++sessionImportScanCacheVersion;
    const scanPromise = runSessionImportScan()
      .then((result) => {
        if (scanCacheVersion === sessionImportScanCacheVersion) {
          cachedSessionImportScan = {
            scope: cacheScope,
            result,
            expiresAt: Date.now() + SESSION_IMPORT_SCAN_CACHE_TTL_MS,
          };
        }
        return result;
      })
      .finally(() => {
        if (inFlightSessionImportScan?.promise === scanPromise) {
          inFlightSessionImportScan = null;
        }
      });

    inFlightSessionImportScan = { scope: cacheScope, force, promise: scanPromise };
    return scanPromise;
  });

  ipcMain.handle('local-db:session-import:import', async (_e, request: SessionImportRequest) => {
    const selected = normalizeImportRequest(request);
    const codexIds = selected.filter((item) => item.source === 'codex').map((item) => item.id);
    const claudeIds = selected.filter((item) => item.source === 'claude').map((item) => item.id);
    const [codex, claude] = await Promise.all([
      importExternalCodexSessions(codexIds),
      importExternalClaudeCodeSessions(claudeIds),
    ]);
    invalidateSessionImportScanCache();
    return {
      inserted: codex.inserted + claude.inserted,
      updated: codex.updated + claude.updated,
      scanned: codex.scanned + claude.scanned,
    };
  });

  ipcMain.handle('local-db:session-import:link-codex-project', async (_e, request: CodexProjectLinkRequest) => {
    const projectDir = normalizeWorkingDir(typeof request?.workingDir === 'string' ? request.workingDir : null);
    if (!projectDir) {
      throwIpcError('INVALID_PARAMS', 'workingDir is required');
    }
    if (isManagedDialogueWorkingDir(projectDir)) {
      log.info('Codex project link skipped for managed dialogue workspace', { projectDir });
      return {
        matched: 0,
        inserted: 0,
        updated: 0,
        scanned: 0,
      };
    }
    const scan = await scanExternalCodexSessions();
    const ids = scan.candidates
      .filter((item) => (
        item.workspaceKind === 'project' &&
        !isManagedDialogueWorkingDir(item.cwd) &&
        isSameOrChildWorkingDir(item.cwd, projectDir)
      ))
      .map((item) => item.id);
    const result = await importExternalCodexSessions(ids);
    invalidateSessionImportScanCache();
    log.info('Codex project link complete', {
      projectDir,
      matched: ids.length,
      inserted: result.inserted,
      updated: result.updated,
    });
    return {
      matched: ids.length,
      inserted: result.inserted,
      updated: result.updated,
      scanned: result.scanned,
    };
  });
}

async function runSessionImportScan(): Promise<SessionImportScanResult> {
  const currentProjectDirs = await readCurrentProjectDirs();
  const [codex, claude] = await Promise.all([
    scanExternalCodexSessions(),
    scanExternalClaudeCodeSessions(),
  ]);
  const existingSdkSessionKinds = await readExistingSdkSessionKinds();
  let existingCount = 0;
  let managedDialogueCount = 0;

  const candidates: ImportCandidate[] = [
    ...codex.candidates.flatMap((item): ImportCandidate[] => {
      const existingKind = existingSdkSessionKinds.get(`codex:${item.id}`);
      if (existingKind === item.workspaceKind) {
        existingCount += 1;
        return [];
      }
      const cwd = normalizeWorkingDirForStorage(item.cwd) ?? item.cwd;
      const projectDir = normalizeWorkingDir(cwd);
      if (isManagedDialogueWorkingDir(projectDir)) {
        managedDialogueCount += 1;
        return [];
      }
      // 无项目 Codex 会话仍保留原 cwd 供 resume / 文件访问使用，
      // 但这个 cwd 不应该作为侧边栏项目根目录。
      return [{
        key: `codex:${item.id}`,
        source: 'codex',
        id: item.id,
        title: item.title,
        cwd,
        updatedAt: new Date(item.updatedAt).toISOString(),
        archived: item.archived,
        workspaceKind: item.workspaceKind,
        sidebarBucket: item.workspaceKind,
        projectDir: item.workspaceKind === 'project' ? projectDir : null,
      }];
    }),
    ...claude.candidates.flatMap((item): ImportCandidate[] => {
      const existingKind = existingSdkSessionKinds.get(`claude:${item.id}`);
      // 同 sdk id 已有任何存活会话行(project 或 dialogue)都不再出候选:分享导入
      // 的 dialogue 会话转录也落在 ~/.claude/projects 下且其内嵌 cwd 是 A 机路径,
      // 只拦 project 会让它变成「点了导入也没反应」的幽灵候选(写侧 upsert 会
      // 因非 claude- 前缀行直接 skip)。
      if (existingKind) {
        existingCount += 1;
        return [];
      }
      const cwd = normalizeWorkingDirForStorage(item.cwd) ?? item.cwd;
      const projectDir = normalizeWorkingDir(cwd);
      if (isManagedDialogueWorkingDir(projectDir)) {
        managedDialogueCount += 1;
        return [];
      }
      return [{
        key: `claude:${item.id}`,
        source: 'claude',
        id: item.id,
        title: item.title,
        cwd,
        updatedAt: new Date(item.updatedAt).toISOString(),
        archived: item.archived,
        workspaceKind: 'project',
        sidebarBucket: 'project',
        projectDir,
      }];
    }),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  log.info('session import scan complete', {
    codexHomes: codex.homes.length,
    claudeRoots: claude.roots.length,
    candidates: candidates.length,
    rejectedCodex: codex.rejectedCount,
    rejectedClaude: claude.rejectedCount,
    existing: existingCount,
    managedDialogue: managedDialogueCount,
  });

  return {
    sources: {
      codexHomes: codex.homes,
      claudeRoots: claude.roots,
    },
    candidates,
    rejected: {
      codex: codex.rejectedCount,
      claude: claude.rejectedCount,
      existing: existingCount,
      managedDialogue: managedDialogueCount,
      claudeReasons: claude.rejected ?? {
        unreadable: 0,
        internal: 0,
        noEvents: 0,
        windowLimit: 0,
        invalidId: 0,
      },
    },
    currentProjectDirs: [...currentProjectDirs].sort(),
  };
}

function invalidateSessionImportScanCache(): void {
  sessionImportScanCacheVersion += 1;
  cachedSessionImportScan = null;
  inFlightSessionImportScan = null;
}

function currentSessionImportScanCacheScope(): string {
  return getCurrentDbClientUserId() ?? '__no-current-db-user__';
}

function normalizeImportRequest(request: SessionImportRequest): Array<{ source: ImportSource; id: string }> {
  if (!request || !Array.isArray(request.items)) return [];
  const out: Array<{ source: ImportSource; id: string }> = [];
  for (const item of request.items) {
    const source = item.source === 'codex' || item.source === 'claude' ? item.source : null;
    const id = typeof item.id === 'string' ? item.id : '';
    if (source && id) out.push({ source, id });
  }
  return out;
}

async function readExistingSdkSessionKinds(): Promise<Map<string, 'project' | 'dialogue'>> {
  const rows = await getDbClient().query<{
    agentKind: string;
    sdkSessionId: string | null;
    workspaceKind?: string | null;
  }>(`
    SELECT
      agent_kind AS agentKind,
      sdk_session_id AS sdkSessionId,
      workspace_kind AS workspaceKind
    FROM sessions
    WHERE status != 'deleted'
      AND sdk_session_id IS NOT NULL
  `);
  const out = new Map<string, 'project' | 'dialogue'>();
  for (const row of rows) {
    if (!row.sdkSessionId) continue;
    const workspaceKind = row.workspaceKind === 'dialogue' ? 'dialogue' : 'project';
    if (row.agentKind === 'codex') out.set(`codex:${row.sdkSessionId}`, workspaceKind);
    if (row.agentKind === 'cc') out.set(`claude:${row.sdkSessionId}`, workspaceKind);
  }
  return out;
}

async function readCurrentProjectDirs(): Promise<Set<string>> {
  const rows = await getDbClient().query<{
    id: string;
    workingDir: string | null;
    userSendAt: number | null;
  }>(`
    SELECT id, working_dir AS workingDir, user_send_at AS userSendAt
    FROM sessions
    WHERE source = 'desktop' AND status != 'deleted'
      AND workspace_kind = 'project'
  `);
  const out = new Set<string>();
  for (const row of rows) {
    if (row.userSendAt == null) continue;
    const dir = normalizeWorkingDir(row.workingDir);
    if (dir) out.add(dir);
  }
  return out;
}

function normalizeWorkingDir(raw: string | null | undefined): string | null {
  return normalizeWorkingDirForGrouping(raw);
}

function workingDirCompareKey(dir: string): string {
  const normalized = normalizeWorkingDir(dir) ?? dir;
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isSameOrChildWorkingDir(candidate: string | null | undefined, projectDir: string): boolean {
  const candidateDir = normalizeWorkingDir(candidate);
  const targetDir = normalizeWorkingDir(projectDir);
  if (!candidateDir || !targetDir) return false;
  const candidateKey = workingDirCompareKey(candidateDir);
  const targetKey = workingDirCompareKey(targetDir);
  return candidateKey === targetKey || candidateKey.startsWith(`${targetKey}/`);
}

function isManagedDialogueWorkingDir(dir: string | null | undefined): boolean {
  const root = normalizeWorkingDir(dialogueWorkspaceRootDir());
  return !!root && isSameOrChildWorkingDir(dir, root);
}
