import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

type IpcHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  userDataDir: '',
  currentUserId: 'test-user',
  /** readExistingSdkSessionKinds 的返回行(sessions 表里已存在的 sdk id)。 */
  sdkSessionRows: [] as Array<{
    agentKind: string;
    sdkSessionId: string;
    workspaceKind: string | null;
  }>,
}));

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected app path: ${name}`);
      return mocks.userDataDir;
    },
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../appSessionState.js', () => ({
  ownerScopedUserDataPath: (...parts: string[]) => path.join(mocks.userDataDir, ...parts),
}));

vi.mock('../localDb/index.js', () => ({
  getRawDb: vi.fn(),
}));

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    query: vi.fn(async (sql: string) =>
      sql.includes('sdk_session_id') ? mocks.sdkSessionRows : [],
    ),
  }),
  getCurrentDbClientUserId: () => mocks.currentUserId,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

vi.mock('../maker-host/codex-local-sessions.js', () => ({
  importExternalCodexSessions: vi.fn(),
  scanExternalCodexSessions: vi.fn(),
}));

vi.mock('../maker-host/claude-local-sessions.js', () => ({
  importExternalClaudeCodeSessions: vi.fn(),
  scanExternalClaudeCodeSessions: vi.fn(),
}));

import { registerSessionImportIpc } from '../localDb/ipc/session-import';
import { getRawDb } from '../localDb/index.js';
import {
  importExternalCodexSessions,
  scanExternalCodexSessions,
} from '../maker-host/codex-local-sessions.js';
import {
  importExternalClaudeCodeSessions,
  scanExternalClaudeCodeSessions,
} from '../maker-host/claude-local-sessions.js';

function stubDb(): void {
  vi.mocked(getRawDb).mockReturnValue({
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  } as never);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('session import IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    // win32 下要用带盘符的真实形态:'\tmp\...'(无盘符)不会被 normalizeWorkingDirForStorage
    // 归一成正斜杠,受管 dialogue 目录的前缀匹配会失效。
    mocks.userDataDir =
      process.platform === 'win32'
        ? 'C:\\tmp\\xdt-maker-user-data'
        : path.join('/tmp', 'xdt-maker-user-data');
    mocks.currentUserId = 'test-user';
    mocks.sdkSessionRows = [];
    stubDb();
    registerSessionImportIpc();
  });

  it('filters xdt-maker managed dialogue workspaces out of import candidates', async () => {
    const managedCwd = path.join(
      mocks.userDataDir,
      'dialogues',
      '2026-05-20',
      'h80b0lu1w154ziagh817iwtd',
    );
    const projectCwd = path.join('/tmp', 'real-project');

    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [
        {
          source: 'codex',
          id: 'codex-managed-dialogue',
          title: 'Managed Codex Dialogue',
          cwd: managedCwd,
          workspaceKind: 'dialogue',
          updatedAt: 1_779_200_000_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
        {
          source: 'codex',
          id: 'codex-real-project',
          title: 'Real Codex Project',
          cwd: projectCwd,
          workspaceKind: 'project',
          updatedAt: 1_779_200_001_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
      ],
      rejectedCount: 0,
    });
    vi.mocked(scanExternalClaudeCodeSessions).mockResolvedValue({
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [
        {
          source: 'claude',
          id: 'claude-managed-dialogue',
          title: 'Managed Claude Dialogue',
          cwd: managedCwd,
          updatedAt: 1_779_200_002_000,
          archived: false,
          sourceFile: path.join('/tmp', 'managed.jsonl'),
        },
        {
          source: 'claude',
          id: 'claude-real-project',
          title: 'Real Claude Project',
          cwd: projectCwd,
          updatedAt: 1_779_200_003_000,
          archived: false,
          sourceFile: path.join('/tmp', 'real.jsonl'),
        },
      ],
      rejectedCount: 0,
    });

    const scan = mocks.handlers.get('local-db:session-import:scan');
    expect(scan).toBeDefined();
    const result = await scan?.();

    expect(result).toMatchObject({
      candidates: [
        { key: 'claude:claude-real-project' },
        { key: 'codex:codex-real-project' },
      ],
      rejected: {
        existing: 0,
        managedDialogue: 2,
      },
    });
  });

  it('filters claude candidates whose sdk id already belongs to any live session (incl. dialogue share import)', async () => {
    // 分享导入的 dialogue 会话:转录落在 ~/.claude/projects 下,内嵌 cwd 是 A 机
    // 路径(managed-dialogue 过滤拦不住),扫描必须凭 DB 里同 sdk id 的存活行剔除。
    const sharedDialogueId = 'shared-dialogue-sdk-id';
    mocks.sdkSessionRows = [
      { agentKind: 'cc', sdkSessionId: sharedDialogueId, workspaceKind: 'dialogue' },
    ];
    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [],
      candidates: [],
      rejectedCount: 0,
    });
    vi.mocked(scanExternalClaudeCodeSessions).mockResolvedValue({
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [
        {
          source: 'claude',
          id: sharedDialogueId,
          title: 'Shared dialogue residue',
          cwd: path.join('/Users', 'alice', 'Library', 'dialogues', 'x'),
          updatedAt: 1_779_200_004_000,
          archived: false,
          sourceFile: path.join('/tmp', 'shared.jsonl'),
        },
        {
          source: 'claude',
          id: 'claude-fresh-cli-session',
          title: 'Fresh CLI session',
          cwd: path.join('/tmp', 'real-project'),
          updatedAt: 1_779_200_005_000,
          archived: false,
          sourceFile: path.join('/tmp', 'fresh.jsonl'),
        },
      ],
      rejectedCount: 0,
    });

    const scan = mocks.handlers.get('local-db:session-import:scan');
    const result = await scan?.();
    expect(result).toMatchObject({
      candidates: [{ key: 'claude:claude-fresh-cli-session' }],
      rejected: { existing: 1 },
    });
  });

  it('normalizes candidate cwd without replacing it with the grouped project directory', async () => {
    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [
        {
          source: 'codex',
          id: 'codex-dialogue',
          title: 'Codex Dialogue',
          cwd: '\\\\?\\C:\\Users\\a\\dialogue',
          workspaceKind: 'dialogue',
          updatedAt: 1_779_200_001_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
        {
          source: 'codex',
          id: 'codex-worktree',
          title: 'Codex Worktree',
          cwd: '\\\\?\\D:\\projects\\demo\\.worktrees\\fix-51',
          workspaceKind: 'project',
          updatedAt: 1_779_200_002_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
        {
          source: 'codex',
          id: 'codex-windows',
          title: 'Codex Windows',
          cwd: 'E:\\projects\\plain',
          workspaceKind: 'project',
          updatedAt: 1_779_200_003_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
        {
          source: 'codex',
          id: 'codex-posix',
          title: 'Codex POSIX',
          cwd: '/Users/a/projects/plain',
          workspaceKind: 'project',
          updatedAt: 1_779_200_004_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
      ],
      rejectedCount: 0,
    });
    vi.mocked(scanExternalClaudeCodeSessions).mockResolvedValue({
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [
        {
          source: 'claude',
          id: 'claude-drive',
          title: 'Claude Drive',
          cwd: '\\\\?\\F:\\projects\\demo',
          updatedAt: 1_779_200_005_000,
          archived: false,
          sourceFile: path.join('/tmp', 'drive.jsonl'),
        },
        {
          source: 'claude',
          id: 'claude-extended-unc',
          title: 'Claude Extended UNC',
          cwd: '\\\\?\\UNC\\server\\share\\repo',
          updatedAt: 1_779_200_006_000,
          archived: false,
          sourceFile: path.join('/tmp', 'extended-unc.jsonl'),
        },
        {
          source: 'claude',
          id: 'claude-unc',
          title: 'Claude UNC',
          cwd: '\\\\server\\share\\plain',
          updatedAt: 1_779_200_007_000,
          archived: false,
          sourceFile: path.join('/tmp', 'unc.jsonl'),
        },
      ],
      rejectedCount: 0,
    });

    const scan = mocks.handlers.get('local-db:session-import:scan');
    const result = await scan?.() as { candidates: unknown[] };

    expect(result.candidates).toHaveLength(7);
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'codex:codex-dialogue',
        cwd: 'C:/Users/a/dialogue',
        projectDir: null,
      }),
      expect.objectContaining({
        key: 'codex:codex-worktree',
        cwd: 'D:/projects/demo/.worktrees/fix-51',
        projectDir: 'D:/projects/demo',
      }),
      expect.objectContaining({
        key: 'codex:codex-windows',
        cwd: 'E:/projects/plain',
        projectDir: 'E:/projects/plain',
      }),
      expect.objectContaining({
        key: 'codex:codex-posix',
        cwd: '/Users/a/projects/plain',
        projectDir: '/Users/a/projects/plain',
      }),
      expect.objectContaining({
        key: 'claude:claude-drive',
        cwd: 'F:/projects/demo',
        projectDir: 'F:/projects/demo',
      }),
      expect.objectContaining({
        key: 'claude:claude-extended-unc',
        cwd: '//server/share/repo',
        projectDir: '//server/share/repo',
      }),
      expect.objectContaining({
        key: 'claude:claude-unc',
        cwd: '//server/share/plain',
        projectDir: '//server/share/plain',
      }),
    ]));
  });

  it('reuses automatic scan results, allows forced refresh, and invalidates after import', async () => {
    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [],
      rejectedCount: 0,
    });
    vi.mocked(scanExternalClaudeCodeSessions).mockResolvedValue({
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [],
      rejectedCount: 0,
    });
    vi.mocked(importExternalCodexSessions).mockResolvedValue({
      homes: 1,
      scanned: 1,
      inserted: 1,
      updated: 0,
    });
    vi.mocked(importExternalClaudeCodeSessions).mockResolvedValue({
      roots: 1,
      scanned: 0,
      inserted: 0,
      updated: 0,
    });

    const scan = mocks.handlers.get('local-db:session-import:scan');
    const importSelected = mocks.handlers.get('local-db:session-import:import');
    expect(scan).toBeDefined();
    expect(importSelected).toBeDefined();

    await scan?.();
    await scan?.();
    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(1);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(1);

    await scan?.(undefined, { force: true });
    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(2);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(2);

    await scan?.();
    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(2);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(2);

    await importSelected?.(undefined, { items: [{ source: 'codex', id: 'codex-1' }] });
    await scan?.();
    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(3);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(3);
  });

  it('does not reuse automatic scan cache across current DB users', async () => {
    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [],
      rejectedCount: 0,
    });
    vi.mocked(scanExternalClaudeCodeSessions).mockResolvedValue({
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [],
      rejectedCount: 0,
    });

    const scan = mocks.handlers.get('local-db:session-import:scan');
    expect(scan).toBeDefined();

    mocks.currentUserId = 'user-a';
    await scan?.();
    mocks.currentUserId = 'user-b';
    await scan?.();

    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(2);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh scan when force refresh happens during an automatic scan', async () => {
    const codexFirst = deferred<Awaited<ReturnType<typeof scanExternalCodexSessions>>>();
    const claudeFirst = deferred<Awaited<ReturnType<typeof scanExternalClaudeCodeSessions>>>();
    const codexForced = deferred<Awaited<ReturnType<typeof scanExternalCodexSessions>>>();
    const claudeForced = deferred<Awaited<ReturnType<typeof scanExternalClaudeCodeSessions>>>();
    const emptyCodexScan = {
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [],
      rejectedCount: 0,
    };
    const emptyClaudeScan = {
      roots: [path.join('/tmp', 'external-claude-projects')],
      candidates: [],
      rejectedCount: 0,
    };
    vi.mocked(scanExternalCodexSessions)
      .mockReturnValueOnce(codexFirst.promise)
      .mockReturnValueOnce(codexForced.promise);
    vi.mocked(scanExternalClaudeCodeSessions)
      .mockReturnValueOnce(claudeFirst.promise)
      .mockReturnValueOnce(claudeForced.promise);

    const scan = mocks.handlers.get('local-db:session-import:scan');
    expect(scan).toBeDefined();

    const automaticScan = scan?.();
    await Promise.resolve();
    const forcedScan = scan?.(undefined, { force: true });
    await Promise.resolve();

    codexFirst.resolve(emptyCodexScan);
    claudeFirst.resolve(emptyClaudeScan);
    codexForced.resolve(emptyCodexScan);
    claudeForced.resolve(emptyClaudeScan);
    await Promise.all([automaticScan, forcedScan]);

    expect(scanExternalCodexSessions).toHaveBeenCalledTimes(2);
    expect(scanExternalClaudeCodeSessions).toHaveBeenCalledTimes(2);
  });

  it('does not link Codex projects from managed dialogue workspaces', async () => {
    const managedCwd = path.join(mocks.userDataDir, 'dialogues', '2026-05-20', 'session-1');

    const link = mocks.handlers.get('local-db:session-import:link-codex-project');
    expect(link).toBeDefined();
    const result = await link?.(undefined, { workingDir: managedCwd });

    expect(result).toEqual({
      matched: 0,
      inserted: 0,
      updated: 0,
      scanned: 0,
    });
    expect(scanExternalCodexSessions).not.toHaveBeenCalled();
  });

  it('links Codex sessions whose cwd is inside a project worktree', async () => {
    vi.mocked(scanExternalCodexSessions).mockResolvedValue({
      homes: [path.join('/tmp', 'external-codex-home')],
      candidates: [
        {
          source: 'codex',
          id: 'codex-worktree-session',
          title: 'Imported Worktree Session',
          cwd: '\\\\?\\D:\\AI\\tl_web_agent\\.worktrees\\cx-20260526-104440',
          workspaceKind: 'project',
          updatedAt: 1_779_200_001_000,
          archived: false,
          sourceHome: path.join('/tmp', 'external-codex-home'),
        },
      ],
      rejectedCount: 0,
    });
    vi.mocked(importExternalCodexSessions).mockResolvedValue({
      homes: 1,
      scanned: 1,
      inserted: 0,
      updated: 1,
    });

    const link = mocks.handlers.get('local-db:session-import:link-codex-project');
    expect(link).toBeDefined();
    const result = await link?.(undefined, { workingDir: 'D:\\AI\\tl_web_agent' });

    expect(importExternalCodexSessions).toHaveBeenCalledWith(['codex-worktree-session']);
    expect(result).toEqual({
      matched: 1,
      inserted: 0,
      updated: 1,
      scanned: 1,
    });
  });
});
