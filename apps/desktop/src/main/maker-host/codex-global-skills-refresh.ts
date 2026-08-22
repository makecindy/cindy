type CodexGlobalSkillsRefreshHandler = () => void | Promise<void>;

let refreshHandler: CodexGlobalSkillsRefreshHandler | null = null;

export function setCodexGlobalSkillsRefreshHandler(
  handler: CodexGlobalSkillsRefreshHandler | null,
): void {
  refreshHandler = handler;
}

/** 在 Ghost Skill 链接或安装清单变更后触发 CODEX_HOME 投影重建。 */
export function scheduleCodexGlobalSkillsRefresh(): void {
  if (!refreshHandler) return;
  void Promise.resolve(refreshHandler()).catch(() => undefined);
}
