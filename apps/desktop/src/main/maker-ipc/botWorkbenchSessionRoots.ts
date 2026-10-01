/**
 * 伙伴工作台读本机会话转录的根目录(纯函数,集中在一处)。
 *
 * 转录是固定目录下的文件,与哪个数据库无关:
 * - Claude Code:Cindy 不隔离配置目录,用户自己与 Cindy 跑的都在 `~/.claude/projects`;
 * - Codex:用户的 `~/.codex`、`$CODEX_HOME`、Codex.app,以及 Cindy 各正式 profile
 *   (CN `Cindy`、Global `CindyGlobal`、`CindyDev`、历史 `xdt-maker`)与当前运行
 *   (含 dev 沙盒)的 `<userData>/codex-home`,以及多账号登录的 `<userData>/codex-accounts/<当前账号>/<供应商>`
 *   (只取当前 Cindy 账号那一层,别的账号不碰);每个 home 取 `sessions/` 与 `archived_sessions/`;
 * - Pi:Cindy 各 profile 与当前运行的 `<userData>/pi-agent-home/sessions`。
 * dev 沙盒因此也能看到正式版 Cindy 跑过的任务。所有根只是候选,不存在的目录由调用方跳过。
 */
import path from 'node:path';

/** Cindy 各正式 profile 的 userData 目录名(与 maker-shared brandIdentity 一致)。 */
export const CINDY_PROFILE_DIR_NAMES = ['Cindy', 'CindyGlobal', 'CindyDev', 'xdt-maker'] as const;

export interface WorkbenchSessionRootsInput {
  homeDir: string;
  /** 系统应用数据目录(macOS 为 ~/Library/Application Support)。 */
  appDataDir: string | null;
  /** 当前运行的 userData(dev 沙盒时就是沙盒目录)。 */
  userDataDir: string | null;
  platform: string;
  env: { CODEX_HOME?: string; CLAUDE_CONFIG_DIR?: string; APPDATA?: string };
  /** 当前 Cindy 账号在 `codex-accounts/` 下的目录名(owner id 的 sha256);没有登录时为 null。 */
  codexAccountOwner?: string | null;
}

export interface WorkbenchSessionRoots {
  claude: string[];
  codex: string[];
  /** `codex-accounts/<当前账号>` 目录;下面每个供应商子目录是一个 Codex home,读取时展开。 */
  codexAccounts: string[];
  pi: string[];
}

function unique(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    if (!raw) continue;
    const resolved = path.resolve(raw);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

export function workbenchSessionRoots(input: WorkbenchSessionRootsInput): WorkbenchSessionRoots {
  const profileDirs = unique([
    input.userDataDir,
    ...(input.appDataDir ? CINDY_PROFILE_DIR_NAMES.map((name) => path.join(input.appDataDir!, name)) : []),
  ]);

  const claude = unique([
    input.env.CLAUDE_CONFIG_DIR ? path.join(input.env.CLAUDE_CONFIG_DIR, 'projects') : null,
    path.join(input.homeDir, '.claude', 'projects'),
  ]);

  const codexHomes = unique([
    input.env.CODEX_HOME,
    path.join(input.homeDir, '.codex'),
    ...(input.platform === 'darwin'
      ? [
          path.join(input.homeDir, 'Library', 'Application Support', 'Codex', 'codex-home'),
          path.join(input.homeDir, 'Library', 'Application Support', 'Codex'),
        ]
      : input.platform === 'win32'
        ? input.env.APPDATA
          ? [path.join(input.env.APPDATA, 'Codex', 'codex-home'), path.join(input.env.APPDATA, 'Codex')]
          : []
        : [path.join(input.homeDir, '.config', 'codex')]),
    ...profileDirs.map((dir) => path.join(dir, 'codex-home')),
  ]);
  const codex = unique(codexHomes.flatMap((home) => [path.join(home, 'sessions'), path.join(home, 'archived_sessions')]));

  const owner = input.codexAccountOwner && /^[0-9a-f]{64}$/.test(input.codexAccountOwner) ? input.codexAccountOwner : null;
  const codexAccounts = owner ? unique(profileDirs.map((dir) => path.join(dir, 'codex-accounts', owner))) : [];

  const pi = unique(profileDirs.map((dir) => path.join(dir, 'pi-agent-home', 'sessions')));
  return { claude, codex, codexAccounts, pi };
}
