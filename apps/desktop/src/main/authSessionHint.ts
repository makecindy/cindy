/**
 * 首启亮色门的同步会话线索(main 侧,窗口创建前即可用)。
 *
 * renderer bootstrap 判定「真首启」时,localStorage 为空是弱代理:renderer
 * 存储被清空(用户清浏览数据 / 存储损坏)而主进程仍持有可恢复登录会话时,
 * 会被误判为首启并激活亮色门,造成已登录暗色用户的亮色首帧(乃至锁亮色)。
 * 本模块提供纯同步的「主进程是否持有存量会话」检查,经 sync IPC 供 preload /
 * renderer bootstrap 消费,把误判从源头消灭。
 *
 * 只做文件存在性 / 明文 JSON 读取,不解密、不触发任何 auth 初始化——
 * token 是否有效不重要(存在即非首启);Electron-free,可直接单测。
 */
import path from 'node:path';
import fs from 'node:fs';

/** 与 authManager.ts 的 REFRESH_TOKEN_KEY / LEGACY_*_KEY 对应(那边是
 * module-private 常量;此处只按 safe-storage 落盘文件名做存在性检查)。 */
const PERSISTED_TOKEN_FILES = [
  'cindy_auth_refresh_token.enc',
  'cindy_auth_account_refresh_token.enc',
  'refresh_token.enc',
];

export interface AuthSessionHintDeps {
  userDataPath: string;
  existsSync?: (filepath: string) => boolean;
  readFileSync?: (filepath: string) => string;
}

/**
 * 主进程是否持有「非首启」的存量会话痕迹:
 *  - safe-storage 下存在任一持久化 refresh token(cloud 登录会在冷启动恢复);
 *  - 或 app-session.json 的 activeMode 为 'local'(账号外本地模式会直进应用)。
 * 两者都没有 → 允许 renderer 按首启处理。读取失败一律按「无会话」兜底,
 * 行为退化为改动前的 localStorage 判定,不会更糟。
 */
export function hasPersistedSessionHint(deps: AuthSessionHintDeps): boolean {
  const exists = deps.existsSync ?? fs.existsSync;
  const read = deps.readFileSync ?? ((p: string) => fs.readFileSync(p, 'utf-8'));

  const safeStorageDir = path.join(deps.userDataPath, 'safe-storage');
  for (const file of PERSISTED_TOKEN_FILES) {
    try {
      if (exists(path.join(safeStorageDir, file))) return true;
    } catch {
      // 单个探测失败继续查其余线索
    }
  }

  try {
    const raw = read(path.join(deps.userDataPath, 'app-session.json'));
    const activeMode = (JSON.parse(raw) as { activeMode?: unknown }).activeMode;
    if (activeMode === 'local') return true;
  } catch {
    // 文件缺失 / 损坏 = 无 local 会话
  }
  return false;
}
