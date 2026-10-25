import path from "node:path";

export type BotSkillErrorCode =
  | "INVALID_ARGS"
  | "SKILL_NAME_UNUSABLE"
  | "SKILL_BODY_TOO_LARGE"
  | "SKILL_LIMIT_REACHED"
  | "NOT_FOUND"
  | "OWNER_SCOPE_CHANGED";

export class BotSkillStoreError extends Error {
  constructor(
    readonly errorCode: BotSkillErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BotSkillStoreError";
  }
}

/** botId 也要过一遍净化:它进的是路径段,不能带分隔符或 `..`。 */
export function botDirName(botId: string): string {
  const trimmed = botId.trim();
  if (!trimmed) throw new BotSkillStoreError("INVALID_ARGS", "botId required");
  const safe = trimmed.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");
  if (!safe)
    throw new BotSkillStoreError(
      "INVALID_ARGS",
      "botId is not usable as a directory name",
    );
  return safe;
}

/**
 * 一个伙伴的技能根目录(= Claude Code 本地 plugin 根)。
 *
 * 这里就是**伙伴的家**(`botProfileFolder.ts`)。技能原来单独住在
 * `<userData>/bot-skills/<botId>/`,与灵魂、用户画像、能力位分居两处;现在一个
 * 伙伴一个家,技能是家里的 `skills/`。搬家由 `migrateBotProfileFolder` 完成,
 * 内容与 slug 都不变,挂载路径每次会话现算、没有任何地方持久化过旧路径。
 *
 * 目录布局刻意仍长成 CC 本地 plugin 的样子(`.claude-plugin/` + `skills/`),
 * 与 SOUL.md 等文件互不干扰 —— CC 只认那两个名字。
 */
export function botSkillRootDir(userDataDir: string, botId: string): string {
  return path.join(userDataDir, "bots", botDirName(botId));
}
