/**
 * 伙伴的项目模式(实验):`capabilities.projectMode === true` 时，伙伴的 workspace 就是它的
 * 项目。缺省或其它值都是原来的伙伴。见 main/maker-ipc/botProjectMode.ts。
 */
export function readBotProjectMode(config: Record<string, unknown> | { projectMode?: unknown }): boolean {
  if (!('projectMode' in config)) return false;
  return config.projectMode === true;
}

/** No paths, Git output or identity values cross the settings boundary. */
export type BotProjectRepositoryStatus = 'ready' | 'needs-identity' | 'not-ready' | 'unavailable' | 'failed';
