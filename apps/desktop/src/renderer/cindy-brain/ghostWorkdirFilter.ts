/**
 * ghostWorkdirFilter — 意识清单的「工作目录级禁用」过滤(renderer 侧)。
 *
 * main 侧生效点(花名册 / ghost_list / ghost_info / ghost_call)已按会话 workdir 过滤;
 * 这里补齐 renderer 的两个入口,让被禁用的意识在该目录下彻底"不存在":
 *   - `$` 指令确认胶囊(GhostCommandDecoration 的 roster);
 *   - 发送期展开(expandGhostCommand 的 ghosts 入参,含编辑重发)。
 * 两处必须与 main 同判,否则会出现"胶囊亮了 / 指令展开了,调用却被
 * GHOST_DISABLED_IN_WORKDIR 拒绝"的裂缝。
 *
 * 禁用清单经 sendSync 现查(ghosts:workdir-prefs,文件读带 mtime 缓存,
 * 极小):调用点都在低频路径(roster 变更 / 发送时刻),不进 keystroke
 * 热路径。目录键归一化在 main 侧统一做,这里传原始 workdir 即可。
 */

import type { InstalledGhost } from '../../shared/ghost';

/** 该 workdir 下被禁用的 ghostId 集合;无 workdir / 查询异常 = 空集。 */
export function getWorkdirDisabledGhostIds(workdir: string | null | undefined): Set<string> {
  if (!workdir || workdir.trim().length === 0) return new Set();
  try {
    return new Set(window.electronAPI.ghosts.workdirPrefsSync(workdir).disabled);
  } catch {
    // jsdom 单测 / preload 未就绪:安全退化为"无禁用"(与旧行为一致)。
    return new Set();
  }
}

/**
 * 按 workdir 过滤意识清单。无禁用时返回**原引用**——
 * setGhostCommandRoster 按引用去重,别让空过滤打散它。
 */
export function filterGhostsForWorkdir(
  ghosts: InstalledGhost[],
  workdir: string | null | undefined,
): InstalledGhost[] {
  const disabled = getWorkdirDisabledGhostIds(workdir);
  if (disabled.size === 0) return ghosts;
  const filtered = ghosts.filter((g) => !disabled.has(g.manifest.id));
  return filtered.length === ghosts.length ? ghosts : filtered;
}
